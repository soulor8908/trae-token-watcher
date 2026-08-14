// 通用 HTTP 工具 — 响应构造 / 错误 / 哈希
// 供各路由模块复用，避免重复定义 json()/httpError()/sha256()

// 构造 JSON 响应
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// 构造带状态码的错误（由上层 catch 统一处理）
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// SHA-256 十六进制摘要（缓存 key / 哈希用）
export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}