/**
 * 浏览器端到端自检（无第三方依赖）
 *
 *   node scripts/e2e.mjs
 *
 * 做法：启动本机 Chrome/Edge 的无头实例（file:// 打开 web/index.html），
 *      通过 DevTools Protocol 收集控制台报错、注入交互、断言 DOM 结果。
 *      目的是验证"在真实浏览器里，模块能加载、界面能跑通、没有运行时报错"。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
// 默认测本地源码；设 MEALPICKER_URL 可以改测线上（例如 GitHub Pages）
const pageUrl = process.env.MEALPICKER_URL
  || pathToFileURL(join(root, 'web', 'index.html')).href;

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const bin = BROWSERS.find((p) => existsSync(p));
if (!bin) {
  console.log('跳过：本机没有找到 Chrome/Edge，无法做浏览器端到端自检');
  process.exit(0);
}

const PORT = 9333 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'mealpicker-e2e-'));

const chrome = spawn(bin, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--disable-features=Translate,MediaRouter',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('DevTools 端口没起来');
}

/* ── 极简 CDP 客户端 ── */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      const arr = this.listeners.get(msg.method);
      if (arr) for (const fn of arr) fn(msg.params);
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} 超时`)); }
      }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* ── 断言小工具 ── */
let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    pass++;
    results.push(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    results.push(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

let cdp;
try {
  await waitForDevtools();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();

  const consoleErrors = [];
  const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') {
      consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    }
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Log.enable');
  cdp.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') consoleErrors.push(`[${p.entry.source}] ${p.entry.text}`);
  });

  await cdp.send('Page.navigate', { url: pageUrl });
  // 等首屏挂载
  for (let i = 0; i < 60; i++) {
    const ready = await cdp.eval('!!(globalThis.__mealPicker && document.querySelector("#home-hint").textContent.length >= 0)');
    if (ready) break;
    await sleep(120);
  }
  await sleep(400);

  console.log(`\n浏览器：${bin}\n页面：${pageUrl}\n`);

  /* ══════════ 首屏 ══════════ */
  console.log('[1] 首屏');

  await check('模块全部加载，应用挂载成功', async () => {
    const v = await cdp.eval('globalThis.__mealPicker?.version || null');
    assert(v, 'window.__mealPicker 未挂载，说明 app.js 没跑起来');
  });

  await check('首页可见、加载页与结果页隐藏', async () => {
    const s = await cdp.eval(`JSON.stringify({
      home: document.body.dataset.view,
      homeVisible: !!document.querySelector('.view--home.is-on'),
      thinkingHidden: !document.querySelector('.view--thinking.is-on'),
      resultHidden: !document.querySelector('.view--result.is-on'),
      title: document.querySelector('.brand__title').textContent,
      input: !!document.querySelector('#ask-input'),
      settingsEntry: !!document.querySelector('#open-settings')
    })`);
    const o = JSON.parse(s);
    assert(o.home === 'home', `body.dataset.view = ${o.home}`);
    assert(o.homeVisible, '首页没有 is-on');
    assert(o.thinkingHidden && o.resultHidden, '其它视图不应可见');
    assert(o.title === '今天吃什么', `标题异常：${o.title}`);
    assert(o.input, '缺少输入框');
    assert(o.settingsEntry, '左下角缺少设置入口');
  });

  await check('图标 sprite 已解析（use 指向存在的 symbol）', async () => {
    const missing = await cdp.eval(`(() => {
      const ids = new Set(Array.from(document.querySelectorAll('symbol')).map(s => s.id));
      const bad = [];
      for (const u of document.querySelectorAll('use')) {
        const href = u.getAttribute('href') || '';
        if (!href.startsWith('#')) continue;
        if (!ids.has(href.slice(1))) bad.push(href);
      }
      return JSON.stringify(bad);
    })()`);
    assert(JSON.parse(missing).length === 0, '有 use 指向不存在的 symbol：' + missing);
  });

  await check('左下角设置入口可打开设置面板', async () => {
    await cdp.eval('document.querySelector("#open-settings").click()');
    await sleep(600);
    const s = await cdp.eval(`JSON.stringify({
      hidden: document.querySelector('#sheet').hidden,
      open: document.querySelector('#sheet').classList.contains('is-open'),
      panes: document.querySelectorAll('#sheet-body .pane').length,
      platforms: document.querySelectorAll('#sheet-body .group').length
    })`);
    const o = JSON.parse(s);
    assert(o.hidden === false, '设置面板仍是 hidden');
    assert(o.open, '设置面板没有 is-open（转场未触发）');
    assert(o.panes >= 1, '设置内容没渲染');
    assert(o.platforms >= 4, `平台条目应有 4 个，实际 ${o.platforms}`);
  });

  await check('四个分页都能切换且渲染出内容', async () => {
    for (const tab of ['taste', 'llm', 'privacy', 'platforms']) {
      await cdp.eval(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
      await sleep(220);
      const n = await cdp.eval('document.querySelectorAll("#sheet-body .pane > *").length');
      assert(n > 0, `${tab} 分页渲染为空`);
    }
  });

  await check('权重滑杆与口味勾选可交互并落盘', async () => {
    await cdp.eval(`document.querySelector('.tab[data-tab="taste"]').click()`);
    await sleep(250);
    const before = JSON.parse(await cdp.eval('JSON.stringify(__mealPicker.store.settings.tastes)'));
    await cdp.eval(`document.querySelectorAll('#sheet-body .chip')[0].click()`);
    await sleep(300);
    const after = JSON.parse(await cdp.eval('JSON.stringify(__mealPicker.store.settings.tastes)'));
    assert(after.length !== before.length || after.join() !== before.join(),
      `点击口味标签没有改变设置：${JSON.stringify(before)} → ${JSON.stringify(after)}`);

    // 拖一下权重滑杆
    await cdp.eval(`(() => {
      const r = document.querySelector('#sheet-body input[type=range]');
      r.value = 33;
      r.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    const w = JSON.parse(await cdp.eval('JSON.stringify(__mealPicker.store.settings.weights)'));
    assert(Object.values(w).some((v) => v === 33), `权重没有写进设置：${JSON.stringify(w)}`);
  });

  await check('关闭设置面板后恢复', async () => {
    await cdp.eval('document.querySelector("#close-settings").click()');
    await sleep(600);
    const hidden = await cdp.eval('document.querySelector("#sheet").hidden');
    assert(hidden === true, '面板没有收起');
  });

  /* ══════════ 主流程 ══════════ */
  console.log('\n[2] 主流程：输入 → 过场 → 结果');

  await check('准备两个启用平台并写入本地存储', async () => {
    await cdp.eval(`(() => {
      __mealPicker.store.saveSettings({ platforms: {
        meituan: { enabled: true }, eleme: { enabled: true }, jd: { enabled: true }, taobao: { enabled: true }
      }});
      return true;
    })()`);
    await sleep(150);
  });

  await check('提交输入后进入加载过场，显示步骤与说明文字', async () => {
    await cdp.eval(`(() => {
      const i = document.querySelector('#ask-input');
      i.value = '想吃点辣的但是别太贵，一个人吃，40以内';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ask-form').requestSubmit();
      return true;
    })()`);
    await sleep(500);
    const s = await cdp.eval(`JSON.stringify({
      view: document.body.dataset.view,
      thinkingOn: !!document.querySelector('.view--thinking.is-on'),
      steps: document.querySelectorAll('#think-steps li').length,
      active: document.querySelectorAll('#think-steps li.is-on').length,
      title: document.querySelector('#think-title').textContent,
      detail: document.querySelector('#think-detail').textContent,
      undo: !!document.querySelector('#think-undo'),
      meta: document.querySelector('#think-meta').textContent
    })`);
    const o = JSON.parse(s);
    assert(o.view === 'thinking', `应进入 thinking，实际 ${o.view}`);
    assert(o.thinkingOn, '加载视图没有显示');
    assert(o.steps === 7, `步骤应有 7 步，实际 ${o.steps}`);
    assert(o.active === 1, '同一时刻应只有一步处于进行中');
    assert(o.title && o.detail, '缺少说明文字');
    assert(o.undo, '加载页缺少"我改主意了"');
    if (!/关键词|转写/.test(o.meta)) {
      // 给一次重试窗口：过场第一步本身就带 780ms 的节奏
      await sleep(1200);
      const later = await cdp.eval('document.querySelector("#think-meta").textContent');
      assert(/关键词|转写/.test(later), `应显示转写结果，500ms 时「${o.meta}」，1.7s 时「${later}」`);
    }
  });

  await check('过场结束后放出结果卡片', async () => {
    for (let i = 0; i < 60; i++) {
      const v = await cdp.eval('document.body.dataset.view');
      if (v === 'result') break;
      await sleep(200);
    }
    const v = await cdp.eval('document.body.dataset.view');
    assert(v === 'result', `仍停留在 ${v}`);
    await sleep(500);
    const s = await cdp.eval(`JSON.stringify({
      card: !!document.querySelector('.card'),
      hero: !!document.querySelector('.card__hero svg'),
      platform: document.querySelector('.plat-tag')?.textContent || '',
      name: document.querySelector('.card__name')?.textContent || '',
      price: document.querySelector('.card__price')?.textContent || '',
      metrics: document.querySelectorAll('.metric').length,
      deals: document.querySelectorAll('.deal').length,
      reasons: document.querySelectorAll('.card__why li').length,
      quotes: document.querySelectorAll('.card__quotes q').length,
      back: !!document.querySelector('#result-back'),
      undo: !!document.querySelector('#result-undo'),
      again: !!document.querySelector('#result-again'),
      otherCards: document.querySelectorAll('.card').length,
      note: document.querySelector('.result__note')?.textContent || ''
    })`);
    const o = JSON.parse(s);
    assert(o.card, '没有生成卡片');
    assert(o.hero, '卡片没有插画');
    assert(o.platform.length >= 2, '缺少平台标识');
    assert(o.name.length >= 2, '缺少套餐名');
    assert(/¥\d/.test(o.price), `价格格式异常：${o.price}`);
    assert(o.metrics === 3, `指标应有 3 项，实际 ${o.metrics}`);
    assert(o.reasons >= 2, `推荐理由应至少 2 条，实际 ${o.reasons}`);
    assert(o.quotes >= 1, '应附带好评原句');
    assert(o.back && o.undo && o.again, '缺少返回/后悔/换一个按钮');
    assert(o.otherCards === 1, `只应呈现一张卡片，实际 ${o.otherCards}`);
    assert(/比过/.test(o.note), '底部缺少比价摘要');
    console.log(`      卡片：${o.platform} · ${o.name} · ${o.price} · ${o.reasons} 条理由`);
  });

  await check('卡片里不出现公式/权重一类的开发者术语', async () => {
    const text = await cdp.eval('document.querySelector("#result-scroll").innerText');
    for (const bad of ['权重', '归一化', '加权公式', '系数', 'API', 'provider', 'token']) {
      assert(!text.includes(bad), `结果页出现了「${bad}」`);
    }
  });

  await check('得分条动画到位（宽度 > 0）', async () => {
    await sleep(1400);
    const w = await cdp.eval('document.querySelector(".card__score-fill")?.style.width || ""');
    assert(/%/.test(w) && parseFloat(w) > 0, `得分条宽度异常：${w}`);
  });

  await check('"换一个"会重新走流程并给出新结果', async () => {
    const before = await cdp.eval('document.querySelector(".card__name").textContent + document.querySelector(".card__price").textContent');
    await cdp.eval('document.querySelector("#result-again").click()');
    await sleep(400);
    const v1 = await cdp.eval('document.body.dataset.view');
    assert(v1 === 'thinking', '"换一个"应先回到加载过场');
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval('document.body.dataset.view') === 'result') break;
      await sleep(200);
    }
    await sleep(400);
    const after = await cdp.eval('document.querySelector(".card__name").textContent + document.querySelector(".card__price").textContent');
    assert(before !== after, '换一个之后结果没变');
  });

  await check('左上角返回按钮回到首页', async () => {
    await cdp.eval('document.querySelector("#result-back").click()');
    await sleep(500);
    const v = await cdp.eval('document.body.dataset.view');
    assert(v === 'home', `应回到 home，实际 ${v}`);
    const val = await cdp.eval('document.querySelector("#ask-input").value');
    assert(val.includes('辣'), '返回后应保留上次输入');
  });

  await check('"我改主意了"可中断流程', async () => {
    await cdp.eval(`(() => {
      const i = document.querySelector('#ask-input');
      i.value = '想喝碗热汤面';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ask-form').requestSubmit();
      return true;
    })()`);
    await sleep(300);
    await cdp.eval('document.querySelector("#think-undo").click()');
    await sleep(400);
    const v = await cdp.eval('document.body.dataset.view');
    assert(v === 'home', `中断后应回到 home，实际 ${v}`);
    // 等足够久，确认被取消的流程不会把结果页顶出来
    await sleep(3500);
    const v2 = await cdp.eval('document.body.dataset.view');
    assert(v2 === 'home', `被取消的流程仍然改写了界面：${v2}`);
  });

  /* ══════════ 空输入 / 无平台 ══════════ */
  console.log('\n[3] 边界');

  await check('空输入不进入流程', async () => {
    await cdp.eval(`(() => {
      const i = document.querySelector('#ask-input');
      i.value = '';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ask-form').requestSubmit();
      return true;
    })()`);
    await sleep(400);
    const v = await cdp.eval('document.body.dataset.view');
    assert(v === 'home', `空输入不该跳转，实际 ${v}`);
  });

  await check('没勾选平台时给出提示而不是崩掉', async () => {
    await cdp.eval(`(() => {
      __mealPicker.store.saveSettings({ platforms: {
        meituan: { enabled: false }, eleme: { enabled: false }, jd: { enabled: false }, taobao: { enabled: false }
      }});
      const i = document.querySelector('#ask-input');
      i.value = '随便来点';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ask-form').requestSubmit();
      return true;
    })()`);
    await sleep(700);
    const s = await cdp.eval(`JSON.stringify({
      view: document.body.dataset.view,
      sheetOpen: document.querySelector('#sheet').classList.contains('is-open')
    })`);
    const o = JSON.parse(s);
    assert(o.view === 'home', '应留在首页');
    assert(o.sheetOpen, '应自动打开设置引导用户勾选平台');
  });

  await check('关掉演示数据源且无接口时给出可理解的错误页', async () => {
    await cdp.eval(`(() => {
      document.querySelector('#close-settings').click();
      __mealPicker.store.saveSettings({
        platforms: { meituan: { enabled: true } },
        dataSource: { mode: 'custom', endpoint: '', demo: false }
      });
      return true;
    })()`);
    await sleep(600);
    await cdp.eval(`(() => {
      const i = document.querySelector('#ask-input');
      i.value = '想吃面';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ask-form').requestSubmit();
      return true;
    })()`);
    for (let i = 0; i < 50; i++) {
      if (await cdp.eval('document.body.dataset.view') === 'result') break;
      await sleep(200);
    }
    await sleep(400);
    const s = await cdp.eval(`JSON.stringify({
      view: document.body.dataset.view,
      empty: !!document.querySelector('.empty'),
      text: document.querySelector('.empty p')?.textContent || ''
    })`);
    const o = JSON.parse(s);
    assert(o.view === 'result' && o.empty, '应显示错误页');
    assert(/数据源|数据来源/.test(o.text), `错误说明不够明确：${o.text}`);
    // 恢复
    await cdp.eval('__mealPicker.store.saveSettings({ dataSource: { mode: "auto", demo: true } })');
  });

  /* ══════════ 报错汇总 ══════════ */
  console.log('\n[4] 运行时报错');

  await check('全程没有未捕获异常', () => {
    assert(pageErrors.length === 0, `捕获到 ${pageErrors.length} 个异常：\n      ` + pageErrors.join('\n      '));
  });

  await check('没有 console.error', () => {
    const filtered = consoleErrors.filter((e) => !/favicon|net::ERR_FILE_NOT_FOUND/i.test(e));
    assert(filtered.length === 0, `捕获到 ${filtered.length} 条：\n      ` + filtered.join('\n      '));
  });

  console.log(results.join('\n'));
  console.log(`\n${'─'.repeat(46)}`);
  console.log(`浏览器自检：通过 ${pass} 项，失败 ${fail} 项`);
  cdp.close();
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error('自检执行失败：', err);
  process.exitCode = 1;
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
