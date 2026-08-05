// IndexedDB 封装 — Trae Token Watcher 数据层
// 数据流要短：content -> background -> IndexedDB；popup 直读 IndexedDB

const DB_NAME = 'trae-token-watcher';
const DB_VERSION = 1;
const STORE_RECORDS = 'usage-records';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const store = db.createObjectStore(STORE_RECORDS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('conversationId', 'conversationId', { unique: false });
        store.createIndex('model', 'model', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 写入一条用量记录
export async function addRecord(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_RECORDS, 'readwrite');
    const store = tx.objectStore(STORE_RECORDS);
    const req = store.add({
      timestamp: Date.now(),
      conversationId: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      url: '',
      source: 'fetch',
      ...record,
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
    today: { since: startOfDay(now), input: 0, output: 0, cached: 0, total: 0, count: 0 },
    week: { since: now - 7 * dayMs, input: 0, output: 0, cached: 0, total: 0, count: 0 },
    month: { since: now - 30 * dayMs, input: 0, output: 0, cached: 0, total: 0, count: 0 },
    all: { since: 0, input: 0, output: 0, cached: 0, total: 0, count: 0 },
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

  // 按 model 汇总
  const byModel = {};
  for (const r of records) {
    const m = r.model || 'unknown';
    if (!byModel[m]) byModel[m] = { model: m, total: 0, count: 0 };
    byModel[m].total += r.totalTokens || 0;
    byModel[m].count += 1;
  }

  return {
    buckets,
    trend: trendArr,
    byModel: Object.values(byModel).sort((a, b) => b.total - a.total),
    totalRecords: records.length,
  };
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
