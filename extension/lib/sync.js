// 数据同步客户端 — 与 Worker 后端的增量同步
// 上传：按本地 id 增量推送；下载：按 server_created_at 增量拉取
// 去重：依赖 (user_id, client_id) 服务端唯一约束 + 本地 clientId 索引

import { getApiBase, getSession } from './auth.js';
import { getRecordsAfterId, importRecords, countAllRecords } from './db.js';

const SYNC_STATE_KEY = 'ttw_sync_state';
const DEVICE_ID_KEY = 'ttw_device_id';
const PUSH_BATCH = 500;
const PULL_LIMIT = 500;

// 获取或生成设备 ID（每个浏览器实例一个）
export async function getDeviceId() {
  const { [DEVICE_ID_KEY]: id } = await chrome.storage.local.get(DEVICE_ID_KEY);
  if (id) return id;
  const newId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  await chrome.storage.local.set({ [DEVICE_ID_KEY]: newId });
  return newId;
}

// 读取同步状态
async function getSyncState() {
  const { [SYNC_STATE_KEY]: state } = await chrome.storage.local.get(SYNC_STATE_KEY);
  return state || { lastSyncedLocalId: 0, lastPullServerTs: 0, lastSyncAt: 0 };
}

async function setSyncState(patch) {
  const cur = await getSyncState();
  const next = { ...cur, ...patch, lastSyncAt: Math.floor(Date.now() / 1000) };
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: next });
  return next;
}

// 是否可同步：需要 session + apiBase
export async function canSync() {
  const session = await getSession();
  const apiBase = await getApiBase();
  return !!(session && apiBase);
}

// 上传本地新增到云端
export async function push() {
  const session = await getSession();
  const apiBase = await getApiBase();
  if (!session || !apiBase) throw new Error('未登录或未配置后端地址');

  const deviceId = await getDeviceId();
  const state = await getSyncState();
  let localId = state.lastSyncedLocalId;
  let totalPushed = 0;
  let totalSkipped = 0;

  // 循环上传直到没有更多
  for (;;) {
    const records = await getRecordsAfterId(localId, PUSH_BATCH);
    if (records.length === 0) break;

    const payload = records.map((r) => ({
      client_id: r.clientId,
      ts: r.timestamp,
      model: r.model,
      conversation_id: r.conversationId,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cached_tokens: r.cachedTokens,
      cache_write_tokens: r.cacheWriteTokens,
      total_tokens: r.totalTokens,
      credits: r.credits,
      cost_money: r.costMoney,
      remaining: r.remaining,
      source: r.source,
      url: r.url,
      user_input_preview: r.userInputPreview,
    }));

    const resp = await fetch(`${apiBase.replace(/\/$/, '')}/api/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ device_id: deviceId, records: payload }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `上传失败 ${resp.status}`);
    }

    const data = await resp.json();
    totalPushed += data.pushed || 0;
    totalSkipped += data.skipped || 0;

    // 推进游标到本批次最后一条的 id
    const lastId = records[records.length - 1].id;
    localId = lastId;
    await setSyncState({ lastSyncedLocalId: localId });

    if (records.length < PUSH_BATCH) break;
  }

  return { pushed: totalPushed, skipped: totalSkipped };
}

// 从云端拉取新记录到本地
export async function pull() {
  const session = await getSession();
  const apiBase = await getApiBase();
  if (!session || !apiBase) throw new Error('未登录或未配置后端地址');

  const deviceId = await getDeviceId();
  const state = await getSyncState();
  let since = state.lastPullServerTs;
  let totalImported = 0;
  let totalSkipped = 0;

  for (;;) {
    const resp = await fetch(
      `${apiBase.replace(/\/$/, '')}/api/sync/pull?since=${since}&limit=${PULL_LIMIT}`,
      { headers: { Authorization: `Bearer ${session.token}` } },
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `拉取失败 ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.records || data.records.length === 0) break;

    const result = await importRecords(data.records);
    totalImported += result.imported;
    totalSkipped += result.skipped;

    since = data.latest_server_ts;
    await setSyncState({ lastPullServerTs: since });

    // 汇报游标
    fetch(`${apiBase.replace(/\/$/, '')}/api/sync/cursor`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({ device_id: deviceId, last_pull_server_ts: since }),
    }).catch(() => {});

    if (!data.has_more) break;
  }

  return { imported: totalImported, skipped: totalSkipped };
}

// 完整同步：先拉取再上传（拉取优先，避免云端缺本地已有）
export async function sync() {
  await pull();
  return await push();
}

// 查询同步状态（本地 + 云端）
export async function getStatus() {
  const session = await getSession();
  const apiBase = await getApiBase();
  const localCount = await countAllRecords();
  const state = await getSyncState();

  if (!session || !apiBase) {
    return {
      canSync: false,
      localCount,
      remoteCount: 0,
      lastSyncAt: state.lastSyncAt || 0,
    };
  }

  const deviceId = await getDeviceId();
  try {
    const resp = await fetch(
      `${apiBase.replace(/\/$/, '')}/api/sync/status?device_id=${encodeURIComponent(deviceId)}`,
      { headers: { Authorization: `Bearer ${session.token}` } },
    );
    if (!resp.ok) {
      return { canSync: true, localCount, remoteCount: 0, lastSyncAt: state.lastSyncAt || 0, error: `status ${resp.status}` };
    }
    const data = await resp.json();
    return {
      canSync: true,
      localCount,
      remoteCount: data.remote_count || 0,
      latestServerTs: data.latest_server_ts || 0,
      lastSyncAt: (data.cursor?.last_sync_at) || state.lastSyncAt || 0,
    };
  } catch (e) {
    return { canSync: true, localCount, remoteCount: 0, lastSyncAt: state.lastSyncAt || 0, error: e.message };
  }
}

// 重置云端数据
export async function resetRemote() {
  const session = await getSession();
  const apiBase = await getApiBase();
  if (!session || !apiBase) throw new Error('未登录或未配置后端地址');
  const resp = await fetch(`${apiBase.replace(/\/$/, '')}/api/sync/reset`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error || `重置失败 ${resp.status}`);
  }
  // 同时重置本地同步游标
  await setSyncState({ lastSyncedLocalId: 0, lastPullServerTs: 0 });
  return { ok: true };
}

// 重置本地同步游标（清空本地数据后调用，让下次全量同步）
export async function resetLocalCursor() {
  await setSyncState({ lastSyncedLocalId: 0, lastPullServerTs: 0 });
}

// 读取自动同步开关
export async function getAutoSyncEnabled() {
  const { ttw_sync_config: cfg } = await chrome.storage.local.get('ttw_sync_config');
  return cfg ? cfg.autoSync !== false : false;
}

export async function setAutoSyncEnabled(enabled) {
  const { ttw_sync_config: cfg } = await chrome.storage.local.get('ttw_sync_config');
  await chrome.storage.local.set({ ttw_sync_config: { ...(cfg || {}), autoSync: !!enabled } });
}
