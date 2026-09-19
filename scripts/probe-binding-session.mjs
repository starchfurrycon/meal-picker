/**
 * 定位：为什么 browser.mjs 的 flatten 会话里 Runtime.addBinding 没生效，
 * 而直连页面 target 的写法却可以。
 *
 *   node scripts/probe-binding-session.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (typeof WebSocket === 'undefined') { console.log('跳过：需要 Node 22+'); process.exit(0); }
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
];
const bin = BROWSERS.find((p) => existsSync(p));
if (!bin) { console.log('跳过：没有浏览器'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NO_SANDBOX = process.platform === 'linux' && (process.getuid?.() === 0 || !!process.env.CI);
const SANDBOX_ARGS = NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
const DEBUG_PORT = 29000 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'mp-bindsess-'));

const chrome = spawn(bin, [...SANDBOX_ARGS,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

/* 完全照抄 browser.mjs 的 Cdp 类 */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
        return;
      }
      for (const fn of (this.listeners.get(m.method) || [])) {
        try { fn(m.params, m.sessionId); } catch { /* ignore */ }
      }
    });
  }
  ready() {
    return new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  raw(method, params = {}, sessionId) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 15000);
    });
  }
}

let cdp = null;
try {
  let version = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* 等 */ }
    await sleep(200);
  }
  if (!version) throw new Error('浏览器没起来');

  cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.raw('Target.setDiscoverTargets', { discover: true });

  const bindings = [];
  cdp.on('Runtime.bindingCalled', (p, sid) => bindings.push({ payload: p.payload, sid }));

  // ① 用 flatten 会话，照 browser.mjs 的做法
  const { targetId } = await cdp.raw('Target.createTarget', { url: 'about:blank' });
  console.log('createTarget →', targetId);

  const att = await cdp.raw('Target.attachToTarget', { targetId, flatten: true });
  const sid = att.sessionId;
  console.log('attachToTarget → sessionId', sid);

  const send = (method, params) => cdp.raw(method, params, sid);
  console.log('Page.enable        →', JSON.stringify(await send('Page.enable')));
  console.log('Runtime.enable     →', JSON.stringify(await send('Runtime.enable')));
  try {
    console.log('Runtime.addBinding →', JSON.stringify(await send('Runtime.addBinding', { name: '__mealPickerRelay' })));
  } catch (e) {
    console.log('Runtime.addBinding → 报错:', e.message);
  }

  // 挂一个探针脚本，记录 document_start 时 binding 在不在
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__probe = { atStart: typeof window.__mealPickerRelay, task: window.__mealPickerTask };`,
  });

  await send('Page.navigate', { url: 'https://waimai.meituan.com/mobile/download/default' });
  await sleep(6000);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (r.exceptionDetails) return '异常: ' + (r.exceptionDetails.exception?.description || '');
    return r.result?.value;
  };

  console.log('\n[flatten 会话]');
  console.log('  document_start 时：', await evalJs('JSON.stringify(window.__probe)'));
  console.log('  现在 typeof      ：', await evalJs('typeof window.__mealPickerRelay'));

  if (await evalJs('typeof window.__mealPickerRelay') === 'function') {
    await evalJs(`window.__mealPickerRelay(JSON.stringify({ via: 'flatten' }))`);
    await sleep(800);
    console.log('  中继侧收到：', JSON.stringify(bindings));
  }

  // ② 对照：再补一次 addBinding（页面已加载后），看能不能补上
  console.log('\n[补一次 addBinding 再看]');
  try {
    await send('Runtime.addBinding', { name: '__mealPickerRelay2' });
    await sleep(500);
    console.log('  typeof __mealPickerRelay2：', await evalJs('typeof window.__mealPickerRelay2'));
  } catch (e) { console.log('  报错:', e.message); }

  // ③ 看目标列表里有哪些 target 类型
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  console.log('\n目标列表：');
  for (const t of list) console.log(`  ${t.type.padEnd(12)} ${String(t.url).slice(0, 70)}`);
} catch (e) {
  console.error('探测失败：', e.message);
} finally {
  try { cdp?.ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(600);
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}
