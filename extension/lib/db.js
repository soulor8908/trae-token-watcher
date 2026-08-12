// IndexedDB 封装 — Trae Token Watcher 数据层
// 数据流要短：content -> background -> IndexedDB；popup 直读 IndexedDB

const DB_NAME = 'trae-token-watcher';
const DB_VERSION = 3;
const STORE_RECORDS = 'usage-records';
const STORE_DIAGNOSES = 'diagnoses';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // 用量记录表（v1 创建，v2 补 clientId 索引）
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('conversationId', 'conversationId', { unique: false });
        store.createIndex('model', 'model', { unique: false });
        store.createIndex('clientId', 'clientId', { unique: false });
      } else if (e.oldVersion < 2) {
        // v1 → v2：补 clientId 索引 + 给旧记录回填 clientId
        const store = e.target.transaction.objectStore(STORE_RECORDS);
        if (!store.indexNames.contains('clientId')) {
          store.createIndex('clientId', 'clientId', { unique: false });
        }
        // 回填旧记录的 clientId（用 id 生成确定性 uuid 替代）
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) {
            const rec = cursor.value;
            if (!rec.clientId) {
              rec.clientId = genClientId();
              cursor.update(rec);
            }
            cursor.continue();
          }
        };
      }

      // 诊断历史表（v3 新增）
      if (!db.objectStoreNames.contains(STORE_DIAGNOSES)) {
        const dstore = db.createObjectStore(STORE_DIAGNOSES, {
          keyPath: 'id',
          autoIncrement: true,
        });
        dstore.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 生成客户端记录 ID（用于跨设备去重）
function genClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 写入一条用量记录
// 去重：对带 conversationId（即 session_id）的记录采用覆盖式去重——同一会话只保留最新一条，
// 旧记录先删后插；历史会话反复查看、实时会话多轮对话都不会再产生重复。
// 无 conversationId 的实时请求保持原行为（每条都入库）。
export async function addRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDS);
    const finalRecord = {
      timestamp: Date.now(),
      conversationId: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      url: '',
      source: 'fetch',
      clientId: genClientId(),
      ...record,
    };
    finalRecord.clientId = record.clientId || genClientId();

    const tryInsert = () => {
      const req = store.add(finalRecord);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };

    if (finalRecord.conversationId) {
      // 纯 session_id 去重：同一会话只保留最新一条记录（覆盖式写入）。
      // 历史会话反复查看、或实时会话多轮对话，都折叠为该 session_id 下的单条最新快照。
      const idx = store.index('conversationId');
      const curReq = idx.openCursor(IDBKeyRange.only(finalRecord.conversationId));
      curReq.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete(); // 删除该会话已有的旧记录
          cursor.continue();
        } else {
          tryInsert(); // 旧的都删完了，写入最新一条
        }
      };
      curReq.onerror = () => tryInsert(); // 索引查询失败则直接插入
    } else {
      tryInsert();
    }

    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => db.close();
  });
}

// 读取指定时间范围内的记录
export async function getRecordsSince(since = 0) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    const idx = store.index('timestamp');
    const range = IDBKeyRange.lowerBound(since);
    const req = idx.getAll(range);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// 获取全部记录（限制条数，默认最近 500 条）
export async function getAllRecords(limit = 500) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    const req = store.openCursor(null, 'prev');
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve(results);
    };
    tx.onerror = () => reject(tx.error);
  });
}

// 聚合统计：按时间段汇总 token 用量
export async function getSummary() {
  const records = await getAllRecords(2000);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  const buckets = {
    today: { since: startOfDay(now), input: 0, output: 0, cached: 0, total: 0, count: 0, credits: 0, costMoney: 0 },
    week: { since: now - 7 * dayMs, input: 0, output: 0, cached: 0, total: 0, count: 0, credits: 0, costMoney: 0 },
    month: { since: now - 30 * dayMs, input: 0, output: 0, cached: 0, total: 0, count: 0, credits: 0, costMoney: 0 },
    all: { since: 0, input: 0, output: 0, cached: 0, total: 0, count: 0, credits: 0, costMoney: 0 },
  };

  // 按天聚合的趋势数据（最近 14 天）
  const trend = {};

  for (const r of records) {
    for (const key of Object.keys(buckets)) {
      if (r.timestamp >= buckets[key].since) {
        buckets[key].input += r.inputTokens || 0;
        buckets[key].output += r.outputTokens || 0;
        buckets[key].cached += r.cachedTokens || 0;
        buckets[key].total += r.totalTokens || 0;
        buckets[key].count += 1;
        buckets[key].credits += r.credits || 0;
        buckets[key].costMoney += r.costMoney || 0;
      }
    }
    // 趋势按天
    const dayKey = dayKeyOf(r.timestamp);
    if (!trend[dayKey]) {
      trend[dayKey] = { date: dayKey, input: 0, output: 0, total: 0, count: 0 };
    }
    trend[dayKey].input += r.inputTokens || 0;
    trend[dayKey].output += r.outputTokens || 0;
    trend[dayKey].total += r.totalTokens || 0;
    trend[dayKey].count += 1;
  }

  // 趋势取最近 14 天，按时间正序
  const trendArr = Object.values(trend)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-14);

  // 按 model 汇总（增强：含 input/output/cached/credits/costMoney）
  const byModel = {};
  for (const r of records) {
    const m = r.model || 'unknown';
    if (!byModel[m]) byModel[m] = {
      model: m, total: 0, count: 0, input: 0, output: 0, cached: 0,
      credits: 0, costMoney: 0, cacheWrite: 0,
    };
    byModel[m].total += r.totalTokens || 0;
    byModel[m].input += r.inputTokens || 0;
    byModel[m].output += r.outputTokens || 0;
    byModel[m].cached += r.cachedTokens || 0;
    byModel[m].cacheWrite += r.cacheWriteTokens || 0;
    byModel[m].credits += r.credits || 0;
    byModel[m].costMoney += r.costMoney || 0;
    byModel[m].count += 1;
  }
  const byModelArr = Object.values(byModel).sort((a, b) => b.total - a.total);

  // 按 session 聚合（会话级明细）
  const bySession = {};
  for (const r of records) {
    const sid = r.conversationId || '_unknown';
    if (!bySession[sid]) bySession[sid] = {
      sessionId: sid,
      title: r.userInputPreview || (sid === '_unknown' ? '未知会话' : sid.slice(0, 16)),
      total: 0, count: 0, input: 0, output: 0, cached: 0,
      credits: 0, costMoney: 0, model: r.model || null,
      firstActive: r.timestamp, lastActive: r.timestamp,
    };
    const s = bySession[sid];
    s.total += r.totalTokens || 0;
    s.input += r.inputTokens || 0;
    s.output += r.outputTokens || 0;
    s.cached += r.cachedTokens || 0;
    s.credits += r.credits || 0;
    s.costMoney += r.costMoney || 0;
    s.count += 1;
    if (r.timestamp < s.firstActive) s.firstActive = r.timestamp;
    if (r.timestamp > s.lastActive) s.lastActive = r.timestamp;
    // 标题优先用第一条用户提问
    if (r.userInputPreview && (s.title === sid.slice(0, 16) || !s.title)) {
      s.title = r.userInputPreview;
    }
  }
  const bySessionArr = Object.values(bySession).sort((a, b) => b.lastActive - a.lastActive);

  // 缓存命中率统计
  // 命中率 = cachedTokens / (inputTokens + cachedTokens)
  // （缓存命中的 token 本应计入 input，命中率反映 prompt 中有多少比例命中缓存）
  const cacheStats = {
    overall: computeCacheRate(buckets.all.input, buckets.all.cached),
    today: computeCacheRate(buckets.today.input, buckets.today.cached),
    byModel: byModelArr.map((m) => ({
      model: m.model,
      rate: computeCacheRate(m.input, m.cached),
      cached: m.cached,
      input: m.input,
    })).filter((m) => m.cached > 0 || m.input > 0),
  };

  return {
    buckets,
    trend: trendArr,
    byModel: byModelArr,
    bySession: bySessionArr,
    cacheStats,
    totalRecords: records.length,
  };
}

function computeCacheRate(input, cached) {
  const denom = (input || 0) + (cached || 0);
  if (denom === 0) return 0;
  return (cached || 0) / denom;
}

// 导出记录：按时间范围 + 模型筛选
// options: { since?: number, until?: number, model?: string }
// 返回 { records, summary } — records 为筛选后记录数组，summary 为汇总
export async function exportRecords(options = {}) {
  const { since = 0, until = Date.now(), model = null } = options;
  const all = await getRecordsSince(since);
  let records = all.filter((r) => r.timestamp <= until);
  if (model && model !== 'all') {
    records = records.filter((r) => (r.model || 'unknown') === model);
  }

  // 汇总
  const summary = {
    exportTime: new Date().toISOString(),
    filter: { since, until, model },
    count: records.length,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    credits: 0,
    costMoney: 0,
    models: {},
    sessions: new Set(),
  };

  for (const r of records) {
    summary.totalTokens += r.totalTokens || 0;
    summary.inputTokens += r.inputTokens || 0;
    summary.outputTokens += r.outputTokens || 0;
    summary.cachedTokens += r.cachedTokens || 0;
    summary.cacheWriteTokens += r.cacheWriteTokens || 0;
    summary.credits += r.credits || 0;
    summary.costMoney += r.costMoney || 0;
    const m = r.model || 'unknown';
    if (!summary.models[m]) summary.models[m] = { count: 0, total: 0, credits: 0 };
    summary.models[m].count++;
    summary.models[m].total += r.totalTokens || 0;
    summary.models[m].credits += r.credits || 0;
    if (r.conversationId) summary.sessions.add(r.conversationId);
  }
  summary.sessions = summary.sessions.size;

  return { records, summary };
}

// 获取所有不同的模型名（用于导出筛选下拉框）
export async function getDistinctModels() {
  const all = await getRecordsSince(0);
  const models = new Set();
  for (const r of all) {
    models.add(r.model || 'unknown');
  }
  return [...models].sort();
}

// 用量预测：基于历史趋势预测未来 7/30 天消耗
// 算法：加权移动平均（最近 7 天权重递减），结合趋势修正
export async function predictUsage() {
  const now = Date.now();
  const dayMs = 86400000;
  const records = await getRecordsSince(now - 14 * dayMs); // 取近 14 天

  if (records.length === 0) {
    return { available: false, reason: '暂无历史数据' };
  }

  // 按天聚合（最近 14 天）
  const dailyMap = new Map();
  for (const r of records) {
    const d = new Date(r.timestamp);
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    if (!dailyMap.has(key)) {
      dailyMap.set(key, { date: key, tokens: 0, credits: 0, count: 0 });
    }
    const day = dailyMap.get(key);
    day.tokens += r.totalTokens || 0;
    day.credits += r.credits || 0;
    day.count += 1;
  }

  const days = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  if (days.length === 0) {
    return { available: false, reason: '近 14 天无数据' };
  }

  // 加权移动平均：最近的天权重最高
  // 权重：第 1 天（最早）权重 1，第 N 天（最近）权重 N
  let totalWeight = 0;
  let weightedTokens = 0;
  let weightedCredits = 0;
  let weightedCount = 0;
  const n = days.length;
  for (let i = 0; i < n; i++) {
    const w = i + 1; // 权重递增
    totalWeight += w;
    weightedTokens += days[i].tokens * w;
    weightedCredits += days[i].credits * w;
    weightedCount += days[i].count * w;
  }
  const avgDailyTokens = weightedTokens / totalWeight;
  const avgDailyCredits = weightedCredits / totalWeight;
  const avgDailyCount = weightedCount / totalWeight;

  // 趋势修正：对比最近 3 天 vs 之前的天
  let trendMultiplier = 1.0;
  if (n >= 4) {
    const recent3 = days.slice(-3);
    const earlier = days.slice(0, -3);
    const recentAvg = recent3.reduce((s, d) => s + d.tokens, 0) / recent3.length;
    const earlierAvg = earlier.reduce((s, d) => s + d.tokens, 0) / earlier.length;
    if (earlierAvg > 0) {
      trendMultiplier = recentAvg / earlierAvg;
      // 限制趋势倍率在 0.5-2.0 之间避免极端值
      trendMultiplier = Math.max(0.5, Math.min(2.0, trendMultiplier));
    }
  }

  // 预测
  const predictedDailyTokens = avgDailyTokens * trendMultiplier;
  const predictedDailyCredits = avgDailyCredits * trendMultiplier;
  const predicted7dTokens = predictedDailyTokens * 7;
  const predicted30dTokens = predictedDailyTokens * 30;
  const predicted7dCredits = predictedDailyCredits * 7;
  const predicted30dCredits = predictedDailyCredits * 30;

  // 今日已用
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayData = days.find((d) => d.date === todayKey) || { tokens: 0, credits: 0, count: 0 };

  return {
    available: true,
    avgDailyTokens: Math.round(avgDailyTokens),
    avgDailyCredits: parseFloat(avgDailyCredits.toFixed(2)),
    avgDailyCount: Math.round(avgDailyCount),
    trendMultiplier: parseFloat(trendMultiplier.toFixed(2)),
    trendDirection: trendMultiplier > 1.1 ? 'up' : (trendMultiplier < 0.9 ? 'down' : 'stable'),
    predictedDailyTokens: Math.round(predictedDailyTokens),
    predictedDailyCredits: parseFloat(predictedDailyCredits.toFixed(2)),
    predicted7d: {
      tokens: Math.round(predicted7dTokens),
      credits: parseFloat(predicted7dCredits.toFixed(2)),
    },
    predicted30d: {
      tokens: Math.round(predicted30dTokens),
      credits: parseFloat(predicted30dCredits.toFixed(2)),
    },
    todayUsed: {
      tokens: todayData.tokens,
      credits: parseFloat(todayData.credits.toFixed(2)),
      count: todayData.count,
    },
    historyDays: n,
  };
}

// 预警检查：对比今日用量与阈值
export async function checkAlert() {
  const prediction = await predictUsage();
  if (!prediction.available) return { triggered: false, reason: prediction.reason };

  // 读取阈值设置
  const { ttw_alert_config: config } = await chrome.storage.local.get('ttw_alert_config');
  if (!config || !config.enabled) return { triggered: false, reason: '未启用预警' };

  const todayCredits = prediction.todayUsed.credits;
  const todayTokens = prediction.todayUsed.tokens;
  const triggers = [];

  // 今日积分阈值
  if (config.dailyCreditLimit && todayCredits >= config.dailyCreditLimit) {
    triggers.push({
      type: 'daily_credits',
      level: 'warning',
      message: `今日已消耗 ${todayCredits.toFixed(2)} 积分（阈值 ${config.dailyCreditLimit}）`,
    });
  }

  // 今日 token 阈值
  if (config.dailyTokenLimit && todayTokens >= config.dailyTokenLimit) {
    triggers.push({
      type: 'daily_tokens',
      level: 'warning',
      message: `今日已消耗 ${Math.round(todayTokens)} tokens（阈值 ${config.dailyTokenLimit}）`,
    });
  }

  // 月度预测阈值
  if (config.monthlyCreditLimit && prediction.predicted30d.credits >= config.monthlyCreditLimit) {
    triggers.push({
      type: 'monthly_predict',
      level: 'danger',
      message: `预测本月消耗 ${prediction.predicted30d.credits.toFixed(2)} 积分（阈值 ${config.monthlyCreditLimit}）`,
    });
  }

  return {
    triggered: triggers.length > 0,
    triggers,
    todayCredits,
    todayTokens,
    predicted30dCredits: prediction.predicted30d.credits,
    config,
  };
}

// 周期对比：今日 vs 昨日、本周 vs 上周、本月 vs 上月
// 返回每个周期的 tokens/credits/count 及环比变化百分比
export async function getComparison() {
  const now = Date.now();
  const dayMs = 86400000;
  // 取近 60 天记录足够覆盖本月+上月对比
  const records = await getRecordsSince(now - 61 * dayMs);

  const ranges = [
    { key: 'daily', label: '日', curStart: startOfDay(now), prevStart: startOfDay(now - dayMs), span: dayMs },
    { key: 'weekly', label: '周', curStart: now - 7 * dayMs, prevStart: now - 14 * dayMs, span: 7 * dayMs },
    { key: 'monthly', label: '月', curStart: now - 30 * dayMs, prevStart: now - 60 * dayMs, span: 30 * dayMs },
  ];

  const result = ranges.map((r) => {
    const curEnd = r.curStart + r.span;
    const prevEnd = r.prevStart + r.span;
    const cur = { tokens: 0, credits: 0, count: 0 };
    const prev = { tokens: 0, credits: 0, count: 0 };

    for (const rec of records) {
      if (rec.timestamp >= r.curStart && rec.timestamp < curEnd) {
        cur.tokens += rec.totalTokens || 0;
        cur.credits += rec.credits || 0;
        cur.count += 1;
      } else if (rec.timestamp >= r.prevStart && rec.timestamp < prevEnd) {
        prev.tokens += rec.totalTokens || 0;
        prev.credits += rec.credits || 0;
        prev.count += 1;
      }
    }

    return {
      key: r.key,
      label: r.label,
      current: cur,
      previous: prev,
      changes: {
        tokens: pctChange(prev.tokens, cur.tokens),
        credits: pctChange(prev.credits, cur.credits),
        count: pctChange(prev.count, cur.count),
      },
    };
  });

  return { ranges: result };
}

function pctChange(prev, cur) {
  if (prev === 0) return cur > 0 ? null : 0; // null 表示"新增"（之前为 0）
  return (cur - prev) / prev;
}

// 清空所有记录
export async function clearAllRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDS);
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// ---------- 诊断历史 ----------
// 诊断结果持久化，便于回看历史诊断数据。
// record 字段：
//   mode: 'quick' | 'deep'
//   path: 'A' | 'B' | 'A-fallback'
//   score: number | null   （从诊断文本中解析的效率评分 0-100）
//   result: string         （诊断全文 Markdown）
//   summary: object|null   （诊断时刻的用量快照，便于对比历史变化）
//   meta: object           （路径 A 的配额/缓存等附加信息）
export async function addDiagnosis(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DIAGNOSES, 'readwrite');
    const store = tx.objectStore(STORE_DIAGNOSES);
    const req = store.add({
      timestamp: Date.now(),
      mode: 'quick',
      path: 'B',
      score: null,
      result: '',
      summary: null,
      meta: {},
      ...record,
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// 读取最近的诊断记录（按时间倒序，默认 50 条）
export async function getDiagnoses(limit = 50) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DIAGNOSES, 'readonly');
    const store = tx.objectStore(STORE_DIAGNOSES);
    const req = store.openCursor(null, 'prev'); // 最新在前
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      db.close();
      resolve(results);
    };
    tx.onerror = () => reject(tx.error);
  });
}

// 按 id 读取单条诊断（透传用，当前 UI 直接用列表里的完整对象）
export async function getDiagnosisById(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DIAGNOSES, 'readonly');
    const store = tx.objectStore(STORE_DIAGNOSES);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// 删除单条诊断记录
export async function deleteDiagnosis(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DIAGNOSES, 'readwrite');
    const store = tx.objectStore(STORE_DIAGNOSES);
    const req = store.delete(id);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// 清空全部诊断历史
export async function clearDiagnoses() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DIAGNOSES, 'readwrite');
    const store = tx.objectStore(STORE_DIAGNOSES);
    const req = store.clear();
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// 诊断历史条数（列表头展示用）
export async function countDiagnoses() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_DIAGNOSES, 'readonly');
    const store = tx.objectStore(STORE_DIAGNOSES);
    const req = store.count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// ---------- 同步相关 ----------
// 按 id 增量读取（上传用）：返回 id > localId 的记录，升序
export async function getRecordsAfterId(localId = 0, limit = 500) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    const range = IDBKeyRange.lowerBound(localId + 1, false);
    const req = store.getAll(range, limit);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// 批量导入记录（下载用）：按 clientId 去重，已存在则跳过
// records: [{ clientId, ts, model, ... }]（server_created_at 字段会被忽略）
export async function importRecords(records) {
  if (!records || records.length === 0) return { imported: 0, skipped: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDS);
    const idx = store.index('clientId');
    let imported = 0;
    let skipped = 0;
    let pending = records.length;

    for (const r of records) {
      const cid = r.clientId || r.client_id;
      if (!cid) { skipped++; pending--; continue; }
      const checkReq = idx.getKey(cid);
      checkReq.onsuccess = () => {
        if (checkReq.result == null) {
          // 不存在，写入
          store.add({
            timestamp: r.ts || Date.now(),
            conversationId: r.conversationId || r.conversation_id || null,
            model: r.model || null,
            inputTokens: r.inputTokens || r.input_tokens || 0,
            outputTokens: r.outputTokens || r.output_tokens || 0,
            cachedTokens: r.cachedTokens || r.cached_tokens || 0,
            cacheWriteTokens: r.cacheWriteTokens || r.cache_write_tokens || 0,
            totalTokens: r.totalTokens || r.total_tokens || 0,
            url: r.url || '',
            source: r.source || 'sync',
            clientId: cid,
            ...(r.remaining != null ? { remaining: r.remaining } : {}),
            ...(r.credits != null ? { credits: r.credits } : {}),
            ...(r.costMoney != null ? { costMoney: r.costMoney } : {}),
            ...(r.userInputPreview != null ? { userInputPreview: r.userInputPreview } : {}),
          });
          imported++;
        } else {
          skipped++;
        }
        pending--;
        if (pending === 0) {
          tx.oncomplete = () => { db.close(); resolve({ imported, skipped }); };
        }
      };
      checkReq.onerror = () => {
        skipped++;
        pending--;
        if (pending === 0) {
          tx.oncomplete = () => { db.close(); resolve({ imported, skipped }); };
        }
      };
    }

    // 兜底：如果没有 pending（空数组已在前面 return）
    tx.onerror = () => reject(tx.error);
  });
}

// 总记录数（同步状态展示用）
export async function countAllRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    const req = store.count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// 最大本地 id（上传游标用）
export async function getMaxLocalId() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    const req = store.openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      resolve(cursor ? cursor.value.id : 0);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// 辅助函数
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKeyOf(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
