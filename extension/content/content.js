// ISOLATED WORLD 内容脚本 — 中转 postMessage 到 background
// 职责单一：监听主世界 inject.js 的消息，转发给 background 存储
(function () {
  'use strict';

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'trae-token-watcher-inject') return;

    if (data.type === 'usage' && data.payload) {
      try {
        chrome.runtime.sendMessage({ type: 'TTW_USAGE', payload: data.payload });
      } catch (_) {
        // service worker 可能休眠，忽略偶发错误
      }
    }
  });

  // 通知 background 内容脚本已就绪（用于更新 badge 计数）
  try {
    chrome.runtime.sendMessage({ type: 'TTW_CONTENT_READY' });
  } catch (_) {}
})();
