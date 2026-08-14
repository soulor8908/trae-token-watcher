// IndexedDB 封装 — Trae Token Watcher 数据层
// 数据流要短：content -> background -> IndexedDB；popup 直读 IndexedDB

const DB_NAME = 'trae-token-watcher';
const DB_VERSION = 5;
const STORE_RECORDS = 'usage-records';
const STORE_DIAGNOSES = 'diagnoses';

// getSummary 只加载近 N 天记录（覆盖月桶 + 14 天趋势），走 timestamp 索引范围查询，
// 避免每次刷新都 getAllRecords(2000) 全量扫描，降低 IDB 与主线程负载。
let _dbPromise = null;

// ---------- 聚合结果内存缓存 ----------
// getSummary / getComparison 各做一次全量/大窗口扫描，而 popup 渲染会频繁触发。
// 加 TTL 缓存复用结果；任何数据写入（addRecord/importRecords/clear）都会通过
// invalidateAggregates() 立即失效，保证「数据一变就重算、没变就复用」。
let _summaryCache = null;
let _comparisonCache = null;
const SUMMARY_TTL_MS = 5000;    // 摘要含今日/跨天桶，5s 内复用足够
const COMPARISON_TTL_MS = 60000; // 周期对比为日级数据，60s 复用足够
// 数据版本号：每次写入自增，供 popup 判断是否需要重渲染（避免固定 15s 全量重绘）
let _dataVersion = 0;

function invalidateAggregates() {
  _summaryCache = null;
  _comparisonCache = null;
  _predictCache = { ts: 0, data: null };
  _dataVersion++;
}

// 轻量数据指纹：仅做索引范围 count + 末条读取，远比 getSummary 全量扫描便宜。
// popup 的 15s 兜底轮询用它判断「数据是否变化」，未变化则跳过 DOM 重渲染。
export async function getDataState() {
  const [maxUsageTime, totalCount] = await Promise.all([getMaxUsageTime(), countRecordsSince(0)]);
  return { maxUsageTime, totalCount, dayKey: dayKeyOf(Date.now()) };
}

// 单例连接：IndexedDB 打开是异步且有开销，复用同一个连接，避免每次读写都 open/close
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
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
        // v5 起 conversationId 为唯一索引：同一会话只保留最新一条，从数据库层面防重复
        store.createIndex('conversationId', 'conversationId', { unique: true });
        store.createIndex('model', 'model', { unique: false });
        store.createIndex('clientId', 'clientId', { unique: false });
        store.createIndex('serverCreatedAt', 'serverCreatedAt', { unique: false });
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

      // v3 → v4：补 serverCreatedAt 索引，支撑按「本地最新记录时间」做增量拉取水位线
      if (e.oldVersion < 4 && db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = e.target.transaction.objectStore(STORE_RECORDS);
        if (!store.indexNames.contains('serverCreatedAt')) {
          store.createIndex('serverCreatedAt', 'serverCreatedAt', { unique: false });
        }
      }

      // v4 → v5：conversationId 改为唯一索引。
      // 先清理重复（同一会话只保留 timestamp 最新的一条），再重建唯一索引，
      // 否则旧库中已有重复会话会导致唯一索引创建抛 ConstraintError、升级失败。
      if (e.oldVersion < 5 && db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = e.target.transaction.objectStore(STORE_RECORDS);
        if (store.indexNames.contains('conversationId')) {
          store.deleteIndex('conversationId');
        }
        const keepKey = new Map(); // cid -> { key, ts }：保留 timestamp 最大的一条
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = (ev) => {
          const cursor = ev.target.result;
          if (cursor) {
            const rec = cursor.value;
            const cid = rec.conversationId;
            if (cid) {
              const ex = keepKey.get(cid);
              if (!ex) {
                keepKey.set(cid, { key: cursor.key, ts: rec.timestamp || 0 });
              } else if ((rec.timestamp || 0) > ex.ts) {
                // 当前记录更新：删掉之前保留的，保留当前
                store.delete(ex.key);
                keepKey.set(cid, { key: cursor.key, ts: rec.timestamp || 0 });
              } else {
                // 之前保留的更新：删掉当前
                cursor.delete();
              }
            }
            cursor.continue();
          } else {
            // 遍历完，重建唯一索引（此时每 cid 仅一条，安全）
            store.createIndex('conversationId', 'conversationId', { unique: true });
          }
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null; // 打开失败则下次重试
      reject(req.error);
    };
  });
  return _dbPromise;
}

// 生成客户端记录 ID（用于跨设备去重）
function genClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 写入一条用量记录
// 去重：带 conversationId（即 session_id）的记录，利用 v5 唯一索引定向删除旧快照后写入，
// 同一会话只保留最新一条（O(log n) 定向删除，替代原先 openCursor 遍历删除所有旧记录）。
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
      req.onsuccess = () => {
        invalidateAggregates(); // 数据已变，使聚合/预测缓存失效
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    };

    if (finalRecord.conversationId) {
      // 唯一索引定向删除旧快照：getKey 返回该会话此前那条记录的主键，删除后写入最新一条
      const idx = store.index('conversationId');
      const keyReq = idx.getKey(finalRecord.conversationId);
      keyReq.onsuccess = () => {
        if (keyReq.result != null) {
          const delReq = store.delete(keyReq.result);
          delReq.onsuccess = () => tryInsert();
          delReq.onerror = () => reject(delReq.error);
        } else {
          tryInsert();
        }
      };
      keyReq.onerror = () => tryInsert(); // 索引查询失败则直接插入
    } else {
      tryInsert();
    }

    tx.onerror = () => reject(tx.error);
    // 复用单例连接，事务结束不关闭
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
    // 复用单例连接，事务结束不关闭
  });
}

// 统计指定时间之后的记录数（用 timestamp 索引的 count，避免一次性加载全部记录）
export async function countRecordsSince(since = 0) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    const idx = store.index('timestamp');
    const range = IDBKeyRange.lowerBound(since);
    const req = idx.count(range);
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

// 获取全部记录（限制条数，默认最近 500 条）
// 排序：按真实用量时间 timestamp 索引降序，与「会话明细」的 lastActive 口径一致。
// 不能用主键 self-increment 倒序——云端导入/历史补采会拿到新 id 但旧 timestamp，导致错位。
export async function getAllRecords(limit = 500) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    const idx = store.index('timestamp');
    const req = idx.openCursor(null, 'prev'); // 按真实时间倒序
    const results = [];
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      }
    };
    tx.oncomplete = () => {
      resolve(results);
    };
    tx.onerror = () => reject(tx.error);
  });
}

// 聚合统计：按时间段汇总 token 用量
export async function getSummary() {
  const now = Date.now();
  if (_summaryCache && now - _summaryCache.ts < SUMMARY_TTL_MS) {
    return _summaryCache.data;
  }
  const dayMs = 24 * 60 * 60 * 1000;
  // 取全量记录：用索引范围查询（下限 0 = 全表，不被 2000 截断），覆盖全部历史。
  // 这样 all / bySession / byModel 聚合的是真实全量；趋势图展示时仍 slice(-14)，
  // 月桶用自然月起点（startOfMonth）。性能由事件驱动刷新(ttw_usage_ping) + 并发守卫
  // + 15s 兜底保证，不再每 5s 无脑全量。
  // 关键点：不能用「近 N 天」窗口取数——否则清空本地、从云端恢复的历史（大多 >31 天）
  // 会被挡在 popup 视图外，造成「数据都没了」的误判（本就是上一轮的回归）。
  const records = await getRecordsSince(0);

  const buckets = {
    today: { since: startOfDay(now), input: 0, output: 0, cached: 0, total: 0, count: 0, credits: 0, costMoney: 0 },
    week: { since: now - 7 * dayMs, input: 0, output: 0, cached: 0, total: 0, count: 0, credits: 0, costMoney: 0 },
    month: { since: startOfMonth(now), input: 0, output: 0, cached: 0, total: 0, count: 0, credits: 0, costMoney: 0 },
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

  const summaryResult = {
    buckets,
    trend: trendArr,
    byModel: byModelArr,
    bySession: bySessionArr,
    cacheStats,
    totalRecords: records.length,
  };
  _summaryCache = { ts: now, data: summaryResult };
  return summaryResult;
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
// predictUsage 较昂贵（加载近 14 天记录），而 handleUsage 每条写入都会触发它。
// 用 60s TTL 缓存最终结果，高频写入时避免反复全量加载。数据即使滞后 60s 对
// 日/月级预警阈值也无影响。
let _predictCache = { ts: 0, data: null };
const PREDICT_TTL_MS = 60000;

export async function predictUsage() {
  const now = Date.now();
  if (_predictCache.data && now - _predictCache.ts < PREDICT_TTL_MS) {
    return _predictCache.data;
  }
  const dayMs = 86400000;
  const records = await getRecordsSince(now - 14 * dayMs); // 取近 14 天

  if (records.length === 0) {
    const res = { available: false, reason: '暂无历史数据' };
    _predictCache = { ts: now, data: res };
    return res;
  }

  // 按天聚合（最近 14 天）
  const dailyMap = new Map();
  for (const r of records) {
    const key = dayKeyOf(r.timestamp); // 本地日期，与 getSummary/getComparison 一致
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
    const res = { available: false, reason: '近 14 天无数据' };
    _predictCache = { ts: now, data: res };
    return res;
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

  // 今日已用（本地日期，与上方按天聚合、以及 getSummary 的"今日"口径一致）
  const todayKey = dayKeyOf(Date.now());
  const todayData = days.find((d) => d.date === todayKey) || { tokens: 0, credits: 0, count: 0 };

  const result = {
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
  _predictCache = { ts: now, data: result };
  return result;
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
  if (_comparisonCache && now - _comparisonCache.ts < COMPARISON_TTL_MS) {
    return _comparisonCache.data;
  }
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

  const comparisonResult = { ranges: result };
  _comparisonCache = { ts: now, data: comparisonResult };
  return comparisonResult;
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
    req.onsuccess = () => {
      invalidateAggregates(); // 清空数据，使聚合/预测缓存失效及版本自增
      resolve(true);
    };
    req.onerror = () => reject(req.error);
    // 复用单例连接，事务结束不关闭
  });
}

// 本地记录中最大的服务端接收时间（增量拉取水位线；无记录或索引缺失返回 0 → 下次全量拉取）
export async function getMaxServerCreatedAt() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    if (!store.indexNames.contains('serverCreatedAt')) {
      resolve(0);
      return;
    }
    const idx = store.index('serverCreatedAt');
    const req = idx.openCursor(null, 'prev'); // 倒序，第一条即最大值
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      resolve(cursor ? (cursor.value.serverCreatedAt || 0) : 0);
    };
    req.onerror = () => reject(req.error);
  });
}

// 本地记录中最大的真实用量时间（批量增量拉取水位线；无记录或索引缺失返回 0 → 下次全量首拉）。
// 取 timestamp 索引倒序第一条即最大值。清空本地数据后库为空 → 返回 0 → 自动全量首拉，
// 彻底摆脱「上一次获取时间」类易失游标（原 BULK_LAST_END_KEY 已废弃）。
export async function getMaxUsageTime() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readonly');
    const store = tx.objectStore(STORE_RECORDS);
    if (!store.indexNames.contains('timestamp')) {
      resolve(0);
      return;
    }
    const idx = store.index('timestamp');
    const req = idx.openCursor(null, 'prev'); // 倒序，第一条即最大值
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      resolve(cursor ? (cursor.value.timestamp || 0) : 0);
    };
    req.onerror = () => reject(req.error);
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
    // 复用单例连接，事务结束不关闭
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
    // 复用单例连接，事务结束不关闭
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
    // 复用单例连接，事务结束不关闭
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
    // 复用单例连接，事务结束不关闭
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
    // 复用单例连接，事务结束不关闭
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
    // 复用单例连接，事务结束不关闭
  });
}

// 批量导入记录（下载用）：按 clientId 去重，已存在则跳过
// records: [{ clientId, ts, model, ... }]（server_created_at 字段会被忽略）
// 注意：同一批次内若含重复 clientId，必须在应用层去重——IDB 的 idx.getKey 是异步的，
// 前一条插入尚未提交时，后一条同 cid 的检查会误判为不存在而重复写入。故用 seen 集合
// 先过滤本批次内的重复 cid，再逐个查库。
export async function importRecords(records) {
  if (!records || records.length === 0) return { imported: 0, skipped: 0 };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDS);
    const idx = store.index('clientId');
    let imported = 0;
    let skipped = 0;
    const seen = new Set(); // 本批次内已处理的 clientId，防同批同 cid 重复写入

    // 事务顶层一次性解析：无论有无 IDB 请求（全 skipped 时事务为空也会 oncomplete），
    // 都能在事务结束时拿到最终计数。避免按 pending 计数在循环内赋值 oncomplete 导致挂起。
    tx.oncomplete = () => {
      invalidateAggregates(); // 批量导入改变数据，使聚合/预测缓存失效及版本自增
      resolve({ imported, skipped });
    };
    tx.onerror = () => reject(tx.error);

    for (const r of records) {
      const cid = r.clientId || r.client_id;
      if (!cid) { skipped++; continue; }
      if (seen.has(cid)) { skipped++; continue; } // 本批次内已出现过，跳过
      seen.add(cid);
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
            serverCreatedAt: r.server_created_at || 0, // 服务端接收时间，用于增量拉取水位线
            ...(r.remaining != null ? { remaining: r.remaining } : {}),
            ...(r.credits != null ? { credits: r.credits } : {}),
            ...(r.costMoney != null ? { costMoney: r.costMoney } : {}),
            ...(r.userInputPreview != null ? { userInputPreview: r.userInputPreview } : {}),
          });
          imported++;
        } else {
          skipped++;
        }
      };
      checkReq.onerror = () => { skipped++; };
    }
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
    // 复用单例连接，事务结束不关闭
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
    // 复用单例连接，事务结束不关闭
  });
}

// 辅助函数
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfMonth(ts) {
  const d = new Date(ts);
  d.setDate(1);
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
