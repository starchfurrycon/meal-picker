/**
 * 平台适配层
 *
 * 数据从哪来？只有两条路，都不含任何模拟数据：
 *
 *  1. realtime —— 实时采集。由本地中继（relay/server.mjs）+ 用户脚本采集器
 *                 在**用户自己的浏览器里、用用户自己的登录态**读取各平台搜索页
 *                 真实返回的价格。见 realtime.js 与 collector/。
 *  2. custom   —— 用户自备的数据接口。前端 POST 一个 JSON，拿回候选列表。
 *                 把自建后端 / 官方开放平台的地址填进来即可。
 *
 * ⚠️ 为什么不能纯前端直连平台？
 *    实测（scripts/probe-realtime.mjs）：无登录态直连各平台搜索接口，
 *    美团返回 418 风控、饿了么老接口 NO_URL_MATCHED、京东要 appid、
 *    淘宝闪购 RGV587 滑块风控 + 跳登录。浏览器还有 CORS 与混合内容限制。
 *    所以真实价格必须来自「用户自己浏览器里页面自己发出的请求」。
 */

import { PLATFORMS, platformById } from './catalog.js';

/* ══════════════ 数据源声明 ══════════════ */

export const SOURCES = [
  {
    id: 'realtime',
    label: '实时采集（推荐）',
    desc: '通过本地中继 + 浏览器采集器，读取各平台真实价格',
    needsEndpoint: false,
  },
  {
    id: 'custom',
    label: '自备数据接口',
    desc: '把你有权访问的接口地址填进来，前端会按约定格式请求',
    needsEndpoint: true,
  },
];

/* ══════════════ 外部记录规范化 ══════════════ */

/**
 * 把一条外部记录规范化成引擎认识的结构。
 * 采集器与自备接口都走这里，保证下游只有一种形状。
 */
export function normalizeOffer(raw, platformId) {
  const p = platformById(platformId);
  const merchant = String(raw.merchant || raw.store || raw.shopName || '').trim();
  const pkgs = (raw.packages || []).map((x, i) => {
    const base = Number(x.basePrice ?? x.originalPrice ?? x.price ?? 0) || 0;
    const deals = Array.isArray(x.deals) ? x.deals.map((d) => ({
      kind: d.kind || 'discount',
      label: String(d.label || d.name || '优惠').slice(0, 24),
      amount: Number(d.amount) || 0,
      threshold: Number(d.threshold) || 0,
    })) : [];
    const shipping = Number(x.shippingFee ?? x.deliveryFee ?? 0) || 0;
    const packing = Number(x.packingFee ?? 0) || 0;
    const sum = deals.reduce((s, d) => s + d.amount, 0);
    const final = Number(x.finalPrice ?? Math.max(0.01, base - sum + shipping + packing));
    const rating = Number(x.rating ?? raw.rating) || 0;
    return {
      id: String(x.id || `${platformId}-${i}`),
      name: String(x.name || x.dish || x.title || '套餐').slice(0, 60),
      dish: String(x.dish || x.name || '套餐').slice(0, 60),
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
      rating,
      reviewCount: Number(x.reviewCount ?? x.reviews ?? 0) || 0,
      monthlySales: Number(x.monthlySales ?? x.sales ?? 0) || 0,
      image: x.image || null,
      keyword: String(x.keyword || ''),
      provenance: x.provenance || null,
    };
  }).filter((x) => x.finalPrice > 0);

  return {
    platform: platformId,
    platformName: p?.name || platformId,
    merchant: merchant.slice(0, 40),
    rating: Number(raw.rating) || 0,
    reviewCount: Number(raw.reviewCount ?? raw.reviews ?? 0) || 0,
    good: toReviewList(raw.good),
    bad: toReviewList(raw.bad),
    packages: pkgs,
    source: raw.source || 'realtime',
  };
}

function toReviewList(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 6).map((g) => ({
    text: String((g && g.text) || g || '').slice(0, 80),
    tag: String((g && g.tag) || '').slice(0, 12),
  })).filter((g) => g.text);
}

/** 把采集器/接口返回的一批记录规范化为 offer 列表 */
export function normalizeBatch(list, platformId) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x === 'object')
    .map((x) => normalizeOffer(x, platformId))
    .filter((o) => o.merchant && o.packages.length);
}

/* ══════════════ 自备数据接口 ══════════════ */

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
        member: !!credentials?.[platformId]?.member,
      }),
    });
    if (!res.ok) throw new Error(`接口返回 ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.offers || data.results || data.data || []);
    if (!Array.isArray(list)) throw new Error('接口返回格式不符合约定');
    return normalizeBatch(list.map((x) => ({ ...x, source: 'custom' })), platformId);
  } finally {
    clearTimeout(timer);
  }
}

/* ══════════════ 统一入口 ══════════════ */

/** 判断某平台这次用哪个源：'realtime' | 'custom' | 'none' */
export function resolveSource(cfg, platformId) {
  const mode = cfg?.mode || 'realtime';
  const hasEndpoint = !!String(cfg?.endpoint || '').trim();
  if (mode === 'none') return 'none';
  if (mode === 'custom') return hasEndpoint ? 'custom' : 'none';
  if (mode === 'realtime') return 'realtime';
  // auto：有接口就用接口，否则走实时采集
  return hasEndpoint ? 'custom' : 'realtime';
}

/** 本轮启用了哪些平台 */
export function enabledPlatforms(settings) {
  return PLATFORMS.filter((p) => settings.platforms?.[p.id]?.enabled);
}

/** 哪些平台走自备接口（这些不需要采集器） */
export function customPlatformIds(settings) {
  const cfg = settings.dataSource || {};
  return enabledPlatforms(settings)
    .filter((p) => resolveSource(cfg, p.id) === 'custom')
    .map((p) => p.id);
}

/**
 * 只跑自备接口的那部分平台（实时采集由 realtime.js 负责编排）。
 * @returns {Promise<{offers:Array, notes:Array}>}
 */
export async function searchCustomOnly({ parsed, settings, credentials }) {
  const cfg = settings.dataSource || {};
  const targets = enabledPlatforms(settings).filter((p) => resolveSource(cfg, p.id) === 'custom');
  const results = await Promise.all(targets.map(async (p) => {
    try {
      const offers = await customPlatformSearch(cfg, p.id, parsed, credentials);
      return { platform: p.id, source: 'custom', count: offers.length, offers };
    } catch (err) {
      return { platform: p.id, source: 'custom', count: 0, error: err?.message || String(err) };
    }
  }));
  const offers = [];
  const notes = [];
  for (const r of results) {
    notes.push({ platform: r.platform, source: r.source, error: r.error, count: r.count });
    if (r.offers) offers.push(...r.offers);
  }
  return { offers, notes };
}
