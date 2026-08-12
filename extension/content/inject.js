// MAIN WORLD 注入脚本 v8 — 用 chat_sessions.created_at 作为真实会话时间
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
  async function resolveSessionTime(conversationId, fallback) {
    if (!conversationId) return fallback || null;
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

  async function reportUsage(usage, url, source, requestMeta) {
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
    const realTime = await resolveSessionTime(conversationId, usage.sessionTime || null);
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
    const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
    const method = (args[1]?.method || (typeof args[0] === 'object' && args[0]?.method) || 'GET').toUpperCase();
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

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ttw_url = url;
    this._ttw_method = method;
    this._ttw_meta = null;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const self = this;
    const url = this._ttw_url || '';
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

  // ---------- 调试模式开关 ----------
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (event.data?.source === 'trae-token-watcher-content' && event.data?.type === 'debug-toggle') {
      DEBUG = !!event.data.enabled;
      try { localStorage.setItem(DEBUG_KEY, DEBUG ? '1' : '0'); } catch (_) {}
      log('调试模式:', DEBUG ? '已开启' : '已关闭');
    }
  });

  console.log(TAG, 'token 拦截器 v8 已注入（真实会话时间=snowflake id 反推 + chat_sessions.created_at）');
  if (DEBUG) console.log(TAG, '调试已开启 | 查看拦截记录: window.__ttw_debug_log | 关闭: localStorage.removeItem("' + DEBUG_KEY + '")');
})();
