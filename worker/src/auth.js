// OAuth 流程 — /auth/github 跳转 + /auth/callback 回调 + 状态查询
// 流程：扩展打开 /auth/github?ext_id=xxx → GitHub 授权 → 回调换 token → 检查 Star → 签发 session → 重定向回扩展

import { buildAuthorizeUrl, exchangeCodeForToken, getUserInfo, checkStarred, encryptToken, decryptToken } from './github.js';
import { upsertUser, saveGithubToken, getGithubToken, purgeExpiredSessions, deleteSession } from './db.js';
import { issueSession, hashToken } from './session.js';
import { httpError, json } from './http.js';

// ---------- OAuth state 防篡改签名（HMAC-SHA256）----------
// 用 SESSION_SECRET 对 state 负载签名，回调时校验，防止 state 被伪造 / OAuth CSRF
async function signState(payloadB64, env) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env?.SESSION_SECRET || ''),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 常量时间比较，规避时序侧信道
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// GET /auth/github — 跳转到 GitHub 授权页
// state 编码 ext_id，回调时用于重定向回扩展
export async function handleAuthStart(request, env) {
  const url = new URL(request.url);
  const extId = url.searchParams.get('ext_id');
  if (!extId) {
    throw httpError(400, '缺少 ext_id 参数');
  }

  // state = base64(payload) + '.' + HMAC 签名；签名防篡改，nonce 防重放
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const payloadB64 = btoa(JSON.stringify({ extId, nonce }));
  const sig = await signState(payloadB64, env);
  const state = `${payloadB64}.${sig}`;

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

  // 校验 state 签名（防篡改 / OAuth CSRF）：无签名或签名不匹配一律拒绝
  const dotIdx = state.lastIndexOf('.');
  if (dotIdx < 0) {
    throw httpError(400, 'state 格式无效');
  }
  const payloadB64 = state.slice(0, dotIdx);
  const providedSig = state.slice(dotIdx + 1);
  const expectedSig = await signState(payloadB64, env);
  if (!timingSafeEqual(providedSig, expectedSig)) {
    throw httpError(400, 'state 校验失败（可能已被篡改）');
  }

  // 解析 state 还原 ext_id
  let extId;
  try {
    const decoded = JSON.parse(atob(payloadB64));
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

  // 3.5 持久化加密的 access_token，供后续 Star 状态回查（失败不阻断登录）
  try {
    const { enc, iv } = await encryptToken(accessToken, env);
    await saveGithubToken(env.DB, { userId: user.id, enc, iv });
  } catch (e) {
    console.warn('[auth] 持久化 access_token 失败', e.message);
  }

  // 4. 检查 Star 状态（带 KV 缓存：已 star 24h，未 star 60s）
  const starred = await getStarredWithCache(env, accessToken, user.id);

  // 5. 签发 session
  const { token, expiresAt } = await issueSession(env, user.id);

  // 6. 顺手清理过期 session（post-response，用 waitUntil 避免 floating promise）
  if (ctx?.waitUntil) {
    ctx.waitUntil(purgeExpiredSessions(env.DB));
  }

  // 7. 重定向到 Worker 自己的 /auth/done 页面
  // 不用 chrome-extension://（Chrome 安全策略禁止网页 302 到 chrome-extension://）
  // 扩展 background 通过 chrome.tabs.onUpdated 监听此 URL 变化，提取 token
  // 用 query params（非 fragment）因为 chrome.tabs API 能看到 query 但看不到 fragment
  const params = new URLSearchParams({
    token,
    expires: String(expiresAt),
    login: userInfo.login,
    avatar: userInfo.avatarUrl || '',
    starred: starred ? '1' : '0',
  });
  const redirectUrl = `${url.origin}/auth/done?${params.toString()}`;
  return Response.redirect(redirectUrl, 302);
}

// Star 状态检查 + KV 缓存
// 缓存策略：已 star 缓存 24h（极少变化）；未 star 缓存 60s（让用户 star 后能尽快生效）
// 缓存键：star:u:{user_id}，值：1/0
export async function getStarredWithCache(env, accessToken, userId) {
  const cacheKey = `star:u:${userId}`;
  const cached = await env.KV.get(cacheKey);
  if (cached !== null) {
    return cached === '1';
  }

  const starred = await checkStarred(accessToken, env.WATCH_REPO_OWNER, env.WATCH_REPO_NAME);
  await writeStarCache(env, userId, starred);
  return starred;
}

// 写 Star 缓存（已 star 长 TTL，未 star 短 TTL）
async function writeStarCache(env, userId, starred) {
  await env.KV.put(`star:u:${userId}`, starred ? '1' : '0', {
    expirationTtl: parseInt(starred ? env.STAR_CACHE_TTL : (env.STAR_MISS_CACHE_TTL || 60), 10),
  });
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

// POST /auth/refresh-star — 强制回查 GitHub Star 状态并刷新 KV 缓存
// 跳过缓存直接问 GitHub：优先用持久化的 access_token（精确），缺失时用公开 stargazers 兜底
export async function handleRefreshStar(env, session) {
  if (!session) {
    return json({ authenticated: false, error: '未登录' }, 401);
  }

  let starred = false;
  let checked = false;
  try {
    const tokenRow = await getGithubToken(env.DB, session.user_id);
    if (tokenRow) {
      // 有持久化 token：解密后用精确端点回查（204/404）
      const accessToken = await decryptToken(tokenRow.access_token_enc, tokenRow.access_token_iv, env);
      starred = await checkStarred(accessToken, env.WATCH_REPO_OWNER, env.WATCH_REPO_NAME);
      checked = true;
    } else {
      // 无持久化 token：已移除未认证公开 stargazers 兜底（受 60 次/小时 IP 限流，
      // Worker 共享出口 IP 易耗尽并误拒已 Star 用户）。直接复用 KV 缓存；
      // 无缓存则建议用户重新登录以刷新 Star 状态。
      const cached = await env.KV.get(`star:u:${session.user_id}`);
      if (cached !== null) {
        starred = cached === '1';
        checked = true;
      } else {
        console.warn('[refresh-star] 无持久化 token 且无 KV 缓存，建议重新登录以刷新 Star 状态');
        starred = false;
        checked = false; // 不写缓存，避免把"未知"误判为"未 star"
      }
    }
  } catch (e) {
    // 回查失败（网络/限流/解密失败）：降级读缓存，避免误判
    console.warn('[refresh-star] 回查失败，降级读缓存', e.message);
    starred = (await env.KV.get(`star:u:${session.user_id}`)) === '1';
  }

  if (checked) {
    await writeStarCache(env, session.user_id, starred);
  }

  return json({
    authenticated: true,
    login: session.login,
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
