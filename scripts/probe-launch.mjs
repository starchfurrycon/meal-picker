/**
 * 可行性验证：中继自己拉起浏览器，并通过 CDP 把采集器注入到平台页面，
 * 从而让用户完全跳过「装油猴 + 装脚本」。
 *
 *   node scripts/probe-launch.mjs
 *
 * 为什么要走 CDP 而不是 --load-extension：
 * Chrome 153 起命令行加载扩展已被禁用（实测 --load-extension、
 * --enable-unsafe-extension-debugging、--disable-features=DisableLoadExtensionCommandLineSwitch
 * 都无效）；Edge 153 仍然可用。而 CDP 注入在所有 Chromium 系浏览器上都成立。
 *
 * 只做只读验证：起一个本地假平台页，看采集器有没有在 document_start 注入成功。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Chrome', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'Edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'Chromium', path: '/usr/bin/google-chrome' },
  { name: 'Chromium', path: '/usr/bin/chromium' },
  { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
];
const picked = BROWSERS.find((b) => existsSync(b.path));
if (!picked) { console.log('跳过：没有浏览器'); process.exit(0); }

/** 容器/CI 里常以 root 运行，Chrome 沙箱会直接拒绝启动 */
const NO_SANDBOX = process.platform === 'linux' && (process.getuid?.() === 0 || !!process.env.CI);
const SANDBOX_ARGS = NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = mkdtempSync(join(tmpdir(), 'mp-launchprobe-'));

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>fake platform</title></head>
<body><h1>假装这是美团搜索页</h1>
<script>
  // 采集器要在页面脚本之前就装好钩子，才能嗅探到这次请求
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

/* 采集器（注入版）：包装 fetch，把嗅探结果挂到 window 上，供验证读取 */
const COLLECTOR = `
(function () {
  if (window.__mpInjected) return;
  window.__mpInjected = true;
  window.__mpSniffed = [];
  const orig = window.fetch;
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
`;

const DEBUG_PORT = 10900 + Math.floor(Math.random() * 300);
const profile = join(work, 'profile');
const browser = spawn(picked.path, [...SANDBOX_ARGS, 
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--no-default-browser-check', '--disable-features=Translate',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

class CDP {
  constructor(ws) {
    this.ws = new WebSocket(ws); this.id = 0; this.pending = new Map(); this.l = new Map();
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      const arr = this.l.get(m.method);
      if (arr) for (const fn of arr) fn(m.params);
    });
  }
  ready() { return new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); }); }
  on(m, fn) { if (!this.l.has(m)) this.l.set(m, []); this.l.get(m).push(fn); }
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

let browserCdp;
const pageCdps = [];
try {
  console.log(`浏览器：${picked.name}  ${picked.path}\n`);

  const end = Date.now() + 20000;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(200);
  }
  const ver = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  console.log('浏览器版本：', ver.Browser);

  // 1) 浏览器级连接：给每个新建的页面目标自动挂上采集器
  browserCdp = new CDP(ver.webSocketDebuggerUrl);
  await browserCdp.ready();
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });

  const injected = new Set();
  const sessions = new Map();
  // 只负责"挂上采集器"，不负责导航
  const attach = async (targetId) => {
    if (injected.has(targetId)) return sessions.get(targetId);
    injected.add(targetId);
    let sessionId;
    try {
      const r = await browserCdp.send('Target.attachToTarget', { targetId, flatten: true });
      sessionId = r.sessionId;
    } catch (e) { console.log('  attach 失败：' + e.message); return null; }
    const sendTo = (method, params = {}) => new Promise((res, rej) => {
      const id = ++browserCdp.id;
      browserCdp.ws.send(JSON.stringify({ id, method, params, sessionId }));
      browserCdp.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => { if (browserCdp.pending.has(id)) { browserCdp.pending.delete(id); rej(new Error(method + ' 超时')); } }, 15000);
    });
    try {
      await sendTo('Page.enable');
      // 关键：在新文档的任何脚本之前注入
      await sendTo('Page.addScriptToEvaluateOnNewDocument', { source: COLLECTOR });
      sessions.set(targetId, sendTo);
      console.log(`  已挂上采集器 → ${targetId.slice(0, 12)}`);
    } catch (e) { console.log('  注入失败：' + e.message); }
    return sendTo;
  };

  browserCdp.on('Target.targetCreated', (p) => {
    if (p.targetInfo.type === 'page') attach(p.targetInfo.targetId).catch(() => {});
  });

  // 2) 打开"平台页"，看注入是否生效
  // 关键顺序：先建 about:blank → 挂采集器 → 再导航到平台页，
  // 这样采集器才是在 document_start（页面任何脚本之前）装好钩子的。
  const created = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
  await sleep(300);
  const sendTo = await attach(created.targetId);
  if (!sendTo) throw new Error('没能挂上采集器');
  const nav = await sendTo('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  console.log('  navigate → ' + JSON.stringify(nav));
  await sleep(3000);
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  console.log('\n当前目标：');
  for (const t of targets) console.log(`  [${t.type}] ${t.url.slice(0, 90)}`);
  const page = targets.find((t) => t.type === 'page' && t.url.includes(String(port)));
  if (!page) throw new Error('没找到平台页目标');

  const cdp = new CDP(page.webSocketDebuggerUrl);
  pageCdps.push(cdp);
  await cdp.ready();
  const probe = await cdp.eval(`JSON.stringify({
    collector: document.documentElement.getAttribute('data-mp-collector'),
    injected: !!window.__mpInjected,
    sniffed: document.documentElement.getAttribute('data-mp-sniffed'),
    sniffedLen: (window.__mpSniffed || []).length,
    pageGot: !!window.__pageGot,
    list: window.__mpSniffed || null,
  })`);
  const o = JSON.parse(probe);
  console.log('\n结果：');
  console.log('  注入脚本已执行 (window.__mpInjected) :', o.injected);
  console.log('  document_start 标记                  :', o.collector || '（无）');
  console.log('  嗅探到页面自己的请求                 :', o.sniffedLen);
  console.log('  页面自身的 fetch 仍正常               :', o.pageGot);
  if (o.list) console.log('  嗅探明细                             :', JSON.stringify(o.list));

  const ok = o.injected && o.sniffedLen >= 1 && o.pageGot;
  console.log('\n' + (ok
    ? `✔ 可行：中继用 CDP 注入，${picked.name} 上不需要装任何扩展/油猴`
    : '✘ CDP 注入这条路有问题'));
} catch (e) {
  console.error('探测失败：', e.message);
} finally {
  for (const c of pageCdps) { try { c.close(); } catch { /* ignore */ } }
  try { browserCdp?.close(); } catch { /* ignore */ }
  browser.kill();
  server.close();
  await sleep(600);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}
