// D1 查询封装 — users / sessions / usage_quota
// 数据流要短：每个函数一个明确的查询/写入

// ---------- users ----------
// 按 github_id 查找或创建用户，返回 user record
export async function upsertUser(db, { githubId, login, avatarUrl }) {
  const existing = await db
    .prepare('SELECT id, github_id, login, avatar_url FROM users WHERE github_id = ?')
    .bind(githubId)
    .first();

  if (existing) {
    // 更新 login / avatar（用户可能改名/换头像）
    await db
      .prepare('UPDATE users SET login = ?, avatar_url = ?, updated_at = unixepoch() WHERE id = ?')
      .bind(login, avatarUrl, existing.id)
      .run();
    return { ...existing, login, avatarUrl };
  }

  const result = await db
    .prepare('INSERT INTO users (github_id, login, avatar_url) VALUES (?, ?, ?)')
    .bind(githubId, login, avatarUrl)
    .run();
  return { id: result.meta.last_row_id, github_id: githubId, login, avatar_url: avatarUrl };
}

export async function getUserById(db, userId) {
  return db
    .prepare('SELECT id, github_id, login, avatar_url FROM users WHERE id = ?')
    .bind(userId)
    .first();
}

// ---------- sessions ----------
// 存储 session（只存哈希）
export async function createSession(db, { tokenHash, userId, expiresAt }) {
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, userId, expiresAt)
    .run();
}

// 按 token 哈希查找有效 session
export async function getSessionByHash(db, tokenHash) {
  return db
    .prepare(`
      SELECT s.token_hash, s.user_id, s.expires_at, u.login, u.avatar_url
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > unixepoch()
    `)
    .bind(tokenHash)
    .first();
}

// 删除 session（登出）
export async function deleteSession(db, tokenHash) {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

// 清理过期 session（可在请求时顺手执行）
export async function purgeExpiredSessions(db) {
  try {
    await db.prepare('DELETE FROM sessions WHERE expires_at <= unixepoch()').run();
  } catch (_) { /* 静默失败，不影响主流程 */ }
}

// ---------- github_tokens ----------
// 存/取加密后的 GitHub access_token，供 Star 状态回查使用
export async function saveGithubToken(db, { userId, enc, iv }) {
  await db
    .prepare(`
      INSERT INTO github_tokens (user_id, access_token_enc, access_token_iv) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        access_token_enc = excluded.access_token_enc,
        access_token_iv = excluded.access_token_iv,
        updated_at = unixepoch()
    `)
    .bind(userId, enc, iv)
    .run();
}

export async function getGithubToken(db, userId) {
  return db
    .prepare('SELECT access_token_enc, access_token_iv FROM github_tokens WHERE user_id = ?')
    .bind(userId)
    .first();
}

// ---------- usage_quota ----------
// 获取用户今日已用配额
export async function getTodayQuota(db, userId) {
  const dateKey = todayKey();
  const row = await db
    .prepare('SELECT count FROM usage_quota WHERE user_id = ? AND date_key = ?')
    .bind(userId, dateKey)
    .first();
  return { dateKey, count: row?.count || 0 };
}

// 配额 +1（不存在则插入）
export async function incrementQuota(db, userId) {
  const dateKey = todayKey();
  await db
    .prepare(`
      INSERT INTO usage_quota (user_id, date_key, count) VALUES (?, ?, 1)
      ON CONFLICT(user_id, date_key) DO UPDATE SET count = count + 1
    `)
    .bind(userId, dateKey)
    .run();
}

function todayKey() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
