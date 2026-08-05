// Session 管理 — 签发 / 校验 / 哈希
// 安全原则：D1 只存 SHA-256 哈希，明文 token 仅返回给客户端一次

import { createSession, getSessionByHash } from './db.js';

const SESSION_TTL = 7 * 24 * 60 * 60; // 7 天（秒）

// 生成随机 session token（32 字节 hex）
export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// SHA-256 哈希（带 secret 盐，防彩虹表）
export async function hashToken(token, env) {
  const secret = env?.SESSION_SECRET || '';
  const data = new TextEncoder().encode(token + ':' + secret);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 签发 session：生成 token + 哈希存库，返回明文 token
export async function issueSession(env, userId) {
  const token = generateToken();
  const tokenHash = await hashToken(token, env);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL;
  await createSession(env.DB, { tokenHash, userId, expiresAt });
  return { token, expiresAt };
}

// 校验请求中的 session，返回 session 记录或 null
export async function verifySession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  if (!token) return null;

  const tokenHash = await hashToken(token, env);
  const session = await getSessionByHash(env.DB, tokenHash);
  return session || null;
}
