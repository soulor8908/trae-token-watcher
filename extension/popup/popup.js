// Popup 仪表盘逻辑 — 渲染统计、趋势、记录；AI 诊断（路径 A 优先，回退 B）
import { getSummary, getAllRecords, predictUsage, checkAlert, getComparison, addDiagnosis, getDiagnoses, deleteDiagnosis, clearDiagnoses } from '../lib/db.js';
import { loginWithGitHub, logout, refreshAuthStatus, refreshStarStatus, getSession, getApiBase, diagnose as diagnoseViaApi } from '../lib/auth.js';

// ---------- 工具函数 ----------
function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (d.toDateString() === now.toDateString()) {
    return d.toTimeString().slice(0, 5);
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toTimeString().slice(0, 5)}`;
}

function shortModel(model) {
  if (!model) return 'unknown';
  return model.length > 24 ? model.slice(0, 24) + '…' : model;
}

// 缓存命中率 = cachedTokens / (inputTokens + cachedTokens)，与 db.js computeCacheRate 保持一致
function cacheRateOf(input, cached) {
  const denom = (input || 0) + (cached || 0);
  if (denom <= 0) return null;
  return cached / denom;
}

// 渲染缓存命中率小标签（按命中率高低配色：高=绿 / 中=琥珀 / 低=红）
function cacheRateChip(input, cached) {
  const rate = cacheRateOf(input, cached);
  if (rate == null) return '';
  const pct = Math.round(rate * 100);
  const cls = rate >= 0.5 ? 'hi' : rate >= 0.2 ? 'mid' : 'lo';
  return `<span class="tok cache-rate ${cls}" title="缓存命中率 = 缓存 / (输入+缓存) = ${pct}%">♻${pct}%</span>`;
}

function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => resolve(resp));
  });
}

// ---------- 渲染汇总 ----------
// 缓存 summary 供 Tab 切换复用，避免重复查询 IndexedDB
let cachedSummary = null;
let modelMetric = 'tokens'; // 'tokens' | 'cost'

async function renderSummary() {
  const summary = await getSummary();
  cachedSummary = summary;
  const { buckets, trend, byModel, bySession, cacheStats, totalRecords } = summary;

  // 汇总卡片（带数字动画）
  animateNum('todayTotal', buckets.today.total);
  animateNum('weekTotal', buckets.week.total);
  animateNum('monthTotal', buckets.month.total);
  document.getElementById('todayCount').textContent = `${buckets.today.count} 次请求`;
  document.getElementById('weekCount').textContent = `${buckets.week.count} 次请求`;
  document.getElementById('monthCount').textContent = `${buckets.month.count} 次请求`;

  // 积分/费用统计
  document.getElementById('todayCredits').textContent = `◈ ${buckets.today.credits.toFixed(2)} 积分 / ¥${buckets.today.costMoney.toFixed(3)}`;
  document.getElementById('weekCredits').textContent = `◈ ${buckets.week.credits.toFixed(2)} 积分 / ¥${buckets.week.costMoney.toFixed(3)}`;
  document.getElementById('monthCredits').textContent = `◈ ${buckets.month.credits.toFixed(2)} 积分 / ¥${buckets.month.costMoney.toFixed(3)}`;

  // 状态指示
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  if (totalRecords > 0) {
    statusDot.classList.add('active');
    statusText.textContent = `共 ${totalRecords} 条记录`;
  } else {
    statusDot.classList.remove('active');
    statusText.textContent = '等待数据';
  }

  // 趋势图
  renderChart(trend);

  // 缓存命中率
  renderCacheStats(cacheStats, buckets);

  // 模型成本对比
  renderModelCompare(byModel);

  // 按模型缓存率
  renderCacheByModel(cacheStats);

  // 会话级明细（定时刷新保留已加载的分页状态，避免被清空）
  renderSessions(bySession, { preserve: true });

  // 最近记录
  const records = await getAllRecords(20);
  renderRecords(records);

  // 用量预测
  renderPrediction(await predictUsage());

  // 周期对比
  renderComparison(await getComparison());

  // 预警检查
  renderAlert(await checkAlert());
}

function animateNum(id, target) {
  const el = document.getElementById(id);
  const start = parseInt(el.dataset.val || '0', 10);
  const duration = 400;
  const startTime = performance.now();
  function step(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const val = Math.round(start + (target - start) * easeOut(t));
    el.textContent = fmt(val);
    if (t < 1) requestAnimationFrame(step);
    else el.dataset.val = String(target);
  }
  requestAnimationFrame(step);
}
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

// ---------- 渲染增量守卫 ----------
// 每次定时刷新若数据未变化则跳过 DOM 重建，避免界面闪烁（整页闪一下）与
// 状态（记录展开、会话滚动/分页、模型视图等）被重置。
const _renderSigs = Object.create(null);
function renderChanged(key, data) {
  let sig;
  try {
    sig = (typeof data === 'string' || typeof data === 'number' || typeof data === 'boolean')
      ? String(data)
      : JSON.stringify(data);
  } catch (_) {
    sig = 'n/a';
  }
  if (_renderSigs[key] === sig) return false; // 未变化，跳过重建
  _renderSigs[key] = sig;
  return true; // 首次渲染或数据已变化
}

// ---------- 趋势图 ----------
function renderChart(trend) {
  if (!renderChanged('chart', trend)) return;
  const chart = document.getElementById('chart');
  if (!trend || trend.length === 0) {
    chart.innerHTML = '<div class="chart-empty">暂无趋势数据</div>';
    return;
  }

  const maxTotal = Math.max(...trend.map((d) => d.input + d.output), 1);
  chart.innerHTML = trend.map((d) => {
    const inH = (d.input / maxTotal) * 100;
    const outH = (d.output / maxTotal) * 100;
    const dateLabel = d.date.slice(5); // MM-DD
    return `
      <div class="chart-bar" title="${d.date}\n输入: ${fmt(d.input)}\n输出: ${fmt(d.output)}\n${d.count} 次">
        <div class="bars">
          <div class="seg in" style="height:${inH}%"></div>
          <div class="seg out" style="height:${outH}%"></div>
        </div>
        <span class="lbl">${dateLabel}</span>
      </div>`;
  }).join('');
}

// ---------- 缓存命中率 ----------
function renderCacheStats(cacheStats, buckets) {
  if (!renderChanged('cacheStats', [cacheStats, buckets])) return;
  if (!cacheStats) return;
  const rate = cacheStats.overall || 0;
  const pct = (rate * 100).toFixed(1);
  document.getElementById('cacheRate').textContent = pct + '%';

  // 环形图：周长 2πr = 2π*32 ≈ 201.06
  const circumference = 2 * Math.PI * 32;
  const ring = document.getElementById('ringFg');
  ring.style.strokeDasharray = circumference;
  ring.style.strokeDashoffset = circumference * (1 - rate);

  document.getElementById('cacheToday').textContent = ((cacheStats.today || 0) * 100).toFixed(1) + '%';
  document.getElementById('cacheTotalTok').textContent = fmt(buckets.all.cached || 0);

  // 估算节省：缓存 token 按输入单价折算积分
  // 单位积分 = totalCredits / totalInputTokens（粗略估算）
  const allInput = buckets.all.input || 0;
  const allCredits = buckets.all.credits || 0;
  const perTokenCredit = allInput > 0 ? allCredits / allInput : 0;
  const saved = (buckets.all.cached || 0) * perTokenCredit;
  document.getElementById('cacheSaved').textContent = `◈ ${saved.toFixed(2)}`;
  document.getElementById('cacheHint').textContent = saved > 0 ? `省 ≈ ${saved.toFixed(1)} 积分` : '';
}

// ---------- 按模型缓存率 ----------
function renderCacheByModel(cacheStats) {
  if (!renderChanged('cacheByModel', cacheStats ? cacheStats.byModel : null)) return;
  const container = document.getElementById('cacheByModel');
  const list = cacheStats?.byModel || [];
  if (list.length === 0) {
    container.innerHTML = '<div class="empty">暂无缓存数据</div>';
    return;
  }
  const sorted = [...list].sort((a, b) => b.rate - a.rate);
  container.innerHTML = sorted.map((m) => {
    const pct = (m.rate * 100).toFixed(1);
    return `
      <div class="cbm-row">
        <span class="cbm-name" title="${escapeHtml(m.model)}">${escapeHtml(shortModel(m.model))}</span>
        <div class="cbm-bar"><div class="cbm-fill" style="width:${pct}%"></div></div>
        <span class="cbm-val">${pct}%</span>
      </div>`;
  }).join('');
}

// ---------- 模型成本对比 ----------
function renderModelCompare(byModel) {
  if (!renderChanged('modelCompare', { m: byModel, v: modelMetric })) return;
  const container = document.getElementById('modelCompare');
  if (!byModel || byModel.length === 0) {
    container.innerHTML = '<div class="empty">暂无模型数据</div>';
    return;
  }

  const colors = ['var(--accent)', 'var(--accent2)', 'var(--amber)', 'var(--purple)', '#38b2ac'];

  if (modelMetric === 'tokens') {
    // Token 视图：堆叠条（输入/输出/缓存）
    const maxTotal = Math.max(...byModel.map((m) => m.input + m.output + m.cached), 1);
    container.innerHTML = byModel.slice(0, 6).map((m, i) => {
      const inPct = (m.input / maxTotal) * 100;
      const outPct = (m.output / maxTotal) * 100;
      const cachePct = (m.cached / maxTotal) * 100;
      const color = colors[i % colors.length];
      return `
        <div class="mc-row">
          <div class="mc-info">
            <span class="mc-name" title="${escapeHtml(m.model)}">${escapeHtml(shortModel(m.model))}</span>
            <span class="mc-count">${m.count} 次</span>
          </div>
          <div class="mc-stack" title="输入 ${fmt(m.input)} / 输出 ${fmt(m.output)} / 缓存 ${fmt(m.cached)}">
            <div class="mc-seg in" style="width:${inPct}%"></div>
            <div class="mc-seg out" style="width:${outPct}%"></div>
            <div class="mc-seg cache" style="width:${cachePct}%"></div>
          </div>
          <span class="mc-val">Σ${fmt(m.total)}</span>
        </div>`;
    }).join('');
  } else {
    // 成本视图：按积分对比
    const maxCredits = Math.max(...byModel.map((m) => m.credits || 0), 0.01);
    container.innerHTML = byModel.slice(0, 6).map((m, i) => {
      const pct = ((m.credits || 0) / maxCredits) * 100;
      const color = colors[i % colors.length];
      return `
        <div class="mc-row">
          <div class="mc-info">
            <span class="mc-name" title="${escapeHtml(m.model)}">${escapeHtml(shortModel(m.model))}</span>
            <span class="mc-count">${m.count} 次</span>
          </div>
          <div class="mc-bar-single">
            <div class="mc-fill-cost" style="width:${pct}%;background:${color}"></div>
          </div>
          <span class="mc-val" style="color:#d69e2e">◈${(m.credits || 0).toFixed(2)}</span>
        </div>`;
    }).join('');
  }
}

// ---------- 会话级明细（滚动到底自动加载更多，最多展示近一个月）----------
const SESSION_PAGE = 30;        // 每批渲染条数
const SESSION_MONTH_DAYS = 30;  // 明细最多覆盖的天数
let _sessData = [];             // 近一个月内、按 lastActive 降序的全部会话
let _sessMaxTotal = 1;          // 进度条百分比基准（一个月范围内的最大值）
let _sessRendered = 0;          // 已渲染条数
let _sessObserver = null;       // 底部 sentinel 的 IntersectionObserver

function renderSessions(bySession, opts = {}) {
  const container = document.getElementById('sessionList');
  const hint = document.getElementById('sessionHint');
  if (!bySession || bySession.length === 0) {
    container.innerHTML = '<div class="empty">暂无会话数据</div>';
    if (hint) hint.textContent = '';
    return;
  }

  const oneMonthAgo = Date.now() - SESSION_MONTH_DAYS * 24 * 60 * 60 * 1000;
  const nextData = bySession.filter((s) => (s.lastActive || 0) >= oneMonthAgo);
  const maxTotal = nextData.reduce((m, s) => Math.max(m, s.total), 1);

  // 定时刷新（preserve）且已经渲染过分页：保留已加载的分页与 DOM，
  // 避免 renderSummary 每 5 秒重渲染把已滚动加载的内容清空 / 造成闪烁
  if (opts.preserve && _sessData.length > 0 && container.querySelector('.sess-row')) {
    _sessData = nextData;
    _sessMaxTotal = maxTotal;
    if (hint) {
      hint.textContent = _sessData.length === bySession.length
        ? `共 ${_sessData.length} 个会话（近一个月）`
        : `近一个月 ${_sessData.length} 个会话（全部 ${bySession.length} 个）`;
    }
    updateSessionSentinel();
    return;
  }

  // 首次 / 硬渲染：重建（重置分页）
  _sessData = nextData;
  _sessMaxTotal = maxTotal;
  _sessRendered = 0;

  // 清理旧 observer，避免监听残留
  if (_sessObserver) { _sessObserver.disconnect(); _sessObserver = null; }

  if (hint) {
    hint.textContent = _sessData.length === bySession.length
      ? `共 ${_sessData.length} 个会话（近一个月）`
      : `近一个月 ${_sessData.length} 个会话（全部 ${bySession.length} 个）`;
  }

  // 近一个月内无任何会话
  if (_sessData.length === 0) {
    container.innerHTML = '<div class="empty">最近一个月内暂无会话数据</div>';
    return;
  }

  // 重建容器 + 底部 sentinel（用于无限滚动）
  container.innerHTML = '';
  const sentinel = document.createElement('div');
  sentinel.id = 'sessionSentinel';
  sentinel.className = 'sess-sentinel';
  container.appendChild(sentinel);

  setupSessionObserver(sentinel);
  renderSessionChunk(); // 渲染首批
}

function buildSessRow(s) {
  const pct = (_sessMaxTotal ? (s.total / _sessMaxTotal) * 100 : 0);
  const modelTxt = s.model ? `<span class="sess-model">${escapeHtml(shortModel(s.model))}</span>` : '';
  return `
    <div class="sess-row" data-sid="${escapeHtml(s.sessionId)}">
      <div class="sess-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title.slice(0, 40))}</div>
      <div class="sess-meta">
        ${modelTxt}
        <span class="sess-time">${fmtTime(s.lastActive)}</span>
        <span class="sess-count">${s.count} 次</span>
      </div>
      <div class="sess-bar"><div class="sess-fill" style="width:${pct}%"></div></div>
      <div class="sess-stats">
        <span class="tok in">↓${fmt(s.input)}</span>
        <span class="tok out">↑${fmt(s.output)}</span>
        <span class="tok total">Σ${fmt(s.total)}</span>
        ${cacheRateChip(s.input, s.cached)}
        ${s.credits > 0 ? `<span class="tok credits">◈${s.credits.toFixed(2)}</span>` : ''}
      </div>
    </div>`;
}

// 追加下一批会话行（插入到 sentinel 之前）
function renderSessionChunk() {
  const container = document.getElementById('sessionList');
  const sentinel = document.getElementById('sessionSentinel');
  if (!container || !sentinel) return;
  const next = _sessData.slice(_sessRendered, _sessRendered + SESSION_PAGE);
  if (next.length === 0) { updateSessionSentinel(); return; }
  sentinel.insertAdjacentHTML('beforebegin', next.map(buildSessRow).join(''));
  _sessRendered += next.length;
  updateSessionSentinel();
}

function updateSessionSentinel() {
  const sentinel = document.getElementById('sessionSentinel');
  if (!sentinel) return;
  if (_sessRendered >= _sessData.length) {
    sentinel.textContent = '已加载最近一个月全部会话明细';
    sentinel.classList.add('done');
    if (_sessObserver) _sessObserver.disconnect();
  } else {
    sentinel.textContent = '滚动加载更多…';
    sentinel.classList.remove('done');
    if (_sessObserver) _sessObserver.observe(sentinel);
  }
}

function setupSessionObserver(sentinel) {
  if (_sessObserver) _sessObserver.disconnect();
  _sessObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        // 下一帧再渲染，避免与本轮 DOM 变更同步重入
        requestAnimationFrame(() => renderSessionChunk());
      }
    }
  }, { root: null, rootMargin: '120px', threshold: 0 });
  _sessObserver.observe(sentinel);
}

// ---------- 用量预测 ----------
function renderPrediction(pred) {
  if (!renderChanged('prediction', pred)) return;
  const detail = document.getElementById('predictDetail');
  if (!pred.available) {
    document.getElementById('todayUsed').textContent = '—';
    document.getElementById('predict7d').textContent = '—';
    document.getElementById('predict30d').textContent = '—';
    document.getElementById('todayUsedTok').textContent = '';
    document.getElementById('predict7dTok').textContent = '';
    document.getElementById('predict30dTok').textContent = '';
    detail.innerHTML = `<div class="empty">${pred.reason}</div>`;
    document.getElementById('trendBadge').textContent = '—';
    document.getElementById('trendBadge').className = 'trend-badge';
    return;
  }

  document.getElementById('todayUsed').textContent = `◈${pred.todayUsed.credits.toFixed(2)}`;
  document.getElementById('todayUsedTok').textContent = `${fmt(pred.todayUsed.tokens)} tokens / ${pred.todayUsed.count} 次`;
  document.getElementById('predict7d').textContent = `◈${pred.predicted7d.credits.toFixed(2)}`;
  document.getElementById('predict7dTok').textContent = `${fmt(pred.predicted7d.tokens)} tokens`;
  document.getElementById('predict30d').textContent = `◈${pred.predicted30d.credits.toFixed(2)}`;
  document.getElementById('predict30dTok').textContent = `${fmt(pred.predicted30d.tokens)} tokens`;

  // 趋势标签
  const trendBadge = document.getElementById('trendBadge');
  const trendMap = {
    up: { txt: '↗ 上升', cls: 'trend-up' },
    down: { txt: '↘ 下降', cls: 'trend-down' },
    stable: { txt: '→ 平稳', cls: 'trend-stable' },
  };
  const t = trendMap[pred.trendDirection] || trendMap.stable;
  trendBadge.textContent = `${t.txt} ${(pred.trendMultiplier * 100).toFixed(0)}%`;
  trendBadge.className = `trend-badge ${t.cls}`;

  // 详细信息
  detail.innerHTML = `
    <div class="pd-row"><span>日均</span><span>${fmt(pred.avgDailyTokens)} tok / ◈${pred.avgDailyCredits} / ${pred.avgDailyCount} 次</span></div>
    <div class="pd-row"><span>预测日均</span><span>${fmt(pred.predictedDailyTokens)} tok / ◈${pred.predictedDailyCredits}</span></div>
    <div class="pd-row"><span>历史样本</span><span>${pred.historyDays} 天</span></div>
  `;
}

// ---------- 预警检查 ----------
async function renderAlert(alertResult) {
  if (!renderChanged('alert', alertResult)) return;
  const banner = document.getElementById('alertBanner');
  const textEl = document.getElementById('alertText');

  if (alertResult.triggered) {
    const messages = alertResult.triggers.map((t) => t.message);
    textEl.textContent = messages.join('；');
    banner.style.display = 'flex';
    banner.className = 'alert-banner ' + (alertResult.triggers.some((t) => t.level === 'danger') ? 'danger' : 'warning');
  } else {
    banner.style.display = 'none';
  }
}

// ---------- 周期对比 ----------
function renderComparison(comp) {
  if (!renderChanged('comparison', comp)) return;
  const grid = document.getElementById('compareGrid');
  const hint = document.getElementById('compareHint');
  if (!comp || !comp.ranges || comp.ranges.length === 0) {
    grid.innerHTML = '<div class="empty">暂无对比数据</div>';
    if (hint) hint.textContent = '';
    return;
  }

  // 判断是否有可用数据（当前或上一个周期任一有数据）
  const hasData = comp.ranges.some((r) => r.current.count > 0 || r.previous.count > 0);
  if (!hasData) {
    grid.innerHTML = '<div class="empty">暂无对比数据</div>';
    if (hint) hint.textContent = '';
    return;
  }

  if (hint) hint.textContent = '环比变化';

  grid.innerHTML = comp.ranges.map((r) => {
    const cur = r.current;
    const prev = r.previous;
    const ch = r.changes;
    return `
      <div class="cmp-card">
        <div class="cmp-head">
          <span class="cmp-label">${escapeHtml(r.label)}环比</span>
          ${changeBadge(ch.tokens)}
        </div>
        <div class="cmp-rows">
          <div class="cmp-row">
            <span class="cmp-k">Token</span>
            <span class="cmp-v">${fmt(cur.tokens)}</span>
            <span class="cmp-prev">前 ${fmt(prev.tokens)}</span>
          </div>
          <div class="cmp-row">
            <span class="cmp-k">积分</span>
            <span class="cmp-v credits">◈${cur.credits.toFixed(2)}</span>
            <span class="cmp-prev">前 ◈${prev.credits.toFixed(2)}</span>
          </div>
          <div class="cmp-row">
            <span class="cmp-k">请求</span>
            <span class="cmp-v">${cur.count}</span>
            <span class="cmp-prev">前 ${prev.count}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

// 变化徽章：上升红色（消耗增加），下降绿色（节省），新增紫色
function changeBadge(pct) {
  if (pct == null) return '<span class="cmp-chg new">NEW</span>';
  if (pct === 0) return '<span class="cmp-chg flat">→</span>';
  const isUp = pct > 0;
  const abs = Math.abs(pct * 100);
  const txt = (isUp ? '↑' : '↓') + (abs >= 100 ? Math.round(abs) + '%' : abs.toFixed(0) + '%');
  const cls = isUp ? 'up' : 'down';
  return `<span class="cmp-chg ${cls}">${txt}</span>`;
}

// ---------- 预警检查（阈值在设置页配置）----------
function sourceTag(source) {
  // 数据来源标签
  const map = {
    'fetch-header': { txt: '响应头', cls: 'src-header' },
    'fetch-body': { txt: '响应体', cls: 'src-body' },
    'xhr-header': { txt: '响应头', cls: 'src-header' },
    'xhr-body': { txt: '响应体', cls: 'src-body' },
    'websocket': { txt: 'WS', cls: 'src-ws' },
    'bulk-usage': { txt: '批量', cls: 'src-bulk' },
  };
  const m = map[source] || { txt: source || '未知', cls: 'src-other' };
  return `<span class="src-tag ${m.cls}">${m.txt}</span>`;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return (u.host + path).slice(0, 60);
  } catch (_) {
    return String(url).slice(0, 60);
  }
}

function renderRecords(records) {
  if (!renderChanged('records', records)) return;
  const container = document.getElementById('records');
  if (!records || records.length === 0) {
    container.innerHTML = '<div class="empty">暂无记录，打开 work.trae.cn 开始对话即可采集</div>';
    return;
  }
  container.innerHTML = records.map((r, i) => {
    const cachedTxt = r.cachedTokens > 0 ? `<span class="tok cached" title="缓存命中 token">♻${fmt(r.cachedTokens)}</span>` : '';
    const cacheWTxt = r.cacheWriteTokens > 0 ? `<span class="tok cache-w" title="缓存写入 token">⤓${fmt(r.cacheWriteTokens)}</span>` : '';
    const creditsTxt = r.credits != null ? `<span class="tok credits" title="消耗积分">◈${r.credits.toFixed(2)}</span>` : '';
    const costTxt = r.costMoney != null ? `<span class="tok cost" title="费用 $">¥${r.costMoney.toFixed(3)}</span>` : '';
    const remainTxt = r.remaining != null ? `<span class="tok remain" title="剩余额度">余额 ${fmt(r.remaining)}</span>` : '';

    // 展开详情
    const convTxt = r.conversationId ? `<div class="detail-row"><span class="detail-k">会话</span><span class="detail-v" title="${escapeHtml(r.conversationId)}">${escapeHtml(String(r.conversationId).slice(0, 40))}</span></div>` : '';
    const urlTxt = r.url ? `<div class="detail-row"><span class="detail-k">URL</span><span class="detail-v" title="${escapeHtml(r.url)}">${escapeHtml(shortUrl(r.url))}</span></div>` : '';
    const previewTxt = r.userInputPreview ? `<div class="detail-row"><span class="detail-k">提问</span><span class="detail-v preview" title="${escapeHtml(r.userInputPreview)}">${escapeHtml(r.userInputPreview.slice(0, 60))}</span></div>` : '';
    const costDetailTxt = (r.credits != null || r.costMoney != null) ? `<div class="detail-row"><span class="detail-k">费用</span><span class="detail-v">${r.credits != null ? r.credits.toFixed(2) + ' 积分' : ''}${r.costMoney != null ? ' / ¥' + r.costMoney.toFixed(3) : ''}</span></div>` : '';

    return `
    <div class="record" data-idx="${i}">
      <div class="record-main">
        <div class="record-info">
          <span class="record-model" title="${escapeHtml(r.model || '')}">${escapeHtml(shortModel(r.model)) || 'unknown'}</span>
          <span class="record-time">${fmtTime(r.timestamp)}</span>
        </div>
        <div class="record-meta">
          ${sourceTag(r.source)}
        </div>
        <div class="record-tokens">
          <span class="tok in" title="输入 token">↓${fmt(r.inputTokens)}</span>
          <span class="sep">/</span>
          <span class="tok out" title="输出 token">↑${fmt(r.outputTokens)}</span>
          <span class="sep">·</span>
          <span class="tok total" title="总计">Σ${fmt(r.totalTokens)}</span>
          ${cachedTxt}
          ${cacheWTxt}
          ${cacheRateChip(r.inputTokens, r.cachedTokens)}
          ${creditsTxt}
          ${costTxt}
          ${remainTxt}
        </div>
      </div>
      <div class="record-detail">
        ${previewTxt}
        ${convTxt}
        ${costDetailTxt}
        ${urlTxt}
      </div>
    </div>`;
  }).join('');

  // 点击展开/收起详情
  container.querySelectorAll('.record').forEach((el) => {
    el.addEventListener('click', () => el.classList.toggle('expanded'));
  });
}

// ---------- AI 诊断（路径 A 优先，回退 B）----------
const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const STORAGE_KEY = 'ttw_deepseek_key';
const DIAG_MODE_KEY = 'ttw_diag_default_mode';

// 读取诊断模式默认值（在设置页配置），初始化 radio
async function loadDiagDefaultMode() {
  const { [DIAG_MODE_KEY]: mode } = await chrome.storage.local.get(DIAG_MODE_KEY);
  const m = mode || 'quick';
  document.querySelectorAll('input[name="diagMode"]').forEach((r) => {
    r.checked = r.value === m;
  });
}

// 更新诊断模式标签
async function updateDiagModeTag() {
  const tag = document.getElementById('diagMode');
  const session = await getSession();
  const base = await getApiBase();
  if (session && base) {
    tag.textContent = '路径 A · 后端转发';
    tag.className = 'tag tag-green';
  } else {
    tag.textContent = '路径 B · 自带 Key';
    tag.className = 'tag tag-amber';
  }
}

async function diagnose() {
  const key = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  const resultEl = document.getElementById('diagResult');
  const btn = document.getElementById('diagBtn');
  const hintEl = document.getElementById('diagHint');
  const mode = document.querySelector('input[name="diagMode"]:checked')?.value || 'quick';

  const summary = await getSummary();
  if (summary.totalRecords === 0) {
    resultEl.textContent = '暂无用量数据，请先在 work.trae.cn 产生对话';
    resultEl.className = 'diag-result show error';
    return;
  }

  btn.disabled = true;
  resultEl.textContent = mode === 'deep' ? '正在深度分析您的 Token 用量…' : '正在分析您的 Token 用量…';
  resultEl.className = 'diag-result show loading';

  const statsPayload = buildStatsPayload(summary, mode);

  // 先尝试路径 A（后端转发）
  try {
    const outcome = await diagnoseViaBackend(statsPayload, mode);
    if (outcome && outcome.result) {
      const quotaInfo = outcome.quotaTotal
        ? `\n\n[路径 A · ${outcome.cached ? '缓存命中' : '已用'} ${outcome.quotaUsed}/${outcome.quotaTotal}]`
        : `\n\n[路径 A${outcome.cached ? ' · 缓存命中' : ''}]`;
      resultEl.innerHTML = formatDiagnosis(outcome.result) + `<div class="diag-meta">${quotaInfo}</div>`;
      resultEl.className = 'diag-result show';
      hintEl.textContent = '';
      // 保存诊断历史
      await saveDiagnosis({
        mode,
        path: 'A',
        result: outcome.result,
        score: extractScore(outcome.result),
        summary: buildDiagSnapshot(summary),
        meta: { cached: outcome.cached, quotaUsed: outcome.quotaUsed, quotaTotal: outcome.quotaTotal },
      });
      return;
    }
    if (outcome && outcome.fallback === 'B' && outcome.reason) {
      hintEl.textContent = `路径 A 跳过：${outcome.reason}，尝试路径 B…`;
    }
  } catch (e) {
    hintEl.textContent = `路径 A 失败：${e.message}，尝试路径 B…`;
  }

  // 回退路径 B（自有 Key 直连）
  if (!key) {
    resultEl.textContent = '后端诊断不可用，且未配置 DeepSeek API Key。请登录 Star 仓库，或在下方填入自有 Key。';
    resultEl.className = 'diag-result show error';
    return;
  }

  try {
    const content = await diagnoseViaDeepSeek(key, statsPayload, mode);
    const modeTag = mode === 'deep' ? '深度分析' : '快速诊断';
    resultEl.innerHTML = formatDiagnosis(content) + `<div class="diag-meta">[路径 B · ${modeTag} · 自有 Key]</div>`;
    resultEl.className = 'diag-result show';
    hintEl.textContent = '';
    // 保存诊断历史
    await saveDiagnosis({
      mode,
      path: 'B',
      result: content,
      score: extractScore(content),
      summary: buildDiagSnapshot(summary),
      meta: {},
    });
  } catch (e) {
    resultEl.textContent = `诊断失败: ${e.message}`;
    resultEl.className = 'diag-result show error';
  } finally {
    btn.disabled = false;
  }
}

// 路径 A：通过后端转发
async function diagnoseViaBackend(statsPayload, mode = 'quick') {
  const outcome = await diagnoseViaApi(statsPayload, mode);

  if (outcome.result) {
    return outcome;
  }
  // 需要回退
  return { fallback: 'B', reason: outcome.reason || '后端不可用' };
}

// 路径 B：直连 DeepSeek
async function diagnoseViaDeepSeek(key, statsPayload, mode = 'quick') {
  const isDeep = mode === 'deep';
  const systemPrompt = isDeep ? DIAGNOSE_SYSTEM_PROMPT : DIAGNOSE_SYSTEM_PROMPT_QUICK;
  const resp = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: statsPayload },
      ],
      temperature: 0.7,
      max_tokens: isDeep ? 2000 : 800,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '诊断完成，但未返回内容';
}

function buildStatsPayload(summary, mode = 'quick') {
  const { buckets, trend, byModel, bySession, cacheStats } = summary;
  const lines = [];

  // === 汇总数据（含积分/费用）===
  lines.push('以下是我的 TRAE Work Token 用量统计（聚合数据，不含对话内容），请分析并给出优化建议：', '');
  lines.push('【汇总统计】');
  lines.push(`- 今日: 输入 ${fmt(buckets.today.input)}, 输出 ${fmt(buckets.today.output)}, 缓存命中 ${fmt(buckets.today.cached)}, 共 ${fmt(buckets.today.total)} tokens / ${buckets.today.count} 次请求 / ${buckets.today.credits.toFixed(2)} 积分 / ¥${buckets.today.costMoney.toFixed(3)}`);
  lines.push(`- 本周: 输入 ${fmt(buckets.week.input)}, 输出 ${fmt(buckets.week.output)}, 缓存 ${fmt(buckets.week.cached)}, 共 ${fmt(buckets.week.total)} tokens / ${buckets.week.count} 次 / ${buckets.week.credits.toFixed(2)} 积分`);
  lines.push(`- 本月: 输入 ${fmt(buckets.month.input)}, 输出 ${fmt(buckets.month.output)}, 共 ${fmt(buckets.month.total)} tokens / ${buckets.month.count} 次 / ${buckets.month.credits.toFixed(2)} 积分`);
  lines.push(`- 全部: 共 ${fmt(buckets.all.total)} tokens / ${buckets.all.count} 次 / ${buckets.all.credits.toFixed(2)} 积分 / ¥${buckets.all.costMoney.toFixed(3)}`);

  // 平均值
  const avgTokensPerReq = buckets.all.count > 0 ? Math.round(buckets.all.total / buckets.all.count) : 0;
  const avgCreditsPerReq = buckets.all.count > 0 ? (buckets.all.credits / buckets.all.count).toFixed(2) : 0;
  lines.push(`- 平均: 每次请求 ${fmt(avgTokensPerReq)} tokens / ${avgCreditsPerReq} 积分`);

  // === 缓存命中率 ===
  lines.push('', '【缓存命中率】');
  lines.push(`- 整体: ${(cacheStats.overall * 100).toFixed(1)}% (缓存 ${fmt(buckets.all.cached)} / 输入+缓存 ${fmt(buckets.all.input + buckets.all.cached)})`);
  lines.push(`- 今日: ${(cacheStats.today * 100).toFixed(1)}%`);
  if (cacheStats.byModel && cacheStats.byModel.length > 0) {
    lines.push('- 按模型:');
    for (const m of cacheStats.byModel.slice(0, 5)) {
      lines.push(`  · ${m.model}: ${(m.rate * 100).toFixed(1)}% (缓存 ${fmt(m.cached)} / 输入 ${fmt(m.input)})`);
    }
  }

  // === 模型成本对比 ===
  lines.push('', '【模型成本分布】');
  for (const m of byModel.slice(0, 6)) {
    const avgPerReq = m.count > 0 ? Math.round(m.total / m.count) : 0;
    const costPct = buckets.all.credits > 0 ? ((m.credits / buckets.all.credits) * 100).toFixed(1) : '0';
    lines.push(`- ${m.model}: ${fmt(m.total)} tokens / ${m.count} 次 / 平均 ${fmt(avgPerReq)} tok/次 / ${m.credits.toFixed(2)} 积分 (${costPct}% 成本)`);
  }

  // === 会话级 Top 消耗 ===
  if (bySession && bySession.length > 0) {
    lines.push('', '【会话级消耗 Top 5】');
    const top5 = [...bySession].sort((a, b) => b.total - a.total).slice(0, 5);
    for (const s of top5) {
      const avgPerReq = s.count > 0 ? Math.round(s.total / s.count) : 0;
      lines.push(`- "${s.title.slice(0, 40)}": ${fmt(s.total)} tokens / ${s.count} 次 / 平均 ${fmt(avgPerReq)} tok/次 / ${s.credits.toFixed(2)} 积分 / ${shortModel(s.model) || 'unknown'}`);
    }
    // 会话总数和平均
    lines.push(`- 共 ${bySession.length} 个会话，平均每会话 ${fmt(Math.round(buckets.all.total / bySession.length))} tokens`);
  }

  // === 14 天趋势 ===
  lines.push('', '【近 14 天趋势】');
  for (const d of trend) {
    lines.push(`- ${d.date}: 输入 ${fmt(d.input)}, 输出 ${fmt(d.output)}, ${d.count} 次`);
  }

  // === 分析指引 ===
  lines.push('', '请从以下角度深度分析：');
  lines.push('1. 用量合理性：平均每次请求 token 数是否偏高，是否有异常大请求');
  lines.push('2. 缓存利用率：缓存命中率是否理想，哪些模型缓存率低需要优化');
  lines.push('3. 输入输出比：输入 token 占比是否过高（说明上下文过长）');
  lines.push('4. 成本效率：哪个模型性价比最高，是否有过度使用昂贵模型的情况');
  lines.push('5. 会话模式：Top 消耗会话是否合理，是否有冗余对话');
  lines.push('6. 可执行建议：给出 3-5 条具体优化措施，并估算每条的预期节省');

  return lines.join('\n');
}

const DIAGNOSE_SYSTEM_PROMPT = `你是 TRAE Work 的 Token 用量优化专家，精通 LLM API 计费模型、缓存策略和成本优化。

用户会提供聚合后的 Token 用量统计（含 token 数、积分消耗、缓存命中率、模型成本分布、会话级 Top 消耗，不含对话内容）。

请用中文进行深度诊断分析，严格按以下 Markdown 结构输出：

## 现状评分
给出 0-100 的整体效率评分（综合缓存利用、成本效率、请求模式），一句话说明评分理由。

## 关键发现
列出 3-5 条数据驱动的发现，每条包含：
- **发现**：一句话描述
- **数据支撑**：引用具体数字（如"缓存率仅 12%，输入 token 占 89%"）
- **影响**：说明对成本/效率的影响

## 优化建议
给出 3-5 条具体可执行的建议，按预期节省排序：
- **建议**：一句话描述
- **操作方法**：具体步骤（如"在新建会话前搜索是否有类似历史会话"）
- **预期节省**：估算可节省的 token 数或积分（如"预计节省 30-50% 输入 token"）

## 趋势预判
基于 14 天趋势，预测未来用量走向，如不干预可能的月度消耗。

注意：
- 所有结论必须基于用户提供的实际数据，不要泛泛而谈
- 缓存命中率低于 30% 属于偏低，建议优化
- 输入 token 占比超过 80% 说明上下文过长
- 关注异常大的单次请求（平均值的 3 倍以上）
- 模型选择建议要考虑成本性价比，便宜模型能完成的任务不要用昂贵模型`;

const DIAGNOSE_SYSTEM_PROMPT_QUICK = `你是 TRAE Work 的 Token 优化专家。用户会提供聚合用量数据。
请用中文给出简洁诊断，200 字以内：

1. **现状**：一句话总结（含评分 X/100）
2. **发现**：2-3 条要点，每条引用具体数据
3. **建议**：2-3 条可执行优化，按优先级排序

直接输出，不要前言。`;

function formatDiagnosis(text) {
  // 先转义 HTML
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Markdown 渲染（按优先级处理）
  // 1. 二级标题 ## xxx
  html = html.replace(/^## (.+)$/gm, '<h4 class="diag-h">$1</h4>');
  // 2. 三级标题 ### xxx
  html = html.replace(/^### (.+)$/gm, '<h5 class="diag-h3">$1</h5>');
  // 3. 加粗 **xxx**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 4. 行内代码 `xxx`
  html = html.replace(/`([^`]+)`/g, '<code class="diag-code">$1</code>');
  // 5. 无序列表项 - xxx / · xxx
  html = html.replace(/^[\-\·] (.+)$/gm, '<div class="diag-li">$1</div>');
  // 6. 有序列表项 1. xxx
  html = html.replace(/^\d+\. (.+)$/gm, '<div class="diag-ol">$1</div>');
  // 7. 段落（连续非空行且不是以上特殊格式）
  html = html.replace(/^(?!<[h\d])(.+)$/gm, '<p class="diag-p">$1</p>');
  // 8. 清理空段落
  html = html.replace(/<p class="diag-p">\s*<\/p>/g, '');
  // 9. 换行
  html = html.replace(/\n/g, '');

  return html;
}

// ---------- 诊断历史 ----------
// 诊断时刻的用量快照：展开历史时展示，便于对比历史变化
function buildDiagSnapshot(summary) {
  const { buckets, cacheStats } = summary;
  return {
    todayTotal: buckets.today.total,
    todayCredits: buckets.today.credits,
    weekTotal: buckets.week.total,
    weekCredits: buckets.week.credits,
    monthTotal: buckets.month.total,
    monthCredits: buckets.month.credits,
    allTotal: buckets.all.total,
    allCredits: buckets.all.credits,
    allCount: buckets.all.count,
    cacheRate: cacheStats?.overall ?? 0,
  };
}

// 从诊断文本中解析效率评分（0-100）
function extractScore(text) {
  if (!text) return null;
  let m = text.match(/(\d{1,3})\s*\/\s*100/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 100) return n;
  }
  m = text.match(/评分[：:\s]*(\d{1,3})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 0 && n <= 100) return n;
  }
  return null;
}

// 持久化一条诊断并刷新列表
async function saveDiagnosis(rec) {
  try {
    await addDiagnosis(rec);
    await renderDiagHistory();
  } catch (e) {
    console.error('[diag-history] 保存诊断失败', e);
  }
}

// 渲染诊断历史列表（最新在前）
async function renderDiagHistory() {
  const container = document.getElementById('diagHistory');
  if (!container) return;
  const list = await getDiagnoses(50);

  const hintEl = document.getElementById('diagHistoryHint');
  if (hintEl) hintEl.textContent = list.length > 0 ? `${list.length} 条记录` : '';

  if (list.length === 0) {
    container.innerHTML = '<div class="empty">暂无诊断记录，点击上方「诊断我的 Token 用法」生成首条</div>';
    return;
  }

  container.innerHTML = list.map((d) => {
    const scoreTxt = d.score != null ? `<span class="dh-score">评分 ${d.score}</span>` : '';
    let pathTag;
    if (d.path === 'A') pathTag = '<span class="tag tag-green">路径 A</span>';
    else if (d.path === 'A-fallback') pathTag = '<span class="tag tag-amber">A→B</span>';
    else pathTag = '<span class="tag tag-amber">路径 B</span>';
    const modeTxt = d.mode === 'deep' ? '深度' : '快速';
    const preview = escapeHtml((d.result || '').replace(/\n+/g, ' ').trim().slice(0, 90));
    return `
      <div class="dh-item" data-id="${d.id}">
        <div class="dh-head">
          <span class="dh-time">${fmtTime(d.timestamp)}</span>
          <span class="dh-tags">
            ${pathTag}
            <span class="dh-mode">${modeTxt}</span>
            ${scoreTxt}
          </span>
          <button class="dh-del" data-id="${d.id}" title="删除此条">✕</button>
        </div>
        <div class="dh-preview">${preview}</div>
        <div class="dh-detail">
          ${formatDiagnosis(d.result || '')}
          ${snapshotHtml(d.summary)}
        </div>
      </div>`;
  }).join('');

  // 点击切换展开/收起
  container.querySelectorAll('.dh-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('dh-del')) return;
      el.classList.toggle('expanded');
    });
  });
  // 单条删除
  container.querySelectorAll('.dh-del').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.id);
      await deleteDiagnosis(id);
      await renderDiagHistory();
    });
  });
}

// 诊断快照展示块
function snapshotHtml(s) {
  if (!s || s.allTotal == null) return '';
  const cred = (n) => (typeof n === 'number' ? n.toFixed(2) : n);
  return `
    <div class="dh-snap">
      <span>今日 Σ${fmt(s.todayTotal)} · ◈${cred(s.todayCredits)}</span>
      <span>本月 Σ${fmt(s.monthTotal)} · ◈${cred(s.monthCredits)}</span>
      <span>缓存率 ${((s.cacheRate || 0) * 100).toFixed(1)}%</span>
      <span>累计 Σ${fmt(s.allTotal)} · ${s.allCount} 次</span>
    </div>`;
}

// ---------- 账号区渲染 ----------
function updateStarUI(starred) {
  const starEl = document.getElementById('starStatus');
  if (starred) {
    starEl.className = 'account-star starred';
    starEl.textContent = '★ 已 Star · 享免费诊断';
  } else {
    starEl.className = 'account-star not-starred';
    starEl.innerHTML = '未 Star · <a href="https://github.com/soulor8908/trae-token-watcher" target="_blank">去 Star</a>';
    // 点击「去 Star」后轮询回查，捕获用户 star 完成的瞬间
    starEl.querySelector('a')?.addEventListener('click', pollStarRefresh);
  }
}

// 「去 Star」点击后轮询强制刷新（每 3s 一次，最多 6 次）
function pollStarRefresh() {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    try {
      const r = await refreshStarStatus();
      if (r.starred) {
        clearInterval(timer);
        updateStarUI(true);
        return;
      }
    } catch (_) {}
    if (attempts >= 6) clearInterval(timer);
  }, 3000);
}

async function renderAccount() {
  const guest = document.getElementById('accountGuest');
  const user = document.getElementById('accountUser');
  const status = await refreshAuthStatus();

  if (status.authenticated) {
    guest.style.display = 'none';
    user.style.display = 'flex';
    document.getElementById('userLogin').textContent = status.login;
    document.getElementById('userAvatar').src = status.avatar || '';
    updateStarUI(!!status.starred);

    // 异步强制回查 Star 状态（跳过 KV 缓存），与缓存值不一致则更新 UI
    refreshStarStatus()
      .then((r) => {
        if (r.authenticated && !!r.starred !== !!status.starred) {
          updateStarUI(!!r.starred);
        }
      })
      .catch(() => {});
  } else {
    guest.style.display = 'flex';
    user.style.display = 'none';
  }
  await updateDiagModeTag();
}

// ---------- 事件绑定 ----------
document.getElementById('refreshBtn').addEventListener('click', renderSummary);
document.getElementById('diagBtn').addEventListener('click', diagnose);

// 打开设置页
function openOptions() {
  chrome.runtime.openOptionsPage();
}

// 全屏面板：在新标签页打开同一仪表盘，绕过 Chrome 弹框 ~600px 高度上限
document.getElementById('fullBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') + '?full=1' });
  window.close();
});
document.getElementById('optionsBtn').addEventListener('click', openOptions);
document.getElementById('openOptionsFromDiag').addEventListener('click', openOptions);

document.getElementById('loginBtn').addEventListener('click', async () => {
  try {
    await loginWithGitHub();
    window.close(); // 关闭 popup，让用户在打开的标签页完成授权
  } catch (e) {
    document.getElementById('loginHint').textContent = e.message;
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await logout();
  await renderAccount();
});

// 浮窗开关：在 work.trae.cn 页面显示/隐藏浮动小组件
let widgetOn = true;
async function loadWidgetState() {
  const { ttw_widget_state: state } = await chrome.storage.local.get('ttw_widget_state');
  widgetOn = state ? state.visible !== false : true;
  updateWidgetBtn();
}
function updateWidgetBtn() {
  const btn = document.getElementById('widgetBtn');
  btn.textContent = widgetOn ? '浮窗●' : '浮窗';
  btn.classList.toggle('on', widgetOn);
}
document.getElementById('widgetBtn').addEventListener('click', async () => {
  widgetOn = !widgetOn;
  const { ttw_widget_state: state } = await chrome.storage.local.get('ttw_widget_state');
  await chrome.storage.local.set({
    ttw_widget_state: { ...(state || {}), visible: widgetOn },
  });
  // 通知所有 trae.cn 标签页
  chrome.tabs.query({ url: ['https://*.trae.cn/*'] }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'TTW_WIDGET_TOGGLE', visible: widgetOn }).catch(() => {});
    }
  });
  updateWidgetBtn();
});

// ---------- 预警设置已迁移到设置页 ----------

// 监听 storage 变化（OAuth 回调页写入 session 后，popup 若开着能刷新）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.ttw_session) {
    renderAccount();
  }
});

// ---------- Tab 切换 ----------
document.getElementById('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  const target = tab.dataset.tab;
  document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `tab-${target}`);
  });
  // 切到诊断 Tab 时刷新历史，确保最新数据
  if (target === 'diag') renderDiagHistory();
});

// ---------- 诊断历史：清空全部 ----------
document.getElementById('clearDiagHistoryBtn').addEventListener('click', async () => {
  if (!window.confirm('确定清空全部诊断历史？此操作不可撤销。')) return;
  await clearDiagnoses();
  await renderDiagHistory();
});

// ---------- 模型视图切换（Token / 成本）----------
document.getElementById('modelToggle').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg');
  if (!seg) return;
  const metric = seg.dataset.metric;
  if (metric === modelMetric) return;
  modelMetric = metric;
  document.querySelectorAll('#modelToggle .seg').forEach((s) => s.classList.toggle('active', s === seg));
  if (cachedSummary) renderModelCompare(cachedSummary.byModel);
});

// ---------- 初始化 ----------
(async function init() {
  // 全屏模式：从新标签页打开（?full=1）时解除弹框高度上限，页面自然滚动
  if (new URLSearchParams(location.search).get('full') === '1') {
    document.body.classList.add('full-mode');
  }
  await loadDiagDefaultMode();
  await loadWidgetState();
  await renderAccount();
  await renderSummary();
  await renderDiagHistory();
  // 每 5 秒刷新一次（popup 打开期间）
  setInterval(renderSummary, 5000);
})();
