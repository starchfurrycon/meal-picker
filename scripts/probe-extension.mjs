/**
 * 可行性验证：中继能不能直接拉起一个"已经装好采集器"的 Chrome，
 * 让用户彻底跳过装油猴 + 装脚本这两步？
 *
 *   node scripts/probe-extension.mjs
 *
 * 只做只读验证：起一个本地静态页，看内容脚本有没有真的注进去。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const ONLY = (process.argv.find((a) => a.startsWith('--browser=')) || '').replace('--browser=', '');
const bin = ONLY ? (existsSync(ONLY) ? ONLY : null) : BROWSERS.find((p) => existsSync(p));
if (!bin) { console.log('跳过：没有浏览器'); process.exit(0); }

/** 容器/CI 里常以 root 运行，Chrome 沙箱会直接拒绝启动 */
const NO_SANDBOX = process.platform === 'linux' && (process.getuid?.() === 0 || !!process.env.CI);
const SANDBOX_ARGS = NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), 'mp-extprobe-'));

/* ── 一个假的"平台页" ── */
const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>fake platform</title></head>
<body><h1>假装这是美团搜索页</h1>
<script>
  // 采集器要嗅探的就是这种"页面自己发的请求"
  fetch('/api/poi/food?keyword=test').then(r => r.json()).then(j => { window.__pageGot = j; });
</script>
</body></html>`;

const server = createServer((req, res) => {
  if (req.url.startsWith('/api/poi/food')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { poiList: [{ name: '测试店', price: 25 }] } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/* ── 一个最小扩展：MV3 + MAIN world 内容脚本 ── */
const ext = join(work, 'ext');
mkdirSync(ext, { recursive: true });
writeFileSync(join(ext, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: '选餐采集器（探测）',
  version: '1.0.0',
  background: { service_worker: 'sw.js' },
  content_scripts: [{
    matches: ['http://127.0.0.1/*', 'http://localhost/*'],
    js: ['collector.js'],
    run_at: 'document_start',
    all_frames: false,
    world: 'MAIN',
  }],
  host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
}, null, 2));
writeFileSync(join(ext, 'sw.js'), "console.log('mp-ext sw alive');\n");

// 内容脚本：在主世界包装 fetch，把嗅探结果挂到 window 上（真实采集器会 POST 给中继）
writeFileSync(join(ext, 'collector.js'), `
(function () {
  const orig = window.fetch;
  window.__mpSniffed = [];
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const p = orig.apply(this, arguments);
    if (/poi\\/food/.test(url)) {
      p.then((res) => {
        res.clone().text().then((t) => {
          window.__mpSniffed.push({ url, len: t.length });
          document.documentElement.setAttribute('data-mp-sniffed', String(window.__mpSniffed.length));
        });
      });
    }
    return p;
  };
  document.documentElement.setAttribute('data-mp-collector', 'loaded');
})();
`);

const DEBUG_PORT = 10800 + Math.floor(Math.random() * 300);
const profile = join(work, 'profile');
const HEADLESS = process.argv.includes('--headless');
const args = [
  ...SANDBOX_ARGS,
  '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--load-extension=${ext}`,
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  `http://127.0.0.1:${port}/`,
];
if (process.argv.includes('--only-except')) args.splice(3, 0, `--disable-extensions-except=${ext}`);
if (process.argv.includes('--unsafe')) args.splice(3, 0, '--enable-unsafe-extension-debugging');
if (process.argv.includes('--nofeature')) args.splice(3, 0, '--disable-features=DisableLoadExtensionCommandLineSwitch');
if (HEADLESS) args.unshift('--headless=new');
const chrome = spawn(bin, args, { stdio: 'ignore' });

class CDP {
  constructor(ws) {
    this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    });
  }
  ready() { return new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 15000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

let cdp;
try {
  const end = Date.now() + 20000;
  let list = [];
  while (Date.now() < end) {
    try {
      list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      if (list.some((t) => t.type === 'page' && t.url.includes(String(port)))) break;
    } catch { /* 等 */ }
    await sleep(200);
  }
  const page = list.find((t) => t.type === 'page' && t.url.includes(String(port)));
  if (!page) throw new Error('没找到页面目标');

  console.log('所有目标：');
  for (const t of list) console.log(`  [${t.type}] ${t.url.slice(0, 100)}`);

  cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.ready();
  await sleep(1500);

  const probe = await cdp.eval(`JSON.stringify({
    collector: document.documentElement.getAttribute('data-mp-collector'),
    sniffed: document.documentElement.getAttribute('data-mp-sniffed'),
    pageGot: !!window.__pageGot,
    list: window.__mpSniffed || null,
  })`);
  const o = JSON.parse(probe);
  console.log('\n结果：');
  console.log('  内容脚本注入 (data-mp-collector) :', o.collector || '（无）');
  console.log('  嗅探到页面自己的请求            :', o.sniffed || '0');
  console.log('  页面自身的 fetch 仍正常工作      :', o.pageGot);
  if (o.list) console.log('  嗅探明细                        :', JSON.stringify(o.list));

  const ok = o.collector === 'loaded' && Number(o.sniffed) >= 1 && o.pageGot;
  console.log('\n' + (ok
    ? '✔ --load-extension 可用：中继可以直接拉起"已装好采集器"的浏览器，用户不必装油猴'
    : '✘ --load-extension 这条路走不通（或需要换方式）'));
} catch (e) {
  console.error('探测失败：', e.message);
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  chrome.kill();
  server.close();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}
