// parse.js 纯解析逻辑测试 — extractUsage / 时间反推 / 批量解析
// parse.js 是 MAIN world 经典脚本（不 export），用 vm 在 fake window 沙箱中加载，读取 window.__ttwParse。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'content', 'parse.js'), 'utf8');

// 每次调用返回全新的 __ttwParse（沙箱独立，注入状态互不污染）
function loadParse() {
  const window = {};
  const sandbox = { window, Date, console };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return window.__ttwParse;
}

// ---------- extractUsage ----------
test('extractUsage: TRAE get_session_usage 结构（extra_info + 单数字段）', () => {
  const { extractUsage } = loadParse();
  const usage = extractUsage({
    user_usage_group_by_session: {
      session_id: 'abcd1234abcd1234',
      model_name: 'DeepSeek-V3',
      credits_float: 1.5,
      cost_money_float: 0.01,
      user_input_preview: '帮我写个函数',
      extra_info: { input_token: 100, output_token: 50, cache_read_token: 20, cache_write_token: 5 },
    },
  });
  assert.ok(usage);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 50);
  assert.equal(usage.cachedTokens, 20);
  assert.equal(usage.cacheWriteTokens, 5);
  assert.equal(usage.totalTokens, 175); // 100+50+20+5
  assert.equal(usage.model, 'DeepSeek-V3');
  assert.equal(usage.conversationId, 'abcd1234abcd1234');
  assert.equal(usage.credits, 1.5);
  assert.equal(usage.userInputPreview, '帮我写个函数');
});

test('extractUsage: 标准 OpenAI usage 结构', () => {
  const { extractUsage } = loadParse();
  const usage = extractUsage({
    model: 'gpt-4o',
    usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
  });
  assert.ok(usage);
  assert.equal(usage.inputTokens, 30);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.totalTokens, 50);
  assert.equal(usage.model, 'gpt-4o');
});

test('extractUsage: 全零用量返回 null（无效数据被过滤）', () => {
  const { extractUsage } = loadParse();
  assert.equal(extractUsage({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), null);
  assert.equal(extractUsage({}), null);
  assert.equal(extractUsage(null), null);
});

test('extractUsage: total < max(input,output) 视为无效（validateUsage）', () => {
  const { extractUsage } = loadParse();
  // total(10) < output(50) → 非法
  assert.equal(extractUsage({ usage: { prompt_tokens: 5, completion_tokens: 50, total_tokens: 10 } }), null);
});

// ---------- 时间反推 ----------
test('deriveTimeFromSessionId: snowflake 前缀（前 8 位 hex=秒）→ 毫秒', () => {
  const p = loadParse();
  // 0x6a34972e = 1781831470（秒）
  const ms = p.deriveTimeFromSessionId('6a34972e<rest-of-id>');
  assert.equal(ms, 1781831470 * 1000);
});

test('deriveTimeFromSessionId: 非 snowflake / 越界 / 过短返回 null', () => {
  const p = loadParse();
  assert.equal(p.deriveTimeFromSessionId('zzzz'), null);          // 非 hex
  assert.equal(p.deriveTimeFromSessionId('123'), null);            // <8 位
  assert.equal(p.deriveTimeFromSessionId('00000000hello'), null);  // 越下界（<2020）
  assert.equal(p.deriveTimeFromSessionId('77359401hello'), null);  // 越上界（>2033）
});

test('deriveTimeFromSessionId: setSfTrusted(false) 后禁用反推', () => {
  const p = loadParse();
  p.setSfTrusted(() => false);
  assert.equal(p.deriveTimeFromSessionId('6a34972e<rest-of-id>'), null);
});

test('normalizeTimeVal: 秒/毫秒/10位/13位字符串互转', () => {
  const { normalizeTimeVal } = loadParse();
  assert.equal(normalizeTimeVal(1781831470), 1781831470 * 1000);     // 秒
  assert.equal(normalizeTimeVal(1781831470000), 1781831470000);      // 毫秒
  assert.equal(normalizeTimeVal('1781831470'), 1781831470 * 1000);   // 10位字符串
  assert.equal(normalizeTimeVal('1781831470000'), 1781831470000);    // 13位字符串
  assert.equal(normalizeTimeVal('2026-06-18T10:00:00Z'), Date.parse('2026-06-18T10:00:00Z'));
  assert.equal(normalizeTimeVal(123), null);                         // 太小，非时间
  assert.equal(normalizeTimeVal(1e18), null);                        // 纳秒，非时间
});

test('extractSessionTime: 取优先级最高的时间字段', () => {
  const { extractSessionTime } = loadParse();
  const createdAt = Date.parse('2026-06-10T00:00:00Z');
  const usageTime = createdAt + 1000; // usage_time 优先级(110) > create_time(90)
  const obj = {
    create_time: createdAt / 1000, // 秒
    usage_time: usageTime / 1000,
  };
  assert.equal(extractSessionTime(obj), usageTime);
});

// ---------- 批量解析 ----------
test('extractBulkArray: data.user_usage_group_by_sessions 数组 + total', () => {
  const { extractBulkArray } = loadParse();
  const res = extractBulkArray({
    data: {
      total: 2,
      user_usage_group_by_sessions: [{ session_id: 'a' }, { session_id: 'b' }],
    },
  });
  assert.ok(res);
  assert.equal(res.total, 2);
  assert.equal(res.items.length, 2);
});

test('extractBulkArray: 无数组 / 空数组返回 null', () => {
  const { extractBulkArray } = loadParse();
  assert.equal(extractBulkArray({ data: {} }), null);
  assert.equal(extractBulkArray({ data: { user_usage_group_by_sessions: [] } }), null);
  assert.equal(extractBulkArray(null), null);
});

test('parseSSE: 标准 data 块 + 跳过 [DONE]', () => {
  const { parseSSE } = loadParse();
  const sse = [
    'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
    'data: [DONE]',
  ].join('\n\n');
  const usage = parseSSE(sse);
  assert.ok(usage);
  assert.equal(usage.totalTokens, 15);
});

test('parseSSE: 命名事件（meta 补 model，usage 块在后）', () => {
  const { parseSSE } = loadParse();
  const sse = [
    'event: meta\ndata: {"model":"DeepSeek-V3","conversation_id":"abc123"}',
    'event: usage\ndata: {"usage":{"prompt_tokens":20,"completion_tokens":10,"total_tokens":30}}',
  ].join('\n\n');
  const usage = parseSSE(sse);
  assert.ok(usage);
  assert.equal(usage.totalTokens, 30);
  assert.equal(usage.model, 'DeepSeek-V3');      // 从 meta 累积
  assert.equal(usage.conversationId, 'abc123');  // 从 meta 累积
});

test('parseSSE: 无有效 data 返回 null', () => {
  const { parseSSE } = loadParse();
  assert.equal(parseSSE('data: [DONE]'), null);
  assert.equal(parseSSE(''), null);
});