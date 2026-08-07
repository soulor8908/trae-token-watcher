// 数据同步 API — 跨设备备份用量记录
// 设计：记录不可变，用 (user_id, client_id) 去重；pull 按 server_created_at 增量
// 所有路由需 session；登录即可用，无需 Star

import { httpError } from './github.js';

const MAX_BATCH = 500;       // 单次 push 上限
const DEFAULT_PULL_LIMIT = 500;

// POST /api/sync/push
// body: { device_id, records: [{ client_id, ts, model, ... }] }
export async function handleSyncPush(request, env, session) {
  if (!session) throw httpError(401, '未登录');

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.records)) {
    throw httpError(400, '缺少 records 数组');
  }
  const deviceId = String(body.device_id || 'anon').slice(0, 64);
  const records = body.records.slice(0, MAX_BATCH);

  if (records.length === 0) {
    return json({ pushed: 0, skipped: 0 });
  }

  // 批量 INSERT OR IGNORE（UNIQUE 约束自动去重）
  const stmts = records.map((r) => {
    const cid = String(r.client_id || '').slice(0, 64);
    if (!cid) throw httpError(400, 'record 缺少 client_id');
    return env.DB
      .prepare(`
        INSERT OR IGNORE INTO usage_records
          (user_id, client_id, ts, model, conversation_id,
           input_tokens, output_tokens, cached_tokens, cache_write_tokens, total_tokens,
           credits, cost_money, remaining, source, url, user_input_preview, device_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        session.user_id,
        cid,
        parseInt(r.ts, 10) || 0,
        str(r.model),
        str(r.conversation_id),
        num(r.input_tokens),
        num(r.output_tokens),
        num(r.cached_tokens),
        num(r.cache_write_tokens),
        num(r.total_tokens),
        flo(r.credits),
        flo(r.cost_money),
        r.remaining == null ? null : num(r.remaining),
        str(r.source),
        str(r.url),
        str(r.user_input_preview),
        deviceId,
      );
  });

  const results = await env.DB.batch(stmts);
  let pushed = 0;
  for (const r of results) {
    if (r.meta?.changes > 0) pushed++;
  }
  const skipped = records.length - pushed;

  // 更新设备游标
  await upsertCursor(env, session.user_id, deviceId, { last_sync_at: nowSec() });

  return json({ pushed, skipped, total: records.length });
}

// GET /api/sync/pull?since=<server_ts>&limit=<n>
// 返回 server_created_at > since 的记录（增量）
export async function handleSyncPull(request, env, session) {
  if (!session) throw httpError(401, '未登录');

  const url = new URL(request.url);
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10));
  const limit = Math.min(DEFAULT_PULL_LIMIT, Math.max(1, parseInt(url.searchParams.get('limit') || String(DEFAULT_PULL_LIMIT), 10)));

  const rows = await env.DB
    .prepare(`
      SELECT client_id, ts, model, conversation_id,
             input_tokens, output_tokens, cached_tokens, cache_write_tokens, total_tokens,
             credits, cost_money, remaining, source, url, user_input_preview, device_id,
             server_created_at
      FROM usage_records
      WHERE user_id = ? AND server_created_at > ?
      ORDER BY server_created_at ASC
      LIMIT ?
    `)
    .bind(session.user_id, since, limit)
    .all();

  const records = (rows.results || []).map(rowToClient);
  const latestServerTs = records.length > 0
    ? records[records.length - 1].server_created_at
    : since;
  const hasMore = records.length === limit;

  return json({
    records,
    latest_server_ts: latestServerTs,
    has_more: hasMore,
  });
}

// GET /api/sync/status
export async function handleSyncStatus(request, env, session) {
  if (!session) throw httpError(401, '未登录');

  const url = new URL(request.url);
  const deviceId = String(url.searchParams.get('device_id') || 'anon').slice(0, 64);

  const countRow = await env.DB
    .prepare('SELECT COUNT(*) as n, MAX(server_created_at) as latest FROM usage_records WHERE user_id = ?')
    .bind(session.user_id)
    .first();

  const cursor = await env.DB
    .prepare('SELECT last_pull_server_ts, last_sync_at FROM sync_cursor WHERE user_id = ? AND device_id = ?')
    .bind(session.user_id, deviceId)
    .first();

  return json({
    remote_count: countRow?.n || 0,
    latest_server_ts: countRow?.latest || 0,
    cursor: cursor || { last_pull_server_ts: 0, last_sync_at: 0 },
  });
}

// POST /api/sync/cursor — 客户端汇报拉取水位
// body: { device_id, last_pull_server_ts }
export async function handleSyncCursor(request, env, session) {
  if (!session) throw httpError(401, '未登录');
  const body = await request.json().catch(() => ({}));
  const deviceId = String(body.device_id || 'anon').slice(0, 64);
  const lastPull = Math.max(0, parseInt(body.last_pull_server_ts || '0', 10));
  await upsertCursor(env, session.user_id, deviceId, {
    last_pull_server_ts: lastPull,
    last_sync_at: nowSec(),
  });
  return json({ ok: true });
}

// POST /api/sync/reset — 清空云端数据
export async function handleSyncReset(request, env, session) {
  if (!session) throw httpError(401, '未登录');
  await env.DB
    .prepare('DELETE FROM usage_records WHERE user_id = ?')
    .bind(session.user_id)
    .run();
  await env.DB
    .prepare('DELETE FROM sync_cursor WHERE user_id = ?')
    .bind(session.user_id)
    .run();
  return json({ ok: true });
}

// ---------- 辅助 ----------
async function upsertCursor(env, userId, deviceId, { last_pull_server_ts, last_sync_at }) {
  // 读取现有游标，取较大值合并
  const existing = await env.DB
    .prepare('SELECT last_pull_server_ts, last_sync_at FROM sync_cursor WHERE user_id = ? AND device_id = ?')
    .bind(userId, deviceId)
    .first();

  const pullTs = Math.max(existing?.last_pull_server_ts || 0, last_pull_server_ts || 0);
  const syncAt = Math.max(existing?.last_sync_at || 0, last_sync_at || 0);

  await env.DB
    .prepare(`
      INSERT INTO sync_cursor (user_id, device_id, last_pull_server_ts, last_sync_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, device_id) DO UPDATE SET
        last_pull_server_ts = excluded.last_pull_server_ts,
        last_sync_at = excluded.last_sync_at
    `)
    .bind(userId, deviceId, pullTs, syncAt)
    .run();
}

function rowToClient(r) {
  return {
    clientId: r.client_id,
    ts: r.ts,
    model: r.model,
    conversationId: r.conversation_id,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedTokens: r.cached_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    totalTokens: r.total_tokens,
    credits: r.credits,
    costMoney: r.cost_money,
    remaining: r.remaining,
    source: r.source,
    url: r.url,
    userInputPreview: r.user_input_preview,
    deviceId: r.device_id,
    server_created_at: r.server_created_at,
  };
}

function str(v) { return v == null ? null : String(v).slice(0, 2000); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0; }
function flo(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function nowSec() { return Math.floor(Date.now() / 1000); }

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
