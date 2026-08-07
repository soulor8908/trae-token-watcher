import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleSyncPush, handleSyncPull, handleSyncStatus, handleSyncReset } from '../src/sync.js';

// Mock D1：链式 prepare().bind().run/all/first + batch
function mockDb({ batchResults, firstResult, allResults } = {}) {
  const chain = {
    bind() { return chain; }, // 链式：忽略参数，返回自身
    async run() { return { meta: { changes: 1 } }; },
    async all() { return { results: allResults || [] }; },
    async first() { return firstResult || null; },
  };
  return {
    prepare() { return chain; },
    async batch(stmts) {
      return batchResults || stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

function mockRequest({ url = 'https://x/api/sync/push', body } = {}) {
  return {
    url,
    json: async () => body,
  };
}

const session = { user_id: 42, login: 'tester', avatar_url: '' };
const env = { DB: mockDb(), KV: { get: async () => null, put: async () => {} } };

test('handleSyncPush: 空数组返回 0', async () => {
  const req = mockRequest({ body: { device_id: 'd1', records: [] } });
  const resp = await handleSyncPush(req, env, session);
  const data = await resp.json();
  assert.equal(data.pushed, 0);
  assert.equal(data.skipped, 0);
});

test('handleSyncPush: 缺少 records 抛 400', async () => {
  const req = mockRequest({ body: { device_id: 'd1' } });
  await assert.rejects(() => handleSyncPush(req, env, session), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test('handleSyncPush: 批量插入返回 pushed 数量', async () => {
  const records = [
    { client_id: 'c1', ts: 1000, model: 'm', input_tokens: 10 },
    { client_id: 'c2', ts: 2000, model: 'm', input_tokens: 20 },
  ];
  const req = mockRequest({ body: { device_id: 'd1', records } });
  const resp = await handleSyncPush(req, env, session);
  const data = await resp.json();
  assert.equal(data.pushed, 2);
  assert.equal(data.skipped, 0);
  assert.equal(data.total, 2);
});

test('handleSyncPush: 缺 client_id 抛 400', async () => {
  const req = mockRequest({ body: { device_id: 'd1', records: [{ ts: 1 }] } });
  await assert.rejects(() => handleSyncPush(req, env, session), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /client_id/);
    return true;
  });
});

test('handleSyncPush: 未登录抛 401', async () => {
  const req = mockRequest({ body: { records: [] } });
  await assert.rejects(() => handleSyncPush(req, env, null), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
});

test('handleSyncPull: 空结果返回 latest_server_ts = since', async () => {
  const envEmpty = { DB: mockDb({ allResults: [] }), KV: env.KV };
  const req = mockRequest({ url: 'https://x/api/sync/pull?since=100' });
  const resp = await handleSyncPull(req, envEmpty, session);
  const data = await resp.json();
  assert.equal(data.records.length, 0);
  assert.equal(data.latest_server_ts, 100);
  assert.equal(data.has_more, false);
});

test('handleSyncPull: 有记录返回字段映射为 camelCase', async () => {
  const row = {
    client_id: 'c1', ts: 1000, model: 'doubao', conversation_id: 'conv1',
    input_tokens: 10, output_tokens: 20, cached_tokens: 5, cache_write_tokens: 2,
    total_tokens: 30, credits: 1.5, cost_money: 0.03, remaining: 1000,
    source: 'fetch', url: 'https://x', user_input_preview: 'hi', device_id: 'd1',
    server_created_at: 500,
  };
  const envRow = { DB: mockDb({ allResults: [row] }), KV: env.KV };
  const req = mockRequest({ url: 'https://x/api/sync/pull?since=0' });
  const resp = await handleSyncPull(req, envRow, session);
  const data = await resp.json();
  assert.equal(data.records.length, 1);
  const r = data.records[0];
  assert.equal(r.clientId, 'c1');
  assert.equal(r.conversationId, 'conv1');
  assert.equal(r.inputTokens, 10);
  assert.equal(r.server_created_at, 500);
  assert.equal(data.latest_server_ts, 500);
});

test('handleSyncStatus: 返回 count 和 cursor', async () => {
  const envStatus = {
    DB: mockDb({
      firstResult: { n: 5, latest: 999 },
    }),
    KV: env.KV,
  };
  const req = mockRequest({ url: 'https://x/api/sync/status?device_id=d1' });
  const resp = await handleSyncStatus(req, envStatus, session);
  const data = await resp.json();
  assert.equal(data.remote_count, 5);
  assert.equal(data.latest_server_ts, 999);
  // firstResult 也用于 cursor 查询，返回同一个对象
  assert.equal(data.cursor.n, 5); // mock 复用 firstResult
});

test('handleSyncReset: 删除并返回 ok', async () => {
  const resp = await handleSyncReset(mockRequest(), env, session);
  const data = await resp.json();
  assert.equal(data.ok, true);
});

test('handleSyncReset: 未登录抛 401', async () => {
  await assert.rejects(() => handleSyncReset(mockRequest(), env, null), (err) => {
    assert.equal(err.status, 401);
    return true;
  });
});
