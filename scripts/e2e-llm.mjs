/**
 * 端到端自检 · LLM 分支
 *
 *   node scripts/e2e-llm.mjs
 *
 * 用一个本机假接口冒充 OpenAI 兼容服务，验证：
 *   真实网络请求发出 → 关键词以模型返回为准 → token 与花费被记录并显示 → 请求体省 token
 * 同时起一个真的本地中继并灌入假采集器数据，让实时采集那一段也能跑通。
 * 不需要任何真实 API Key，不产生任何费用。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* ── 本地中继 ── */
const RELAY_PORT = 18100 + Math.floor(Math.random() * 300);
const relayProc = spawn(process.execPath, [
  join(root, 'relay', 'server.mjs'), '--port', String(RELAY_PORT), '--quiet', '--no-open',
], { stdio: ['ignore', 'pipe', 'pipe'] });

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitRelay(timeoutMs = 9000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/health`); if (r.ok) return true; } catch { /* 等 */ }
    await sleepMs(150);
  }
  return false;
}
const relayUp = await waitRelay();
const pageUrl = relayUp
  ? `http://127.0.0.1:${RELAY_PORT}/`
  : new URL(`file://${join(root, 'web', 'index.html').replace(/\\/g, '/')}`).href;
if (!relayUp) console.log('提示：中继没起来，LLM 分支只验证转写部分');

/** 假采集器数据 */
const FIXTURE = {
  merchant: '蜀香源川菜馆', rating: 4.7, reviewCount: 2381,
  good: [{ text: '分量是真的足，一个人吃撑了', tag: '份量足' }, { text: '出餐快，到手还是烫的', tag: '出餐快' }],
  bad: [{ text: '微微有点咸，但整体很香', tag: '偏咸' }],
  packages: [{
    id: 'mt-1', name: '水煮鱼片套餐', dish: '水煮鱼片套餐', art: 'hotpot',
    basePrice: 48, shippingFee: 4, packingFee: 1,
    deals: [{ kind: 'coupon', label: '满 40 减 12', amount: 12, threshold: 40 }],
    finalPrice: 41, etaMin: 32, rating: 4.7, reviewCount: 2381, monthlySales: 890,
  }],
};
let feeder = null;
function startFeeder(platforms) {
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

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const bin = BROWSERS.find((p) => existsSync(p));
if (!bin) {
  console.log('跳过：本机没有 Chrome/Edge');
  process.exit(0);
}

// CDP 需要 WebSocket。Node 22+ 才有全局 WebSocket；更早的版本明确跳过，不报错。
if (typeof WebSocket === 'undefined') {
  console.log(`跳过：Node ${process.version} 没有全局 WebSocket，请用 Node 22+ 运行本自检`);
  process.exit(0);
}

/* ══════════ 假 LLM 服务 ══════════ */
const MODEL_REPLY = {
  kw: ['酸菜鱼', '水煮鱼', '川味小炒'],
  k: ['hotpot'],
  t: ['spicy', 'meat'],
  b: 45,
  p: 2,
  a: ['香菜'],
};

/** 跑一次完整流程，并在期间持续灌入假采集器数据 */
async function submitAndWait(cdp, query, { maxWaitMs = 45000 } = {}) {
  if (relayUp) startFeeder(['meituan', 'eleme', 'jd', 'taobao']);
  try {
    // 上一轮的结果可能还留在 DOM 里，而 dataset.view 在提交的那一刻就变成 thinking 了。
    // 先把旧卡片抹掉，这样"等到 .card 出现"才是真的等到本轮渲染完，而不是看到上一轮。
    await cdp.eval('document.querySelector("#result-scroll").replaceChildren(); true');
    await cdp.eval(`(() => {
      const i = document.querySelector('#ask-input');
      i.value = ${JSON.stringify(query)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ask-form').requestSubmit();
      return true;
    })()`);
    const end = Date.now() + maxWaitMs;
    while (Date.now() < end) {
      const ready = await cdp.eval('document.body.dataset.view === "result" && !!document.querySelector(".card")');
      if (ready) break;
      await sleep(200);
    }
    await sleep(300);
  } finally {
    stopFeeder();
  }
}

let lastRequestBody = null;
let requestCount = 0;

const server = createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requestCount++;
    try { lastRequestBody = JSON.parse(body); } catch { lastRequestBody = { raw: body }; }
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: 'mock-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(MODEL_REPLY) },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 318, completion_tokens: 42, total_tokens: 360 },
    }));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

/* ══════════ 浏览器 ══════════ */
const DEBUG_PORT = 9800 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'mealpicker-llm-'));
const chrome = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--allow-file-access-from-files',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* 等 */ }
    await sleep(150);
  }
  throw new Error('DevTools 没起来');
}

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
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
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
  on(m, fn) { if (!this.listeners.has(m)) this.listeners.set(m, []); this.listeners.get(m).push(fn); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

let pass = 0, fail = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); pass++; results.push(`  ✓ ${name}`); }
  catch (e) { fail++; results.push(`  ✗ ${name}\n      ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

let cdp;
try {
  await waitForDevtools();
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();

  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: pageUrl });

  for (let i = 0; i < 60; i++) {
    if (await cdp.eval('!!globalThis.__mealPicker')) break;
    await sleep(120);
  }
  // 无头浏览器会拦截 window.open；这里换成桩，让"打开平台页"那一步能走通
  await cdp.eval(`(() => {
    window.open = () => ({ close() {}, closed: false, focus() {} });
    return true;
  })()`);
  await sleep(400);

  console.log(`\n假 LLM 服务：${baseUrl}`);
  console.log(`浏览器：${bin}\n`);

  await check('配置 LLM（假接口 + 假 Key + 单价）', async () => {
    await cdp.eval(`(async () => {
      const s = __mealPicker.store;
      s.saveSettings({
        platforms: { meituan: { enabled: true }, eleme: { enabled: true }, jd: { enabled: true }, taobao: { enabled: true } },
        llm: { enabled: true, baseUrl: ${JSON.stringify(baseUrl)}, model: 'mock-model', priceIn: 2, priceOut: 8, showCost: true },
        dataSource: { mode: 'realtime', relayPort: ${RELAY_PORT}, timeoutMs: 20000 }
      });
      await s.setApiKey('sk-mock-key-for-test');
      return true;
    })()`);
    const ok = await cdp.eval('__mealPicker.store.settings.llm.enabled && !!__mealPicker.store.getApiKey()');
    assert(ok, 'LLM 配置没写进去');
  });

  await check('走完流程，关键词来自模型返回', async () => {
    await submitAndWait(cdp, '想和朋友吃点够味的鱼，两个人，别超过五十');
    const v = await cdp.eval('document.body.dataset.view');
    assert(v === 'result', `没走到结果页，停在 ${v}`);
    assert(requestCount >= 1, '假接口没有收到请求');
    const kw = lastRequestBody?.messages?.[1]?.content || '';
    assert(kw.includes('够味的鱼'), `请求里应带上用户原话，实际「${kw}」`);
  });

  await check('请求体是省 token 的形态（短 system、max_tokens 受限、强制 JSON）', async () => {
    const b = lastRequestBody;
    assert(b.model === 'mock-model', `模型名没传对：${b.model}`);
    assert(b.max_tokens <= 200, `max_tokens 应卡死在小值，实际 ${b.max_tokens}`);
    assert(b.temperature <= 0.3, `temperature 应偏低，实际 ${b.temperature}`);
    assert(b.response_format?.type === 'json_object', '没有强制 JSON 输出');
    assert(b.stream === false, '不应开启流式');
    const sys = b.messages?.[0]?.content || '';
    assert(sys.length < 700, `system 提示词过长（${sys.length} 字符），会浪费 API 费用`);
    assert(/JSON/.test(sys), 'system 里应要求 JSON');
  });

  await check('花费被记录（318 in / 42 out × ¥2/¥8 每百万）', async () => {
    const u = JSON.parse(await cdp.eval('JSON.stringify(__mealPicker.store.todayUsage())'));
    assert(u.calls === 1, `调用次数应为 1，实际 ${u.calls}`);
    assert(u.tokensIn === 318 && u.tokensOut === 42, `token 记录不对：${JSON.stringify(u)}`);
    const expect = (318 / 1e6) * 2 + (42 / 1e6) * 8;
    assert(Math.abs(u.cost - expect) < 1e-9, `费用估算不对：${u.cost} vs ${expect}`);
  });

  await check('结果页脚显示了本次花费', async () => {
    const note = await cdp.eval('document.querySelector(".result__note").innerText');
    assert(/token/.test(note), `底部应显示 token 用量，实际「${note}」`);
    assert(/¥/.test(note), `底部应显示金额，实际「${note}」`);
  });

  await check('设置页「智能转写」显示了用量统计', async () => {
    await cdp.eval('document.querySelector("#open-settings").click()');
    await sleep(600);
    await cdp.eval('document.querySelector(\'.tab[data-tab="llm"]\').click()');
    await sleep(400);
    const txt = await cdp.eval('document.querySelector("#sheet-body").innerText');
    assert(/今日调用次数/.test(txt), '缺少调用次数统计');
    assert(/花费/.test(txt), '缺少花费统计');
    assert(/mock-model/.test(txt) || txt.includes('模型名'), '缺少模型名输入');
    await cdp.eval('document.querySelector("#close-settings").click()');
    await sleep(500);
  });

  await check('同样的话第二次命中缓存，不再产生费用', async () => {
    const before = JSON.parse(await cdp.eval('JSON.stringify(__mealPicker.store.todayUsage())'));
    const reqBefore = requestCount;
    await submitAndWait(cdp, '想和朋友吃点够味的鱼，两个人，别超过五十');
    assert(requestCount === reqBefore, '重复提问不应再次请求接口');
    const after = JSON.parse(await cdp.eval('JSON.stringify(__mealPicker.store.todayUsage())'));
    assert(after.calls === before.calls, `缓存命中时不应增加调用次数：${before.calls} → ${after.calls}`);
    const note = await cdp.eval('document.querySelector(".result__note").innerText');
    assert(/缓存/.test(note), `应提示命中缓存，实际「${note}」`);
  });

  await check('接口报错时回退到内置转写，流程不中断', async () => {
    await cdp.eval(`__mealPicker.store.saveSettings({ llm: { baseUrl: 'http://127.0.0.1:1/v1' } })`);
    if (relayUp) startFeeder(['meituan', 'eleme', 'jd', 'taobao']);
    await cdp.eval(`(() => {
      const i = document.querySelector('#ask-input');
      i.value = '来一碗热汤面';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#ask-form').requestSubmit();
      return true;
    })()`);
    await sleep(1800);
    const meta = await cdp.eval('document.querySelector("#think-meta").textContent');
    assert(/内置转写/.test(meta), `应回退到内置转写，实际「${meta}」`);
    const end = Date.now() + 40000;
    while (Date.now() < end) {
      if (await cdp.eval('document.body.dataset.view') === 'result') break;
      await sleep(200);
    }
    stopFeeder();
    const v = await cdp.eval('document.body.dataset.view');
    assert(v === 'result', `回退后仍应出结果，实际 ${v}`);
    const card = await cdp.eval('!!document.querySelector(".card")');
    assert(card, '回退后没有卡片');
    // 收尾：把 baseUrl 恢复，避免影响后续人工排查
    await cdp.eval(`__mealPicker.store.saveSettings({ llm: { baseUrl: ${JSON.stringify(baseUrl)} } })`);
  });

  await check('全程没有未捕获异常', () => {
    assert(pageErrors.length === 0, `异常：\n      ` + pageErrors.join('\n      '));
  });

  console.log(results.join('\n'));
  console.log(`\n${'─'.repeat(46)}`);
  console.log(`LLM 分支自检：通过 ${pass} 项，失败 ${fail} 项`);
  process.exitCode = fail ? 1 : 0;
} catch (err) {
  console.error('自检执行失败：', err);
  process.exitCode = 1;
} finally {
  stopFeeder();
  try { cdp?.close(); } catch { /* ignore */ }
  chrome.kill();
  server.close();
  try { relayProc?.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
