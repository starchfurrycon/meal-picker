/**
 * 加权比价引擎
 *
 * 把各平台采集回来的候选套餐摊平成一个列表，对每个候选计算 8 个因子的得分，
 * 按用户权重加权求和，得出总分与排名。推荐理由从**数据本身**生成（评分、评价
 * 标签、优惠明细），不调用大模型。
 */

import { FACTORS, platformById } from './catalog.js';
import { clamp } from './util.js';

/* ══════════════ 归一化 ══════════════ */

const norm = (v, lo, hi) => (hi === lo ? 0.5 : clamp((v - lo) / (hi - lo), 0, 1));

function minMax(values) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return { lo: 0, hi: 1 };
  return { lo, hi };
}

/* ══════════════ 因子计算 ══════════════ */

/**
 * @param {Array} candidates 已摊平的套餐候选（含 platform / merchant / package 字段）
 * @param {object} parsed 语义解析结果
 * @param {object} settings 用户设置
 */
export function scoreCandidates(candidates, parsed, settings) {
  if (!candidates.length) return [];

  const weights = { ...settings.weights };
  for (const f of FACTORS) if (!Number.isFinite(weights[f.id])) weights[f.id] = f.weight;
  // 「极致省钱」口味：价格权重自动加码
  if ((parsed.tastes || []).includes('value')) {
    weights.price = (weights.price || 0) * 1.6;
    weights.discount = (weights.discount || 0) * 1.2;
  }
  const wSum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;

  /* ── 数据范围 ── */
  const prices = candidates.map((c) => c.finalPrice);
  const { lo: pLo, hi: pHi } = minMax(prices);
  const etaRange = minMax(candidates.map((c) => c.etaMin || 0));
  const salesRange = minMax(candidates.map((c) => c.package.monthlySales || 0));

  /* ── 商家诚信度：评分 + 评价体量 + 差评扣分 ── */
  for (const c of candidates) {
    const ratingPart = norm(c.rating || 4, 3.6, 5) * 0.55;
    const volumePart = norm(Math.log10((c.reviewCount || 1) + 1), 1.5, 4.2) * 0.25;
    const badPart = (1 - clamp((c.bad?.length || 0) / 3, 0, 1)) * 0.20;
    c.credibility = ratingPart + volumePart + badPart;
  }
  const credRange = minMax(candidates.map((c) => c.credibility));

  /* ── 逐候选打分 ── */
  for (const c of candidates) {
    const pk = c.package;

    // 1) 到手价：越便宜越高（用区间归一化，最低价拿满分）
    const priceScore = 1 - norm(pk.finalPrice, pLo, pHi);

    // 2) 折扣力度：省下来的钱 / 原价
    const saved = Math.max(0, pk.basePrice - pk.finalPrice);
    const discountRate = pk.basePrice > 0 ? saved / pk.basePrice : 0;
    const discountScore = clamp(discountRate / 0.55, 0, 1);

    // 3) 优惠券：可用券金额 + 是否够门槛
    const couponAmt = pk.deals.filter((d) => d.kind === 'coupon' || d.kind === 'newcomer')
      .reduce((s, d) => s + (d.amount || 0), 0);
    const couponScore = clamp(couponAmt / 25, 0, 1) * (pk.couponUsable ? 1 : 0.35);

    // 4) 商家评分
    const ratingScore = norm(c.rating || 4, 3.6, 5);

    // 5) 商家诚信
    const creditScore = norm(c.credibility, credRange.lo, credRange.hi);

    // 6) 口味匹配
    const matchScore = matchFactor(c, parsed);

    // 7) 送达速度：越快越高
    const speedScore = 1 - norm(pk.etaMin || 0, etaRange.lo, etaRange.hi);

    // 8) 会员权益
    const memberAmt = pk.deals.filter((d) => d.kind === 'member').reduce((s, d) => s + (d.amount || 0), 0);
    const memberScore = clamp(memberAmt / 10, 0, 1);

    // 销量作为轻微加分（同价位更稳的店）
    const salesScore = norm(pk.monthlySales || 0, salesRange.lo, salesRange.hi);

    const parts = {
      price: priceScore,
      discount: discountScore,
      coupon: couponScore,
      rating: ratingScore,
      credit: creditScore,
      match: matchScore,
      speed: speedScore,
      member: memberScore,
    };

    let total = 0;
    const contrib = {};
    for (const f of FACTORS) {
      const w = (weights[f.id] || 0) / wSum;
      const v = parts[f.id] ?? 0;
      contrib[f.id] = w * v;
      total += w * v;
    }
    // 销量微调（±2%）
    total = total * (0.98 + salesScore * 0.04);

    c.scores = parts;
    c.contrib = contrib;
    c.score = clamp(total, 0, 1);
    c.saved = saved;
    c.savedRate = discountRate;
  }

  candidates.sort((a, b) => b.score - a.score);
  candidates.forEach((c, i) => { c.rank = i + 1; });
  return candidates;
}

/* ══════════════ 口味匹配 ══════════════ */

function matchFactor(c, parsed) {
  const hay = `${c.merchant} ${c.package.name} ${c.package.dish} ${c.package.cuisine || ''}`;
  let hit = 0, total = 0;

  const tasteKeywords = {
    spicy: ['麻辣', '香辣', '辣', '椒', '川', '湘', '冒菜', '水煮'],
    light: ['清淡', '蒸', '汤', '粥', '白灼', '菌菇'],
    lowcal: ['轻食', '沙拉', '低卡', '荞麦', '鸡胸', '藜麦'],
    meat: ['牛', '猪', '鸡腿', '排骨', '羊', '烤肉', '大份'],
    noodle: ['面', '粉', '米线'],
    rice: ['饭', '米', '煲仔'],
    soup: ['汤', '粥', '羹', '煲'],
    sweet: ['甜', '奶茶', '蛋糕', '布丁', '芋'],
    seafood: ['虾', '蟹', '海鲜', '鱼', '贝', '生蚝'],
    value: [],
  };

  for (const t of parsed.tastes || []) {
    const words = tasteKeywords[t];
    if (!words || !words.length) continue;
    total += 1;
    if (words.some((w) => hay.includes(w))) hit += 1;
  }

  // 品类命中
  if (parsed.kinds?.length) {
    total += 1;
    const kindHit = parsed.kinds.includes(c.package.art) ||
      (c.package.cuisine && parsed.kinds.some((k) => c.package.cuisine.includes(k)));
    if (kindHit) hit += 1;
  }

  // 关键词命中（套餐名 / 店名里出现用户原话的词）
  const kws = (parsed.keywords || []).filter((k) => k.length >= 2);
  if (kws.length) {
    total += 1;
    if (kws.some((k) => hay.includes(k) || k.includes(c.package.dish))) hit += 1;
  }

  if (!total) return 0.6;
  return clamp(hit / total, 0, 1) * 0.85 + 0.15;
}

/* ══════════════ 推荐理由（无 LLM） ══════════════ */

/**
 * 从数据里提炼 2–4 条人话理由，外加一句来自好评的佐证。
 */
export function buildReasons(best, all, parsed) {
  const reasons = [];
  const pk = best.package;

  /* 1) 价格：是否全场最低 / 比第二名便宜多少 */
  const others = all.filter((c) => c !== best);
  const cheapest = all.reduce((a, b) => (a.finalPrice <= b.finalPrice ? a : b));
  if (best === cheapest || Math.abs(best.finalPrice - cheapest.finalPrice) < 0.01) {
    reasons.push(`这一份是 <b>${all.length} 个候选里到手价最低</b>的，实付 ${money(pk.finalPrice)}。`);
  } else if (others.length) {
    const avg = others.reduce((s, c) => s + c.finalPrice, 0) / others.length;
    const diff = avg - best.finalPrice;
    if (diff > 0.5) {
      reasons.push(`到手价 ${money(pk.finalPrice)}，<b>比同批候选平均便宜 ${money(diff)}</b>，是加权后的最优解。`);
    } else {
      reasons.push(`到手价 ${money(pk.finalPrice)}，在同等品质里属于第一梯队。`);
    }
  }

  /* 2) 优惠结构 */
  const saved = best.saved;
  if (saved > 0.5) {
    const dealNames = pk.deals.filter((d) => d.amount > 0)
      .sort((a, b) => b.amount - a.amount).slice(0, 3)
      .map((d) => d.label);
    const rate = Math.round(best.savedRate * 100);
    reasons.push(
      `原价 ${money(pk.basePrice)}，叠加${dealNames.length ? `<b>${dealNames.join(' + ')}</b>` : '平台优惠'}`
      + `，一共省下 ${money(saved)}（约 ${rate}%）。`
    );
  }
  if (pk.shippingFee === 0) reasons.push('配送费已免，不用凑单。');

  /* 3) 口碑：从好评里挑最有信息量的一句 */
  const good = (best.good || []).filter((g) => g.text);
  if (good.length) {
    const pickOne = good.find((g) => /份量|料足|新鲜|出餐快|稳定|划算|性价比/.test(g.text)) || good[0];
    reasons.push(`口碑上，<b>${best.rating} 分 / ${formatCount(best.reviewCount)} 条评价</b>，有人专门提到「${trim(pickOne.text)}」。`);
  } else if (best.rating) {
    reasons.push(`商家评分 <b>${best.rating}</b>，累计 ${formatCount(best.reviewCount)} 条评价。`);
  }

  /* 4) 时效 / 诚信 */
  if (pk.etaMin) {
    const etaRange = all.map((c) => c.package.etaMin || 99);
    const fastest = Math.min(...etaRange);
    if (pk.etaMin <= fastest + 4) reasons.push(`预计 <b>${pk.etaMin} 分钟</b>送达，是这批里最快的一档。`);
    else reasons.push(`预计 ${pk.etaMin} 分钟送达。`);
  }
  if (best.credibility > 0.78) {
    reasons.push('评价量与评分结构健康，<b>没有明显刷分或翻车迹象</b>。');
  } else if ((best.bad || []).length) {
    reasons.push(`少数差评集中在「${best.bad[0].tag || '细节'}」，整体仍在可接受范围。`);
  }

  return reasons.slice(0, 4);
}

/** 卡片上的一句推荐语（好评摘要，非 LLM 生成） */
export function buildPitch(best, all) {
  const good = (best.good || []);
  const tagCount = {};
  for (const g of good) if (g.tag) tagCount[g.tag] = (tagCount[g.tag] || 0) + 1;
  const topTag = Object.entries(tagCount).sort((a, b) => b[1] - a[1])[0]?.[0];
  const cheapest = all.reduce((a, b) => (a.finalPrice <= b.finalPrice ? a : b));

  if (best === cheapest && topTag) return `最便宜的一份，而且 ${topTag}`;
  if (best === cheapest) return '同批候选里最便宜的到手价';
  if (topTag) return `${topTag}，性价比也站得住`;
  return '综合价格、优惠与口碑的最优解';
}

/** 从好评里抽 1–2 条原句作为佐证（截断到 42 字） */
export function buildQuotes(best) {
  const list = (best.good || [])
    .filter((g) => g.text && !/偏咸|偏小/.test(g.text))
    .slice(0, 2)
    .map((g) => trim(g.text, 42));
  return list;
}

export function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return String(v);
}

function trim(s, n = 28) {
  const t = String(s).replace(/[。！!，,]+$/g, '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

const money = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? `¥${v}` : `¥${v.toFixed(2)}`;
};

/* ══════════════ 汇总统计 ══════════════ */

export function summarize(ranked) {
  if (!ranked.length) return null;
  const prices = ranked.map((c) => c.finalPrice);
  return {
    count: ranked.length,
    platforms: Array.from(new Set(ranked.map((c) => c.platform))).length,
    merchants: Array.from(new Set(ranked.map((c) => c.merchant))).length,
    min: Math.min(...prices),
    max: Math.max(...prices),
    avg: prices.reduce((a, b) => a + b, 0) / prices.length,
  };
}

export const platformColor = (id) => platformById(id)?.color || '#FF8A3D';
