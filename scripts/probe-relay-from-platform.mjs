/**
 * 在**真实平台页面**上测「页面 → http://127.0.0.1 中继」这条通道。
 *
 *   node scripts/probe-relay-from-platform.mjs [meituan|eleme|taobao|jd]
 *
 * 为什么必须用真实平台页：本地自签 https 页跑不出真实语境（CSP、混合内容、
 * 平台自己的 fetch 包装都可能不一样），而这条通道通不通直接决定
 * 「零安装」这条路成不成立 —— 采集器读到了价格却回传不了，等于白采。
 *
 * 只读：不抓数据，只发一次 /api/health。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { platformSearchUrl } from '../relay/platform-urls.js';

const PLATFORM = process.argv[2] || 'meituan';
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

/* 中继：完全照搬 relay/server.mjs 的 CORS 头 */
let hitCount = 0;
const relay = createServer((req, res) => {
  hitCount++;
  const h = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, h); res.end(); return; }
  res.writeHead(200, { ...h, 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, hit: hitCount }));
});
await new Promise((r) => relay.listen(0, '127.0.0.1', r));
const relayPort = relay.address().port;

const DEBUG_PORT = 27000 + Math.floor(Math.random() * 400);
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const profile = mkdtempSync(join(tmpdir(), 'mp-fromplat-'));

// 故意不加 --allow-running-insecure-content：要测的就是真实的混合内容策略
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
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Log.entryAdded') logs.push(m.params.entry.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ result: {} }); } }, 12000);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  const url = platformSearchUrl(PLATFORM, '酸菜鱼');
  console.log(`中继：http://127.0.0.1:${relayPort}`);
  console.log(`页面：${url}\n`);
  await send('Page.navigate', { url });
  await sleep(6000);

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return '异常: ' + (r.result.exceptionDetails.exception?.description || '');
    return r.result?.result?.value;
  };

  console.log('实际停在：', await evalJs('location.href'));

  console.log('\n[A] 普通 GET（无自定义头，不触发预检）');
  console.log('   ', await evalJs(`(async () => {
    try { const r = await fetch('http://127.0.0.1:${relayPort}/api/health', { cache: 'no-store' });
          return '通了 ' + r.status + ' ' + (await r.text()).slice(0, 40); }
    catch (e) { return e.name + ': ' + e.message; }
  })()`));

  console.log('\n[B] 带 Content-Type: application/json 的 GET（触发预检，采集器就是这么发的）');
  console.log('   ', await evalJs(`(async () => {
    try { const r = await fetch('http://127.0.0.1:${relayPort}/api/health',
            { cache: 'no-store', headers: { 'Content-Type': 'application/json' } });
          return '通了 ' + r.status; }
    catch (e) { return e.name + ': ' + e.message; }
  })()`));

  console.log('\n[C] POST JSON（采集器回传价格用的）');
  console.log('   ', await evalJs(`(async () => {
    try { const r = await fetch('http://127.0.0.1:${relayPort}/api/prices',
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ platform: '${PLATFORM}', offers: [] }) });
          return '通了 ' + r.status; }
    catch (e) { return e.name + ': ' + e.message; }
  })()`));

  console.log(`\n中继实际收到 ${hitCount} 次请求`);

  if (logs.length) {
    console.log('\n页面报错：');
    for (const v of [...new Set(logs)].slice(0, 10)) console.log('  ' + String(v).slice(0, 200));
  }
} catch (e) {
  console.error('探测失败：', e.message);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  relay.close();
  chrome.kill();
  await sleep(600);
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}
