/**
 * 单独验证：Runtime.addBinding 挂上去之后，页面 document_start 时能不能看到它。
 *
 *   node scripts/probe-binding-timing.mjs
 *
 * 这条链路是"零安装"的关键 —— 采集器靠它把价格交回中继。
 * 如果注入脚本跑的时候 binding 还没生效，采集器就会以为中继没开。
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
const DEBUG_PORT = 28000 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'mp-bind-'));

const chrome = spawn(bin, [...SANDBOX_ARGS,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

let ws = null;
try {
  let target = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
      if (target) break;
    } catch { /* 等 */ }
    await sleep(200);
  }
  if (!target) throw new Error('浏览器没起来');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('连不上')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const bindings = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.bindingCalled') bindings.push(m.params);
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ result: {}, __timeout: true }); } }, 10000);
  });

  await send('Page.enable');
  await send('Runtime.enable');

  // 关键顺序：先加 binding，再挂 document_start 脚本，最后导航
  const addRes = await send('Runtime.addBinding', { name: '__mealPickerRelay' });
  console.log('Runtime.addBinding 返回：', JSON.stringify(addRes.result ?? addRes.error ?? addRes));

  // 用一个探针脚本记录 document_start 时 binding 在不在
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__probe = {
        atStart: typeof window.__mealPickerRelay,
        time: Date.now(),
      };
    `,
  });

  await send('Page.navigate', { url: 'https://waimai.meituan.com/mobile/download/default' });
  await sleep(5000);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return '异常: ' + (r.result.exceptionDetails.exception?.description || '');
    return r.result?.result?.value;
  };

  console.log('\ndocument_start 时：', await evalJs('JSON.stringify(window.__probe)'));
  console.log('现在 typeof    ：', await evalJs('typeof window.__mealPickerRelay'));

  if (await evalJs('typeof window.__mealPickerRelay') === 'function') {
    await evalJs(`window.__mealPickerRelay(JSON.stringify({ hello: 'from page' }))`);
    await sleep(800);
    console.log(`中继侧收到 ${bindings.length} 条：`, bindings.map((b) => String(b.payload).slice(0, 60)).join(' | ') || '（无）');
  }

  console.log('\n结论：' + (await evalJs('typeof window.__mealPickerRelay') === 'function'
    ? 'binding 在页面里可用'
    : 'binding 不可用 ← 采集器会误判成"中继没在跑"'));
} catch (e) {
  console.error('探测失败：', e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(600);
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}
