/**
 * LLM 关键词转写
 *
 * 定位：**只做一件事** —— 把用户那句很模糊的话，改写成可以拿去平台搜索的关键词
 *       和几个结构化约束。不让它挑店、不让它报价、不让它写推荐语。
 *
 * 省钱的做法：
 *  - 极短 system + 两个 few-shot，输出字段名压到 2 字符
 *  - 强制 JSON 对象（response_format），max_tokens 卡死，temperature 0.2
 *  - 转写结果按"原句 + 口味 + 预算"缓存，同样的话不会重复调用
 *  - 返回后按用户填的单价估算本次费用，并累计到当天用量
 */

import { CUISINE_KINDS } from './catalog.js';

const KIND_IDS = CUISINE_KINDS.map((k) => k.id);
const TASTE_IDS = ['spicy', 'light', 'lowcal', 'meat', 'noodle', 'rice', 'soup', 'sweet', 'seafood', 'value'];

const SYSTEM = [
  '把用户的口腹之欲转成外卖搜索词。只输出 JSON，不要解释。',
  'kw: 2-4 个可直接搜索的中文短词（含具体菜名，≤8 字），第一个最重要',
  'k: 从品类表选 1-2 个',
  `品类表 ${KIND_IDS.join(' ')}`,
  't: 口味标签 0-3 个',
  `口味表 ${TASTE_IDS.join(' ')}`,
  'b: 预算上限（元，数字），没提到填 null',
  'p: 人数（数字），没提到填 null',
  'a: 忌口数组，没有填 []',
  '示例1 输入「想吃点辣的但是别太贵，一个人吃」→ {"kw":["麻辣香锅","水煮肉片","川菜"],"k":["hotpot"],"t":["spicy","value"],"b":null,"p":1,"a":[]}',
  '示例2 输入「感冒了想喝点热乎的粥，不要葱」→ {"kw":["皮蛋瘦肉粥","砂锅粥","养生汤"],"k":["congee"],"t":["soup","light"],"b":null,"p":null,"a":["葱"]}',
].join('\n');

const CACHE_LIMIT = 60;
const cache = new Map();

function cacheKey({ text, tastes, budget }) {
  return `${String(text).trim()}||${(tastes || []).join(',')}||${budget ?? ''}`;
}

/** 估算费用（元） */
export function estimateCost({ tokensIn = 0, tokensOut = 0, priceIn = 0, priceOut = 0 }) {
  return (tokensIn / 1e6) * priceIn + (tokensOut / 1e6) * priceOut;
}

/** 粗略估 token（无 usage 字段时兜底）：中文约 1 字 ≈ 1 token */
function roughTokens(s) {
  return Math.max(1, Math.round(String(s).length * 0.9));
}

function sanitize(obj, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;
  const kw = Array.isArray(obj.kw) ? obj.kw.map((x) => String(x).trim()).filter(Boolean) : [];
  const k = Array.isArray(obj.k) ? obj.k.filter((x) => KIND_IDS.includes(x)) : [];
  const t = Array.isArray(obj.t) ? obj.t.filter((x) => TASTE_IDS.includes(x)) : [];
  const b = Number.isFinite(Number(obj.b)) && Number(obj.b) > 3 && Number(obj.b) < 5000 ? Number(obj.b) : null;
  const p = Number.isFinite(Number(obj.p)) && Number(obj.p) > 0 && Number(obj.p) <= 20 ? Number(obj.p) : null;
  const a = Array.isArray(obj.a) ? obj.a.map((x) => String(x).trim()).filter(Boolean).slice(0, 5) : [];

  const keywords = kw
    .map((s) => s.replace(/[。，,、!！?？\s]+$/g, '').slice(0, 12))
    .filter(Boolean)
    .slice(0, 5);

  return {
    keywords: keywords.length ? keywords : fallback.keywords,
    kinds: k.length ? k : fallback.kinds,
    tastes: t.length ? t : fallback.tastes,
    budget: b ?? fallback.budget,
    party: p ?? fallback.party,
    avoid: a.length ? a : fallback.avoid,
    time: fallback.time,
    raw: fallback.raw,
    source: 'llm',
  };
}

/**
 * 调用 LLM 转写
 * @returns {Promise<{ok:boolean, parsed?:object, usage?:object, cost?:number, error?:string}>}
 */
export async function llmExtract({ text, apiKey, cfg, fallback }) {
  const key = cacheKey({ text, tastes: [], budget: null });
  if (cache.has(key)) {
    const hit = cache.get(key);
    return { ok: true, parsed: { ...hit.parsed, source: 'llm', cached: true }, usage: { cached: true }, cost: 0 };
  }

  if (!apiKey) return { ok: false, error: '未填写 API Key' };
  if (!cfg?.baseUrl) return { ok: false, error: '未填写接口地址' };

  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const userMsg = fallback.tastes?.length
    ? `${text}\n（用户长期偏好：${fallback.tastes.join('、')}）`
    : text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: cfg.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMsg },
        ],
        temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.2,
        max_tokens: 180,
        response_format: { type: 'json_object' },
        stream: false,
      }),
    });

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.error?.message || j?.message || '';
      } catch { /* ignore */ }
      const hint = res.status === 401 ? 'API Key 无效或已过期'
        : res.status === 402 ? '账户余额不足'
          : res.status === 429 ? '请求过于频繁，稍后再试'
            : res.status === 404 ? '接口地址或模型名不对'
              : `HTTP ${res.status}`;
      return { ok: false, error: `${hint}${detail ? '：' + detail : ''}` };
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    let obj = null;
    try { obj = JSON.parse(content); }
    catch {
      const m = String(content).match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch { /* ignore */ } }
    }
    if (!obj) return { ok: false, error: '模型返回的不是 JSON' };

    const parsed = sanitize(obj, fallback);
    const u = data?.usage || {};
    const tokensIn = Number(u.prompt_tokens) || roughTokens(SYSTEM + userMsg);
    const tokensOut = Number(u.completion_tokens) || roughTokens(content);
    const cost = estimateCost({ tokensIn, tokensOut, priceIn: cfg.priceIn || 0, priceOut: cfg.priceOut || 0 });

    cache.set(key, { parsed });
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);

    return {
      ok: true,
      parsed,
      usage: { tokensIn, tokensOut, total: Number(u.total_tokens) || tokensIn + tokensOut },
      cost,
      model: cfg.model,
    };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? '请求超时' : (err?.message || String(err));
    const corsy = /failed to fetch|networkerror|load failed/i.test(msg);
    return { ok: false, error: corsy ? '网络或跨域被拦截（该接口可能不允许浏览器直连）' : msg };
  } finally {
    clearTimeout(timer);
  }
}

/** 连通性自检：发一条最小请求 */
export async function llmPing({ apiKey, cfg }) {
  const r = await llmExtract({ text: '想吃面', apiKey, cfg, fallback: { keywords: ['面'], kinds: [], tastes: [], budget: null, party: null, avoid: [], raw: '想吃面' } });
  return r;
}

export const PROMPT_PREVIEW = SYSTEM;
