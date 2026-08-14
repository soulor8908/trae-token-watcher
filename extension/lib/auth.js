// 扩展端 Auth 客户端 — 管理 session、调用后端 API
// 路径 A（后端）与路径 B（直连 DeepSeek）的统一入口
//
// 设计哲学（BYO 默认 + 自托管可选）：
//   - 普通用户开箱即用，DEFAULT_API_BASE 指向项目方运营的官方 Worker
//   - 高级用户/企业内网可在设置页切换到自部署模式（填入自己的 Worker URL）
//   - 复杂性吸收在项目方，对终端用户不可见

const SESSION_KEY = 'ttw_session';
const API_BASE_KEY = 'ttw_api_base'; // 用户自定义后端域名（为空则走官方默认）

// 项目方运营的官方 Worker — 普通用户零配置
const DEFAULT_API_BASE = 'https://trae-token-watcher-api.ai-kits.workers.dev';

// 读取后端 API 基址（默认走官方，未配置自定义时返回 DEFAULT_API_BASE）
export async function getApiBase() {
  const result = await chrome.storage.local.get(API_BASE_KEY);
  const custom = result[API_BASE_KEY];
  return custom && custom.trim() ? custom.trim() : DEFAULT_API_BASE;
}

// 是否走自定义后端（用于 UI 显示当前模式）
export async function isCustomApiBase() {
  const result = await chrome.storage.local.get(API_BASE_KEY);
  const custom = result[API_BASE_KEY];
  return !!(custom && custom.trim());
}

// 重置为官方默认
export async function resetApiBase() {
  await chrome.storage.local.remove(API_BASE_KEY);
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
// Worker 完成后 302 到自己的 /auth/done?token=...（不再跳 chrome-extension://）
// background 通过 chrome.tabs.onUpdated 监听并提取 token
export async function loginWithGitHub() {
  const apiBase = await getApiBase();
  const extId = chrome.runtime.id;
  const url = `${apiBase.replace(/\/$/, '')}/auth/github?ext_id=${encodeURIComponent(extId)}`;
  // 通知 background 开始监听 OAuth 回调
  chrome.runtime.sendMessage({ type: 'TTW_OAUTH_START' });
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
      // 超时兜底：后端慢/挂起时 5s 后 reject，走下方 catch 返回本地缓存，不阻塞调用方
      signal: AbortSignal.timeout(5000),
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

// 强制回查后端 GitHub Star 状态（跳过 KV 缓存）
// 用于「去 Star」后立即刷新：调用 /auth/refresh-star，成功则更新本地缓存
export async function refreshStarStatus() {
  const session = await getSession();
  if (!session) return { authenticated: false };

  const apiBase = await getApiBase();
  if (!apiBase) {
    return { authenticated: true, starred: session.starred, offline: true };
  }

  try {
    const resp = await fetch(`${apiBase.replace(/\/$/, '')}/auth/refresh-star`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
      // 超时兜底：后端慢/挂起时 5s 后 reject，走下方 catch 返回本地缓存，不阻塞调用方
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) {
      if (resp.status === 401) await clearSession();
      return { authenticated: resp.status !== 401, starred: session.starred };
    }
    const data = await resp.json();
    if (data.authenticated) {
      // 更新本地缓存的 starred 字段
      await chrome.storage.local.set({
        [SESSION_KEY]: { ...session, starred: data.starred },
      });
    }
    return data;
  } catch (_) {
    return { authenticated: true, starred: session.starred, offline: true };
  }
}

// 诊断：优先路径 A（后端），失败回退路径 B（自有 Key）
// statsPayload: 聚合统计文本
export async function diagnose(statsPayload, mode = 'quick') {
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
        body: JSON.stringify({ stats: statsPayload, mode }),
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
