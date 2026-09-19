/**
 * 平台适配层
 *
 * 一个 Provider 负责"给我一批候选套餐"。当前内置两种：
 *
 *  1. demo   —— 内置演示数据源。确定性伪随机（同一关键词结果稳定），
 *               用于把「关键词 → 搜索 → 采集 → 加权 → 排名 → 卡片」整条链路真实跑通。
 *  2. custom —— 用户自备的数据接口。前端 POST 一个 JSON，拿回候选列表。
 *               想把真实平台数据接进来时，把自建后端/官方开放平台的地址填在这里即可。
 *
 * ⚠️ 为什么不直接在前端抓平台？
 *    浏览器受同源策略限制（CORS），平台接口也不允许第三方网页直连；
 *    加上各平台的反爬与登录态校验，纯前端抓取既不可行也不合规。
 *    所以真实数据必须经由「你有权访问的接口」。见 README。
 */

import {
  PLATFORMS, platformById, CUISINE_KINDS, MERCHANT_PREFIX, MERCHANT_SUFFIX,
  REVIEW_POOL, BAD_REVIEW_POOL, PLATFORM_TRAITS,
} from './catalog.js';
import { mulberry32, hashSeed, pick, jitter, clamp } from './util.js';

/* ══════════════ 数据源声明 ══════════════ */

export const SOURCES = [
  {
    id: 'demo',
    label: '内置演示数据源',
    desc: '离线可用，生成结构完整的占位数据，用来跑通比价链路',
    needsEndpoint: false,
  },
  {
    id: 'custom',
    label: '自备数据接口',
    desc: '把你有权访问的接口地址填进来，前端会按约定格式请求',
    needsEndpoint: true,
  },
];

/* ══════════════ 演示数据源 ══════════════ */

const KIND_BY_ART = Object.fromEntries(CUISINE_KINDS.map((k) => [k.id, k]));

function pickKinds(parsed, rng) {
  const ids = (parsed.kinds || []).filter((k) => KIND_BY_ART[k]);
  if (ids.length) return ids.slice(0, 2).map((id) => KIND_BY_ART[id]);
  // 没有识别出品类：用关键词做一次模糊匹配
  const kw = (parsed.keywords || []).join('');
  const hit = CUISINE_KINDS.filter((k) =>
    k.packs.some((p) => kw.includes(p.slice(0, 2))) || kw.includes(k.label));
  if (hit.length) return hit.slice(0, 2);
  return [CUISINE_KINDS[Math.floor(rng() * CUISINE_KINDS.length)]];
}

function merchantName(rng) {
  return `${pick(rng, MERCHANT_PREFIX)}${pick(rng, MERCHANT_SUFFIX)}`;
}

function buildDeals(rng, trait, ctx) {
  const { base, platformId, memberOn, party } = ctx;
  const deals = [];

  // 平台折扣
  const discountRate = clamp(jitter(rng, 0.86 * (trait.priceBias < 1 ? 0.97 : 1.01), 0.09), 0.62, 0.99);
  if (rng() < 0.72) {
    deals.push({
      kind: 'discount',
      label: `${(discountRate * 10).toFixed(1).replace(/\.0$/, '')} 折`,
      amount: Math.round(base * (1 - discountRate) * 100) / 100,
    });
  }

  // 满减券（门槛高于原价就用不了，直接不生成）
  if (rng() < 0.78 * trait.couponBias) {
    const tiers = [[20, 5], [30, 8], [40, 12], [50, 15], [60, 20], [80, 26]];
    const usable = tiers.filter(([th]) => base >= th);
    const tier = usable.length ? usable[usable.length - 1] : null;
    if (tier) {
      const extra = Math.round(tier[1] * clamp(jitter(rng, 1, 0.18), 0.8, 1.3));
      deals.push({ kind: 'coupon', label: `满 ${tier[0]} 减 ${extra}`, amount: extra, threshold: tier[0] });
    }
  }

  // 免配送费
  if (rng() < 0.34) deals.push({ kind: 'freeship', label: '配送费已免', amount: 0 });

  // 会员权益
  if (memberOn && rng() < 0.66) {
    deals.push({
      kind: 'member',
      label: '会员价',
      amount: Math.round(clamp(base * jitter(rng, 0.06, 0.4), 1, 12) * 100) / 100,
    });
  }

  // 新客 / 限时
  if (rng() < 0.22) {
    deals.push({
      kind: 'newcomer',
      label: '限时立减',
      amount: Math.round(clamp(base * jitter(rng, 0.08, 0.5), 2, 18) * 100) / 100,
    });
  }

  if (party && party >= 3 && rng() < 0.5) {
    deals.push({ kind: 'coupon', label: `多人餐立减 ${party * 2}`, amount: party * 2 });
  }

  return deals;
}

function buildReviews(rng, quality) {
  const good = [];
  const used = new Set();
  const want = quality > 0.75 ? 3 : 2;
  while (good.length < want && used.size < REVIEW_POOL.length) {
    const i = Math.floor(rng() * REVIEW_POOL.length);
    if (used.has(i)) continue;
    used.add(i);
    good.push(REVIEW_POOL[i]);
  }
  const bad = [];
  if (quality < 0.72) {
    bad.push(BAD_REVIEW_POOL[Math.floor(rng() * BAD_REVIEW_POOL.length)]);
  }
  return { good, bad };
}

/**
 * 生成某平台下的一批候选
 */
export function demoPlatformSearch(platformId, parsed, settings, credentials, salt = 0) {
  const p = platformById(platformId);
  const trait = PLATFORM_TRAITS[platformId] || PLATFORM_TRAITS.meituan;
  const kwKey = (parsed.keywords || []).join('|') || parsed.raw || 'default';
  const seedBase = salt ? `${kwKey}#${salt}` : kwKey;
  const cred = credentials?.[platformId] || {};
  const memberOn = !!(settings.platforms?.[platformId]?.options?.['会员'] ||
    Object.values(settings.platforms?.[platformId]?.options || {}).some(Boolean) ||
    cred.member);

  const offers = [];
  const merchantCount = 4;
  for (let mi = 0; mi < merchantCount; mi++) {
    const rng = mulberry32(hashSeed(`${seedBase}::${platformId}::m${mi}`));
    const kinds = pickKinds(parsed, rng);
    const kind = kinds[mi % kinds.length];

    const rating = clamp(jitter(rng, 4.55 * trait.ratingBias, 0.09), 3.5, 5);
    const reviewCount = Math.round(jitter(rng, 1400, 0.9));
    const name = merchantName(rng);

    const packages = [];
    const pkgCount = 1 + (rng() < 0.6 ? 1 : 0) + (rng() < 0.2 ? 1 : 0);
    for (let pi = 0; pi < pkgCount; pi++) {
      const prng = mulberry32(hashSeed(`${seedBase}::${platformId}::m${mi}::p${pi}`));
      const packName = kind.packs[(mi + pi) % kind.packs.length];
      const span = kind.price[1] - kind.price[0];
      const partyFactor = parsed.party && parsed.party > 1 ? 1 + (parsed.party - 1) * 0.62 : 1;
      let base = (kind.price[0] + span * (0.25 + prng() * 0.75)) * partyFactor * trait.priceBias;
      if (parsed.budget) {
        // 让价格围绕预算上下浮动，形成有意义的取舍
        base = base * 0.55 + parsed.budget * (0.62 + prng() * 0.72);
      }
      base = Math.round(clamp(base, 9, 400) * 100) / 100;

      const deals = buildDeals(prng, trait, { base, platformId, memberOn, party: parsed.party });
      const shippingFee = deals.some((d) => d.kind === 'freeship')
        ? 0
        : Math.round(jitter(prng, 4.2 * trait.speedBias, 0.55) * 10) / 10;
      const packingFee = Math.round(jitter(prng, 1.6, 0.5) * 10) / 10;
      const couponDeal = deals.find((d) => d.kind === 'coupon');
      const minSpend = couponDeal ? (couponDeal.threshold || 0) : 0;
      const couponUsable = !minSpend || base >= minSpend;
      const effectiveDeals = couponUsable ? deals : deals.filter((d) => d.kind !== 'coupon');
      const fees = shippingFee + packingFee;
      let dealSum = effectiveDeals.reduce((s, d) => s + (d.amount || 0), 0);

      // 到手价不应高于原价：优惠不足时补一笔"平台补贴"把差价填平，
      // 保证「原价 − 优惠合计 + 配送 + 打包 = 到手价」这条等式永远成立。
      if (dealSum < fees) {
        effectiveDeals.push({
          kind: 'discount',
          label: '平台补贴',
          amount: Math.round((fees - dealSum) * 100) / 100,
        });
        dealSum = fees;
      }

      const final = Math.max(1, Math.round((base - dealSum + fees) * 100) / 100);

      const quality = clamp((rating - 3.4) / 1.6, 0, 1);

      const etaBase = 34 * trait.speedBias;
      const eta = Math.round(clamp(jitter(prng, etaBase, 0.35), 12, 75));

      packages.push({
        id: `${platformId}-${mi}-${pi}`,
        name: `${name} · ${packName}`,
        dish: packName,
        art: kind.art,
        cuisine: kind.label,
        basePrice: base,
        shippingFee,
        packingFee,
        deals: effectiveDeals,
        minSpend,
        couponUsable,
        finalPrice: final,
        etaMin: eta,
        rating: Math.round(rating * 10) / 10,
        reviewCount,
        quality,
        monthlySales: Math.round(jitter(prng, 800 * quality + 60, 0.7)),
        image: null,
      });
    }
    packages.sort((a, b) => a.finalPrice - b.finalPrice);

    offers.push({
      platform: platformId,
      platformName: p.name,
      merchant: name,
      rating: Math.round(rating * 10) / 10,
      reviewCount,
      credibility: 0,
      ...buildReviews(mulberry32(hashSeed(`${seedBase}::${platformId}::r${mi}`)), clamp((rating - 3.6) / 1.4, 0, 1)),
      packages,
      source: 'demo',
    });
  }
  return offers;
}

/* ══════════════ 自备数据接口 ══════════════ */

/** 把外部返回的一条记录规范化，字段缺失就用安全默认值 */
function normalizeOffer(raw, platformId) {
  const p = platformById(platformId);
  const pkgs = (raw.packages || []).map((x, i) => {
    const base = Number(x.basePrice ?? x.originalPrice ?? x.price ?? 0) || 0;
    const deals = Array.isArray(x.deals) ? x.deals.map((d) => ({
      kind: d.kind || 'discount',
      label: String(d.label || d.name || '优惠'),
      amount: Number(d.amount) || 0,
    })) : [];
    const shipping = Number(x.shippingFee ?? x.deliveryFee ?? 0) || 0;
    const packing = Number(x.packingFee ?? 0) || 0;
    const sum = deals.reduce((s, d) => s + d.amount, 0);
    const final = Number(x.finalPrice ?? Math.max(1, base - sum + shipping + packing));
    return {
      id: String(x.id || `${platformId}-${i}`),
      name: String(x.name || x.title || '套餐'),
      dish: String(x.dish || x.name || '套餐'),
      art: String(x.art || 'default'),
      cuisine: String(x.cuisine || ''),
      basePrice: base,
      shippingFee: shipping,
      packingFee: packing,
      deals,
      minSpend: Number(x.minSpend) || 0,
      couponUsable: x.couponUsable !== false,
      finalPrice: Math.round(final * 100) / 100,
      etaMin: Number(x.etaMin ?? x.eta ?? 0) || 0,
      rating: Number(x.rating) || 0,
      reviewCount: Number(x.reviewCount ?? x.reviews ?? 0) || 0,
      quality: Number(x.quality) || 0,
      monthlySales: Number(x.monthlySales ?? x.sales ?? 0) || 0,
      image: x.image || null,
    };
  }).filter((x) => x.finalPrice > 0);

  return {
    platform: platformId,
    platformName: p?.name || platformId,
    merchant: String(raw.merchant || raw.store || raw.shopName || '未知商家'),
    rating: Number(raw.rating) || 0,
    reviewCount: Number(raw.reviewCount ?? raw.reviews ?? 0) || 0,
    credibility: Number(raw.credibility) || 0,
    good: Array.isArray(raw.good) ? raw.good.map((g) => ({ text: String(g.text || g), tag: g.tag || '' })) : [],
    bad: Array.isArray(raw.bad) ? raw.bad.map((g) => ({ text: String(g.text || g), tag: g.tag || '' })) : [],
    packages: pkgs,
    source: 'custom',
  };
}

export async function customPlatformSearch(cfg, platformId, parsed, credentials) {
  const url = String(cfg.endpoint || '').trim();
  if (!url) throw new Error('未配置接口地址');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 8000);

  const headers = { 'Content-Type': 'application/json' };
  const cred = credentials?.[platformId];
  if (cred?.token) headers['X-Platform-Token'] = cred.token;
  if (cfg.authHeader) headers['Authorization'] = cfg.authHeader;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        platform: platformId,
        keywords: parsed.keywords || [],
        kinds: parsed.kinds || [],
        tastes: parsed.tastes || [],
        budget: parsed.budget ?? null,
        party: parsed.party ?? null,
        avoid: parsed.avoid || [],
        raw: parsed.raw || '',
        account: cred?.account ? String(cred.account).slice(0, 3) + '****' : null,
      }),
    });
    if (!res.ok) throw new Error(`接口返回 ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.offers || data.results || data.data || []);
    if (!Array.isArray(list)) throw new Error('接口返回格式不符合约定');
    return list.map((x) => normalizeOffer(x, platformId)).filter((o) => o.packages.length);
  } finally {
    clearTimeout(timer);
  }
}

/* ══════════════ 统一入口 ══════════════ */

/** 判断某平台这次用哪个源 */
export function resolveSource(cfg, platformId) {
  const mode = cfg.mode || 'auto';
  const hasEndpoint = !!String(cfg.endpoint || '').trim();
  if (mode === 'demo') return 'demo';
  if (mode === 'custom') return hasEndpoint ? 'custom' : (cfg.demo ? 'demo' : 'none');
  // auto
  if (hasEndpoint) return 'custom';
  return cfg.demo ? 'demo' : 'none';
}

/**
 * 并发搜索所有已启用平台。
 * @returns {Promise<{offers:Array, notes:Array<{platform:string,source:string,error?:string,count:number}>}>}
 */
export async function searchAll({ parsed, settings, credentials, salt = 0, signal }) {
  const cfg = settings.dataSource || {};
  const enabled = PLATFORMS.filter((p) => settings.platforms?.[p.id]?.enabled);

  const tasks = enabled.map(async (p) => {
    const src = resolveSource(cfg, p.id);
    if (src === 'none') {
      return { platform: p.id, source: 'none', count: 0, error: '未配置数据来源' };
    }
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const offers = src === 'demo'
        ? demoPlatformSearch(p.id, parsed, settings, credentials, salt)
        : await customPlatformSearch(cfg, p.id, parsed, credentials);
      return { platform: p.id, source: src, count: offers.length, offers };
    } catch (err) {
      return { platform: p.id, source: src, count: 0, error: err?.message || String(err) };
    }
  });

  const results = await Promise.all(tasks);
  const offers = [];
  const notes = [];
  for (const r of results) {
    notes.push({ platform: r.platform, source: r.source, error: r.error, count: r.count });
    if (r.offers) offers.push(...r.offers);
  }
  return { offers, notes };
}
