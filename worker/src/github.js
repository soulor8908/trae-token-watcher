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

// 构造授权跳转 URL
export function buildAuthorizeUrl(env, state, redirectUri) {
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
