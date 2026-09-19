/**
 * 选餐 · 应用主控
 *
 * 流程：一句模糊的话 →（可选）LLM 转写为搜索关键词
 *      → 本地中继登记本轮任务 → 打开各平台搜索页
 *      → 采集器在那些页面上读真实价格并回传
 *      → 按用户权重打分排名 → 只呈现最优的一份
 *
 * 价格一律是实时采集来的，没有任何模拟数据。
 */

import { store } from './store.js';
import { PLATFORMS, platformById } from './catalog.js';
import { extractBuiltin, mergePrefs } from './taste.js';
import { llmExtract } from './llm.js';
import { searchCustomOnly, resolveSource, enabledPlatforms } from './adapters.js';
import { probeRelay, collectRealtime, openCollectorTabs, searchUrlFor, relayBase, startManagedBrowser, managedBrowserStatus, stopManagedBrowser } from './realtime.js';
import { scoreCandidates, buildReasons, summarize } from './engine.js';
import { $, el, sleep } from './util.js';
import { showView, toast } from './ui.js';
import { renderHome, createThinking, renderResult, renderEmpty } from './views.js';
import { initSettings, openSettings, costText } from './settings.js';

/* ══════════════ 状态 ══════════════ */

let lastQuery = '';
let runToken = 0;          // 递增即可取消上一轮
let lastCtx = null;
let activeTabs = null;     // 采集时打开的标签页

/* ══════════════ 启动 ══════════════ */

async function boot() {
  await store.init();
  initSettings(store, { onHomeRefresh: () => renderHome(store) });
  renderHome(store);
  bindEvents();
  showView('home', { instant: true });

  // 首次使用：直接把人带到设置页，省得找
  if (!enabledPlatforms(store.settings).length) {
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

  $('#think-undo').addEventListener('click', cancelRun);
  $('#result-undo').addEventListener('click', cancelRun);
  $('#result-back').addEventListener('click', backHome);
  $('#result-again').addEventListener('click', () => {
    if (!lastQuery) return backHome();
    run(lastQuery, { again: true });
  });
}

function cancelRun() {
  runToken++;
  if (activeTabs) { activeTabs.closeAll(); activeTabs = null; }
  // 托管模式：用户改主意了，把采集用的浏览器也收掉，别留一堆窗口
  stopManagedBrowser(store.settings).catch(() => {});
  backHome();
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

async function run(query) {
  const token = ++runToken;
  lastQuery = query;

  const sendBtn = $('#ask-send');
  sendBtn.disabled = true;

  const enabled = enabledPlatforms(store.settings);
  if (!enabled.length) {
    showView('home');
    sendBtn.disabled = false;
    toast('还没有勾选任何平台', { icon: 'info' });
    openSettings('platforms');
    return;
  }

  const cfg = store.settings.dataSource || {};
  const customIds = enabled.filter((p) => resolveSource(cfg, p.id) === 'custom').map((p) => p.id);
  const liveIds = enabled.filter((p) => resolveSource(cfg, p.id) === 'realtime').map((p) => p.id);
  // 采集方式：auto = 中继拉起托管浏览器（用户零安装）；manual = 油猴脚本 + 自己浏览器
  const autoMode = liveIds.length > 0 && cfg.collectorMode !== 'manual';

  if (!customIds.length && !liveIds.length) {
    sendBtn.disabled = false;
    fail('没有可用的数据来源', '你把所有平台的数据源都设成了「不使用」。'
      + '请到「设置 → 平台 → 价格数据从哪来」里改成实时采集，或填入自备接口地址。');
    return;
  }

  /* ── 需要实时采集时：先把该做的检查做完，再打开标签页 ── */

  let relay = null;
  if (liveIds.length) {
    relay = await probeRelay(store.settings);
    if (token !== runToken) { sendBtn.disabled = false; return; }
    if (!relay.ok) {
      sendBtn.disabled = false;
      showRelayMissing(relay);
      return;
    }
  }

  /* 进入过场 */
  showView('thinking');
  const think = createThinking();

  /* 1. 语义转写 */
  think.step(0);
  const baseParsed = mergePrefs(extractBuiltin(query), store.settings);
  think.meta(`内置转写：${baseParsed.keywords.slice(0, 3).join(' · ')}`);

  const llmCfg = store.settings.llm || {};
  const llmEnabled = !!llmCfg.enabled;
  const apiKey = store.getApiKey();
  let llmInfo = null;
  let parsed = baseParsed;

  // 注意：赋值必须发生在 await 的这个 Promise 内部。
  // 如果写成 llmExtract().then(r => { parsed = ... })，await 只等到 llmExtract 完成，
  // .then 的回调要等下一轮微任务才跑 —— 缓存命中时立刻 resolve，就会出现
  // "关键词已经是模型的、花费却还是旧值"的错位。
  const llmTask = (async () => {
    if (!(llmEnabled && apiKey)) return null;
    let r;
    try {
      r = await llmExtract({ text: query, apiKey, cfg: llmCfg, fallback: baseParsed });
    } catch {
      return null;
    }
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
  })();

  await sleep((llmEnabled && apiKey) ? 1200 : 700);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }
  await llmTask;
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  if (llmInfo && !llmInfo.failed) {
    think.meta(llmInfo.cached
      ? `关键词：${parsed.keywords.slice(0, 3).join(' · ')}　命中缓存`
      : `关键词：${parsed.keywords.slice(0, 3).join(' · ')}　本次约 ${costText(llmInfo.cost)}`);
  }

  const keyword = (parsed.keywords && parsed.keywords[0]) || query;

  /* 2. 打开平台页面
     油猴模式必须还在点击手势的调用栈里，否则会被弹窗拦截；
     托管模式由中继拉起浏览器，不受这个限制，放在任务登记之后更好
     （采集器一上岗就能领到活，不用空轮询）。 */
  if (liveIds.length && !autoMode) {
    think.step(1, { detail: `正在打开 ${liveIds.map((id) => platformById(id)?.name).join(' · ')}` });
    activeTabs = openCollectorTabs(liveIds, keyword, {
      background: cfg.openTabs === 'background',
    });
    if (!activeTabs.count) {
      think.meta('浏览器拦住了新标签页，请允许弹出窗口后重试');
    }
  } else if (liveIds.length) {
    think.step(1, { detail: `正在为你打开 ${liveIds.map((id) => platformById(id)?.name).join(' · ')}` });
  } else {
    think.step(1, { detail: '使用你配置的接口' });
  }
  await sleep(420);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  /* 3. 采集实时价格 */
  think.step(2, { detail: `正在读 ${liveIds.length} 个平台的实时价格` });
  let liveResult = { offers: [], notes: [], collected: {}, missing: [] };
  let managedInfo = null;
  if (liveIds.length) {
    liveResult = await collectRealtime({
      keyword,
      platforms: liveIds,
      settings: store.settings,
      isCancelled: () => token !== runToken,
      timeoutMs: Math.max(15000, Number(cfg.timeoutMs) || 45000),
      onProgress: (msg) => think.step(2, { detail: msg }),
      onTaskReady: autoMode
        ? async () => {
            const r = await startManagedBrowser({ keyword, platforms: liveIds, settings: store.settings });
            managedInfo = r;
            if (!r.ok) {
              think.meta(r.hint || `没能自动打开浏览器：${r.error}`);
            }
          }
        : null,
    });
    if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }
  }

  /* 3b. 自备接口那部分平台 */
  let customResult = { offers: [], notes: [] };
  if (customIds.length) {
    think.meta(`正在请求你配置的接口（${customIds.length} 个平台）`);
    customResult = await searchCustomOnly({
      parsed,
      settings: store.settings,
      credentials: store.credentials,
    });
    if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }
  }

  const allOffers = [...liveResult.offers, ...customResult.offers];
  const allNotes = [...liveResult.notes, ...customResult.notes];

  /* 收工后关掉采集用的标签页 */
  if (activeTabs) { activeTabs.closeAll(); activeTabs = null; }

  /* 摊平候选 */
  const candidates = [];
  for (const offer of allOffers) {
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

  think.step(3, { detail: `已拿到 ${filtered.length} 个套餐的实时报价` });
  await sleep(720);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  if (!filtered.length) {
    think.cancel();
    sendBtn.disabled = false;
    showNoData({ liveIds, liveResult, customResult, parsed, enabled });
    return;
  }

  /* 4. 口碑 */
  think.step(3, { detail: `正在读 ${new Set(filtered.map((c) => c.merchant)).size} 家店的评价` });
  await sleep(700);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  /* 5. 加权 */
  think.step(4);
  await sleep(600);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }

  const ranked = scoreCandidates(filtered, parsed, store.settings);
  const best = ranked[0];

  /* 6. 出卡 */
  think.step(5);
  await sleep(520);
  if (token !== runToken) { think.cancel(); sendBtn.disabled = false; return; }
  think.finish();

  const reasons = buildReasons(best, ranked, parsed);
  const summary = summarize(ranked);

  lastCtx = {
    best, ranked, parsed, reasons, summary,
    notes: allNotes, llmInfo, settings: store.settings,
    budgetRelaxed, budget,
  };

  await sleep(200);
  if (token !== runToken) { sendBtn.disabled = false; return; }

  renderResult(lastCtx);
  showView('result');
  sendBtn.disabled = false;
  renderHome(store);
}

/* ══════════════ 各种"没成功"的呈现 ══════════════ */

function fail(title, text, { details = [], actions = [] } = {}) {
  renderEmpty({ iconName: 'info', title, text, details, actions });
  showView('result');
}

function actionBtn(label, onClick, { primary = false } = {}) {
  const b = el('button', { class: `btn ${primary ? 'btn--primary' : ''}`, type: 'button', text: label });
  b.addEventListener('click', onClick);
  return b;
}

function linkBtn(label, href) {
  return el('a', { class: 'btn btn--primary', href, target: '_blank', rel: 'noopener', text: label });
}

/** 中继没跑起来 */
function showRelayMissing(relay) {
  const details = [
    '在项目目录里执行：node relay/server.mjs',
    'Windows 上也可以双击 relay 目录里的启动脚本',
    `然后打开中继托管的页面：${relay.base}/`,
  ];
  if (relay.mixedContent) {
    details.unshift('当前页面是 https，浏览器会拦截对 http://127.0.0.1 的请求，必须改用中继托管的页面');
  }
  fail('本地中继没在运行', '实时价格要经过本地中继才能拿到，现在连不上它。', {
    details,
    actions: [actionBtn('我知道了，去启动', backHome, { primary: true })],
  });
}

/** 采到了中继，但没有任何价格 */
function showNoData({ liveIds, liveResult, customResult, parsed, enabled }) {
  const missing = liveResult.missing || [];
  const missingNames = missing.map((id) => platformById(id)?.name || id);
  const errs = [...liveResult.notes, ...customResult.notes].filter((n) => n.error);

  const actions = [];

  // 缺哪个平台，就给一个直达那个平台搜索页的入口
  for (const id of missing.slice(0, 3)) {
    const url = searchUrlFor(id, (parsed.keywords && parsed.keywords[0]) || parsed.raw || '');
    const name = platformById(id)?.name || id;
    if (url) actions.push(linkBtn(`去 ${name} 搜一次`, url));
  }

  const details = [];
  if (missingNames.length) {
    details.push(`没读到价格的平台：${missingNames.join('、')}`);
    details.push('常见原因：那个平台没登录、页面还没加载出结果、或者采集器脚本没装');
  }
  for (const e of errs.slice(0, 3)) {
    const name = platformById(e.platform)?.name || e.platform;
    details.push(`${name}：${e.error}`);
  }

  fail('这次没拿到实时价格', '工具不会用估算或占位价格来凑数，所以这次没法给你比价结果。', {
    details,
    actions: actions.length ? actions : [actionBtn('返回改一句', backHome, { primary: true })],
  });
}

/* ══════════════ 暴露给控制台调试（不展示在界面上） ══════════════ */

globalThis.__mealPicker = {
  store,
  rerun: (q) => run(q || lastQuery || '想吃点辣的'),
  context: () => lastCtx,
  relayBase: () => relayBase(store.settings),
  probeRelay: () => probeRelay(store.settings),
  platformList: () => PLATFORMS.map((p) => p.id),
  version: '2.1.1',
};

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<div class="toast-stack"><div class="toast">启动失败：${String(err?.message || err)}</div></div>`);
});
