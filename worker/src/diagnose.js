// 诊断 API — 路径 A：后端转发 DeepSeek
// 流程：校验 session → 检查 Star → 限流(10/天) → 命中缓存则返回 → 否则转发 DeepSeek → 缓存结果 → 返回
// 只接收聚合统计，不含对话内容

import { getTodayQuota, incrementQuota } from './db.js';
import { httpError, json, sha256 } from './http.js';
import { rateLimit } from './rateLimit.js';

const DEEPSEEK_API = 'https://api.deepseek.com/chat/completions';

// quick 模式：快速诊断，简洁、字数少
const QUICK_SYSTEM_PROMPT = `你是 TRAE Work 的 Token 优化专家。用户会提供聚合后的 Token 用量统计（不含对话内容）。
请用简洁的中文给出诊断，格式如下：
1. 一句话总结现状
2. 2-3 条关键发现（用要点列出）
3. 3 条可立即执行的具体优化建议（按优先级排序）
保持简洁，总字数控制在 300 字以内。`;

// deep 模式：深度诊断，结构更完整、给出量化依据与可落地方案
const DEEP_SYSTEM_PROMPT = `你是 TRAE Work 的 Token 优化专家。用户会提供聚合后的 Token 用量统计（不含对话内容）。
请用中文给出深入的诊断报告，格式如下：
1. 现状总览：一句话概括整体用量特征
2. 关键发现：3-5 条，逐条给出「现象 → 可能成因」的推断，尽量引用统计中的具体数值
3. 优化建议：4-6 条，按优先级排序，每条给出「具体动作 → 预期收益」
4. 风险提示：对可能被忽略的异常项（如某模型用量异常高、缓存率偏低）单独指出
分析要具体、可执行，避免泛泛而谈；总字数控制在 800 字以内。`;

// 依据用户选择的模式选择提示词
function pickSystemPrompt(mode) {
  return mode === 'deep' ? DEEP_SYSTEM_PROMPT : QUICK_SYSTEM_PROMPT;
}

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
  const mode = body.mode === 'deep' ? 'deep' : 'quick';

  // 短周期限流：防止瞬间打爆 DeepSeek（固定窗口，默认 10 次 / 15 分钟）
  const rl = await rateLimit(env, `diag:${session.user_id}`, parseInt(env.DIAG_RATE_LIMIT || 10) || 10, 900);
  if (!rl.allowed) {
    throw httpError(429, '诊断请求过于频繁，请稍后再试');
  }

  // 限流：每天 10 次
  const { count } = await getTodayQuota(env.DB, session.user_id);
  const quota = parseInt(env.DAILY_QUOTA || 10);
  if (count >= quota) {
    throw httpError(429, `今日免费诊断已用完（${quota} 次/天），请明天再来或使用自有 API Key`);
  }

  // 缓存：相同 stats + mode 文本的诊断结果缓存 1h
  const cacheKey = `diag:${mode}:${await sha256(stats)}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) {
    return json({
      result: cached,
      cached: true,
      mode,
      quotaUsed: count,
      quotaTotal: quota,
    });
  }

  // 转发 DeepSeek
  const result = await callDeepSeek(env, stats, pickSystemPrompt(mode));

  // 缓存结果
  await env.KV.put(cacheKey, result, {
    expirationTtl: parseInt(env.DIAG_CACHE_TTL || 3600),
  });

  // 配额 +1
  await incrementQuota(env.DB, session.user_id);

  return json({
    result,
    cached: false,
    mode,
    quotaUsed: count + 1,
    quotaTotal: quota,
  });
}

const DEEPSEEK_TIMEOUT_MS = 15000; // 单次请求超时
const DEEPSEEK_MAX_RETRIES = 2;    // 超时 / 5xx 重试次数

// fetch 带超时：超时后 abort，避免 Worker 被挂起的下游请求拖死
async function fetchWithTimeout(url, options, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 调用 DeepSeek API（带超时 + 有限重试）
// 仅对「网络错误 / 超时 / 5xx」重试；4xx（含 401/429）视为终态，直接报错不重试
async function callDeepSeek(env, stats, systemPrompt) {
  let lastErr;
  for (let attempt = 0; attempt <= DEEPSEEK_MAX_RETRIES; attempt++) {
    try {
      const resp = await fetchWithTimeout(DEEPSEEK_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: stats },
          ],
          temperature: 0.7,
          max_tokens: 1200,
        }),
      }, DEEPSEEK_TIMEOUT_MS);

      if (!resp.ok) {
        // 5xx 瞬时错误：重试；4xx 终态：直接报错
        if (resp.status >= 500 && attempt < DEEPSEEK_MAX_RETRIES) {
          lastErr = new Error(`DeepSeek 5xx ${resp.status}`);
          await sleep(300 * (attempt + 1));
          continue;
        }
        const errText = await resp.text();
        throw httpError(502, `DeepSeek API 错误 ${resp.status}: ${errText.slice(0, 200)}`);
      }

      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '诊断完成，但未返回内容';
    } catch (e) {
      // 已构造的 HTTP 错误（上面 throw 的 httpError，带 status）直接上抛，不重试
      if (e && e.status) throw e;
      // 其余（AbortError / 网络异常）可重试
      if (attempt < DEEPSEEK_MAX_RETRIES) {
        lastErr = e;
        await sleep(300 * (attempt + 1));
        continue;
      }
      lastErr = e;
      break;
    }
  }
  throw httpError(502, `DeepSeek 调用失败: ${lastErr?.message || '未知错误'}`);
}
