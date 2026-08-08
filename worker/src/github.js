// GitHub API 封装 — OAuth 换 token + 用户信息 + Star 检查
// 失败优雅：所有调用抛出带状态码的错误，由上层捕获

const GITHUB_API = 'https://api.github.com';
const GITHUB_OAUTH = 'https://github.com/login/oauth';

// 用授权码换 access_token
export async function exchangeCodeForToken(code, env) {
  const resp = await fetch(`${GITHUB_OAUTH}/access_token`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  if (!resp.ok) {
    throw httpError(502, `GitHub token 接口返回 ${resp.status}`);
  }

  const data = await resp.json();
  if (data.error) {
    throw httpError(400, `GitHub 授权失败: ${data.error_description || data.error}`);
  }
  if (!data.access_token) {
    throw httpError(400, 'GitHub 未返回 access_token');
  }
  return data.access_token;
}

// 获取用户信息
export async function getUserInfo(accessToken) {
  const resp = await fetch(`${GITHUB_API}/user`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'trae-token-watcher',
    },
  });

  if (!resp.ok) {
    throw httpError(502, `GitHub 用户接口返回 ${resp.status}`);
  }

  const user = await resp.json();
  return {
    githubId: user.id,
    login: user.login,
    avatarUrl: user.avatar_url,
  };
}

// 检查用户是否 Star 了指定仓库
export async function checkStarred(accessToken, owner, repo) {
  const resp = await fetch(`${GITHUB_API}/user/starred/${owner}/${repo}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'trae-token-watcher',
    },
  });

  // 204 = 已 Star，404 = 未 Star
  if (resp.status === 204) return true;
  if (resp.status === 404) return false;
  throw httpError(502, `GitHub Star 检查接口返回 ${resp.status}`);
}

// 公开接口检查 login 是否 Star 了指定仓库（不需要 access_token）
// 用于持久化 token 缺失时的兜底回查（如老用户尚未重新登录）
// 限制：未认证 60 次/小时（按出口 IP），且仓库 star 数 > 上限时可能漏判
const STAR_PUBLIC_MAX_PAGES = 10; // 最多翻 10 页（1000 个最新 stargazer）
export async function checkStarredPublic(login, owner, repo) {
  for (let page = 1; page <= STAR_PUBLIC_MAX_PAGES; page++) {
    const resp = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/stargazers?per_page=100&page=${page}`, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'trae-token-watcher',
      },
    });
    if (!resp.ok) {
      // 403 通常是未认证限流，按未 star 处理避免误放行
      if (resp.status === 403) return false;
      throw httpError(502, `GitHub stargazers 接口返回 ${resp.status}`);
    }
    const users = await resp.json();
    if (!Array.isArray(users) || users.length === 0) return false;
    if (users.some((u) => u && u.login === login)) return true;
    if (users.length < 100) return false; // 已到最后一页
  }
  return false; // 超过上限仍未找到，按未 star 处理
}

// ---------- access_token 加密存储（AES-GCM）----------
// 密钥由 SESSION_SECRET 经 SHA-256 派生；secret 变更后旧密文不可解，需重新登录
async function deriveAesKey(env) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env?.SESSION_SECRET || ''));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptToken(token, env) {
  const key = await deriveAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
  return { enc: toHex(new Uint8Array(enc)), iv: toHex(iv) };
}

export async function decryptToken(encHex, ivHex, env) {
  const key = await deriveAesKey(env);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(ivHex) }, key, fromHex(encHex));
  return new TextDecoder().decode(dec);
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

// 构造授权跳转 URL
export function buildAuthorizeUrl(env, state, redirectUri) {
  // 防御：secret 未配置时直接报错，避免跳转到 GitHub 拿到 client_id=undefined 的 404
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw httpError(500, 'Worker 未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET，请用 wrangler secret put 设置');
  }
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'read:user',   // 只需读取用户信息，Star 检查用 user/starred 端点（同样需要 read:user）
    state,
  });
  return `${GITHUB_OAUTH}/authorize?${params.toString()}`;
}

// 工具：构造 HTTP 错误
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}
