// TODO 解析纯函数 — 从 inject.js 抽出的共享模块（v9）
// 仅含无副作用 / 依赖可注入的纯解析逻辑，供 inject.js（MAIN world 经典脚本）与 Node 测试复用。
// 浏览器中作为内容脚本在 inject.js 之前加载，挂到 window.__ttwParse；Node 测试经 vm 加载读取同名全局。
//
// 依赖注入（setter）：这些解析函数原本闭包依赖 inject.js 的运行时状态，这里以可注入方式解耦：
//   - setLog(fn)          parseSSE 的调试日志（默认静默）
//   - setSfTrusted(fn)    deriveTimeFromSessionId 的 snowflake 自检开关（默认可信）
//   - setConvIdFromUrl(fn) extractRequestMeta 从 URL 提取会话 id（默认 null）
(function () {
  'use strict';

  // ---------- 字段候选 ----------
  // model 字段候选（TRAE 用 model_name）
  const MODEL_KEYS = ['model', 'model_name', 'modelName', 'model_id', 'modelId', 'agent_type', 'agentType', 'agent'];
  const CONV_KEYS = ['conversation_id', 'conversationId', 'chat_id', 'chatId', 'chat_session_id', 'chatSessionId', 'session_id', 'sessionId', 'turn_id', 'turnId', 'id'];

  // ---------- 可注入依赖（默认安全值）----------
  let _log = () => {};
  let _sfTrusted = () => true;
  let _convIdFromUrl = () => null;

  function setLog(fn) { _log = typeof fn === 'function' ? fn : () => {}; }
  function setSfTrusted(fn) { _sfTrusted = typeof fn === 'function' ? fn : () => true; }
  function setConvIdFromUrl(fn) { _convIdFromUrl = typeof fn === 'function' ? fn : () => null; }

  // ---------- 字段取值 ----------
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

  // ---------- 响应体提取 ----------
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

  // 从 session_id 反推 created_at：Trae 的 session_id 是 snowflake ID，
  // 前 8 位十六进制 = 创建时间（秒）。零网络开销、100% 可靠的兜底。
  // 是否启用反推由 setSfTrusted 注入（inject.js 用权威样本自检后决定）。
  function deriveTimeFromSessionId(id) {
    if (!_sfTrusted()) return null; // 已判定该启发式失效，禁用反推
    if (typeof id !== 'string' || id.length < 8) return null;
    const hex = id.slice(0, 8).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(hex)) return null;
    const secs = parseInt(hex, 16);
    // 合理区间：2020-01-01 ~ 2033 年（秒）。超出视为非 snowflake，放弃反推。
    if (!secs || secs < 1577836800 || secs > 2000000000) return null;
    return secs * 1000;
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
    _log(`SSE: ${dataBlocks.length} 块, 事件类型: ${[...new Set(eventTypes)].join('/')}`);

    // 1. 从后往前找 usage（通常在 done/end/usage 事件里）
    let usage = null;
    for (let i = dataBlocks.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(dataBlocks[i]);
        usage = extractUsage(obj);
        if (usage) {
          _log(`SSE 第 ${i + 1} 块 [${eventTypes[i]}] 含 usage`);
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
            _log(`SSE 第 ${i + 1} 块 [${eventTypes[i]}] 含 model: ${m}`);
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
    meta.conversationId = _convIdFromUrl(url);
    if (!body) return meta;
    try {
      const obj = typeof body === 'string' ? JSON.parse(body) : body;
      meta.model = pickStr(obj, MODEL_KEYS);
      meta.agentType = pickStr(obj, ['agent_type', 'agentType', 'agent']);
      if (!meta.conversationId) meta.conversationId = pickStr(obj, CONV_KEYS);
    } catch (_) {}
    return meta;
  }

  // ---------- 批量数组提取 ----------
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

  const api = {
    MODEL_KEYS, CONV_KEYS,
    extractUsage, parseUsageFields, validateUsage, findKey, enrich,
    pickNum, pickStr,
    normalizeTimeVal, normalizeTimeStr, extractSessionTime, deriveTimeFromSessionId,
    parseSSE, tryParseBody, extractRequestMeta, extractBulkArray, tryParseBulk,
    setLog, setSfTrusted, setConvIdFromUrl,
  };

  if (typeof window !== 'undefined' && window) {
    window.__ttwParse = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();