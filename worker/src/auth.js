// OAuth 流程 — /auth/github 跳转 + /auth/callback 回调 + 状态查询
// 流程：扩展打开 /auth/github?ext_id=xxx → GitHub 授权 → 回调换 token → 检查 Star → 签发 session → 重定向回扩展

import { buildAuthorizeUrl, exchangeCodeForToken, getUserInfo, checkStarred, httpError } from './github.js';
import { upsertUser, purgeExpiredSessions, deleteSession } from './db.js';
import { issueSession, hashToken } from './session.js';

// GET /auth/github — 跳转到 GitHub 授权页
// state 编码 ext_id，回调时用于重定向回扩展
export async function handleAuthStart(request, env) {
  const url = new URL(request.url);
  const extId = url.searchParams.get('ext_id');
  if (!extId) {
    throw httpError(400, '缺少 ext_id 参数');
  }

  // state = base64(ext_id + 随机 nonce)，防 CSRF
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const stateRaw = JSON.stringify({ extId, nonce });
  const state = btoa(stateRaw);

  const callbackUrl = `${url.origin}/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl(env, state, callbackUrl);
  return Response.redirect(authorizeUrl, 302);
}

// GET /auth/callback — GitHub 回调，完成认证并重定向回扩展
export async function handleAuthCallback(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    throw httpError(400, `GitHub 授权被拒绝: ${error}`);
  }
  if (!code || !state) {
    throw httpError(400, '回调缺少 code 或 state 参数');
  }

  // 解析 state 还原 ext_id
  let extId;
  try {
    const decoded = JSON.parse(atob(state));
    extId = decoded.extId;
  } catch (_) {
    throw httpError(400, 'state 参数无效');
  }
  if (!extId) {
    throw httpError(400, 'state 中缺少 ext_id');
  }

  // 1. 换 access_token
  const accessToken = await exchangeCodeForToken(code, env);

  // 2. 获取用户信息
  const userInfo = await getUserInfo(accessToken);

  // 3. 创建/更新用户记录
  const user = await upsertUser(env.DB, {
    githubId: userInfo.githubId,
    login: userInfo.login,
    avatarUrl: userInfo.avatarUrl,
  });

  // 4. 检查 Star 状态（带 KV 缓存，TTL 24h）— 统一用 user_id 作缓存键
  const starred = await getStarredWithCache(env, accessToken, user.id, userInfo.githubId);

  // 5. 签发 session
  const { token, expiresAt } = await issueSession(env, user.id);

  // 6. 顺手清理过期 session（post-response，用 waitUntil 避免 floating promise）
  if (ctx?.waitUntil) {
    ctx.waitUntil(purgeExpiredSessions(env.DB));
  }

  // 7. 重定向回扩展 callback 页，通过 fragment 传递（fragment 不会发到服务器）
  const params = new URLSearchParams({
    token,
    expires: String(expiresAt),
    login: userInfo.login,
    avatar: userInfo.avatarUrl || '',
    starred: starred ? '1' : '0',
  });
  const redirectUrl = `chrome-extension://${extId}/callback.html#${params.toString()}`;
  return Response.redirect(redirectUrl, 302);
}

// Star 状态检查 + KV 缓存（TTL 24h）
// 缓存键：star:u:{user_id}，值：1/0
export async function getStarredWithCache(env, accessToken, userId, githubId) {
  const cacheKey = `star:u:${userId}`;
  const cached = await env.KV.get(cacheKey);
  if (cached !== null) {
    return cached === '1';
  }

  const starred = await checkStarred(accessToken, env.WATCH_REPO_OWNER, env.WATCH_REPO_NAME);
  await env.KV.put(cacheKey, starred ? '1' : '0', {
    expirationTtl: parseInt(env.STAR_CACHE_TTL || 86400),
  });
  return starred;
}

// GET /auth/status — 查询当前 session 的登录与 Star 状态
export async function handleAuthStatus(env, session) {
  if (!session) {
    return json({ authenticated: false });
  }

  const starred = (await env.KV.get(`star:u:${session.user_id}`)) === '1';

  return json({
    authenticated: true,
    login: session.login,
    avatar: session.avatar_url,
    starred,
  });
}

// POST /auth/logout — 登出（需 session）
export async function handleAuthLogout(env, session, request) {
  if (!session) {
    return json({ ok: true });
  }
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const tokenHash = await hashToken(token, env);
  await deleteSession(env.DB, tokenHash);
  return json({ ok: true });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
