// 扩展端 Auth 客户端 — 管理 session、调用后端 API
// 路径 A（后端）与路径 B（直连 DeepSeek）的统一入口

const SESSION_KEY = 'ttw_session';
const API_BASE_KEY = 'ttw_api_base'; // 后端 Worker 域名，用户需配置
const DEFAULT_API_BASE = ''; // 部署后由用户在设置里填写

// 读取后端 API 基址
export async function getApiBase() {
  const result = await chrome.storage.local.get(API_BASE_KEY);
  return result[API_BASE_KEY] || DEFAULT_API_BASE;
}

export async function setApiBase(url) {
  await chrome.storage.local.set({ [API_BASE_KEY]: url });
}

// 读取当前 session
export async function getSession() {
  const result = await chrome.storage.local.get(SESSION_KEY);
  const session = result[SESSION_KEY];
  if (!session) return null;
  // 检查过期
  if (session.expires && session.expires * 1000 < Date.now()) {
    await clearSession();
    return null;
  }
  return session;
}

export async function clearSession() {
  await chrome.storage.local.remove(SESSION_KEY);
}

// 发起 GitHub OAuth 登录
// 打开新标签页到 Worker 的 /auth/github，带上扩展 id
export async function loginWithGitHub() {
  const apiBase = await getApiBase();
  if (!apiBase) {
    throw new Error('请先在设置中配置后端 API 地址');
  }
  const extId = chrome.runtime.id;
  const url = `${apiBase.replace(/\/$/, '')}/auth/github?ext_id=${encodeURIComponent(extId)}`;
  await chrome.tabs.create({ url });
}

// 登出
export async function logout() {
  const session = await getSession();
  const apiBase = await getApiBase();
  if (session && apiBase) {
    // 尽力通知后端删除 session，失败也无所谓（本地已清除）
    fetch(`${apiBase.replace(/\/$/, '')}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
    }).catch(() => {});
  }
  await clearSession();
}

// 查询后端的最新登录/Star 状态（刷新本地缓存）
export async function refreshAuthStatus() {
  const session = await getSession();
  if (!session) return { authenticated: false };

  const apiBase = await getApiBase();
  if (!apiBase) {
    // 没配置后端，用本地缓存的 session 信息
    return {
      authenticated: true,
      login: session.login,
      avatar: session.avatar,
      starred: session.starred,
      offline: true,
    };
  }

  try {
    const resp = await fetch(`${apiBase.replace(/\/$/, '')}/auth/status`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!resp.ok) {
      if (resp.status === 401) await clearSession();
      return { authenticated: false };
    }
    const data = await resp.json();
    // 更新本地缓存
    await chrome.storage.local.set({
      [SESSION_KEY]: { ...session, ...data, starred: data.starred },
    });
    return data;
  } catch (_) {
    return {
      authenticated: true,
      login: session.login,
      avatar: session.avatar,
      starred: session.starred,
      offline: true,
    };
  }
}

// 诊断：优先路径 A（后端），失败回退路径 B（自有 Key）
// statsPayload: 聚合统计文本
export async function diagnose(statsPayload) {
  const session = await getSession();
  const apiBase = await getApiBase();

  // 路径 A：通过后端（Star 用户免费，限流）
  if (session && apiBase) {
    try {
      const resp = await fetch(`${apiBase.replace(/\/$/, '')}/api/diagnose`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ stats: statsPayload }),
      });

      if (resp.ok) {
        const data = await resp.json();
        return {
          result: data.result,
          source: 'A',
          cached: data.cached,
          quotaUsed: data.quotaUsed,
          quotaTotal: data.quotaTotal,
        };
      }

      // 403 = 未 Star，429 = 配额用完 → 回退路径 B
      if (resp.status === 403 || resp.status === 429) {
        const err = await resp.json().catch(() => ({}));
        return { fallback: 'B', reason: err.error, source: 'A-fallback' };
      }

      // 401 = session 失效
      if (resp.status === 401) {
        await clearSession();
        return { fallback: 'B', reason: '登录已失效', source: 'A-fallback' };
      }

      // 其他错误也回退
      return { fallback: 'B', reason: `后端错误 ${resp.status}`, source: 'A-fallback' };
    } catch (_) {
      return { fallback: 'B', reason: '后端不可达', source: 'A-fallback' };
    }
  }

  // 路径 B：直连 DeepSeek（用户自有 Key）
  return { fallback: 'B', source: 'B' };
}
