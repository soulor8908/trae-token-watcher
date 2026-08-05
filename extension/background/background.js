// Background Service Worker — 数据写入中枢 + 消息路由
// 失败优雅：所有写入均 try/catch，不影响页面正常运行
import { addRecord, getSummary, getAllRecords, clearAllRecords, getRecordsSince } from '../lib/db.js';

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
  }
});

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
    });
    refreshBadge();
  } catch (e) {
    console.warn('[trae-token-watcher] 写入失败', e);
  }
}

// 更新扩展图标 badge：显示今日请求数
async function refreshBadge() {
  try {
    const records = await getRecordsSince(startOfDay(Date.now()));
    const count = records.length;
    const text = count > 0 ? String(count > 999 ? '999+' : count) : '';
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: '#27d98b' });
  } catch (_) {}
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 扩展安装时初始化
chrome.runtime.onInstalled.addListener(() => {
  refreshBadge();
});
