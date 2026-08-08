// ISOLATED WORLD 内容脚本 — 中转消息 + 调试开关 + 页面浮窗
// 职责：
// 1. 监听 inject.js 的 usage 消息转发给 background
// 2. 转发 popup 的调试开关给 inject.js
// 3. 在顶层 frame 注入浮动小组件，实时显示今日 Token 消耗
(function () {
  'use strict';

  const isTopFrame = window === window.top;

  // ---------- 消息中继 ----------
  // inject.js → background
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
      // 实时更新浮窗
      if (isTopFrame) {
        updateWidgetWithUsage(data.payload);
      }
    }
  });

  // popup → inject.js（调试开关）+ 浮窗开关
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'TTW_DEBUG_TOGGLE') {
      window.postMessage({
        source: 'trae-token-watcher-content',
        type: 'debug-toggle',
        enabled: msg.enabled,
      }, '*');
    }

    if (msg?.type === 'TTW_WIDGET_TOGGLE') {
      if (msg.visible) {
        initWidget();
      } else {
        removeWidget();
      }
    }
  });

  // 通知 background 内容脚本已就绪
  try {
    chrome.runtime.sendMessage({ type: 'TTW_CONTENT_READY' });
  } catch (_) {}

  // 仅在顶层 frame 注入浮窗
  if (!isTopFrame) return;

  // ---------- 浮动小组件 ----------
  let widgetState = { visible: true, collapsed: false, x: null, y: null };
  let widgetHost = null;
  let widgetShadow = null;
  let todayData = {
    total: 0, input: 0, output: 0, cached: 0,
    credits: 0, count: 0, lastModel: '', lastTokens: 0,
  };
  let refreshTimer = null;

  // 扩展被重新加载/更新后，已注入页面的 chrome.* 绑定会失效
  // chrome.runtime.id 在 context 失效后变 undefined，用作探针
  function isContextValid() {
    return !!(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
  }

  function fmt(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function shortModel(m) {
    if (!m) return '—';
    return m.length > 22 ? m.slice(0, 22) + '…' : m;
  }

  async function initWidget() {
    if (!isContextValid()) return;
    try {
      const { ttw_widget_state: saved } = await chrome.storage.local.get('ttw_widget_state');
      if (saved) widgetState = { ...widgetState, ...saved };
    } catch (_) { /* context 失效，用默认 state */ }
    if (widgetState.visible === false) return;

    if (document.body) {
      createWidget();
      refreshWidgetData();
    } else {
      const observer = new MutationObserver(() => {
        if (document.body) {
          observer.disconnect();
          createWidget();
          refreshWidgetData();
        }
      });
      observer.observe(document.documentElement, { childList: true });
    }
  }

  function createWidget() {
    if (widgetHost) return;

    widgetHost = document.createElement('div');
    widgetHost.id = 'ttw-widget-host';
    widgetHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';

    // 定位：默认右上角
    const defaultX = window.innerWidth - 220;
    const defaultY = 80;
    widgetHost.style.left = (widgetState.x != null ? widgetState.x : defaultX) + 'px';
    widgetHost.style.top = (widgetState.y != null ? widgetState.y : defaultY) + 'px';

    widgetShadow = widgetHost.attachShadow({ mode: 'closed' });
    widgetShadow.innerHTML = `<style>${WIDGET_CSS}</style>${widgetHTML(widgetState.collapsed)}`;

    document.documentElement.appendChild(widgetHost);
    bindWidgetEvents();

    // 定时刷新（15 秒）
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refreshWidgetData, 15000);
  }

  function widgetHTML(collapsed) {
    return `
      <div class="widget ${collapsed ? 'collapsed' : ''}" id="widget">
        <div class="header" id="header">
          <span class="dot"></span>
          <span class="title">Token Watcher</span>
          <span class="spacer"></span>
          <button class="btn-min" id="btnMin" title="收起">−</button>
          <button class="btn-close" id="btnClose" title="关闭浮窗">×</button>
        </div>
        <div class="body" id="body">
          <div class="main-stat">
            <span class="main-val" id="mainVal">0</span>
            <span class="main-lbl">今日 Token</span>
          </div>
          <div class="stats">
            <div class="stat"><span class="sk in">↓ 输入</span><span class="sv" id="vIn">0</span></div>
            <div class="stat"><span class="sk out">↑ 输出</span><span class="sv" id="vOut">0</span></div>
            <div class="stat"><span class="sk">◈ 积分</span><span class="sv credits" id="vCredits">0.00</span></div>
            <div class="stat"><span class="sk">♻ 缓存</span><span class="sv" id="vCache">—</span></div>
            <div class="stat"><span class="sk">请求</span><span class="sv" id="vCount">0</span></div>
          </div>
          <div class="last-row">
            <span class="last-model" id="vModel" title="">—</span>
            <span class="last-tokens" id="vLastTok">—</span>
          </div>
        </div>
        <div class="collapsed-body" id="collBody">
          <span class="coll-val" id="collVal">0</span>
          <span class="coll-lbl">tokens</span>
        </div>
      </div>`;
  }

  const WIDGET_CSS = `
    * { margin:0; padding:0; box-sizing:border-box; }
    .widget {
      width: 196px;
      background: rgba(17,20,26,0.92);
      border: 1px solid rgba(42,47,58,0.8);
      border-radius: 10px;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
      overflow: hidden;
      font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
      font-size: 12px;
      color: #e8eaed;
      user-select: none;
      transition: width 0.2s ease;
    }
    .widget.collapsed { width: 76px; }
    .widget.collapsed .header,
    .widget.collapsed .body { display: none; }
    .widget.collapsed .collapsed-body { display: flex; }

    .header {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px;
      background: rgba(22,26,34,0.9);
      border-bottom: 1px solid rgba(42,47,58,0.6);
      cursor: move;
    }
    .dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #27d98b;
      box-shadow: 0 0 6px rgba(39,217,139,0.6);
      flex-shrink: 0;
    }
    .widget.flash .dot { animation: pulse 0.5s ease; }
    .widget.flash .main-val { color: #62a8ff; }
    .title {
      font-size: 11px; font-weight: 600;
      color: #9ca3af; letter-spacing: 0.3px;
    }
    .spacer { flex: 1; }
    .btn-min, .btn-close {
      background: none; border: none; color: #6b7280;
      font-size: 14px; cursor: pointer; padding: 0 2px;
      line-height: 1; transition: color 0.15s;
    }
    .btn-min:hover, .btn-close:hover { color: #e8eaed; }

    .body { padding: 10px 12px; }

    .main-stat {
      display: flex; flex-direction: column; align-items: center;
      margin-bottom: 8px; padding-bottom: 8px;
      border-bottom: 1px solid rgba(42,47,58,0.5);
    }
    .main-val {
      font-size: 22px; font-weight: 700; color: #27d98b;
      font-family: "SF Mono", "Cascadia Code", "Consolas", monospace;
      line-height: 1.1;
      transition: color 0.3s;
    }
    .main-lbl { font-size: 10px; color: #6b7280; margin-top: 2px; }

    .stats { display: flex; flex-direction: column; gap: 3px; }
    .stat { display: flex; justify-content: space-between; align-items: center; }
    .sk { font-size: 10px; color: #6b7280; }
    .sk.in { color: #62a8ff; }
    .sk.out { color: #27d98b; }
    .sv {
      font-size: 11px; font-weight: 600; color: #e8eaed;
      font-family: "SF Mono", "Cascadia Code", "Consolas", monospace;
    }
    .sv.credits { color: #e6a23c; }

    .last-row {
      margin-top: 6px; padding-top: 6px;
      border-top: 1px solid rgba(42,47,58,0.5);
      display: flex; justify-content: space-between; align-items: center;
      font-size: 10px; color: #6b7280;
    }
    .last-model {
      max-width: 120px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap;
    }
    .last-tokens { color: #9ca3af; font-family: monospace; }

    .collapsed-body {
      display: none;
      flex-direction: column; align-items: center; justify-content: center;
      padding: 10px 8px; cursor: pointer; gap: 1px;
    }
    .coll-val {
      font-size: 16px; font-weight: 700; color: #27d98b;
      font-family: "SF Mono", monospace; line-height: 1.1;
    }
    .coll-lbl { font-size: 9px; color: #6b7280; }

    @keyframes pulse {
      0%,100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
  `;

  function bindWidgetEvents() {
    const $ = (id) => widgetShadow.getElementById(id);
    const widget = $('widget');
    const header = $('header');

    // 收起 / 展开
    $('btnMin').addEventListener('click', (e) => {
      e.stopPropagation();
      widgetState.collapsed = !widgetState.collapsed;
      widget.classList.toggle('collapsed', widgetState.collapsed);
      saveWidgetState();
    });

    $('collBody').addEventListener('click', () => {
      widgetState.collapsed = false;
      widget.classList.remove('collapsed');
      saveWidgetState();
    });

    // 关闭
    $('btnClose').addEventListener('click', (e) => {
      e.stopPropagation();
      removeWidget();
      widgetState.visible = false;
      saveWidgetState();
    });

    // 拖拽
    let dragging = false;
    let offsetX = 0, offsetY = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true;
      const rect = widgetHost.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let x = e.clientX - offsetX;
      let y = e.clientY - offsetY;
      x = Math.max(0, Math.min(x, window.innerWidth - 60));
      y = Math.max(0, Math.min(y, window.innerHeight - 30));
      widgetHost.style.left = x + 'px';
      widgetHost.style.top = y + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      widgetState.x = parseInt(widgetHost.style.left, 10);
      widgetState.y = parseInt(widgetHost.style.top, 10);
      saveWidgetState();
    });
  }

  function removeWidget() {
    if (widgetHost) {
      widgetHost.remove();
      widgetHost = null;
      widgetShadow = null;
    }
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  async function saveWidgetState() {
    if (!isContextValid()) return; // 扩展已重载，旧 content script 不再能写存储
    try {
      await chrome.storage.local.set({ ttw_widget_state: widgetState });
    } catch (_) { /* context 失效，静默丢弃 */ }
  }

  // 从 background 获取今日汇总
  async function refreshWidgetData() {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'TTW_WIDGET_INIT' });
      if (resp && resp.summary) {
        todayData = resp.summary;
        renderWidget();
      }
    } catch (_) {}
  }

  // 实时更新：inject.js 捕获到新用量时立即调用
  function updateWidgetWithUsage(payload) {
    if (!widgetHost) return;

    todayData.total += payload.totalTokens || 0;
    todayData.input += payload.inputTokens || 0;
    todayData.output += payload.outputTokens || 0;
    todayData.cached += payload.cachedTokens || 0;
    todayData.credits += payload.credits || 0;
    todayData.count += 1;
    if (payload.model) todayData.lastModel = payload.model;
    todayData.lastTokens = payload.totalTokens || 0;

    renderWidget();

    // 闪烁效果
    const widget = widgetShadow?.getElementById('widget');
    if (widget) {
      widget.classList.add('flash');
      setTimeout(() => widget.classList.remove('flash'), 500);
    }
  }

  function renderWidget() {
    if (!widgetShadow) return;
    const $ = (id) => widgetShadow.getElementById(id);

    const mainVal = $('mainVal');
    if (!mainVal) return;

    mainVal.textContent = fmt(todayData.total);
    $('vIn').textContent = fmt(todayData.input);
    $('vOut').textContent = fmt(todayData.output);
    $('vCredits').textContent = (todayData.credits || 0).toFixed(2);

    const denom = todayData.input + todayData.cached;
    $('vCache').textContent = denom > 0
      ? ((todayData.cached / denom) * 100).toFixed(0) + '%'
      : '—';

    $('vCount').textContent = todayData.count;

    const modelEl = $('vModel');
    modelEl.textContent = shortModel(todayData.lastModel);
    modelEl.title = todayData.lastModel || '';

    $('vLastTok').textContent = todayData.lastTokens > 0 ? fmt(todayData.lastTokens) : '—';
    $('collVal').textContent = fmt(todayData.total);
  }

  // 启动浮窗
  initWidget();
})();
