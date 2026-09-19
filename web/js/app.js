/**
 * 选餐 · 应用主控
 *
 * 流程：一句模糊的话 →（可选）LLM 转写为搜索关键词 → 并发搜索各平台
 *      → 采集价格/优惠/口碑 → 按用户权重打分排名 → 只呈现最优的一份
 */

import { store } from './store.js';
import { PLATFORMS, platformById } from './catalog.js';
import { extractBuiltin, mergePrefs } from './taste.js';
import { llmExtract } from './llm.js';
import { searchAll, resolveSource } from './adapters.js';
import { scoreCandidates, buildReasons, summarize } from './engine.js';
import { $, sleep } from './util.js';
import { showView, toast } from './ui.js';
import { renderHome, createThinking, renderResult, renderEmpty } from './views.js';
import { initSettings, openSettings, costText } from './settings.js';

/* ══════════════ 状态 ══════════════ */

let lastQuery = '';
let runToken = 0;      // 递增即可取消上一轮
let rerollSalt = 0;
let lastCtx = null;

/* ══════════════ 启动 ══════════════ */

async function boot() {
  await store.init();
  initSettings(store, { onHomeRefresh: () => renderHome(store) });
  renderHome(store);
  bindEvents();
  showView('home', { instant: true });

  // 首次使用：直接把人带到设置页，省得找
  if (!store.settings.platforms || !Object.values(store.settings.platforms).some((p) => p.enabled)) {
    setTimeout(() => {
      if (!$('#sheet').hidden) return;
      openSettings('platforms');
    }, 700);
  }
  if (store.needsPassphrase) {
    setTimeout(() => openSettings('platforms'), 900);
  }
}

/* ══════════════ 事件 ══════════════ */

function bindEvents() {
  const form = $('#ask-form');
  const input = $('#ask-input');
  const send = $('#ask-send');

  const autoGrow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  };
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) {
      input.focus();
      toast('先说说今天想吃什么', { icon: 'info' });
      return;
    }
    if (send.disabled) return;
    run(q);
  });

  $('#chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    input.value = chip.dataset.q || chip.textContent.trim();
    autoGrow();
    run(input.value);
  });

  $('#think-undo').addEventListener('click', () => {
    runToken++;
    backHome();
  });
  $('#result-undo').addEventListener('click', () => {
    runToken++;
    backHome();
  });
  $('#result-back').addEventListener('click', backHome);
  $('#result-again').addEventListener('click', () => {
    if (!lastQuery) return backHome();
    rerollSalt++;
    run(lastQuery, { reroll: true });
  });
}

function backHome() {
  const input = $('#ask-input');
  if (lastQuery && !input.value) input.value = lastQuery;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  showView('home');
  renderHome(store);
  setTimeout(() => input.focus({ preventScroll: true }), 260);
}

/* ══════════════ 主流程 ══════════════ */

async function run(query, { reroll = false } = {}) {
  const token = ++runToken;
  lastQuery = query;

  const sendBtn = $('#ask-send');
  sendBtn.disabled = true;

  /* 前置检查：有没有可用平台 */
  const enabled = PLATFORMS.filter((p) => store.settings.platforms?.[p.id]?.enabled);
  if (!enabled.length) {
    showView('home');
    sendBtn.disabled = false;
    toast('还没有勾选任何平台', { icon: 'info' });
    openSettings('platforms');
    return;
  }

  /* 进入过场 */
  showView('thinking');
  const think = createThinking();

  /* 1. 语义转写（LLM 与动画并行） */
  think.step(0);
  const baseParsed = mergePrefs(extractBuiltin(query), store.settings);
  think.meta(`内置转写：${baseParsed.keywords.slice(0, 3).join(' · ')}`);

  const llmCfg = store.settings.llm || {};
  const llmEnabled = !!llmCfg.enabled;
  const apiKey = store.getApiKey();
  let llmInfo = null;
  let parsed = baseParsed;

  const llmPromise = (llmEnabled && apiKey)
    ? llmExtract({ text: query, apiKey, cfg: llmCfg, fallback: baseParsed })
      .then((r) => {
        if (token !== runToken) return null;
        if (r.ok) {
          parsed = mergePrefs(r.parsed, store.settings);
          llmInfo = {
            model: llmCfg.model,
            tokens: r.usage?.total || 0,
            cost: r.cost || 0,
            cached: !!r.usage?.cached,
          };
          if (!r.usage?.cached) {
            store.recordUsage({
              tokensIn: r.usage?.tokensIn || 0,
              tokensOut: r.usage?.tokensOut || 0,
              cost: r.cost || 0,
              model: llmCfg.model,
              mode: 'extract',
            });
          }
          think.meta(`关键词：${parsed.keywords.slice(0, 3).join(' · ')}`);
        } else {
          llmInfo = { failed: true, error: r.error, model: llmCfg.model };
          think.meta(`智能转写未成功，已用内置转写：${r.error}`);
        }
        return r;
      })
      .catch(() => null)
    : Promise.resolve(null);

  // 动画节奏：给转写留出时间
  const llmWait = (llmEnabled && apiKey) ? 1400 : 780;
  await sleep(llmWait);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }
  await llmPromise;
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  if (llmInfo && !llmInfo.failed) {
    think.meta(llmInfo.cached
      ? `关键词：${parsed.keywords.slice(0, 3).join(' · ')}　命中缓存`
      : `关键词：${parsed.keywords.slice(0, 3).join(' · ')}　本次约 ${costText(llmInfo.cost)}`);
  }

  /* 2. 核对账户 */
  think.step(1, { detail: `${enabled.length} 个平台已启用` });
  await sleep(480);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  /* 3. 搜索（真实工作在这一步） */
  think.step(2, { detail: `正在 ${enabled.map((p) => p.name).join(' · ')} 检索` });
  const cfg = store.settings.dataSource || {};
  const anyNone = enabled.every((p) => resolveSource(cfg, p.id) === 'none');
  if (anyNone) {
    think.cancel();
    sendBtn.disabled = false;
    showResultError({
      title: '还没有可用的数据来源',
      text: '你没有配置自备接口，同时也关掉了内置演示数据源。'
        + '请在「设置 → 平台 → 价格数据从哪来」里打开演示数据源，或填入你有权访问的接口地址。',
    });
    return;
  }

  let searchResult;
  try {
    searchResult = await searchAll({
      parsed,
      settings: store.settings,
      credentials: store.credentials,
      salt: rerollSalt,
    });
  } catch (err) {
    think.cancel();
    sendBtn.disabled = false;
    showResultError({
      title: '搜索出错了',
      text: err?.message || String(err),
    });
    return;
  }
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  /* 摊平候选 */
  const candidates = [];
  for (const offer of searchResult.offers) {
    for (const pk of offer.packages) {
      candidates.push({
        platform: offer.platform,
        merchant: offer.merchant,
        rating: offer.rating,
        reviewCount: offer.reviewCount,
        good: offer.good,
        bad: offer.bad,
        source: offer.source,
        package: pk,
        finalPrice: pk.finalPrice,
      });
    }
  }

  /* 预算硬过滤 */
  const budget = parsed.budget;
  let filtered = candidates;
  let budgetRelaxed = false;
  if (budget) {
    const within = candidates.filter((c) => c.finalPrice <= budget);
    if (within.length) filtered = within;
    else budgetRelaxed = true;
  }

  think.step(3, { detail: `已采集 ${filtered.length} 个套餐的报价与优惠` });
  await sleep(860);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  if (!filtered.length) {
    think.cancel();
    sendBtn.disabled = false;
    showResultError({
      title: '这次没搜到合适的',
      text: searchResult.notes.some((n) => n.error)
        ? '部分平台没取到数据，换个说法或者放宽预算再试一次。'
        : '换个说法试试，比如把想吃的具体一点。',
    });
    return;
  }

  /* 4. 口碑 */
  think.step(4, { detail: `正在读 ${new Set(filtered.map((c) => c.merchant)).size} 家店的评价` });
  await sleep(800);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  /* 5. 加权 */
  think.step(5);
  await sleep(680);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  const ranked = scoreCandidates(filtered, parsed, store.settings);
  const best = ranked[0];

  /* 6. 出卡 */
  think.step(6);
  await sleep(560);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }
  think.finish();

  const reasons = buildReasons(best, ranked, parsed);
  const summary = summarize(ranked);

  lastCtx = {
    best, ranked, parsed, reasons, summary,
    notes: searchResult.notes, llmInfo, settings: store.settings,
    budgetRelaxed, budget,
  };

  await sleep(220);
  if (token !== runToken) { sendBtn.disabled = false; return; }

  renderResult(lastCtx);
  showView('result');
  sendBtn.disabled = false;
  renderHome(store);
}

/* ══════════════ 错误呈现 ══════════════ */

function showResultError({ title, text, action }) {
  const actions = [];
  if (action) actions.push(action);
  const btn = document.createElement('button');
  btn.className = 'btn btn--primary';
  btn.type = 'button';
  btn.textContent = '返回改一句';
  btn.addEventListener('click', backHome);
  actions.push(btn);

  renderEmpty({ iconName: 'info', title, text, actions });
  showView('result');
}

/* ══════════════ 暴露给控制台调试（不展示在界面上） ══════════════ */

globalThis.__mealPicker = {
  store,
  rerun: (q) => run(q || lastQuery || '想吃点辣的'),
  context: () => lastCtx,
  version: '1.0.0',
};

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<div class="toast-stack"><div class="toast">启动失败：${String(err?.message || err)}</div></div>`);
});
