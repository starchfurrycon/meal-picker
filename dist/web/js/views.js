/**
 * 三个主视图：首页 / 加载过场 / 结果卡片
 */

import { PLATFORMS, platformById } from './catalog.js';
import { $, el, icon, money, copyText, openUrl, clamp } from './util.js';
import { artSvg } from './art.js';
import { buildQuotes, buildPitch, formatCount } from './engine.js';
import { toast, getView } from './ui.js';
import { costText } from './settings.js';

/* ══════════════ 首页 ══════════════ */

export function renderHome(store) {
  const hint = $('#home-hint');
  if (!hint) return;
  const on = PLATFORMS.filter((p) => store.settings.platforms?.[p.id]?.enabled);
  const names = on.map((p) => p.name);
  const parts = [];
  if (names.length) parts.push(`已启用 ${names.join(' · ')}`);
  else parts.push('还没有启用平台，点左下角设置一下');

  const llmOn = store.settings.llm?.enabled && store.hasApiKey();
  if (llmOn) {
    const t = store.todayUsage();
    parts.push(`智能转写已开${t.calls ? ` · 今日 ${t.calls} 次 ${costText(t.cost)}` : ''}`);
  }
  hint.textContent = parts.join('　');
}

/* ══════════════ 加载过场 ══════════════ */

const STEPS = [
  { key: 'parse', title: '理解你的口味', detail: '把这句话变成能直接搜索的关键词' },
  { key: 'accounts', title: '核对已登记的平台', detail: '检查各平台账户与会员状态' },
  { key: 'search', title: '在各平台搜索', detail: '按关键词检索可下单的套餐' },
  { key: 'collect', title: '采集价格与优惠', detail: '原价、折扣、满减、配送与打包费' },
  { key: 'reviews', title: '翻阅商家口碑', detail: '评分、评价量、真实度与差评点' },
  { key: 'score', title: '按你的偏好加权', detail: '价格 · 折扣 · 口碑 · 时效逐项打分' },
  { key: 'pick', title: '挑出最划算的一份', detail: '生成推荐理由与卡片' },
];

/**
 * 播放加载过场
 * @param {object} opts
 * @param {string} opts.lead 第一阶段标题（会随 LLM 结果更新）
 * @param {Array<{title:string,detail:string,ms:number}>} opts.stages 实际阶段
 * @param {(key:string)=>void} opts.onStage
 */
export function createThinking() {
  const list = $('#think-steps');
  const titleNode = $('#think-title');
  const detailNode = $('#think-detail');
  const metaNode = $('#think-meta');
  list.replaceChildren();
  metaNode.textContent = '';

  const nodes = STEPS.map((s, i) => {
    const dot = el('span', { class: 'dot' });
    const li = el('li', { style: { animationDelay: `${i * 40}ms` } }, [dot, el('span', { text: s.title })]);
    li._dot = dot;
    li._step = s;
    list.append(li);
    return li;
  });

  let cancelled = false;
  let idx = -1;

  const setStage = (i, { title, detail } = {}) => {
    if (cancelled) return;
    nodes.forEach((n, j) => {
      n.classList.toggle('is-on', j === i);
      n.classList.toggle('is-done', j < i);
      if (j < i) n._dot.replaceChildren(icon('check'));
      else n._dot.replaceChildren();
    });
    const s = STEPS[i] || STEPS[STEPS.length - 1];
    titleNode.textContent = title || s.title;
    detailNode.textContent = detail || s.detail;
    idx = i;
  };

  return {
    /** 高亮到第 i 步（0 基） */
    step(i, override) { setStage(clamp(i, 0, STEPS.length - 1), override); },
    /** 全部完成 */
    finish() {
      nodes.forEach((n) => {
        n.classList.remove('is-on');
        n.classList.add('is-done');
        n._dot.replaceChildren(icon('check'));
      });
    },
    /** 右侧小字 */
    meta(text) { metaNode.textContent = text || ''; },
    get index() { return idx; },
    cancel() { cancelled = true; },
  };
}

export const THINK_STEPS = STEPS;

/* ══════════════ 结果卡片 ══════════════ */

/**
 * @param {object} ctx
 * @param {object} ctx.best 最佳候选
 * @param {Array} ctx.ranked 全部候选（用于比较措辞）
 * @param {object} ctx.parsed 语义解析结果
 * @param {Array} ctx.reasons 理由
 * @param {object} ctx.summary 汇总
 * @param {object} ctx.notes 数据源说明
 * @param {object} ctx.llmInfo LLM 花费信息
 * @param {object} ctx.settings
 */
export function renderResult(ctx) {
  const scroll = $('#result-scroll');
  const foot = $('#result-foot');
  scroll.replaceChildren();
  foot.hidden = false;

  const { best, ranked, parsed, reasons, summary, notes, llmInfo, settings, budgetRelaxed, budget } = ctx;
  const p = platformById(best.platform) || { name: best.platform, color: '#FF8A3D', tint: 'rgba(255,138,61,.12)', line: 'rgba(255,138,61,.3)' };
  const pk = best.package;

  const card = el('article', { class: 'card' });

  /* ── Hero ── */
  const hero = el('div', { class: 'card__hero' });
  const artWrap = el('div', { class: 'card__art' });
  artWrap.innerHTML = artSvg(pk.art, { label: pk.dish });
  hero.append(artWrap);
  hero.append(el('span', { class: 'card__rank' }, [icon('crown'), '加权最优']));
  if (best.saved > 0.5) {
    hero.append(el('span', { class: 'card__save', text: `省 ${money(best.saved)}` }));
  }
  card.append(hero);

  /* ── Body ── */
  const body = el('div', { class: 'card__body' });

  body.append(el('div', { class: 'card__store' }, [
    el('span', {
      class: 'plat-tag',
      style: { '--p-color': p.color, '--p-tint': p.tint, '--p-line': p.line },
    }, [el('span', { class: 'plat-tag__dot' }), p.name]),
    icon('store'),
    el('span', { text: best.merchant }),
    el('span', { text: '·' }),
    el('span', { text: `${formatCount(best.reviewCount)} 条评价` }),
  ]));

  body.append(el('h2', { class: 'card__name', text: pk.dish }));
  body.append(el('p', { class: 'card__dish', text: buildPitch(best, ranked) }));

  const priceRow = el('div', { class: 'card__price-row' }, [
    el('span', { class: 'card__price', html: `<small>¥</small>${formatPrice(pk.finalPrice)}` }),
    best.saved > 0.5 ? el('span', { class: 'card__price-was', text: money(pk.basePrice) }) : null,
    el('span', {
      class: 'card__price-note',
      text: pk.shippingFee === 0 ? '免配送费' : `含配送 ${money(pk.shippingFee)}`,
    }),
  ]);
  body.append(priceRow);

  body.append(el('div', { class: 'card__metrics' }, [
    metric('clock', `${pk.etaMin || '—'} 分`, '预计送达'),
    metric('star-fill', String(best.rating || '—'), '商家评分'),
    metric('cart', formatCount(pk.monthlySales), '月售'),
  ]));

  if (pk.deals?.length) {
    const dealWrap = el('div', { class: 'card__deals' });
    for (const d of pk.deals) {
      const cls = d.kind === 'coupon' || d.kind === 'newcomer' ? 'deal deal--coupon'
        : d.kind === 'member' ? 'deal deal--member' : 'deal';
      const ic = d.kind === 'coupon' || d.kind === 'newcomer' ? 'ticket'
        : d.kind === 'member' ? 'crown'
          : d.kind === 'freeship' ? 'bike' : 'wallet';
      dealWrap.append(el('span', { class: cls }, [icon(ic), d.label]));
    }
    body.append(dealWrap);
  }

  /* ── 推荐理由 ── */
  const why = el('div', { class: 'card__why' }, [
    el('h3', {}, [icon('leaf'), '为什么是它']),
    el('ul', {}, reasons.map((r) => el('li', { html: r }))),
  ]);
  const quotes = buildQuotes(best);
  if (quotes.length) {
    why.append(el('div', { class: 'card__quotes' }, quotes.map((q) => el('q', { text: q }))));
  }
  body.append(why);

  /* ── 得分条 ── */
  const fill = el('div', { class: 'card__score-fill' });
  body.append(el('div', { class: 'card__score' }, [
    el('span', { class: 'card__score-num', text: '综合得分' }),
    el('div', { class: 'card__score-bar' }, [fill]),
    el('span', { class: 'card__score-num', text: `${Math.round(best.score * 100)}` }),
  ]));

  /* ── 操作 ── */
  const orderUrl = p.search ? p.search(pk.dish) : '';
  const orderBtn = el('button', { class: 'btn btn--primary', type: 'button' }, [
    icon('external'), `去${p.name}下单`,
  ]);
  orderBtn.addEventListener('click', () => {
    if (!orderUrl) return;
    openUrl(orderUrl);
    toast('已在平台搜索该套餐，登录后即可下单', { icon: 'info' });
  });

  const shareBtn = el('button', { class: 'btn', type: 'button' }, [icon('share'), '分享这一份']);
  shareBtn.addEventListener('click', () => shareCard({ best, parsed, reasons, p }));

  body.append(el('div', { class: 'card__actions' }, [orderBtn, shareBtn]));
  card.append(body);
  scroll.append(card);

  /* ── 底部小字 ── */
  const srcLabel = sourceLabel(notes);
  const noteParts = [];
  if (budgetRelaxed && budget) {
    noteParts.push(`没有套餐落在 ${money(budget)} 以内，已放宽预算取最接近的`);
  }
  if (summary) {
    noteParts.push(`比过 ${summary.platforms} 个平台 · ${summary.merchants} 家店 · ${summary.count} 个套餐，`
      + `价差 ${money(summary.max - summary.min)}`);
  }
  if (llmInfo) {
    noteParts.push(llmInfo.cached
      ? `关键词转写：命中缓存，本次 ¥0`
      : `关键词转写：${llmInfo.model || '模型'} · ${llmInfo.tokens || 0} token · 约 ${costText(llmInfo.cost || 0)}`);
  }
  if (srcLabel) noteParts.push(srcLabel);

  const note = el('p', { class: 'result__note' });
  note.innerHTML = noteParts.map((t) => escapeHtml(t)).join('<br>');
  scroll.append(note);

  // 得分条动画
  requestAnimationFrame(() => {
    fill.style.width = `${Math.round(best.score * 100)}%`;
  });

  scroll.scrollTop = 0;
  return card;
}

function metric(iconName, value, key) {
  return el('div', { class: 'metric' }, [
    el('div', { class: 'metric__v' }, [icon(iconName), el('span', { text: value })]),
    el('div', { class: 'metric__k', text: key }),
  ]);
}

const formatPrice = (n) => {
  const v = Math.round(Number(n) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

function sourceLabel(notes) {
  if (!notes?.length) return '';
  const used = Array.from(new Set(notes.filter((n) => !n.error).map((n) => n.source)));
  const failed = notes.filter((n) => n.error);
  const parts = [];
  if (used.includes('demo')) parts.push('价格数据来自内置演示数据源（店名与价格均为虚构）');
  if (used.includes('custom')) parts.push('价格数据来自你配置的接口');
  if (failed.length) {
    const names = failed.map((f) => platformById(f.platform)?.name || f.platform).join('、');
    parts.push(`${names} 未取到数据`);
  }
  return parts.join('；');
}

/* ══════════════ 空态 / 错误态 ══════════════ */

export function renderEmpty({ iconName = 'info', title, text, actions = [] }) {
  const scroll = $('#result-scroll');
  const foot = $('#result-foot');
  foot.hidden = true;
  scroll.replaceChildren();
  scroll.append(el('div', { class: 'empty' }, [
    el('div', { class: 'empty__art' }, [icon(iconName)]),
    el('h2', { text: title }),
    el('p', { text }),
    ...actions,
  ]));
  return scroll.firstElementChild;
}

/* ══════════════ 分享 ══════════════ */

async function shareCard({ best, parsed, reasons, p }) {
  const pk = best.package;
  const plainReasons = reasons.map((r) => '· ' + r.replace(/<[^>]+>/g, '')).join('\n');
  const text = [
    `今天吃：${pk.dish}`,
    `${p.name} · ${best.merchant}`,
    `到手 ${money(pk.finalPrice)}${best.saved > 0.5 ? `（省 ${money(best.saved)}）` : ''} · 约 ${pk.etaMin} 分钟`,
    '',
    plainReasons,
    '',
    `—— 用「选餐」比过 ${parsed.raw ? `「${parsed.raw}」` : '各平台'} 后选出的最划算一份`,
  ].join('\n');

  try {
    if (navigator.share) {
      await navigator.share({ title: `今天吃 ${pk.dish}`, text });
      return;
    }
  } catch { /* 用户取消或不可用，走复制 */ }

  const ok = await copyText(text);
  toast(ok ? '推荐内容已复制，可以直接发给朋友' : '复制失败，请手动截图分享', {
    icon: ok ? 'check' : 'info',
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
