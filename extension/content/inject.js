// MAIN WORLD 注入脚本 v9 — 主动批量拉取 + 真实用量时间（参考 docs/trae-token-viewer.user.js）
//
// === v7 改进（根因修复）===
// v6 问题：真正的 token 数据在 get_session_usage 接口响应体里，但未采集到：
//   - 字段名 input_token/output_token（少 's'），v6 只认 input_tokens
//   - 字段路径 user_usage_group_by_session.extra_info，不在标准 usage 对象
//   - model 字段是 model_name，v6 只认 model
//   - session_id 在 user_usage_group_by_session 顶层
// v7 修复：
//   - 专门适配 get_session_usage 响应结构
//   - parseUsageFields 增加 input_token/output_token/cache_read_token/cache_write_token
//   - extractUsage 优先检查 user_usage_group_by_session.extra_info 路径
//   - MODEL_KEYS 增加 model_name
//   - 增加积分/费用字段：credits/cost_money/amount
//   - 增加用户提问预览：user_input_preview
//
// === v8 改进（真实会话时间）===
// 问题：查看历史会话抓到的 get_session_usage 是历史真实用量，但其响应里没有时间字段
//       （usage_time 恒为 0），旧逻辑把"采集时刻 Date.now()"当成对话时间 —— 错。
// 修复：真实对话时间在 chat_sessions 列表/详情响应的 created_at（毫秒时间戳）。
//       usage 的 session_id 与 chat_sessions 的 chat_session_id 同源（ID 前 8 位 = created_at/1000 十六进制），
//       建一张 sessionId→createdAt 映射优先用它；映射未命中时改用 session_id 前缀(snowflake)反推 created_at，
//       详情拉取仅作异步元数据补充，确保历史会话一定归到真实发生时间而非采集时刻。
//       这样历史会话会被归到它真实发生的那天，"今日用量"也不会被历史查看虚增。
//
// === v9 改进（主动批量拉取 + 真实用量时间）===
// 参考 docs/trae-token-viewer.user.js 拦截的「用量明细」批量接口 query_user_usage_group_by_session：
//   - 该接口一次返回全部会话用量（user_usage_group_by_sessions[]），每条自带真实 usage_time（秒）、
//     extra_info（input/output/cache_read/cache_write token）、credits_float、cost_money_float、
//     model_name、user_input_preview、session_id、usage_source —— 比逐会话 get_session_usage 更完整。
//   - 用户一进 work.trae.cn（顶层 frame），默认主动拉取最近 30 天的用量并写入账本，
//     无需手动翻看每个会话；数据自带 usage_time，时间归因直接用真实发生时刻，不再依赖 snowflake 反推。
//   - 被动拦截保留：页面自然触发该接口时也捕获，并记住成功 path 供后续复用（localStorage）。
(function () {
  'use strict';

  const TAG = '[trae-token-watcher]';
  const DEBUG_KEY = '__ttw_debug__';

  let DEBUG = false;
  try { DEBUG = localStorage.getItem(DEBUG_KEY) === '1'; } catch (_) {}

  const debugLog = [];
  const sampledUrls = new Map(); // URL → 已采样次数
  const SAMPLE_LIMIT = 2;
  // 会话真实时间缓存：chat_sessions 列表/详情响应 → { createdAt, updatedAt, title, mode }
  // key 为 chat_session_id（与 usage 的 session_id 同源）
  const sessionInfoMap = new Map();
  const pendingSessionFetches = new Map(); // 并发去重的详情拉取
  const SESSION_MAP_MAX = 400;

  function pushDebug(entry) {
    if (!DEBUG) return;
    // 对已知噪音 URL 采样（只记前 2 条）
    if (entry.url && /super_completion_query|completion_query/i.test(entry.url)) {
      const count = sampledUrls.get(entry.url) || 0;
      if (count >= SAMPLE_LIMIT) return;
      sampledUrls.set(entry.url, count + 1);
    }
    debugLog.push({ t: Date.now(), ...entry });
    if (debugLog.length > 300) debugLog.shift();
  }
  try { Object.defineProperty(window, '__ttw_debug_log', { get: () => debugLog, configurable: true }); } catch (_) {}

  function log(...args) {
    if (DEBUG) console.log(TAG, ...args);
  }

  // ---------- URL 匹配 ----------
  function getPath(url) {
    try { return new URL(url, location.href).pathname; } catch (_) { return url || ''; }
  }
  function getHost(url) {
    try { return new URL(url, location.href).host; } catch (_) { return ''; }
  }

  // 对话/补全/流式路径
  const CHAT_PATH_PATTERN = /\/(chat\/completion|completion|conversation|stream|invoke|messages?|chat_sessions|events|super_chat|super_dialog|dialog|chat_query)\b/i;
  // 额度/用量路径
  const QUOTA_PATH_PATTERN = /\/(quota|consume|usage|credit|balance|billing|ent_usage|pay_status|token_usage)\b/i;
  // 已知 LLM / TRAE API 域名
  const LLM_DOMAIN_PATTERN = /(ark\.cn|volces\.com|doubao|bytedance|mchost\.guru|trae-api)/i;
  const TRAE_DOMAIN_PATTERN = /(trae\.cn|mchost\.guru)$/i;
  const STATIC_PATTERN = /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i;
  const EXCLUDE_PATH = /\/(user|profile|config|setting|notification|heartbeat|ping|health|locale|i18n|theme|login|logout|register|captcha|avatar|menu|sidebar|footer|header|diffview|explorer|preview|abtest|access_key|frontier)\b/i;

  function isChatUrl(url) {
    const path = getPath(url);
    return CHAT_PATH_PATTERN.test(path) || LLM_DOMAIN_PATTERN.test(url);
  }
  function isQuotaUrl(url) {
    return QUOTA_PATH_PATTERN.test(getPath(url));
  }
  function shouldIntercept(url) {
    if (!url) return false;
    if (STATIC_PATTERN.test(url)) return false;
    if (EXCLUDE_PATH.test(getPath(url))) return false;
    return isChatUrl(url) || isQuotaUrl(url);
  }
  // EventSource / WebSocket 兜底：扩大到所有 TRAE/LLM 相关域名
  function shouldInterceptStream(url) {
    if (!url) return false;
    return /trae\.cn|volces\.com|ark\.cn|doubao|bytedance|mchost\.guru|trae-api/i.test(url) || shouldIntercept(url);
  }

  function extractConvIdFromUrl(url) {
    const m = getPath(url).match(/\/chat_sessions\/([^/?]+)/i);
    return m ? m[1] : null;
  }

  function postUsage(data) {
    try {
      window.postMessage({ source: 'trae-token-watcher-inject', type: 'usage', payload: data }, '*');
    } catch (_) {}
  }

  // ---------- 请求上下文缓存 ----------
  const ctxCache = new Map();
  const CTX_TTL = 60000;

  function cacheContext(conversationId, meta) {
    if (!conversationId) return;
    ctxCache.set(conversationId, {
      model: meta.model || null,
      agentType: meta.agentType || null,
      ts: Date.now(),
    });
    if (ctxCache.size > 50) {
      const now = Date.now();
      for (const [k, v] of ctxCache) {
        if (now - v.ts > CTX_TTL) ctxCache.delete(k);
      }
    }
  }
  function lookupContext(conversationId) {
    if (!conversationId) return null;
    const ctx = ctxCache.get(conversationId);
    if (!ctx) return null;
    if (Date.now() - ctx.ts > CTX_TTL) {
      ctxCache.delete(conversationId);
      return null;
    }
    return ctx;
  }

  // ---------- 响应头提取 ----------
  const HEADER_KEY_RE = /^x-(token|usage|credit|quota|consume|prompt|completion|total|cached|model|session|agent)/i;

  function extractFromHeaders(headers) {
    if (!headers) return null;
    const collected = {};
    try {
      for (const [key, val] of headers.entries()) {
        const lk = key.toLowerCase();
        if (HEADER_KEY_RE.test(lk)) collected[lk] = val;
      }
    } catch (_) {}
    if (Object.keys(collected).length === 0) return null;
    log('token 相关响应头:', collected);
    return parseHeaderMap(collected);
  }

  function extractFromXHRHeaders(xhr) {
    const collected = {};
    try {
      const all = xhr.getAllResponseHeaders();
      for (const line of all.split('\n')) {
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        if (HEADER_KEY_RE.test(key)) collected[key] = val;
      }
    } catch (_) {}
    if (Object.keys(collected).length === 0) return null;
    log('XHR token 相关响应头:', collected);
    return parseHeaderMap(collected);
  }

  function parseHeaderMap(map) {
    for (const k of ['x-token-usage', 'x-usage']) {
      if (map[k]) {
        try {
          const parsed = JSON.parse(map[k]);
          const fromJson = parseUsageFields(parsed);
          if (fromJson) return { ...fromJson, _source: 'header-json', _model: map['x-model'], _agent: map['x-agent-type'], _session: map['x-session-id'] };
        } catch (_) {}
      }
    }
    const input = pickHeaderNum(map, ['x-token-input', 'x-usage-input', 'x-consume-input', 'x-prompt-tokens']);
    const output = pickHeaderNum(map, ['x-token-output', 'x-usage-output', 'x-consume-output', 'x-completion-tokens']);
    const total = pickHeaderNum(map, ['x-token-total', 'x-usage-total', 'x-total-tokens', 'x-token-used', 'x-consume-tokens']);
    const cached = pickHeaderNum(map, ['x-token-cached']);
    const remaining = pickHeaderNum(map, ['x-token-remaining', 'x-credit-remaining', 'x-quota-remaining', 'x-credit-balance']);
    if (input == null && output == null && total == null) return null;
    const usage = {
      inputTokens: input || 0, outputTokens: output || 0, cachedTokens: cached || 0,
      totalTokens: total || (input || 0) + (output || 0),
      _source: 'header', _model: map['x-model'] || null, _agent: map['x-agent-type'] || null, _session: map['x-session-id'] || null,
    };
    if (remaining != null) usage.remaining = remaining;
    return validateUsage(usage);
  }

  function pickHeaderNum(map, keys) {
    for (const k of keys) {
      if (map[k] != null) {
        const n = parseInt(map[k], 10);
        if (!isNaN(n) && n >= 0) return n;
      }
    }
    return null;
  }

  // ---------- 响应体提取 ----------
  // model 字段候选（TRAE 用 model_name）
  const MODEL_KEYS = ['model', 'model_name', 'modelName', 'model_id', 'modelId', 'agent_type', 'agentType', 'agent'];
  const CONV_KEYS = ['conversation_id', 'conversationId', 'chat_id', 'chatId', 'chat_session_id', 'chatSessionId', 'session_id', 'sessionId', 'turn_id', 'turnId', 'id'];

  function extractUsage(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // === TRAE 专用：get_session_usage 结构 ===
    // 路径: user_usage_group_by_session.{extra_info, model_name, session_id, credits_float, ...}
    const traeGroup = obj.user_usage_group_by_session;
    if (traeGroup && typeof traeGroup === 'object') {
      const extra = traeGroup.extra_info || {};
      const input = pickNum(extra, ['input_token', 'input_tokens', 'prompt_tokens']);
      const output = pickNum(extra, ['output_token', 'output_tokens', 'completion_tokens']);
      const cacheRead = pickNum(extra, ['cache_read_token', 'cache_read_tokens', 'prompt_cache_hit_tokens']);
      const cacheWrite = pickNum(extra, ['cache_write_token', 'cache_write_tokens']);
      if (input != null || output != null) {
        const total = (input || 0) + (output || 0) + (cacheRead || 0) + (cacheWrite || 0);
        const usage = validateUsage({
          inputTokens: input || 0,
          outputTokens: output || 0,
          cachedTokens: cacheRead || 0,
          cacheWriteTokens: cacheWrite || 0,
          totalTokens: total,
        });
        if (usage) {
          return {
            ...usage,
            model: pickStr(traeGroup, MODEL_KEYS) || pickStr(obj, MODEL_KEYS),
            conversationId: pickStr(traeGroup, ['session_id', 'sessionId']) || pickStr(obj, CONV_KEYS),
            credits: pickNum(traeGroup, ['credits_float', 'credits']),
            costMoney: pickNum(traeGroup, ['cost_money_float', 'cost_money']),
            amount: pickNum(traeGroup, ['amount_float', 'amount']),
            userInputPreview: pickStr(traeGroup, ['user_input_preview']),
            sessionTime: extractSessionTime(traeGroup) || extractSessionTime(obj),
          };
        }
      }
    }

    // === 标准 OpenAI 结构 ===
    const usage = findKey(obj, ['usage', 'token_usage', 'tokenUsage', 'tokenInfo', 'token_info'], 0);
    if (usage) {
      const result = parseUsageFields(usage);
      if (result) return enrich(obj, result);
    }
    const direct = parseUsageFields(obj);
    if (direct) return enrich(obj, direct);
    return null;
  }

  function findKey(obj, keys, depth) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    for (const k of keys) {
      if (obj[k] != null) return obj[k];
    }
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const found = findKey(v, keys, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function parseUsageFields(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // 兼容单数/复数两种字段名（TRAE 用单数 input_token，OpenAI 用复数 prompt_tokens）
    const input = pickNum(obj, ['prompt_tokens', 'input_tokens', 'input_token', 'inputTokens', 'promptTokens']);
    const output = pickNum(obj, ['completion_tokens', 'output_tokens', 'output_token', 'outputTokens', 'completionTokens']);
    const total = pickNum(obj, ['total_tokens', 'totalTokens', 'total_token']);
    const cached = pickNum(obj, [
      'prompt_cache_hit_tokens', 'promptCacheHitTokens',
      'cached_tokens', 'cachedTokens', 'cache_hit_tokens', 'cacheHitTokens',
      'cache_read_token', 'cache_read_tokens',
    ]);
    const cacheWrite = pickNum(obj, ['cache_write_token', 'cache_write_tokens']);
    if (input == null && output == null && total == null) return null;
    const result = {
      inputTokens: input || 0, outputTokens: output || 0, cachedTokens: cached || 0,
      totalTokens: total || (input || 0) + (output || 0) + (cached || 0) + (cacheWrite || 0),
    };
    if (cacheWrite != null && cacheWrite > 0) result.cacheWriteTokens = cacheWrite;
    return validateUsage(result);
  }

  function validateUsage(usage) {
    const { inputTokens, outputTokens, totalTokens } = usage;
    if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) return null;
    const maxIO = Math.max(inputTokens, outputTokens);
    if (totalTokens < maxIO) return null;
    return usage;
  }

  function enrich(obj, usage) {
    return {
      ...usage,
      model: pickStr(obj, MODEL_KEYS),
      conversationId: pickStr(obj, CONV_KEYS),
      sessionTime: extractSessionTime(obj),
    };
  }

  function pickNum(obj, keys) {
    for (const k of keys) {
      if (typeof obj[k] === 'number' && obj[k] >= 0) return obj[k];
      if (typeof obj[k] === 'string' && obj[k] !== '') {
        const n = parseInt(obj[k], 10);
        if (!isNaN(n) && n >= 0) return n;
      }
    }
    return null;
  }

  function pickStr(obj, keys) {
    for (const k of keys) {
      if (typeof obj[k] === 'string' && obj[k].trim() !== '') return obj[k].trim();
    }
    return null;
  }

  // ---------- 会话时间提取 ----------
  // 历史会话被查看时，抓到的 get_session_usage 数据是历史真实用量，
  // 其实际发生时间应取自响应里的会话时间字段，而非采集时刻（Date.now）。
  // 这里健壮地递归扫描常见时间字段，归一化为毫秒时间戳。
  const SESSION_TIME_KEYS = {
    usage_time: 110, usageTime: 110, // 「用量明细」批量接口自带权威时间戳（秒），优先级最高
    session_time: 100, sessionTime: 100, sessiontimestamp: 100, session_timestamp: 100,
    conv_time: 95, convTime: 95, conversation_time: 95, conversationTime: 95,
    create_time: 90, createTime: 90, created_at: 90, createdAt: 90, create_at: 90,
    chat_time: 80, chatTime: 80, msg_time: 80, msgTime: 80,
    gen_time: 70, genTime: 70,
    update_time: 60, updateTime: 60, updated_at: 60, updatedAt: 60,
    time: 40, timestamp: 40, date: 40, datetime: 40, send_time: 40, sendTime: 40,
  };
  const SESSION_TIME_MIN = Date.parse('2020-01-01');
  const SESSION_TIME_MAX_FUTURE = 86400000; // 允许未来 1 天（时钟误差）

  function normalizeTimeVal(v) {
    if (typeof v === 'number') {
      if (v > 1e17) return null;            // 纳秒，非时间
      if (v >= 1e12) return Math.floor(v);  // 毫秒
      if (v >= 1e9 && v < 1e12) return Math.floor(v * 1000); // 秒
      return null;                          // 太小，非时间
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^\d{10}$/.test(s)) return parseInt(s, 10) * 1000;
      if (/^\d{13}$/.test(s)) return parseInt(s, 10);
      const t = Date.parse(s);
      if (!isNaN(t)) return t;
    }
    return null;
  }

  function extractSessionTime(obj) {
    if (!obj || typeof obj !== 'object') return null;
    let best = null; // { ms, score }
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 4) return;
      for (const [k, v] of Object.entries(node)) {
        const lk = k.toLowerCase();
        let matched = null;
        for (const cand in SESSION_TIME_KEYS) {
          const lc = cand.toLowerCase();
          if (lk === lc || lk.endsWith(lc)) { matched = cand; break; }
        }
        if (matched) {
          const ms = normalizeTimeVal(v);
          const now = Date.now();
          if (ms != null && ms >= SESSION_TIME_MIN && ms <= now + SESSION_TIME_MAX_FUTURE) {
            const score = SESSION_TIME_KEYS[matched];
            if (!best || score > best.score) best = { ms, score };
          }
        } else if (v && typeof v === 'object' && depth < 3) {
          walk(v, depth + 1);
        }
      }
    };
    walk(obj, 0);
    return best ? best.ms : null;
  }

  // ---------- 会话真实时间（chat_sessions.created_at）----------
  // 历史会话被查看时，get_session_usage 只知道 session_id，没有时间；
  // 真正的对话时间在 chat_sessions 列表/详情响应的 created_at 字段（毫秒时间戳字符串）。
  // 这里建一张 sessionId → createdAt 的映射，记录用量时优先用它当 timestamp。
  function normalizeTimeStr(v) {
    if (v == null) return null;
    if (typeof v === 'number') return normalizeTimeVal(v);
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^\d+$/.test(s)) return parseInt(s, 10); // 纯数字 → 毫秒时间戳
      const t = Date.parse(s);
      return isNaN(t) ? null : t;
    }
    return null;
  }

  function captureSessions(text, url) {
    if (!text || !/chat_session_id/.test(text)) return;
    if (!(url && /\/chat_sessions\b/i.test(getPath(url)))) return; // 只在会话列表/详情响应里解析
    let json;
    try { json = JSON.parse(text); } catch (_) { return; }
    const data = json && json.data;
    const items = Array.isArray(data?.items)
      ? data.items
      : (data && data.chat_session_id ? [data] : null);
    if (!items || items.length === 0) return;
    for (const it of items) {
      const id = it?.chat_session_id || it?.session_id;
      if (!id) continue;
      const createdAt = normalizeTimeStr(it.created_at);
      if (!createdAt) continue;
      sessionInfoMap.set(id, {
        createdAt,
        updatedAt: normalizeTimeStr(it.updated_at),
        title: typeof it.title === 'string' ? it.title : null,
        mode: typeof it.mode === 'string' ? it.mode : null,
      });
    }
    if (sessionInfoMap.size > SESSION_MAP_MAX) {
      const keys = [...sessionInfoMap.keys()].slice(0, sessionInfoMap.size - SESSION_MAP_MAX);
      for (const k of keys) sessionInfoMap.delete(k);
    }
    pushDebug({ type: 'sessions-captured', count: sessionInfoMap.size });
  }

  // 从 session_id 反推 created_at：Trae 的 session_id 是 snowflake ID，
  // 前 8 位十六进制 = 创建时间（秒）。已用真实样本验证：chat_session_id 前 8 位
  // 十六进制 == chat_sessions.created_at/1000（如 6a34972e == 1781831470 == 1781831470369/1000）。
  // 这是零网络开销、100% 可靠的兜底，覆盖「会话不在已捕获列表里」的情形。
  function deriveTimeFromSessionId(id) {
    if (typeof id !== 'string' || id.length < 8) return null;
    const hex = id.slice(0, 8).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(hex)) return null;
    const secs = parseInt(hex, 16);
    // 合理区间：2020-01-01 ~ 2033 年（秒）。超出视为非 snowflake，放弃反推。
    if (!secs || secs < 1577836800 || secs > 2000000000) return null;
    return secs * 1000;
  }

  // 异步补充：拉会话详情，拿到权威 created_at + title/mode（仅用于后续记录与元数据，不阻塞本次记录）
  function refillSession(conversationId) {
    if (!conversationId || pendingSessionFetches.has(conversationId)) return;
    const p = (async () => {
      try {
        const r = await fetch(`/api/remote/v1/chat_sessions/${conversationId}`, {
          headers: { accept: 'application/json' },
        });
        const j = await r.json();
        const item = j && j.data;
        if (item && item.chat_session_id) {
          const createdAt = normalizeTimeStr(item.created_at);
          if (createdAt) {
            sessionInfoMap.set(item.chat_session_id, {
              createdAt,
              updatedAt: normalizeTimeStr(item.updated_at),
              title: typeof item.title === 'string' ? item.title : null,
              mode: typeof item.mode === 'string' ? item.mode : null,
            });
          }
        }
      } catch (_) {}
    })();
    pendingSessionFetches.set(conversationId, p);
    p.finally(() => pendingSessionFetches.delete(conversationId));
  }

// 解析某 session_id 的真实时间：
//   1) 优先命中内存映射（来自 chat_sessions 列表/详情的真实 created_at，最权威）
//   2) 否则用 session_id 反推（snowflake 前缀，零网络开销、100% 可靠兜底）
//   3) 同时异步拉详情补充元数据（不阻塞本次记录）
// 这样历史会话被查看时，记录会归到它真实发生的那天，而不会是采集时刻。
// skipRefill=true（批量数据）：自带权威 usage_time，直接优先使用，不再反推/补拉详情，避免海量冗余请求。
async function resolveSessionTime(conversationId, fallback, skipRefill) {
    if (!conversationId) return fallback || null;
    if (skipRefill) {
      const derived = deriveTimeFromSessionId(conversationId);
      return fallback || derived || null;
    }
    if (sessionInfoMap.has(conversationId)) {
      return sessionInfoMap.get(conversationId).createdAt;
    }
    const derived = deriveTimeFromSessionId(conversationId);
    refillSession(conversationId); // 异步补充更权威的时间 + 元数据，不影响本次
    return derived || fallback || null;
  }

  // ---------- SSE 解析（支持命名事件）----------
  // 支持两种 SSE 格式：
  //   1. 标准：data: {...}\n\n
  //   2. 命名事件：event: meta\ndata: {...}\n\nevent: output\ndata: {...}\n\n
  function parseSSE(text) {
    const blocks = text.split(/\n\n/); // SSE 块以空行分隔
    const dataBlocks = [];
    const eventTypes = []; // 对应每个 data 块的事件类型

    for (const block of blocks) {
      const lines = block.split('\n');
      let eventType = 'message';
      let data = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('event:')) {
          eventType = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
          data += trimmed.slice(5).trim();
        }
      }
      if (data && data !== '[DONE]') {
        dataBlocks.push(data);
        eventTypes.push(eventType);
      }
    }

    if (dataBlocks.length === 0) return null;
    log(`SSE: ${dataBlocks.length} 块, 事件类型: ${[...new Set(eventTypes)].join('/')}`);

    // 1. 从后往前找 usage（通常在 done/end/usage 事件里）
    let usage = null;
    for (let i = dataBlocks.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(dataBlocks[i]);
        usage = extractUsage(obj);
        if (usage) {
          log(`SSE 第 ${i + 1} 块 [${eventTypes[i]}] 含 usage`);
          break;
        }
      } catch (_) {}
    }

    // 2. 累积提取 model（通常在 meta 事件里）
    if (usage) {
      for (let i = 0; i < dataBlocks.length; i++) {
        try {
          const obj = JSON.parse(dataBlocks[i]);
          const m = pickStr(obj, MODEL_KEYS);
          if (m) {
            if (!usage.model) usage.model = m;
            log(`SSE 第 ${i + 1} 块 [${eventTypes[i]}] 含 model: ${m}`);
            break;
          }
        } catch (_) {}
      }
      // 累积提取 conversationId
      for (let i = 0; i < dataBlocks.length; i++) {
        try {
          const obj = JSON.parse(dataBlocks[i]);
          const c = pickStr(obj, CONV_KEYS);
          if (c) {
            if (!usage.conversationId) usage.conversationId = c;
            break;
          }
        } catch (_) {}
      }
    }

    if (usage) return usage;

    // 3. fallback：整体拼接
    try { return extractUsage(JSON.parse(dataBlocks.join(''))); } catch (_) {}
    return null;
  }

  function tryParseBody(text, contentType) {
    if (!text) return null;
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('event-stream') || text.includes('data:')) return parseSSE(text);
    if (ct.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try { return extractUsage(JSON.parse(text)); } catch (_) {}
    }
    return null;
  }

  function extractRequestMeta(body, url) {
    const meta = { model: null, agentType: null, conversationId: null };
    meta.conversationId = extractConvIdFromUrl(url);
    if (!body) return meta;
    try {
      const obj = typeof body === 'string' ? JSON.parse(body) : body;
      meta.model = pickStr(obj, MODEL_KEYS);
      meta.agentType = pickStr(obj, ['agent_type', 'agentType', 'agent']);
      if (!meta.conversationId) meta.conversationId = pickStr(obj, CONV_KEYS);
    } catch (_) {}
    return meta;
  }

  // ---------- 去重 ----------
  // 用 conversationId + source 去重，避免相同会话的重复请求被误杀
  // （get_session_usage 是 POST，相同 URL 不同 body，不能按 URL 去重）
  const seenRequests = new Map();
  const DEDUP_WINDOW = 3000;
  function shouldRecord(conversationId, url, source, disc) {
    // 优先用 conversationId 去重；无 conversationId 时用 url。
    // disc 注入会话时间 + token 总量，使同一历史会话反复查看能被识别为重复（跨 3s 窗口）。
    const key = `${conversationId || url}::${source}::${disc || ''}`;
    const now = Date.now();
    const last = seenRequests.get(key);
    if (last && now - last < DEDUP_WINDOW) return false;
    seenRequests.set(key, now);
    if (seenRequests.size > 200) {
      for (const [k, t] of seenRequests) {
        if (now - t > DEDUP_WINDOW) seenRequests.delete(k);
      }
    }
    return true;
  }

  async function reportUsage(usage, url, source, requestMeta, opts) {
    if (!usage) return;

    let model = usage.model || usage._model || requestMeta?.model || null;
    const agentType = usage._agent || requestMeta?.agentType || null;
    if (!model && agentType) model = agentType;

    let conversationId = usage.conversationId || usage._session || requestMeta?.conversationId || null;

    if (!model && conversationId) {
      const ctx = lookupContext(conversationId);
      if (ctx) model = ctx.model || ctx.agentType;
    }

    // 真实会话时间：优先 chat_sessions.created_at（已落 map），否则回退到响应里扫到的时间，再否则用采集时刻。
    // 注意：get_session_usage 响应里没有时间字段（usage_time 恒为 0），所以 fallback 到这里通常已是 null。
    const realTime = await resolveSessionTime(conversationId, usage.sessionTime || null, opts && opts.skipRefill);
    // 去重 key 注入真实时间 + token 总量，使同一历史会话反复查看被识别为重复（跨 3s 窗口）
    const disc = `${realTime || ''}::${usage.totalTokens || 0}`;

    if (!shouldRecord(conversationId, url, source, disc)) return;

    const now = Date.now();
    const payload = {
      ...usage,
      url, source,
      model, conversationId,
      timestamp: realTime != null ? realTime : now,
      collectedAt: now,
      isHistorical: realTime != null,
    };
    delete payload._source; delete payload._model; delete payload._agent; delete payload._session;

    log('记录 token:', payload);
    pushDebug({ type: 'usage-recorded', source, url, model, inputTokens: payload.inputTokens, outputTokens: payload.outputTokens, totalTokens: payload.totalTokens, conversationId, credits: payload.credits, costMoney: payload.costMoney, realTime, isHistorical: payload.isHistorical });
    postUsage(payload);
  }

  // ---------- 拦截 fetch ----------
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    // 哨兵：批量重放请求（fetchBulkPage 发起）由此进入，直接走最底层 fetch 放行，
    // 不再二次捕获/解析；这样重放会经过页面的鉴权拦截器（注入 authorization），从而通过 401。
    if (args[1] && args[1].__ttw_bulk) {
      return originalFetch.apply(this, args);
    }
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const method = (args[1]?.method || (typeof args[0] === 'object' && args[0]?.method) || 'GET').toUpperCase();
    sniffUsageEndpoint(method, url);
    grabAuthFromHeaders(args[1] && args[1].headers); // 顺手记登录态 token（重放兜底用）
    if (url.indexOf('query_user_usage_group_by_session') >= 0) captureUsageRequestShape(url, args[1]);
    const isApi = shouldIntercept(url);
    const isTreaApi = TRAE_DOMAIN_PATTERN.test(getHost(url)) && /\/api\//i.test(getPath(url));

    let requestMeta = null;
    if ((isApi || isTreaApi) && args[1]?.body) {
      requestMeta = extractRequestMeta(args[1].body, url);
      if (method === 'POST' && /\/messages?\b/i.test(getPath(url))) {
        cacheContext(requestMeta.conversationId, requestMeta);
      }
    } else if (isApi || isTreaApi) {
      requestMeta = { model: null, agentType: null, conversationId: extractConvIdFromUrl(url) };
    }

    const response = await originalFetch.apply(this, args);

    try {
      const ct = response.headers.get('content-type') || '';
      const isSse = ct.includes('event-stream');
      const headerUsage = (isApi || isTreaApi || isSse) ? extractFromHeaders(response.headers) : null;
      if (headerUsage) reportUsage(headerUsage, url, 'fetch-header', requestMeta);

      // 响应体解析 + debug log 记录
      // 条件：对话 URL 或 SSE 响应（兜底）
      if (isApi || isSse) {
        const clone = response.clone();
        clone.text().then((text) => {
          log(`fetch resp: ${method} ${url} | ${text.length} 字符 | ct: ${ct}`);
          pushDebug({ type: 'fetch', method, url, status: response.status, ct, bodyLen: text.length, bodyPreview: text.slice(0, 2000), headerUsage: !!headerUsage });
          const bodyUsage = tryParseBody(text, ct);
          if (bodyUsage) reportUsage(bodyUsage, url, 'fetch-body', requestMeta);
          captureSessions(text, url);
          // 被动捕获「用量明细」批量接口（参考 user.js）：数组形式 user_usage_group_by_sessions
          const bulkArr = tryParseBulk(text, ct);
          if (bulkArr) {
            rememberBulkPath(url);
            reportBulkItems(bulkArr.items, url);
          }
        }).catch(() => {});
      }
    } catch (e) {
      log('fetch 拦截异常:', e);
    }

    return response;
  };

  // ---------- 拦截 XMLHttpRequest ----------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  // 关键：页面用 axios 发请求，鉴权头 authorization: Cloud-IDE-JWT 是经 setRequestHeader 在 open() 之后注入的
  // （对照 docs 里的 XHR 适配器：E.open(...) 后，for 循环 E.setRequestHeader(n, r) 逐头设置）。
  // 所以 token 与用量请求的完整头只能在 setRequestHeader 处抓取——open 时它们还不存在，这是我之前 401 的根因。
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    grabAuthFromHeaders({ [name]: value }); // 顺手记登录态 token（重放兜底用）
    if (!this._ttw_reqHeaders) this._ttw_reqHeaders = {};
    this._ttw_reqHeaders[name] = value; // 累积当前请求的全部头，供用量请求捕获完整形状
    return originalSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ttw_url = url;
    this._ttw_method = method;
    this._ttw_reqHeaders = {};
    sniffUsageEndpoint(method, url);
    // 标记用量请求，但不在 open 时捕获（头尚未注入）；待 send 时头已就绪再捕获完整形状
    this._ttw_isBulk = !!(url && url.indexOf('query_user_usage_group_by_session') >= 0);
    this._ttw_meta = null;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const self = this;
    const url = this._ttw_url || '';
    // 用量请求：此时 setRequestHeader 已全部执行，头（含 authorization: Cloud-IDE-JWT）已就绪，
    // 捕获完整形状（含鉴权头 + body 模板），并据此触发一进站点即拉取最近一个月。
    if (this._ttw_isBulk) {
      try {
        captureUsageRequestShape(url, {
          method: this._ttw_method,
          headers: this._ttw_reqHeaders || {},
          credentials: 'include', // axios 走 withCredentials，跨域带 cookie
          mode: 'cors',
          referrer: location.href,
          body,
        });
      } catch (_) {}
    }
    const isApi = shouldIntercept(url);
    const isTreaApi = TRAE_DOMAIN_PATTERN.test(getHost(url)) && /\/api\//i.test(getPath(url));

    if (isApi || isTreaApi) {
      if (body) {
        this._ttw_meta = extractRequestMeta(body, url);
        if (this._ttw_method === 'POST' && /\/messages?\b/i.test(getPath(url))) {
          cacheContext(this._ttw_meta.conversationId, this._ttw_meta);
        }
      } else {
        this._ttw_meta = { model: null, agentType: null, conversationId: extractConvIdFromUrl(url) };
      }
      this.addEventListener('load', function () {
        try {
          const headerUsage = extractFromXHRHeaders(self);
          if (headerUsage) reportUsage(headerUsage, url, 'xhr-header', self._ttw_meta);
          const ct = self.getResponseHeader('content-type') || '';
          const text = self.responseText || '';
            if (isApi || ct.includes('event-stream')) {
              log(`XHR resp: ${text.length} 字符 | ct: ${ct}`);
              pushDebug({ type: 'xhr', url, ct, bodyLen: text.length, bodyPreview: text.slice(0, 2000), headerUsage: !!headerUsage });
              const bodyUsage = tryParseBody(text, ct);
              if (bodyUsage) reportUsage(bodyUsage, url, 'xhr-body', self._ttw_meta);
              captureSessions(text, url);
              // 被动捕获「用量明细」批量接口（参考 user.js）：数组形式 user_usage_group_by_sessions
              const bulkArr = tryParseBulk(text, ct);
              if (bulkArr) {
                rememberBulkPath(url);
                reportBulkItems(bulkArr.items, url);
              }
            }
        } catch (e) {
          log('XHR 拦截异常:', e);
        }
      });
    }
    return originalSend.call(this, body);
  };

  // ---------- 拦截 EventSource ----------
  if (window.EventSource) {
    const OriginalEventSource = window.EventSource;
    const SSE_EVENT_NAMES = ['message', 'token', 'usage', 'done', 'end', 'complete', 'finished', 'final', 'close', 'delta', 'chunk', 'data', 'result', 'response', 'meta', 'output', 'time_cost'];

    window.EventSource = function EventSource(url, config) {
      const es = new OriginalEventSource(url, config);
      const fullUrl = typeof url === 'string' ? url : (url?.url || '');

      if (shouldInterceptStream(fullUrl)) {
        log('EventSource →', fullUrl);
        const convId = extractConvIdFromUrl(fullUrl);
        const ctx = convId ? lookupContext(convId) : null;

        const capture = (event) => {
          try {
            const data = event.data || '';
            pushDebug({ type: 'eventsource', url: fullUrl, event: event.type, dataLen: data.length, dataPreview: data.slice(0, 2000) });
            const usage = tryParseBody(data, 'application/json');
            if (usage) {
              if (!usage.model && ctx) usage.model = ctx.model || ctx.agentType;
              if (!usage.conversationId && convId) usage.conversationId = convId;
              reportUsage(usage, fullUrl, 'eventsource', { model: ctx?.model, agentType: ctx?.agentType, conversationId: convId });
            }
            if (data.includes('data:')) {
              const u2 = parseSSE(data);
              if (u2) {
                if (!u2.model && ctx) u2.model = ctx.model || ctx.agentType;
                if (!u2.conversationId && convId) u2.conversationId = convId;
                reportUsage(u2, fullUrl, 'eventsource-sse', { model: ctx?.model, agentType: ctx?.agentType, conversationId: convId });
              }
            }
          } catch (_) {}
        };

        for (const name of SSE_EVENT_NAMES) {
          try { es.addEventListener(name, capture); } catch (_) {}
        }

        const origAdd = es.addEventListener.bind(es);
        es.addEventListener = function (type, listener, opts) {
          if (type && !SSE_EVENT_NAMES.includes(type) && type !== 'open' && type !== 'error') {
            try { origAdd(type, capture); } catch (_) {}
            SSE_EVENT_NAMES.push(type);
          }
          return origAdd(type, listener, opts);
        };

        try {
          let _onmsg = es.onmessage;
          Object.defineProperty(es, 'onmessage', {
            get: () => _onmsg,
            set: (fn) => { _onmsg = fn; },
            configurable: true,
          });
        } catch (_) {}
      }

      return es;
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
    window.EventSource.CONNECTING = OriginalEventSource.CONNECTING;
    window.EventSource.OPEN = OriginalEventSource.OPEN;
    window.EventSource.CLOSED = OriginalEventSource.CLOSED;
  }

  // ---------- 拦截 WebSocket ----------
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new OriginalWebSocket(...args);
    const wsUrl = args[0] || '';

    if (shouldInterceptStream(wsUrl)) {
      log('WS 连接:', wsUrl);
      const convId = extractConvIdFromUrl(wsUrl);
      const ctx = convId ? lookupContext(convId) : null;

      ws.addEventListener('message', function (event) {
        try {
          const data = typeof event.data === 'string' ? event.data : '';
          pushDebug({ type: 'websocket', url: wsUrl, dataLen: data.length, dataPreview: data.slice(0, 2000) });
          if (data.includes('token') || data.includes('usage') || data.includes('quota') || data.includes('prompt_tokens')) {
            const usage = tryParseBody(data, 'application/json');
            if (usage) {
              if (!usage.model && ctx) usage.model = ctx.model || ctx.agentType;
              if (!usage.conversationId && convId) usage.conversationId = convId;
              reportUsage(usage, wsUrl, 'websocket', { model: ctx?.model, agentType: ctx?.agentType, conversationId: convId });
            }
          }
        } catch (_) {}
      });
    }
    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // ---------- 主动批量拉取（参考 docs/trae-token-viewer.user.js）----------
  // 参考 user.js 拦截的「用量明细」批量接口 query_user_usage_group_by_session：
  // 一次返回全部会话用量（user_usage_group_by_sessions[]），每条带真实 usage_time（秒）、
  // extra_info（input/output/cache_read/cache_write token）、credits_float、cost_money_float、
  // model_name、user_input_preview、session_id、usage_source。比逐会话 get_session_usage 更完整，
  // 且自带真实时间，无需 snowflake 反推。用户一进站点默认「增量」拉取：首次拉最近 BULK_DAYS 天，
  // 之后记录上次覆盖到的时间边界，每次只拉边界→当前时刻的新增量（串行分页 + 限频，防频繁被拉黑）。
  const BULK_MAX_PAGES = 100; // 每页沿用页面真实 page_size(约20)，100 页≈2000 条上限；末页不满即自动停止
  const BULK_DAYS = 30;
  const BULK_PATH_KEY = '__ttw_bulk_path__';
  // 静态兜底候选：只保留真实 host 的绝对路径（来自用户抓包）。相对路径会被拼到 www.trae.cn 错误 host
  // 上导致 404，纯属误导，已移除。真正可靠的仍是「捕获页面真实请求形状」或「持久化的鉴权形状」。
  const BULK_USAGE_CANDIDATES = [
    'https://api.trae.cn/trae/api/v1/pay/query_user_usage_group_by_session',
  ];

  // ---------- 增量串行拉取：记录上次拉取边界，避免重复全量请求被拉黑 ----------
  const BULK_LAST_END_KEY = '__ttw_bulk_last_end__'; // 上次成功增量拉取覆盖到的时间上界（秒）
  const BULK_PAGE_DELAY_MS = 300;   // 每页之间串行延时，降低请求频率
  const BULK_MIN_INTERVAL_SEC = 60; // 距上次成功增量 < 60s 则本次自动跳过，防频繁
  function loadBulkLastEnd() {
    try { const v = parseInt(localStorage.getItem(BULK_LAST_END_KEY) || '', 10); return Number.isFinite(v) && v > 0 ? v : null; }
    catch (_) { return null; }
  }
  function saveBulkLastEnd(sec) {
    try { localStorage.setItem(BULK_LAST_END_KEY, String(sec)); } catch (_) {}
  }
  const delayMs = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 用量接口自动嗅探 + 真实请求形状捕获 ----------
  const USAGE_SNIFF_RE = /usage|pay|quota|credit|bill|consume|cost|token|finance|charge|fee|balance|stat/i;
  const sniffedUsageUrls = new Set();
  function sniffUsageEndpoint(method, url) {
    if (!url || !USAGE_SNIFF_RE.test(url)) return;
    if (sniffedUsageUrls.has(url)) return;
    sniffedUsageUrls.add(url);
    console.log(TAG, `[bulk-detect] 疑似用量/计费接口: ${method} ${url}`);
    try {
      const list = JSON.parse(localStorage.getItem('__ttw_detected_endpoints__') || '[]');
      list.push({ method, url, t: Date.now() });
      localStorage.setItem('__ttw_detected_endpoints__', JSON.stringify(list.slice(-40)));
    } catch (_) {}
  }

  // 浏览器禁设的请求头（复制页面请求头时需剔除，否则抛错或被忽略）
  const FORBIDDEN_REQ_HEADERS = new Set([
    'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
    'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
    'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade-insecure-requests', 'user-agent',
  ]);

  // 机会性抓取页面任意请求里的 authorization 头（登录后几乎所有 API 请求都带 Cloud-IDE-JWT）。
  // 不依赖"恰好捕获到用量接口那一次"，从而绕开 fetch 包装器安装顺序导致的鉴权头缺失问题（401 根因）。
  // 重放时若捕获到的请求形状里没有 authorization，就用这里记下的 token 兜底。
  let latestAuthToken = null;
  function grabAuthFromHeaders(h) {
    if (!h) return;
    let val = null;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) val = h.get('authorization');
      else if (h && typeof h === 'object') {
        for (const k in h) { if (k.toLowerCase() === 'authorization') { val = h[k]; break; } }
      }
    } catch (_) { return; }
    if (val && /Cloud-IDE-JWT\s+[A-Za-z0-9_-]+\./.test(val)) latestAuthToken = val;
  }

  // 把已捕获的鉴权形状（含 JWT）持久化到 localStorage，使后续进站点无需先打开用量页即可自行拉取；
  // JWT 有 exp，过期后 loadBulkAuth 返回 null，自动退回"等页面重新触发"的捕获路径。
  const BULK_AUTH_KEY = '__ttw_bulk_auth__';
  function saveBulkAuth(reqShape) {
    try {
      localStorage.setItem(BULK_AUTH_KEY, JSON.stringify({
        baseUrl: reqShape.baseUrl, method: reqShape.method, headers: reqShape.headers,
        credentials: reqShape.credentials, mode: reqShape.mode, referrer: reqShape.referrer,
        bodyTemplate: reqShape.bodyTemplate,
        authToken: latestAuthToken, // 顺手记下的登录态 token，即便本次没抓到 usage 接口的 authorization 也能重放
      }));
    } catch (_) {}
  }
  function loadBulkAuth() {
    try {
      const raw = localStorage.getItem(BULK_AUTH_KEY);
      if (!raw) return null;
      const a = JSON.parse(raw);
      const auth = a.headers && (a.headers['authorization'] || a.headers['Authorization']);
      if (auth) {
        const m = /Cloud-IDE-JWT\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(auth);
        if (m) {
          try {
            const b64 = m[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
            if (payload.exp && payload.exp * 1000 < Date.now()) {
              console.log(TAG, '[bulk] 缓存的鉴权 JWT 已过期，等待页面重新触发用量请求以刷新');
              return null;
            }
          } catch (_) {}
        }
      }
      return a;
    } catch (_) { return null; }
  }

  // 捕获页面自己发的「用量明细」请求形状（URL base + method + 鉴权头 + credentials/mode），
  // 之后主动翻页时按同形状重放，跨域与鉴权都自动正确。
  let capturedUsageReq = null;
  let bulkLoadDone = false;
  let captureTriggeredLoad = false;
  function captureUsageRequestShape(url, init) {
    if (!url || url.indexOf('query_user_usage_group_by_session') < 0) return;
    const method = (init && init.method ? init.method : 'GET').toUpperCase();
    if (method === 'OPTIONS') return; // 跳过 CORS 预检，只取真实 GET/POST
    try {
      const u = new URL(url, location.href);
      // 去掉分页/日期参数，保留干净 base（其余业务参数保留）
      ['page', 'page_size', 'pagesize', 'start_time', 'end_time', 'starttime', 'endtime', 'cursor', 'offset']
        .forEach((k) => u.searchParams.delete(k));
      const headers = {};
      const h = (init && init.headers) || {};
      const copyHeader = (k, v) => {
        const lk = (k || '').toLowerCase();
        if (FORBIDDEN_REQ_HEADERS.has(lk) || lk.startsWith('sec-')) return;
        headers[k] = v;
      };
      if (typeof Headers !== 'undefined' && h instanceof Headers) h.forEach(copyHeader);
      else if (h && typeof h === 'object') { for (const k in h) copyHeader(k, h[k]); }
      grabAuthFromHeaders(headers); // 用量接口这次抓到的头也更新 token
    // 这样能 100% 复刻页面发出来的、确定成功的请求形状。
    let bodyTemplate = null;
    if (method === 'POST' && init && init.body != null) {
      try { bodyTemplate = JSON.parse(typeof init.body === 'string' ? init.body : JSON.stringify(init.body)); }
      catch (_) { bodyTemplate = null; }
    }
    const base = u.origin + u.pathname + (u.search || '');
    const prev = capturedUsageReq && capturedUsageReq.baseUrl;
    capturedUsageReq = {
      baseUrl: base, method, headers,
      credentials: init && init.credentials,
      mode: init && init.mode,
      referrer: init && init.referrer,
      bodyTemplate,
    };
    console.log(TAG, `[bulk] 已捕获页面真实用量请求形状: ${method} ${base}（含 ${Object.keys(headers).length} 个请求头${bodyTemplate ? ' + body模板(usage_type=' + JSON.stringify(bodyTemplate.usage_type) + ')' : ''}）`);
    saveBulkAuth(capturedUsageReq); // 记住鉴权形状，供后续进站点即自行拉取（JWT 过期前）
    if (base !== prev) maybeTriggerBulkFromCapture();
    } catch (_) {}
  }

  // 一旦捕获到真实请求且尚未拉全，延时触发一次主动拉取（复用捕获到的鉴权头）
  function maybeTriggerBulkFromCapture() {
    if (bulkLoadDone || captureTriggeredLoad || !capturedUsageReq) return;
    captureTriggeredLoad = true;
    setTimeout(() => {
      runBulkLoadOnce(BULK_DAYS).then((ok) => { if (ok === false) captureTriggeredLoad = false; });
    }, 600);
  }

  // 从批量响应里抽取 user_usage_group_by_sessions 数组（只认数组形式，避免与单条 get_session_usage 重复处理）
  function extractBulkArray(json) {
    if (!json || typeof json !== 'object') return null;
    const d = json.data || json;
    let items = null;
    if (Array.isArray(d && d.user_usage_group_by_sessions)) items = d.user_usage_group_by_sessions;
    else if (Array.isArray(json.user_usage_group_by_sessions)) items = json.user_usage_group_by_sessions;
    if (!items || items.length === 0) return null;
    const total = (d && typeof d.total === 'number') ? d.total
      : (typeof json.total === 'number' ? json.total : items.length);
    return { items, total };
  }

  // 被动/主动通用：把批量数组里的每条记录转成 usage 并上报（复用现有 extractUsage + reportUsage 管道）
  function reportBulkItems(items, url) {
    if (!items || items.length === 0) return;
    for (const item of items) {
      try {
        // 复用现有解析：把单条包成 { user_usage_group_by_session: item } 即可命中 TRAE 分支
        const usage = extractUsage({ user_usage_group_by_session: item });
        if (!usage) continue;
        if (item.usage_source != null) usage.usageSource = item.usage_source;
        reportUsage(usage, url, 'bulk-usage', null, { skipRefill: true });
      } catch (_) {}
    }
  }

  // 在响应文本里尝试解析批量数组（仅 JSON 才尝试，避免误伤）
  function tryParseBulk(text, ct) {
    if (!text) return null;
    const c = (ct || '').toLowerCase();
    if (!c.includes('json') && !text.trim().startsWith('{') && !text.trim().startsWith('[')) return null;
    try {
      return extractBulkArray(JSON.parse(text));
    } catch (_) {
      return null;
    }
  }

  // 记住本次成功命中的批量接口完整 URL（去掉查询串，含跨域 host），供后续主动复用
  function rememberBulkPath(url) {
    try {
      const u = new URL(url, location.href);
      localStorage.setItem(BULK_PATH_KEY, u.origin + u.pathname);
    } catch (_) {}
  }

  // 单页拉取：POST 探测失败则退化为 GET；返回 { status, items, total }（items 为 null 表示未命中/未解析）
  // reqShape 为页面真实请求形状（含鉴权头/credentials/mode），有则按同形状重放以通过跨域鉴权
  async function fetchBulkPage(url, method, page, sinceSec, untilSec, reqShape) {
    let u = url;
    const opts = { method, headers: {} };
    if (reqShape && reqShape.headers) {
      for (const k in reqShape.headers) {
        const lk = k.toLowerCase();
        if (FORBIDDEN_REQ_HEADERS.has(lk) || lk.startsWith('sec-')) continue;
        opts.headers[k] = reqShape.headers[k];
      }
    }
    if (method === 'GET') {
      const qs = new URLSearchParams();
      qs.set('page_num', String(page));
      // 沿用页面真实 page_size（缺省 20），不强制 100，避免 9004
      qs.set('page_size', String((reqShape && reqShape.bodyTemplate && reqShape.bodyTemplate.page_size) || 20));
      if (sinceSec) qs.set('start_time', String(sinceSec));
      if (untilSec) qs.set('end_time', String(untilSec));
      u = url + (url.indexOf('?') >= 0 ? '&' : '?') + qs.toString();
    } else {
      if (!opts.headers['Content-Type'] && !opts.headers['content-type']) opts.headers['Content-Type'] = 'application/json';
      // 优先用页面真实 body 模板（保留 usage_type 等业务字段），只覆盖分页与日期窗口；
      // 兜底（无模板，如纯静态候选）：补上 usage_type=[7]，否则接口返回空
      let body = (reqShape && reqShape.bodyTemplate)
        ? JSON.parse(JSON.stringify(reqShape.bodyTemplate))
        : { usage_type: [7] };
      body.page_num = page;
      // 关键：不要强制覆盖 page_size！页面真实请求用的是 20（见 docs/28990 源码默认 page_size=20），
      // 服务端对 page_size 有上限校验，传 100 会直接返回 9004「订单参数错误」。故优先沿用页面真实值，缺省才兜底 20。
      if (body.page_size == null) body.page_size = 20;
      if (sinceSec) body.start_time = sinceSec;
      if (untilSec) body.end_time = untilSec;
      opts.body = JSON.stringify(body);
    }
    if (reqShape && reqShape.credentials) opts.credentials = reqShape.credentials;
    if (reqShape && reqShape.mode) opts.mode = reqShape.mode;
    if (reqShape && reqShape.referrer) opts.referrer = reqShape.referrer;
    // 兜底：捕获到的形状里若没有 authorization，用机会性抓到的 token 补上（解决 401）
    if (!opts.headers['authorization'] && !opts.headers['Authorization'] && latestAuthToken) {
      opts.headers['authorization'] = latestAuthToken;
    }
    // 静态候补（无真实请求形状）仍需跨域凭据与 CORS 模式，否则跨域请求被浏览器拦掉
    if (!reqShape) {
      if (!opts.credentials) opts.credentials = 'include';
      if (!opts.mode) opts.mode = 'cors';
    }
    // 用 window.fetch（最外层，会经过页面的鉴权拦截器注入 authorization）重放，
    // 并打 __ttw_bulk 哨兵让本脚本包装器直接放行；这样能复用页面自身的登录态，避免 401。
    try {
      const resp = await window.fetch(u, Object.assign({}, opts, { __ttw_bulk: true }));
      const status = resp.status;
      if (!resp.ok) return { status, items: null };
      const text = await resp.text();
      const arr = tryParseBulk(text, resp.headers.get('content-type') || '');
      return { status, items: arr ? arr.items : [], total: arr ? arr.total : 0 };
    } catch (e) {
      return { status: -1, items: null, error: e && e.message };
    }
  }

  // 尝试某个目标（{url, reqShape}）：有 reqShape 直接用页面真实方法翻页；否则先 POST 再 GET 探测。
  // 拉取近 days 天窗口内记录，返回成功上报条数。
  async function tryLoadFromPath(target, sinceMs, untilMs) {
    const url = target.url.indexOf('http') === 0 ? target.url : location.origin + target.url;
    const reqShape = target.reqShape;
    const sinceSec = Math.floor(sinceMs / 1000);
    const untilSec = Math.floor(untilMs / 1000);

    let method = null;
    if (reqShape && reqShape.method) {
      // 复用页面真实请求方法（GET/POST），无需再探测
      method = reqShape.method;
      const probe = await fetchBulkPage(url, method, 1, sinceSec, untilSec, reqShape);
      console.log(TAG, `[bulk] 探测 ${method} ${url} → status=${probe.status}${probe.error ? ' err=' + probe.error : ''} items=${probe.items ? probe.items.length : 0}`);
    } else {
      // 无真实形状：先 POST 再 GET 探测（page 1），打印结果便于排错
      const probePost = await fetchBulkPage(url, 'POST', 1, sinceSec, untilSec, null);
      console.log(TAG, `[bulk] 探测 POST ${url} → status=${probePost.status}${probePost.error ? ' err=' + probePost.error : ''} items=${probePost.items ? probePost.items.length : 0}`);
      if (probePost.items && probePost.items.length > 0) {
        method = 'POST';
      } else {
        const probeGet = await fetchBulkPage(url, 'GET', 1, sinceSec, untilSec, null);
        console.log(TAG, `[bulk] 探测 GET ${url} → status=${probeGet.status}${probeGet.error ? ' err=' + probeGet.error : ''} items=${probeGet.items ? probeGet.items.length : 0}`);
        if (probeGet.items && probeGet.items.length > 0) method = 'GET';
      }
    }
    if (!method) return 0;

    let total = 0;
    let page = 1;
    let complete = false; // 正常拉到末页（非失败中断）为 true
    // 实际 page_size（与 fetchBulkPage 一致：优先页面模板、缺省 20），用于判断末页
    const effPageSize = (reqShape && reqShape.bodyTemplate && reqShape.bodyTemplate.page_size) || 20;
    while (page <= BULK_MAX_PAGES) {
      if (page > 1) await delayMs(BULK_PAGE_DELAY_MS); // 串行延时，降低请求频率，防拉黑
      const res = await fetchBulkPage(url, method, page, sinceSec, untilSec, reqShape);
      if (!res || res.items === null) {
        if (res && res.items === null) console.log(TAG, `[bulk] 第 ${page} 页拉取失败 status=${res.status}${res.error ? ' err=' + res.error : ''}`);
        complete = false; // 中途失败：整段增量不完整，下次从边界重试
        break;
      }
      if (res.items.length === 0) { complete = true; break; } // 空页 = 无更多，已覆盖窗口
      const items = res.items;
      let inWindow = 0;
      let allOlder = true;
      let sawTimed = false;
      for (const item of items) {
        const t = item && item.usage_time;
        const ts = (typeof t === 'number' && t > 0) ? t * 1000 : null;
        if (ts != null) {
          sawTimed = true;
          if (ts < sinceMs || ts > untilMs) continue; // 超出窗口
          inWindow++;
          allOlder = false;
        }
        const usage = extractUsage({ user_usage_group_by_session: item });
        if (!usage) continue;
        if (item.usage_source != null) usage.usageSource = item.usage_source;
        reportUsage(usage, url, 'bulk-usage', null, { skipRefill: true });
        total++;
      }
      if (items.length < effPageSize) { complete = true; break; } // 末页（不足一页）已覆盖
      // 整页都早于窗口下界（且确有时间字段）则停止：已覆盖到上次请求的时间边界
      if (sawTimed && allOlder && inWindow === 0) { complete = true; break; }
      page++;
    }
    return { count: total, complete };
  }

  let bulkLoadRunning = false;
  // 主动拉取一次；返回是否成功拿到数据。优先用页面真实捕获到的请求形状（带鉴权头）。
  async function runBulkLoadOnce(days) {
    if (bulkLoadDone) return true;
    if (bulkLoadRunning) return false;
    bulkLoadRunning = true;
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const lastEnd = loadBulkLastEnd();
      let sinceSec, mode;
      if (lastEnd) {
        // 增量：从上次覆盖到的边界之后，拉到当前时刻
        sinceSec = lastEnd;
        mode = '增量';
        // 冷却：距上次成功增量不足阈值则跳过，防频繁请求被拉黑
        if (nowSec - lastEnd < BULK_MIN_INTERVAL_SEC) {
          console.log(TAG, `[bulk] 距上次增量仅 ${nowSec - lastEnd}s（< ${BULK_MIN_INTERVAL_SEC}s），跳过本次自动拉取`);
          return 'cooldown';
        }
      } else {
        // 首次：拉最近 days 天
        sinceSec = nowSec - days * 86400;
        mode = '首次';
      }
      const untilSec = nowSec;
      const sinceMs = sinceSec * 1000;
      const untilMs = untilSec * 1000;
      const candidates = [];
      // 1) 页面本次真实捕获到的请求形状（跨域 host + 鉴权头 + body 模板，最可靠）
      if (capturedUsageReq) candidates.push({ url: capturedUsageReq.baseUrl, reqShape: capturedUsageReq });
      // 2) 上次会话缓存的鉴权形状（含 JWT，未过期则可"一进站点即加载"，无需先打开用量页）
      const persistedAuth = loadBulkAuth();
      if (persistedAuth && !capturedUsageReq) {
        if (persistedAuth.authToken) latestAuthToken = persistedAuth.authToken; // 恢复上次记下的 token
        candidates.push({ url: persistedAuth.baseUrl, reqShape: persistedAuth });
      }
      // 3) 静态候选（绝对路径，含真实 host；无鉴权头，仅兜底，会返回 401 便于排错）
      for (const p of BULK_USAGE_CANDIDATES) {
        if (!candidates.some((c) => c.url === p)) candidates.push({ url: p, reqShape: null });
      }
      for (const target of candidates) {
        try {
          const r = await tryLoadFromPath(target, sinceMs, untilMs);
          if (r && (r.count > 0 || r.complete)) {
            bulkLoadDone = true;
            try {
              const fu = new URL(target.url.indexOf('http') === 0 ? target.url : location.origin + target.url);
              localStorage.setItem(BULK_PATH_KEY, fu.origin + fu.pathname);
            } catch (_) {}
            // 仅当整段增量完整拉到末页，才把边界推进到当前时刻；否则保留旧边界，下次续拉
            if (r.complete) saveBulkLastEnd(untilSec);
            const d0 = new Date(sinceMs).toISOString().slice(0, 10);
            const d1 = new Date(untilMs).toISOString().slice(0, 10);
            console.log(TAG, `[bulk] ${mode}拉取成功（窗口 ${d0} ~ ${d1}）：${target.url}，新增/更新 ${r.count} 条${r.complete ? '' : '（未拉完，下次续拉）'}`);
            return true;
          }
        } catch (e) {
          log('[bulk] 候选 endpoint 失败：', target.url, e && e.message);
        }
      }
      return false;
    } finally {
      bulkLoadRunning = false;
    }
  }

  let bulkLoadScheduled = false;
  // 用户一进来默认加载最近一个月：顶层 frame 才触发，带退避重试（等登录态就绪）
  function scheduleBulkLoad(days, maxAttempts) {
    if (window !== window.top) return;
    if (bulkLoadScheduled) return;
    bulkLoadScheduled = true;
    const delays = [1500, 6000, 15000, 30000];
    let attempt = 0;
    const tick = async () => {
      attempt++;
      let ok = false;
      try { ok = await runBulkLoadOnce(days); } catch (_) {}
      if (ok === 'cooldown') {
        console.log(TAG, '[bulk] 本次为冷却跳过，不再重试');
        return;
      }
      if (ok || attempt >= (maxAttempts || delays.length)) {
        if (!ok) console.log(TAG, '[bulk] 主动拉取未命中可用 endpoint（可能路径不符或未登录），已依赖被动采集');
        return;
      }
      const next = delays[Math.min(attempt, delays.length - 1)];
      setTimeout(tick, next);
    };
    setTimeout(tick, delays[0]);
  }

  // ---------- 调试模式开关 ----------
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.data?.source === 'trae-token-watcher-content' && event.data?.type === 'debug-toggle') {
      DEBUG = !!event.data.enabled;
      try { localStorage.setItem(DEBUG_KEY, DEBUG ? '1' : '0'); } catch (_) {}
      log('调试模式:', DEBUG ? '已开启' : '已关闭');
    }
  });

  // 启动增量批量拉取：用户一进入站点，增量补齐上次边界→当前时刻的用量
  if (window === window.top) {
    scheduleBulkLoad(BULK_DAYS);
    const le = loadBulkLastEnd();
    console.log(TAG, `[bulk] 已调度增量批量拉取（host=${location.host}），上次边界=${le ? new Date(le * 1000).toISOString() : '无（首次拉最近 ' + BULK_DAYS + ' 天）'}`);
  } else {
    console.log(TAG, '[bulk] 当前为 iframe 上下文，跳过主动拉取（如需支持请将 iframe 纳入 content_scripts）');
  }

  console.log(TAG, 'token 拦截器 v9 已注入（主动批量拉取 + 真实会话时间=snowflake id 反推 + chat_sessions.created_at）');
  if (DEBUG) console.log(TAG, '调试已开启 | 查看拦截记录: window.__ttw_debug_log | 关闭: localStorage.removeItem("' + DEBUG_KEY + '")');
})();
