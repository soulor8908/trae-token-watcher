// KV 固定窗口限流 — 每用户/每窗口计数
// 说明：get 后 put 非严格原子，极端并发下计数可能略超阈值，对限流场景可接受（与既有 D1 quota 竞态一致）

export async function rateLimit(env, key, limit, windowSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSeconds);
  const rlKey = `rl:${key}:${bucket}`;
  const current = parseInt((await env.KV.get(rlKey)) || '0', 10);
  if (current >= limit) {
    return { allowed: false, limit, current };
  }
  const next = current + 1;
  // 窗口结束后 KV 自动过期，避免残留
  const ttl = Math.max(1, bucket * windowSeconds + windowSeconds - now);
  await env.KV.put(rlKey, String(next), { expirationTtl: ttl });
  return { allowed: true, limit, current: next };
}