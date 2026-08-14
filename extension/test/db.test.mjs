// db.js 数据层测试 — 聚合(getSummary) / 去重(addRecord) / 导入(importRecords)
// 用 fake-indexeddb 提供浏览器 IndexedDB 环境，import 真实 db.js 做黑盒验证。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

globalThis.indexedDB = indexedDB;
globalThis.IDBKeyRange = IDBKeyRange;

const db = await import('../lib/db.js');

// 每次测试前清空，保证确定性（clearAllRecords 同时失效聚合缓存）
beforeEach(async () => {
  await db.clearAllRecords();
});

test('addRecord: 同一 conversationId 去重（保留最新一条）', async () => {
  await db.addRecord({ conversationId: 'c1', model: 'm1', inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  await db.addRecord({ conversationId: 'c1', model: 'm1', inputTokens: 100, outputTokens: 50, totalTokens: 150 });
  const all = await db.getRecordsSince(0);
  assert.equal(all.length, 1);                 // 只保留一条
  assert.equal(all[0].totalTokens, 150);       // 保留最新
  const count = await db.countAllRecords();
  assert.equal(count, 1);
});

test('addRecord: 无 conversationId 的实时请求不合并，每条都入库', async () => {
  await db.addRecord({ inputTokens: 1, totalTokens: 1 });
  await db.addRecord({ inputTokens: 2, totalTokens: 2 });
  const all = await db.getRecordsSince(0);
  assert.equal(all.length, 2);
});

test('importRecords: 按 clientId 去重，已存在跳过', async () => {
  const res = await db.importRecords([
    { clientId: 'a', ts: Date.now(), model: 'm1', totalTokens: 10 },
    { clientId: 'a', ts: Date.now(), model: 'm1', totalTokens: 20 }, // 重复 clientId → skip
    { clientId: 'b', ts: Date.now(), model: 'm2', totalTokens: 30 },
  ]);
  assert.equal(res.imported, 2);
  assert.equal(res.skipped, 1);
  const all = await db.getRecordsSince(0);
  assert.equal(all.length, 2);
});

test('importRecords: 兼容 snake_case 字段（服务端同步数据）', async () => {
  await db.importRecords([
    { client_id: 'x', ts: Date.now(), model: 'm1', input_tokens: 40, output_tokens: 20, total_tokens: 60 },
  ]);
  const all = await db.getRecordsSince(0);
  assert.equal(all.length, 1);
  assert.equal(all[0].inputTokens, 40);   // 被映射为 camelCase
  assert.equal(all[0].totalTokens, 60);
});

test('getSummary: 桶聚合 + 按模型/会话统计 + totalRecords', async () => {
  const now = Date.now();
  await db.addRecord({ conversationId: 'c1', model: 'DeepSeek-V3', inputTokens: 100, outputTokens: 50, totalTokens: 150, credits: 1.5 });
  await db.addRecord({ conversationId: 'c2', model: 'DeepSeek-V3', inputTokens: 200, outputTokens: 100, totalTokens: 300, credits: 3 });
  await db.addRecord({ conversationId: 'c3', model: 'Claude-3.5', inputTokens: 10, outputTokens: 5, totalTokens: 15, credits: 0.1 });

  const s = await db.getSummary();
  assert.equal(s.totalRecords, 3);
  // 三条都在「今日」时间窗口内
  assert.equal(s.buckets.today.count, 3);
  assert.equal(s.buckets.today.input, 310);
  assert.equal(s.buckets.today.output, 155);
  assert.equal(s.buckets.today.total, 465);
  assert.equal(s.buckets.today.credits, 4.6);

  // 按模型：DeepSeek 两条
  const ds = s.byModel.find((m) => m.model === 'DeepSeek-V3');
  assert.ok(ds);
  assert.equal(ds.count, 2);
  assert.equal(ds.total, 450);

  // 按会话
  const c1 = s.bySession.find((x) => x.sessionId === 'c1');
  assert.ok(c1);
  assert.equal(c1.total, 150);
});

test('getSummary: 聚合缓存被写入失效（数据变化后重算）', async () => {
  const now = Date.now();
  await db.addRecord({ conversationId: 'c1', model: 'm1', totalTokens: 10 });
  const s1 = await db.getSummary();
  assert.equal(s1.totalRecords, 1);

  await db.addRecord({ conversationId: 'c2', model: 'm1', totalTokens: 20 }); // 触发 invalidateAggregates
  const s2 = await db.getSummary();
  assert.equal(s2.totalRecords, 2);
});

test('getComparison: 返回 daily/weekly/monthly 三组对比', async () => {
  await db.addRecord({ conversationId: 'c1', model: 'm1', totalTokens: 100, credits: 1 });
  const c = await db.getComparison();
  assert.equal(c.ranges.length, 3);
  const kinds = c.ranges.map((r) => r.key);
  assert.deepEqual(kinds, ['daily', 'weekly', 'monthly']);
  for (const r of c.ranges) {
    assert.ok(typeof r.current.tokens === 'number');
    assert.ok('changes' in r);
  }
});

test('getAllRecords: 按真实时间 timestamp 降序（非插入顺序）', async () => {
  // 模拟云端导入：先进旧的记录、后进新的记录（id 顺序与时间无关）
  await db.addRecord({ conversationId: 'old', model: 'm1', totalTokens: 1, timestamp: 1000 });
  await db.addRecord({ conversationId: 'mid', model: 'm1', totalTokens: 2, timestamp: 500 });
  await db.addRecord({ conversationId: 'new', model: 'm1', totalTokens: 3, timestamp: 2000 });
  const all = await db.getAllRecords(20);
  assert.deepEqual(all.map((r) => r.conversationId), ['new', 'old', 'mid']); // timestamp 降序
});