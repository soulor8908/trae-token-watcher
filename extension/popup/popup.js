// Popup 仪表盘逻辑 — 渲染统计、趋势、记录；AI 诊断（路径 B）
import { getSummary, getAllRecords, clearAllRecords } from '../lib/db.js';

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

function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (resp) => resolve(resp));
  });
}

// ---------- 渲染汇总 ----------
async function renderSummary() {
  const summary = await getSummary();
  const { buckets, trend, byModel, totalRecords } = summary;

  // 汇总卡片（带数字动画）
  animateNum('todayTotal', buckets.today.total);
  animateNum('weekTotal', buckets.week.total);
  animateNum('monthTotal', buckets.month.total);
  document.getElementById('todayCount').textContent = `${buckets.today.count} 次请求`;
  document.getElementById('weekCount').textContent = `${buckets.week.count} 次请求`;
  document.getElementById('monthCount').textContent = `${buckets.month.count} 次请求`;

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

  // 模型分布
  renderModels(byModel);

  // 最近记录
  const records = await getAllRecords(20);
  renderRecords(records);
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

// ---------- 趋势图 ----------
function renderChart(trend) {
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

// ---------- 模型分布 ----------
function renderModels(byModel) {
  const section = document.getElementById('modelSection');
  const list = document.getElementById('modelList');
  if (!byModel || byModel.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  const maxTotal = Math.max(...byModel.map((m) => m.total), 1);
  const colors = ['var(--accent)', 'var(--accent2)', 'var(--amber)', 'var(--purple)'];
  list.innerHTML = byModel.slice(0, 5).map((m, i) => {
    const pct = (m.total / maxTotal) * 100;
    const color = colors[i % colors.length];
    return `
      <div class="model-row">
        <span class="model-name" title="${m.model}">${shortModel(m.model)}</span>
        <div class="model-bar"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
        <span class="model-val">${fmt(m.total)}</span>
      </div>`;
  }).join('');
}

// ---------- 最近记录 ----------
function renderRecords(records) {
  const container = document.getElementById('records');
  if (!records || records.length === 0) {
    container.innerHTML = '<div class="empty">暂无记录，打开 work.trae.cn 开始对话即可采集</div>';
    return;
  }
  container.innerHTML = records.map((r) => `
    <div class="record">
      <div class="record-info">
        <span class="record-model" title="${r.model || ''}">${shortModel(r.model) || 'unknown'}</span>
        <span class="record-time">${fmtTime(r.timestamp)}</span>
      </div>
      <div class="record-tokens">
        <span class="tok in">↓${fmt(r.inputTokens)}</span>
        <span class="sep">/</span>
        <span class="tok out">↑${fmt(r.outputTokens)}</span>
      </div>
    </div>`).join('');
}

// ---------- AI 诊断（路径 B）----------
const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';
const STORAGE_KEY = 'ttw_deepseek_key';

async function loadApiKey() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  if (result[STORAGE_KEY]) {
    document.getElementById('apiKey').value = result[STORAGE_KEY];
    document.getElementById('diagHint').textContent = 'Key 已保存';
  }
}

async function saveApiKey() {
  const key = document.getElementById('apiKey').value.trim();
  if (!key) {
    document.getElementById('diagHint').textContent = '请先输入 Key';
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: key });
  document.getElementById('diagHint').textContent = '已保存';
}

async function diagnose() {
  const key = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  const resultEl = document.getElementById('diagResult');
  const btn = document.getElementById('diagBtn');

  if (!key) {
    resultEl.textContent = '请先保存 DeepSeek API Key';
    resultEl.className = 'diag-result show error';
    return;
  }

  const summary = await getSummary();
  if (summary.totalRecords === 0) {
    resultEl.textContent = '暂无用量数据，请先在 work.trae.cn 产生对话';
    resultEl.className = 'diag-result show error';
    return;
  }

  btn.disabled = true;
  resultEl.textContent = '正在分析您的 Token 用量…';
  resultEl.className = 'diag-result show loading';

  // 只发送聚合统计，不包含任何对话内容
  const statsPayload = buildStatsPayload(summary);

  try {
    const resp = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: DIAGNOSE_SYSTEM_PROMPT },
          { role: 'user', content: statsPayload },
        ],
        temperature: 0.7,
        max_tokens: 1200,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`API ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '诊断完成，但未返回内容';
    resultEl.innerHTML = formatDiagnosis(content);
    resultEl.className = 'diag-result show';
  } catch (e) {
    resultEl.textContent = `诊断失败: ${e.message}`;
    resultEl.className = 'diag-result show error';
  } finally {
    btn.disabled = false;
  }
}

function buildStatsPayload(summary) {
  const { buckets, trend, byModel } = summary;
  const lines = [
    '以下是我的 TRAE Work Token 用量统计（聚合数据，不含对话内容），请分析并给出优化建议：',
    '',
    '【汇总】',
    `- 今日: 输入 ${buckets.today.input}, 输出 ${buckets.today.output}, 缓存命中 ${buckets.today.cached}, 共 ${buckets.today.total} tokens / ${buckets.today.count} 次请求`,
    `- 本周: 输入 ${buckets.week.input}, 输出 ${buckets.week.output}, 共 ${buckets.week.total} tokens / ${buckets.week.count} 次请求`,
    `- 本月: 输入 ${buckets.month.input}, 输出 ${buckets.month.output}, 共 ${buckets.month.total} tokens / ${buckets.month.count} 次请求`,
    '',
    '【按模型分布】',
    ...byModel.map((m) => `- ${m.model}: ${m.total} tokens / ${m.count} 次`),
    '',
    '【近 14 天趋势】',
    ...trend.map((d) => `- ${d.date}: 输入 ${d.input}, 输出 ${d.output}, ${d.count} 次`),
    '',
    '请从以下角度分析：1) 用量是否合理 2) 缓存利用率 3) 输入输出比 4) 是否有浪费 5) 具体可执行的优化建议',
  ];
  return lines.join('\n');
}

const DIAGNOSE_SYSTEM_PROMPT = `你是 TRAE Work 的 Token 优化专家。用户会提供聚合后的 Token 用量统计（不含对话内容）。
请用简洁的中文给出诊断，格式如下：
1. 一句话总结现状
2. 2-3 条关键发现（用要点列出）
3. 3 条可立即执行的具体优化建议（按优先级排序）
保持简洁，总字数控制在 300 字以内。`;

function formatDiagnosis(text) {
  // 简单格式化：加粗数字
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- 事件绑定 ----------
document.getElementById('refreshBtn').addEventListener('click', renderSummary);
document.getElementById('saveKey').addEventListener('click', saveApiKey);
document.getElementById('diagBtn').addEventListener('click', diagnose);
document.getElementById('apiKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveApiKey();
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  if (confirm('确定清空所有 Token 用量记录？此操作不可恢复。')) {
    await clearAllRecords();
    await renderSummary();
  }
});

// ---------- 初始化 ----------
(async function init() {
  await loadApiKey();
  await renderSummary();
  // 每 5 秒刷新一次（popup 打开期间）
  setInterval(renderSummary, 5000);
})();
