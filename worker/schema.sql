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
