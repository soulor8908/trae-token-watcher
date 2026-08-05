// 诊断 API — 路径 A：后端转发 DeepSeek
// 流程：校验 session → 检查 Star → 限流(10/天) → 命中缓存则返回 → 否则转发 DeepSeek → 缓存结果 → 返回
// 只接收聚合统计，不含对话内容

import { getTodayQuota, incrementQuota } from './db.js';
import { httpError } from './github.js';

const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';

const SYSTEM_PROMPT = `你是 TRAE Work 的 Token 优化专家。用户会提供聚合后的 Token 用量统计（不含对话内容）。
请用简洁的中文给出诊断，格式如下：
1. 一句话总结现状
2. 2-3 条关键发现（用要点列出）
3. 3 条可立即执行的具体优化建议（按优先级排序）
保持简洁，总字数控制在 300 字以内。`;

// POST /api/diagnose
// body: { stats: "聚合统计文本" }
export async function handleDiagnose(request, env, session) {
  if (!session) {
    throw httpError(401, '未登录');
  }

  // 检查 Star 状态（KV 缓存）
  const starred = (await env.KV.get(`star:u:${session.user_id}`)) === '1';
  if (!starred) {
    throw httpError(403, '需要先 Star 仓库才能使用免费诊断');
  }

  // 解析请求体
  const body = await request.json().catch(() => null);
  if (!body || !body.stats) {
    throw httpError(400, '缺少 stats 字段');
  }
  const stats = String(body.stats).slice(0, 4000); // 限制长度，防滥用

  // 限流：每天 10 次
  const { count } = await getTodayQuota(env.DB, session.user_id);
  const quota = parseInt(env.DAILY_QUOTA || 10);
  if (count >= quota) {
    throw httpError(429, `今日免费诊断已用完（${quota} 次/天），请明天再来或使用自有 API Key`);
  }

  // 缓存：相同 stats 文本的诊断结果缓存 1h
  const cacheKey = `diag:${await sha256(stats)}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    return json({
      result: cached,
      cached: true,
      quotaUsed: count,
      quotaTotal: quota,
    });
  }

  // 转发 DeepSeek
  const result = await callDeepSeek(env, stats);

  // 缓存结果
  await env.KV.put(cacheKey, result, {
    expirationTtl: parseInt(env.DIAG_CACHE_TTL || 3600),
  });

  // 配额 +1
  await incrementQuota(env.DB, session.user_id);

  return json({
    result,
    cached: false,
    quotaUsed: count + 1,
    quotaTotal: quota,
  });
}

// 调用 DeepSeek API
async function callDeepSeek(env, stats) {
  const resp = await fetch(DEEPSEEK_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: stats },
      ],
      temperature: 0.7,
      max_tokens: 1200,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw httpError(502, `DeepSeek API 错误 ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '诊断完成，但未返回内容';
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
