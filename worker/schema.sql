-- Trae Token Watcher — D1 数据库 Schema
-- 设计原则：只存身份与配额，不存用户对话内容（用量数据在扩展本地）

-- 用户表：GitHub 身份
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Session 表：只存 SHA-256 哈希，不存明文 token
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,           -- SHA-256(session_token)
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL,           -- 过期时间戳（秒）
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 配额表：Star 用户每天限 10 次免费诊断
-- 以 (user_id, date) 为键，按自然日计数
CREATE TABLE IF NOT EXISTS usage_quota (
  user_id INTEGER NOT NULL,
  date_key TEXT NOT NULL,                -- YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 用量记录表：跨设备同步
-- 记录不可变（写入后不修改），用 (user_id, client_id) 去重
CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,               -- 客户端生成的 uuid，去重键
  ts INTEGER NOT NULL,                   -- 记录时间戳（毫秒）
  model TEXT,
  conversation_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  credits REAL NOT NULL DEFAULT 0,
  cost_money REAL NOT NULL DEFAULT 0,
  remaining INTEGER,
  source TEXT,
  url TEXT,
  user_input_preview TEXT,
  device_id TEXT,                        -- 区分设备
  server_created_at INTEGER NOT NULL DEFAULT (unixepoch()),  -- 服务器接收时间（秒）
  UNIQUE (user_id, client_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_user_ts ON usage_records(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_user_server ON usage_records(user_id, server_created_at);

-- 同步水位表：记录每个用户每个设备的最后同步位置
CREATE TABLE IF NOT EXISTS sync_cursor (
  user_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  last_pull_server_ts INTEGER NOT NULL DEFAULT 0,  -- 上次拉取到的 server_created_at
  last_sync_at INTEGER NOT NULL DEFAULT 0,         -- 上次同步动作时间（秒）
  PRIMARY KEY (user_id, device_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

