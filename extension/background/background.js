// Background Service Worker — 数据写入中枢 + 消息路由 + 预警检查 + 自动同步
// 失败优雅：所有写入均 try/catch，不影响页面正常运行
import { addRecord, getSummary, getAllRecords, clearAllRecords, getRecordsSince, countRecordsSince, checkAlert, getMaxUsageTime } from '../lib/db.js';
import { sync, pull, push, getAutoSyncEnabled, canSync, resetLocalCursor } from '../lib/sync.js';

const ALERT_ALARM = 'ttw-alert-check';
const SYNC_ALARM = 'ttw-sync-periodic';
const ALERT_NOTIF_ID = 'ttw-alert';
const ALERT_COOLDOWN_MS = 3600000; // 每小时最多一次通知
const SYNC_DEBOUNCE_MS = 30000;    // 写入后 30 秒上传

// 消息路由表
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'TTW_USAGE':
      handleUsage(msg.payload, sender);
      break;
    case 'TTW_CONTENT_READY':
      refreshBadge();
      break;
    case 'TTW_GET_SUMMARY':
      getSummary().then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
      return true; // 异步响应
    case 'TTW_GET_RECORDS':
      getAllRecords(msg.payload?.limit || 500)
        .then(sendResponse)
        .catch((e) => sendResponse({ error: String(e) }));
      return true;
    case 'TTW_CLEAR':
      clearAllRecords().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: String(e) }));
      return true;
    case 'TTW_GET_TODAY':
      getRecordsSince(startOfDay(Date.now()))
        .then((records) => sendResponse({ records }))
        .catch((e) => sendResponse({ error: String(e) }));
      return true;
    case 'TTW_GET_MAX_USAGE_TIME':
      // 供 inject.js（MAIN world）取本地库最新一条真实用量时间，作为批量增量拉取水位线；
      // 清空本地数据后库为空 → 返回 0 → inject 自动全量首拉。
      getMaxUsageTime()
        .then((value) => sendResponse({ value }))
        .catch((e) => sendResponse({ value: 0, error: String(e) }));
      return true;
    case 'TTW_WIDGET_INIT':
      getWidgetSummary()
        .then((summary) => sendResponse({ summary }))
        .catch((e) => sendResponse({ error: String(e) }));
      return true;
    case 'TTW_DEBUG_TOGGLE':
      // 转发调试开关到所有 trae.cn 标签页的 content script
      chrome.tabs.query({ url: ['https://*.trae.cn/*'] }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'TTW_DEBUG_TOGGLE', enabled: msg.enabled }).catch(() => {});
        }
      });
      return false;
    case 'TTW_SYNC':
      // 手动触发同步（来自 options 页）
      (msg.payload?.only === 'pull' ? pull() : msg.payload?.only === 'push' ? push() : sync())
        .then((r) => sendResponse({ ok: true, result: r }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case 'TTW_SYNC_RESET_CURSOR':
      resetLocalCursor()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case 'TTW_OAUTH_START':
      // 扩展即将打开 OAuth 登录标签页，开始监听 /auth/done 回调
      // 持久化到 storage：SW 被杀后仍能识别回调（内存布尔会在 SW 重启时丢失）
      chrome.storage.local.set({ ttw_awaiting_oauth: true });
      return false;
    case 'TTW_OPEN_FULL_PANEL':
      // 由 content script（浮窗全屏按钮）触发。
      // 放在 background 打开标签页：service worker 上下文始终有效，
      // 避免浮窗里的 content script 在扩展被重载后「上下文失效」导致
      // chrome.tabs.create 静默失败、点击全屏没反应。
      chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') + '?full=1' });
      return false;
  }
});

// ---------- OAuth 回调监听 ----------
// Worker 不再 302 到 chrome-extension://（Chrome 禁止网页导航到扩展 URL）
// 而是 302 到 Worker 自己的 /auth/done?token=... 页面
// 扩展 background 通过 chrome.tabs.onUpdated 检测此 URL，提取 token
// 监听标志持久化在 storage（ttw_awaiting_oauth），避免 SW 重启丢状态导致登录静默失败
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const { ttw_awaiting_oauth: awaiting } = await chrome.storage.local.get('ttw_awaiting_oauth');
  if (!awaiting) return;
  const url = changeInfo.url || tab?.url;
  if (!url) return;

  try {
    const urlObj = new URL(url);
    if (urlObj.pathname !== '/auth/done') return;
    const token = urlObj.searchParams.get('token');
    if (!token) return;

    await chrome.storage.local.remove('ttw_awaiting_oauth');
    await chrome.storage.local.set({
      ttw_session: {
        token,
        expires: parseInt(urlObj.searchParams.get('expires') || '0', 10),
        login: urlObj.searchParams.get('login') || '',
        avatar: urlObj.searchParams.get('avatar') || '',
        starred: urlObj.searchParams.get('starred') === '1',
      },
    });
    console.log('[trae-token-watcher] OAuth 登录完成:', urlObj.searchParams.get('login'));
    chrome.tabs.remove(tabId).catch(() => {});
  } catch (e) {
    console.warn('[trae-token-watcher] OAuth 回调处理失败', e);
  }
});

// ---------- 自动同步 ----------
let syncTimer = null;
async function scheduleDebouncedSync() {
  if (!(await getAutoSyncEnabled())) return;
  if (!(await canSync())) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    runAutoSync();
  }, SYNC_DEBOUNCE_MS);
}

async function runAutoSync() {
  try {
    if (!(await getAutoSyncEnabled()) || !(await canSync())) return;
    await sync();
    console.log('[trae-token-watcher] 自动同步完成');
  } catch (e) {
    console.warn('[trae-token-watcher] 自动同步失败', e.message);
  }
}

// 写入用量记录并更新 badge
async function handleUsage(payload, sender) {
  if (!payload) return;
  try {
    await addRecord({
      inputTokens: payload.inputTokens || 0,
      outputTokens: payload.outputTokens || 0,
      cachedTokens: payload.cachedTokens || 0,
      totalTokens: payload.totalTokens || 0,
      model: payload.model || null,
      conversationId: payload.conversationId || null,
      url: payload.url || '',
      source: payload.source || 'fetch',
      tabId: sender.tab?.id || null,
      // 历史会话用真实会话时间；实时数据用采集时刻（inject 已计算好）
      ...(payload.timestamp != null ? { timestamp: payload.timestamp } : {}),
      ...(payload.collectedAt != null ? { collectedAt: payload.collectedAt } : {}),
      ...(payload.isHistorical != null ? { isHistorical: payload.isHistorical } : {}),
      ...(payload.sessionTime != null ? { sessionTime: payload.sessionTime } : {}),
      ...(payload.remaining != null ? { remaining: payload.remaining } : {}),
      ...(payload.cacheWriteTokens != null ? { cacheWriteTokens: payload.cacheWriteTokens } : {}),
      ...(payload.credits != null ? { credits: payload.credits } : {}),
      ...(payload.costMoney != null ? { costMoney: payload.costMoney } : {}),
      ...(payload.amount != null ? { amount: payload.amount } : {}),
      ...(payload.usageSource != null ? { usageSource: payload.usageSource } : {}),
      ...(payload.userInputPreview != null ? { userInputPreview: payload.userInputPreview } : {}),
    });
    refreshBadge();
    // 发布刷新信号：popup / 浮窗监听此 key 的变化即可事件驱动刷新，无需固定高频轮询
    chrome.storage.local.set({ ttw_usage_ping: Date.now() }).catch(() => {});
    console.log('[trae-token-watcher] 记录:', payload.source, payload.totalTokens, 'tokens |', payload.model, '|', payload.url);
    scheduleDebouncedSync();
    runAlertCheck(); // 写入后顺带检查预警（内部自带冷却，不会重复通知）
  } catch (e) {
    console.warn('[trae-token-watcher] 写入失败', e);
  }
}

// 更新扩展图标 badge：显示今日请求数，预警时变红
async function refreshBadge() {
  try {
    // 仅取计数（用索引 count），避免每次写入都加载当天全部记录
    const count = await countRecordsSince(startOfDay(Date.now()));
    const text = count > 0 ? String(count > 999 ? '999+' : count) : '';
    chrome.action.setBadgeText({ text });

    // 检查预警状态决定 badge 颜色
    const alert = await checkAlert();
    if (alert.triggered && alert.triggers.some((t) => t.level === 'danger')) {
      chrome.action.setBadgeBackgroundColor({ color: '#e53e3e' }); // 红色危险
    } else if (alert.triggered) {
      chrome.action.setBadgeBackgroundColor({ color: '#dd6b20' }); // 橙色警告
    } else {
      chrome.action.setBadgeBackgroundColor({ color: '#27d98b' }); // 绿色正常
    }
  } catch (_) {}
}

// 浮窗摘要：今日累计统计 + 最近一条记录
async function getWidgetSummary() {
  const records = await getRecordsSince(startOfDay(Date.now()));
  let total = 0, input = 0, output = 0, cached = 0, credits = 0;
  let lastModel = '', lastTokens = 0;
  // 今日已计入基线的会话，供浮窗增量去重：页面被动采集 + 主动批量拉取会重复上报同一会话，
  // 浮窗据此判断某条历史记录是否已计入基线，避免「今日 Token」被虚增。
  const sessionIds = new Set();

  for (const r of records) {
    total += r.totalTokens || 0;
    input += r.inputTokens || 0;
    output += r.outputTokens || 0;
    cached += r.cachedTokens || 0;
    credits += r.credits || 0;
    if (r.conversationId) sessionIds.add(r.conversationId);
  }

  // records 按时间戳升序，最后一条是最新的
  if (records.length > 0) {
    const last = records[records.length - 1];
    lastModel = last.model || '';
    lastTokens = last.totalTokens || 0;
  }

  return { total, input, output, cached, credits, count: records.length, lastModel, lastTokens, sessionIds: [...sessionIds] };
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------- 定时预警检查 ----------
async function runAlertCheck() {
  try {
    const alert = await checkAlert();
    if (!alert.triggered) return;

    // 冷却检查：距上次通知 > 1 小时
    const { ttw_last_alert_ts: lastTs } = await chrome.storage.local.get('ttw_last_alert_ts');
    if (lastTs && Date.now() - lastTs < ALERT_COOLDOWN_MS) return;

    // 发送桌面通知
    const messages = alert.triggers.map((t) => t.message);
    const hasDanger = alert.triggers.some((t) => t.level === 'danger');
    chrome.notifications.create(ALERT_NOTIF_ID, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: hasDanger ? '⚠ TRAE Token 预警' : 'TRAE Token 提醒',
      message: messages.join('\n'),
      priority: 2,
    });

    await chrome.storage.local.set({ ttw_last_alert_ts: Date.now() });
    console.log('[trae-token-watcher] 预警通知已发送:', messages.join('; '));
  } catch (e) {
    console.warn('[trae-token-watcher] 预警检查失败', e);
  }
}

// 通知点击：打开 popup
chrome.notifications.onClicked.addListener(() => {
  chrome.action.openPopup?.();
  chrome.notifications.clear(ALERT_NOTIF_ID);
});

// 扩展安装时初始化 + 启动定时预警 + 定时同步
chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
  // 每 15 分钟检查一次预警（alarm 最小间隔 1 分钟）
  chrome.alarms.create(ALERT_ALARM, { periodInMinutes: 15 });
  // 每 10 分钟拉取一次其他设备的记录
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 10 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALERT_ALARM) {
    runAlertCheck();
  } else if (alarm.name === SYNC_ALARM) {
    runAutoSync();
  }
});
