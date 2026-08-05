// 主入口 — 路由表 + CORS + 错误处理
// 后端很薄，只做三件事：验证身份、转发诊断、缓存结果

import { handleAuthStart, handleAuthCallback, handleAuthStatus, handleAuthLogout } from './auth.js';
import { handleDiagnose } from './diagnose.js';
import { verifySession } from './session.js';
import { httpError } from './github.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();

    try {
      // ---------- 健康检查 ----------
      if (pathname === '/' || pathname === '/health') {
        return json({ ok: true, service: 'trae-token-watcher-api', version: '0.1.0' });
      }

      // ---------- OAuth 路由（无需 session）----------
      if (pathname === '/auth/github' && method === 'GET') {
        return await handleAuthStart(request, env);
      }
      if (pathname === '/auth/callback' && method === 'GET') {
        return await handleAuthCallback(request, env, ctx);
      }

      // ---------- 以下路由需要 CORS（扩展 popup 调用）----------
      // OPTIONS 预检
      if (method === 'OPTIONS') {
        return handleCORS();
      }

      // 校验 session（auth/status、auth/logout、api/diagnose 需要）
      const session = await verifySession(env, request);

      if (pathname === '/auth/status' && method === 'GET') {
        return cors(await handleAuthStatus(env, session));
      }
      if (pathname === '/auth/logout' && method === 'POST') {
        return cors(await handleAuthLogout(env, session, request));
      }
      if (pathname === '/api/diagnose' && method === 'POST') {
        return cors(await handleDiagnose(request, env, session));
      }

      // 404
      return cors(json({ error: 'Not Found', path: pathname }, 404));
    } catch (err) {
      const status = err.status || 500;
      const message = err.message || 'Internal Server Error';
      if (status >= 500) console.error('[api-error]', err);
      return cors(json({ error: message }, status));
    }
  },
};

// CORS 处理：扩展 popup 通过 fetch 调用，需允许扩展来源
function handleCORS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function cors(response) {
  const headers = corsHeaders();
  response.headers.forEach((v, k) => { headers[k] = v; });
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
