// Options 页逻辑 — 集中管理所有配置 + 云端同步
import {
  loginWithGitHub, logout, refreshAuthStatus,
  getApiBase, setApiBase, isCustomApiBase, resetApiBase,
} from '../lib/auth.js';
import {
  clearAllRecords, exportRecords, getDistinctModels,
} from '../lib/db.js';
import {
  sync, push, pull, getStatus, resetRemote, resetLocalCursor,
  getAutoSyncEnabled, setAutoSyncEnabled,
} from '../lib/sync.js';

const DEEPSEEK_KEY = 'ttw_deepseek_key';
const DIAG_MODE_KEY = 'ttw_diag_default_mode';
const ALERT_CFG_KEY = 'ttw_alert_config';
const WIDGET_STATE_KEY = 'ttw_widget_state';
const DEBUG_KEY = 'ttw_debug';

// ---------- 工具 ----------
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function shortModel(m) {
  if (!m) return 'unknown';
  return m.length > 24 ? m.slice(0, 24) + '…' : m;
}
function csvEscape(s) {
  if (!s) return '';
  const str = String(s);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
function fmtSyncTime(ts) {
  if (!ts) return '从未';
  const d = new Date(ts * 1000);
  const diff = Date.now() - ts * 1000;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`;
}

// ---------- 账户 ----------
async function renderAccount() {
  const guest = document.getElementById('accountGuest');
  const user = document.getElementById('accountUser');
  const status = await refreshAuthStatus();

  if (status.authenticated) {
    guest.style.display = 'none';
    user.style.display = 'flex';
    document.getElementById('userLogin').textContent = status.login;
    document.getElementById('userAvatar').src = status.avatar || '';

    const starEl = document.getElementById('starStatus');
    if (status.starred) {
      starEl.className = 'account-star starred';
      starEl.textContent = '★ 已 Star · 享免费诊断';
    } else {
      starEl.className = 'account-star not-starred';
      starEl.innerHTML = '未 Star · <a href="https://github.com/soulor8908/trae-token-watcher" target="_blank">去 Star</a>';
    }
  } else {
    guest.style.display = 'flex';
    user.style.display = 'none';
  }
  await refreshSyncUI();
  await updateDiagModeTag();
}

// ---------- 后端 API 地址 ----------
// 默认走官方 Worker，自部署模式仅在「高级」折叠区配置
async function loadApiBase() {
  const custom = await isCustomApiBase();
  const input = document.getElementById('apiBase');
  input.value = custom ? await getApiBase() : '';
  await updateApiModeTag();
}
async function updateApiModeTag() {
  const custom = await isCustomApiBase();
  const tag = document.getElementById('apiModeTag');
  const hint = document.getElementById('apiModeHint');
  if (custom) {
    tag.textContent = '自部署';
    tag.className = 'tag tag-amber';
    hint.textContent = '走自定义 Worker，已脱离官方服务';
  } else {
    tag.textContent = '官方服务';
    tag.className = 'tag tag-green';
    hint.textContent = '默认由项目方提供，免配置';
  }
}
async function saveApiBase() {
  const url = document.getElementById('apiBase').value.trim().replace(/\/$/, '');
  if (url) {
    await setApiBase(url);
    setSyncHint('已切换为自部署后端：' + url);
  } else {
    await resetApiBase();
    setSyncHint('已清空自定义地址，恢复官方服务');
  }
  await updateApiModeTag();
  await refreshSyncUI();
  await updateDiagModeTag();
}
async function doResetApiBase() {
  await resetApiBase();
  document.getElementById('apiBase').value = '';
  setSyncHint('已恢复官方服务');
  await updateApiModeTag();
  await refreshSyncUI();
  await updateDiagModeTag();
}

// ---------- DeepSeek Key ----------
async function loadApiKey() {
  const { [DEEPSEEK_KEY]: key } = await chrome.storage.local.get(DEEPSEEK_KEY);
  if (key) document.getElementById('apiKey').value = key;
}
async function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  if (!key) { setSyncHint('请先输入 Key'); return; }
  await chrome.storage.local.set({ [DEEPSEEK_KEY]: key });
  setSyncHint('DeepSeek Key 已保存');
  await updateDiagModeTag();
}

// 诊断模式默认值
async function loadDiagMode() {
  const { [DIAG_MODE_KEY]: mode } = await chrome.storage.local.get(DIAG_MODE_KEY);
  const m = mode || 'quick';
  document.querySelectorAll('#diagModeToggle .seg').forEach((s) => {
    s.classList.toggle('active', s.dataset.mode === m);
  });
}
async function updateDiagModeTag() {
  const tag = document.getElementById('diagMode');
  const session = await refreshAuthStatus();
  const base = await getApiBase();
  if (session.authenticated && base) {
    tag.textContent = '路径 A · 后端转发';
    tag.className = 'tag tag-green';
  } else {
    tag.textContent = '路径 B · 自带 Key';
    tag.className = 'tag tag-amber';
  }
}

// ---------- 云端同步 ----------
async function refreshSyncUI() {
  const status = await getStatus();
  const tag = document.getElementById('syncStatusTag');
  const syncNowBtn = document.getElementById('syncNowBtn');

  document.getElementById('localCount').textContent = fmt(status.localCount || 0);
  document.getElementById('remoteCount').textContent = status.canSync ? fmt(status.remoteCount || 0) : '—';
  document.getElementById('lastSync').textContent = fmtSyncTime(status.lastSyncAt);

  if (status.canSync) {
    tag.textContent = '已连接';
    tag.className = 'tag tag-green';
    syncNowBtn.disabled = false;
  } else {
    tag.textContent = '未登录 / 未配置';
    tag.className = 'tag tag-gray';
    syncNowBtn.disabled = true;
  }

  // 自动同步开关
  const autoOn = await getAutoSyncEnabled();
  document.getElementById('autoSync').checked = autoOn;

  if (status.error) {
    setSyncHint(`状态查询失败：${status.error}`);
  }
}

function setSyncHint(text) {
  document.getElementById('syncHint').textContent = text;
}

async function doSync(only) {
  const btn = document.getElementById('syncNowBtn');
  btn.disabled = true;
  setSyncHint(only === 'pull' ? '正在拉取…' : only === 'push' ? '正在上传…' : '正在同步…');
  try {
    const r = await (only === 'pull' ? pull() : only === 'push' ? push() : sync());
    const parts = [];
    if (r.pushed != null) parts.push(`上传 ${r.pushed} 条`);
    if (r.imported != null) parts.push(`拉取 ${r.imported} 条`);
    if (r.skipped) parts.push(`跳过 ${r.skipped} 条`);
    setSyncHint(parts.length ? `同步完成：${parts.join('，')}` : '已是最新');
  } catch (e) {
    setSyncHint(`同步失败：${e.message}`);
  } finally {
    btn.disabled = false;
    await refreshSyncUI();
  }
}

async function doSyncReset() {
  if (!confirm('确定清空云端所有用量记录？此操作不可恢复，且会影响所有设备。')) return;
  setSyncHint('正在重置云端…');
  try {
    await resetRemote();
    setSyncHint('云端数据已清空，本地游标已重置');
  } catch (e) {
    setSyncHint(`重置失败：${e.message}`);
  } finally {
    await refreshSyncUI();
  }
}

// ---------- 预警 ----------
async function loadAlertConfig() {
  const { [ALERT_CFG_KEY]: cfg } = await chrome.storage.local.get(ALERT_CFG_KEY);
  if (cfg) {
    document.getElementById('alertEnabled').checked = cfg.enabled || false;
    document.getElementById('dailyCreditLimit').value = cfg.dailyCreditLimit || '';
    document.getElementById('dailyTokenLimit').value = cfg.dailyTokenLimit || '';
    document.getElementById('monthlyCreditLimit').value = cfg.monthlyCreditLimit || '';
  }
}
async function saveAlertConfig() {
  const cfg = {
    enabled: document.getElementById('alertEnabled').checked,
    dailyCreditLimit: parseFloat(document.getElementById('dailyCreditLimit').value) || 0,
    dailyTokenLimit: parseInt(document.getElementById('dailyTokenLimit').value, 10) || 0,
    monthlyCreditLimit: parseFloat(document.getElementById('monthlyCreditLimit').value) || 0,
  };
  await chrome.storage.local.set({ [ALERT_CFG_KEY]: cfg });
  setSyncHint('预警设置已保存');
}

// ---------- 显示 ----------
async function loadDisplaySettings() {
  const { [WIDGET_STATE_KEY]: ws } = await chrome.storage.local.get(WIDGET_STATE_KEY);
  document.getElementById('widgetToggle').checked = ws ? ws.visible !== false : true;

  const { [DEBUG_KEY]: dbg } = await chrome.storage.local.get(DEBUG_KEY);
  document.getElementById('debugToggle').checked = !!dbg;
}
async function toggleWidget(on) {
  const { [WIDGET_STATE_KEY]: ws } = await chrome.storage.local.get(WIDGET_STATE_KEY);
  await chrome.storage.local.set({ [WIDGET_STATE_KEY]: { ...(ws || {}), visible: on } });
  chrome.tabs.query({ url: ['https://*.trae.cn/*'] }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'TTW_WIDGET_TOGGLE', visible: on }).catch(() => {});
    }
  });
}
async function toggleDebug(on) {
  await chrome.storage.local.set({ [DEBUG_KEY]: on });
  chrome.runtime.sendMessage({ type: 'TTW_DEBUG_TOGGLE', enabled: on });
}

// ---------- 数据导出 ----------
let exportFormat = 'csv';

async function refreshExportModels() {
  const models = await getDistinctModels();
  const select = document.getElementById('exportModel');
  const current = select.value;
  select.innerHTML = '<option value="all" selected>全部模型</option>' +
    models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(shortModel(m))}</option>`).join('');
  if (models.includes(current)) select.value = current;
}

function getExportFilter() {
  const range = document.getElementById('exportRange').value;
  const model = document.getElementById('exportModel').value;
  const now = Date.now();
  const dayMs = 86400000;
  let since = 0;
  if (range === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0); since = d.getTime();
  } else if (range === 'week') {
    since = now - 7 * dayMs;
  } else if (range === 'month') {
    since = now - 30 * dayMs;
  }
  return { since, until: now, model };
}

async function updateExportPreview() {
  const filter = getExportFilter();
  const { summary } = await exportRecords(filter);
  document.getElementById('exportPreview').innerHTML = `
    <div class="ep-row"><span>记录数</span><span>${summary.count}</span></div>
    <div class="ep-row"><span>总 Token</span><span>${fmt(summary.totalTokens)}</span></div>
    <div class="ep-row"><span>输入 / 输出</span><span>${fmt(summary.inputTokens)} / ${fmt(summary.outputTokens)}</span></div>
    <div class="ep-row"><span>缓存命中</span><span>${fmt(summary.cachedTokens)}</span></div>
    <div class="ep-row"><span>积分 / 费用</span><span>◈${summary.credits.toFixed(2)} / ¥${summary.costMoney.toFixed(3)}</span></div>
    <div class="ep-row"><span>会话数</span><span>${summary.sessions}</span></div>
  `;
}

async function exportDownload() {
  const filter = getExportFilter();
  const { records, summary } = await exportRecords(filter);
  if (records.length === 0) { alert('当前筛选条件下无数据可导出'); return; }

  let content = '', filename = '', mime = '';
  if (exportFormat === 'csv') {
    content = recordsToCSV(records, summary);
    filename = `trae-tokens-${new Date().toISOString().slice(0, 10)}.csv`;
    mime = 'text/csv;charset=utf-8';
  } else {
    content = JSON.stringify({ summary, records }, null, 2);
    filename = `trae-tokens-${new Date().toISOString().slice(0, 10)}.json`;
    mime = 'application/json;charset=utf-8';
  }
  const blob = new Blob(['\uFEFF' + content], { type: mime });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
}

function recordsToCSV(records, summary) {
  const headers = ['时间', '模型', '输入Token', '输出Token', '缓存Token', '缓存写入Token', '总Token', '积分', '费用', '会话ID', '来源', '提问预览', 'URL'];
  const lines = [headers.join(',')];
  for (const r of records) {
    lines.push([
      new Date(r.timestamp).toISOString(),
      csvEscape(r.model || ''),
      r.inputTokens || 0, r.outputTokens || 0, r.cachedTokens || 0, r.cacheWriteTokens || 0, r.totalTokens || 0,
      r.credits != null ? r.credits.toFixed(4) : '',
      r.costMoney != null ? r.costMoney.toFixed(4) : '',
      csvEscape(r.conversationId || ''), csvEscape(r.source || ''),
      csvEscape(r.userInputPreview || ''), csvEscape(r.url || ''),
    ].join(','));
  }
  lines.push('');
  lines.push(`# 汇总,记录数:${summary.count},总Token:${summary.totalTokens},输入:${summary.inputTokens},输出:${summary.outputTokens},缓存:${summary.cachedTokens},积分:${summary.credits.toFixed(2)},费用:${summary.costMoney.toFixed(3)},会话数:${summary.sessions}`);
  lines.push(`# 导出时间,${summary.exportTime}`);
  return lines.join('\n');
}

// ---------- 清空本地 ----------
async function clearLocalData() {
  if (!confirm('确定清空所有本地 Token 用量记录？此操作不可恢复。')) return;
  await clearAllRecords();
  // 重置同步游标，让下次能全量从云端拉取
  await resetLocalCursor();
  setSyncHint('本地数据已清空，同步游标已重置');
  await refreshSyncUI();
}

// ---------- 事件绑定 ----------
document.getElementById('loginBtn').addEventListener('click', async () => {
  try { await loginWithGitHub(); } catch (e) { setSyncHint(e.message); }
});
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await logout();
  await renderAccount();
});

document.getElementById('saveApiBase').addEventListener('click', saveApiBase);
document.getElementById('apiBase').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveApiBase(); });
document.getElementById('resetApiBase').addEventListener('click', doResetApiBase);
document.getElementById('saveKey').addEventListener('click', saveApiKey);
document.getElementById('apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveApiKey(); });

document.getElementById('diagModeToggle').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg');
  if (!seg) return;
  document.querySelectorAll('#diagModeToggle .seg').forEach((s) => s.classList.toggle('active', s === seg));
  chrome.storage.local.set({ [DIAG_MODE_KEY]: seg.dataset.mode });
});

document.getElementById('autoSync').addEventListener('change', async (e) => {
  await setAutoSyncEnabled(e.target.checked);
  setSyncHint(e.target.checked ? '已开启自动同步' : '已关闭自动同步');
});

document.getElementById('syncNowBtn').addEventListener('click', () => doSync());
document.getElementById('syncPullBtn').addEventListener('click', () => doSync('pull'));
document.getElementById('syncPushBtn').addEventListener('click', () => doSync('push'));
document.getElementById('syncResetBtn').addEventListener('click', doSyncReset);

document.getElementById('saveAlert').addEventListener('click', saveAlertConfig);

document.getElementById('widgetToggle').addEventListener('change', (e) => toggleWidget(e.target.checked));
document.getElementById('debugToggle').addEventListener('change', (e) => toggleDebug(e.target.checked));

document.getElementById('formatToggle').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg');
  if (!seg) return;
  exportFormat = seg.dataset.fmt;
  document.querySelectorAll('#formatToggle .seg').forEach((s) => s.classList.toggle('active', s === seg));
  updateExportPreview();
});
document.getElementById('exportRange').addEventListener('change', updateExportPreview);
document.getElementById('exportModel').addEventListener('change', updateExportPreview);
document.getElementById('exportDownload').addEventListener('click', exportDownload);

document.getElementById('clearBtn').addEventListener('click', clearLocalData);

document.getElementById('backToPopup').addEventListener('click', () => {
  window.close();
});

// 监听 storage 变化（OAuth 回调写入 session 后刷新）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ttw_session) {
    renderAccount();
  }
});

// ---------- 初始化 ----------
(async function init() {
  await loadApiBase();
  await loadApiKey();
  await loadDiagMode();
  await loadAlertConfig();
  await loadDisplaySettings();
  await renderAccount();
  await refreshExportModels();
  await updateExportPreview();
})();
