// MAIN WORLD 注入脚本 — 拦截 fetch/XHR，提取 token 用量
// 运行在页面主世界，通过 window.postMessage 与隔离世界脚本通信
(function () {
  'use strict';

  const TAG = '[trae-token-watcher]';
  // 只拦截看起来像 API 请求的 URL
  const API_PATTERN = /\/(api|chat|conversation|message|completion|stream|invoke|agent)/i;

  function postUsage(data) {
    try {
      window.postMessage({ source: 'trae-token-watcher-inject', type: 'usage', payload: data }, '*');
    } catch (_) { /* 静默失败 */ }
  }

  // 从任意 JSON 对象中递归提取 token 用量
  function extractUsage(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // 直接查找 usage 对象
    const usage = findKey(obj, ['usage', 'token_usage', 'tokenUsage', 'tokens']);
    if (usage) {
      const result = parseUsageFields(usage);
      if (result) return enrich(obj, result);
    }

    // 有些响应直接把 token 字段放在顶层
    const direct = parseUsageFields(obj);
    if (direct) return enrich(obj, direct);

    return null;
  }

  // 在对象树中查找指定 key 的值（广度优先，限深 4 层）
  function findKey(obj, keys, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
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
    const input = pickNum(obj, ['prompt_tokens', 'input_tokens', 'inputTokens', 'promptTokens']);
    const output = pickNum(obj, ['completion_tokens', 'output_tokens', 'outputTokens', 'completionTokens']);
    const total = pickNum(obj, ['total_tokens', 'totalTokens']);
    const cached = pickNum(obj, [
      'prompt_cache_hit_tokens', 'promptCacheHitTokens',
      'cached_tokens', 'cachedTokens',
      'prompt_tokens_details',
    ]);

    // 至少要有 input 或 output 才认为有效
    if (input == null && output == null) return null;

    return {
      inputTokens: input || 0,
      outputTokens: output || 0,
      cachedTokens: cached || 0,
      totalTokens: total || (input || 0) + (output || 0),
    };
  }

  function enrich(obj, usage) {
    return {
      ...usage,
      model: pickStr(obj, ['model', 'model_name', 'modelName']),
      conversationId: pickStr(obj, ['conversation_id', 'conversationId', 'chat_id', 'chatId', 'session_id', 'sessionId']),
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

  // 解析 SSE 文本，从最后一个 data 块中提取 usage
  function parseSSE(text) {
    const lines = text.split('\n');
    let lastData = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]' || data === '') continue;
        try {
          lastData = JSON.parse(data);
          break;
        } catch (_) { /* 跳过非 JSON 行 */ }
      }
    }
    if (lastData) return extractUsage(lastData);

    // fallback：尝试拼接所有 data 行后整体解析
    const allData = lines
      .filter((l) => l.trim().startsWith('data:'))
      .map((l) => l.trim().slice(5).trim())
      .filter((d) => d && d !== '[DONE]')
      .join('');
    if (allData) {
      try { return extractUsage(JSON.parse(allData)); } catch (_) {}
    }
    return null;
  }

  function tryParseBody(text, contentType) {
    if (!text) return null;
    const ct = (contentType || '').toLowerCase();

    if (ct.includes('event-stream') || ct.includes('text/event-stream')) {
      return parseSSE(text);
    }

    // 尝试 JSON 解析
    if (ct.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        const obj = JSON.parse(text);
        return extractUsage(obj);
      } catch (_) { /* 非 JSON，忽略 */ }
    }

    // 兜底：文本里如果包含 SSE data 行也试一下
    if (text.includes('data:')) {
      return parseSSE(text);
    }
    return null;
  }

  // ---------- 拦截 fetch ----------
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);

    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      if (url && API_PATTERN.test(url)) {
        const clone = response.clone();
        const contentType = response.headers.get('content-type') || '';
        // 异步读取，不阻塞页面
        clone.text().then((text) => {
          const usage = tryParseBody(text, contentType);
          if (usage) {
            postUsage({ ...usage, url, source: 'fetch' });
          }
        }).catch(() => {});
      }
    } catch (_) { /* 静默失败，不影响页面 */ }

    return response;
  };

  // ---------- 拦截 XMLHttpRequest ----------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._ttw_url = url;
    this._ttw_method = method;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const self = this;
    const url = this._ttw_url || '';

    if (url && API_PATTERN.test(url)) {
      this.addEventListener('load', function () {
        try {
          const contentType = self.getResponseHeader('content-type') || '';
          const text = self.responseText || '';
          const usage = tryParseBody(text, contentType);
          if (usage) {
            postUsage({ ...usage, url, source: 'xhr' });
          }
        } catch (_) {}
      });
    }
    return originalSend.call(this, body);
  };

  console.log(TAG, 'token 拦截器已注入');
})();
