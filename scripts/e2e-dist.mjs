/**
 * 发行包自检：确认「单文件版」和「目录版」在真实浏览器里都能跑
 *
 *   node scripts/e2e-dist.mjs
 *
 * 单文件版会被拷到一个**路径含空格**的临时目录下，用 file:// 打开，
 * 模拟用户把 html 下载到桌面双击的真实场景。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const bin = BROWSERS.find((p) => existsSync(p));
if (!bin) { console.log('跳过：本机没有 Chrome/Edge'); process.exit(0); }

// CDP 需要 WebSocket。Node 22+ 才有全局 WebSocket；更早的版本明确跳过，不报错。
if (typeof WebSocket === 'undefined') {
  console.log(`跳过：Node ${process.version} 没有全局 WebSocket，请用 Node 22+ 运行本自检`);
  process.exit(0);
}

const singleSrc = join(root, 'dist', 'meal-picker.html');
const dirSrc = join(root, 'dist', 'web', 'index.html');
if (!existsSync(singleSrc) || !existsSync(dirSrc)) {
  console.error('dist/ 里没有产物，请先运行 node scripts/build.mjs');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'meal picker dist '));  // 故意带空格
const singleDest = join(work, 'meal-picker.html');
copyFileSync(singleSrc, singleDest);

/* ── 本地中继 + 假采集器 ── */
const RELAY_PORT = 19100 + Math.floor(Math.random() * 300);
const relayProc = spawn(process.execPath, [
  join(root, 'relay', 'server.mjs'), '--port', String(RELAY_PORT), '--quiet', '--no-open',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const FIXTURE = {
  merchant: '蜀香源川菜馆', rating: 4.7, reviewCount: 2381,
  good: [{ text: '分量是真的足，一个人吃撑了', tag: '份量足' }, { text: '出餐快，到手还是烫的', tag: '出餐快' }],
  bad: [{ text: '微微有点咸，但整体很香', tag: '偏咸' }],
  packages: [{
    id: 'mt-1', name: '水煮肉片套餐', dish: '水煮肉片套餐', art: 'hotpot',
    basePrice: 42, shippingFee: 4, packingFee: 1,
    deals: [{ kind: 'coupon', label: '满 40 减 12', amount: 12, threshold: 40 }],
    finalPrice: 35, etaMin: 32, rating: 4.7, reviewCount: 2381, monthlySales: 890,
  }],
};
let feeder = null;
function startFeeder() {
  stopFeeder();
  const platforms = ['meituan', 'eleme', 'jd', 'taobao'];
  const push = async () => {
    try {
      const snap = await (await fetch(`http://127.0.0.1:${RELAY_PORT}/api/prices`)).json();
      const done = new Set(Object.keys(snap.prices || {}));
      for (const id of platforms) {
        if (done.has(id)) continue;
        await fetch(`http://127.0.0.1:${RELAY_PORT}/api/prices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: id, keyword: 'test', offers: [FIXTURE] }),
        });
      }
    } catch { /* ignore */ }
  };
  push();
  feeder = setInterval(push, 600);
}
function stopFeeder() { if (feeder) { clearInterval(feeder); feeder = null; } }

const DEBUG_PORT = 10200 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'mealpicker-dist-'));
const chrome = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--allow-file-access-from-files',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(t = 15000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) return;
    } catch { /* 等 */ }
    await sleep(150);
  }
  throw new Error('DevTools 没起来');
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0; this.pending = new Map(); this.listeners = new Map();
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      const arr = this.listeners.get(m.method);
      if (arr) for (const fn of arr) fn(m.params);
    });
  }
  ready() {
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
  }
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

let pass = 0, fail = 0;
const out = [];
const check = async (name, fn) => {
  try { await fn(); pass++; out.push(`  ✓ ${name}`); }
  catch (e) { fail++; out.push(`  ✗ ${name}\n      ${e.message}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

let cdp;
try {
  await waitForDevtools();
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  cdp = new CDP(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.ready();
  const errs = [];
  cdp.on('Runtime.exceptionThrown', (p) => errs.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  console.log(`\n浏览器：${bin}`);
  console.log(`单文件：${singleDest}\n`);

  /* ══════════ 单文件版 ══════════ */
  console.log('[1] 单文件版（file:// 直接打开）');
  await cdp.send('Page.navigate', { url: pathToFileURL(singleDest).href });
  for (let i = 0; i < 80; i++) {
    if (await cdp.eval('!!globalThis.__mealPicker')) break;
    await sleep(120);
  }
  await sleep(400);

  await check('零外部请求即可启动（CSS/JS 已内联）', async () => {
    const v = await cdp.eval('globalThis.__mealPicker?.version');
    assert(v, '应用没启动');
    const s = await cdp.eval(`JSON.stringify({
      styleTags: document.querySelectorAll('style').length,
      scripts: Array.from(document.querySelectorAll('script')).map(s => s.getAttribute('src')).filter(Boolean),
      links: Array.from(document.querySelectorAll('link[rel=stylesheet]')).length
    })`);
    const o = JSON.parse(s);
    assert(o.styleTags >= 1, '没有内联样式');
    assert(o.scripts.length === 0, '仍有外部脚本：' + o.scripts.join(','));
    assert(o.links === 0, '仍有外部样式表');
  });

  await check('界面元素齐全', async () => {
    const s = await cdp.eval(`JSON.stringify({
      title: document.querySelector('.brand__title')?.textContent,
      input: !!document.querySelector('#ask-input'),
      settings: !!document.querySelector('#open-settings'),
      undo: !!document.querySelector('#think-undo'),
      back: !!document.querySelector('#result-back'),
      symbols: document.querySelectorAll('symbol').length
    })`);
    const o = JSON.parse(s);
    assert(o.title === '今天吃什么', `标题异常：${o.title}`);
    assert(o.input && o.settings && o.undo && o.back, '有界面元素缺失');
    assert(o.symbols >= 30, `图标 sprite 未内联（只有 ${o.symbols} 个 symbol）`);
  });

  await check('完整跑一遍：输入 → 过场 → 卡片', async () => {
    await cdp.eval(`(() => {
      __mealPicker.store.saveSettings({ platforms: {
        meituan: { enabled: true }, eleme: { enabled: true }, jd: { enabled: true }, taobao: { enabled: true }
      }, dataSource: { mode: 'realtime', relayPort: ${RELAY_PORT}, timeoutMs: 20000 } });
      const i = document.querySelector('#ask-input');
      i.value = '想吃点辣的，一个人，四十以内';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ask-form').requestSubmit();
      return true;
    })()`);
    startFeeder();
    for (let i = 0; i < 110; i++) {
      if (await cdp.eval('document.body.dataset.view') === 'result') break;
      await sleep(200);
    }
    stopFeeder();
    await sleep(500);
    const s = await cdp.eval(`JSON.stringify({
      view: document.body.dataset.view,
      card: !!document.querySelector('.card'),
      price: document.querySelector('.card__price')?.textContent || '',
      reasons: document.querySelectorAll('.card__why li').length,
      steps: document.querySelectorAll('#think-steps li').length,
      note: document.querySelector('.result__note')?.innerText || ''
    })`);
    const o = JSON.parse(s);
    assert(o.view === 'result', `停在 ${o.view}`);
    assert(o.card, '卡片缺失');
    assert(/¥\d/.test(o.price), `价格异常：${o.price}`);
    assert(o.reasons >= 2, '理由不足');
    assert(o.steps === 6, `过场应有 6 步，实际 ${o.steps}`);
    assert(/实时采集/.test(o.note), `底部应说明价格来自实时采集：${o.note}`);
    console.log(`      卡片：${o.price} · ${o.reasons} 条理由`);
  });

  await check('插画已内联，可离线渲染', async () => {
    const s = await cdp.eval(`(() => {
      // 插画是内联的图形片段（不是 <symbol>），直接数卡片里的图形元素
      const svg = document.querySelector('.card__hero svg');
      if (!svg) return 'no-card-art';
      const shapes = svg.querySelectorAll('path, circle, rect, ellipse').length;
      return shapes >= 3 ? 'ok' : 'too-few-shapes:' + shapes;
    })()`);
    assert(s === 'ok', `插画渲染异常：${s}`);
  });

  await check('设置面板可用', async () => {
    await cdp.eval('document.querySelector("#result-back").click()');
    await sleep(400);
    await cdp.eval('document.querySelector("#open-settings").click()');
    await sleep(600);
    const n = await cdp.eval('document.querySelectorAll("#sheet-body .group").length');
    assert(n >= 4, `设置面板内容不全（${n}）`);
    await cdp.eval('document.querySelector("#close-settings").click()');
    await sleep(500);
  });

  await check('单文件版无运行时报错', () => {
    assert(errs.length === 0, errs.join('\n      '));
  });

  /* ══════════ 目录版 ══════════ */
  console.log('\n[2] 目录版（dist/web）');
  errs.length = 0;
  await cdp.send('Page.navigate', { url: pathToFileURL(dirSrc).href });
  for (let i = 0; i < 80; i++) {
    if (await cdp.eval('!!globalThis.__mealPicker')) break;
    await sleep(120);
  }
  await sleep(400);

  await check('目录版同样能启动（模块按文件加载）', async () => {
    const v = await cdp.eval('globalThis.__mealPicker?.version');
    assert(v, '目录版没启动');
  });

  await check('目录版无运行时报错', () => {
    assert(errs.length === 0, errs.join('\n      '));
  });

  console.log(out.join('\n'));
  console.log(`\n${'─'.repeat(46)}`);
  console.log(`发行包自检：通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('自检执行失败：', e);
  process.exitCode = 1;
} finally {
  stopFeeder();
  try { cdp?.close(); } catch { /* ignore */ }
  chrome.kill();
  try { relayProc?.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}
