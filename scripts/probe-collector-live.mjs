/**
 * 在托管浏览器里打开一个真实平台页，然后用 CDP 看采集器到底活没活：
 * 注入是否发生、平台判定对不对、跟中继的通信通不通。
 *
 *   node scripts/probe-collector-live.mjs [meituan|eleme|taobao|jd]
 *
 * 只读诊断：不抓数据、不改页面，只看采集器自身状态。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platformSearchUrl } from '../relay/platform-urls.js';

const PLATFORM = process.argv[2] || 'meituan';
const RELAY_PORT = 24567;

if (typeof WebSocket === 'undefined') { console.log('跳过：需要 Node 22+'); process.exit(0); }
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
];
const bin = BROWSERS.find((p) => existsSync(p));
if (!bin) { console.log('跳过：没有浏览器'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const root = join(import.meta.dirname, '..');
const NO_SANDBOX = process.platform === 'linux' && (process.getuid?.() === 0 || !!process.env.CI);
const SANDBOX_ARGS = NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];

/* 起中继 */
// 先确认端口是空的：上一次探测如果被强杀，旧中继会留在那儿，
// 后面所有请求都打到那个旧进程上，看到的永远是旧代码 —— 排查起来极坑。
try {
  const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/health`);
  if (r.ok) {
    console.error(`端口 ${RELAY_PORT} 上已经有一个中继在跑（可能是上次探测的残留）。`);
    console.error('先把它关掉：Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -match \'server.mjs\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }');
    process.exit(1);
  }
} catch { /* 端口空着，正常 */ }

const relay = spawn(process.execPath, [join(root, 'relay', 'server.mjs'), '--port', String(RELAY_PORT), '--quiet', '--no-open'], { stdio: 'ignore', cwd: root });
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/health`); if (r.ok) break; } catch { /* 等 */ }
  await sleep(200);
}
// 登记一个任务，采集器领到活才会去采
await fetch(`http://127.0.0.1:${RELAY_PORT}/api/collect`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ keyword: '酸菜鱼', platforms: [PLATFORM], timeoutMs: 30000 }),
});

/* 走中继自己的 HTTP 接口 —— 跟工具页面用的是同一条路，
   这样 onCollect / ingestPrices 这些真实链路也一并验到 */
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
let managed = null;
let debugPort = null;
try {
  const start = await (await fetch(`${RELAY}/api/browser/start`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: '酸菜鱼', platforms: [PLATFORM] }),
  })).json();  console.log('拉起浏览器：', JSON.stringify({ ok: start.ok, browser: start.browser, opened: start.opened, error: start.error }));
  if (!start.ok) throw new Error(start.error || '浏览器没拉起来');
  debugPort = (await (await fetch(`${RELAY}/api/browser`)).json()).debugPort;
  const dbg = await (await fetch(`${RELAY}/api/browser`)).json();
  console.log('浏览器状态：', JSON.stringify(dbg, null, 1));
  console.log(`\n打开：${platformSearchUrl(PLATFORM, '酸菜鱼')}\n`);

  // 等页面稳下来，再挂上去看。
  // 注意：这里刻意只等固定几轮，不用 ws 长连接轮询 —— 页面一导航，
  // 旧的调试连接会失效，某些情况下会让 CDP 命令永远不返回。
  let done = false;
  for (let i = 0; i < 12 && !done; i++) {
    await sleep(2500);
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
    if (!page) continue;
    console.log(`第 ${i + 1} 轮（${(i + 1) * 2.5}s）→ ${String(page.url).slice(0, 100)}`);

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const opened = await Promise.race([
      new Promise((res) => {
        ws.addEventListener('open', () => res(true), { once: true });
        ws.addEventListener('error', () => res(false), { once: true });
      }),
      sleep(4000).then(() => false),
    ]);
    if (!opened) { try { ws.close(); } catch { /* ignore */ } continue; }

    let seq = 0;
    const pending = new Map();
    const consoleMsgs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === 'Runtime.consoleAPICalled') {
        consoleMsgs.push(m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
      // CDP 命令可能因为页面导航而永远不返回，兜个底
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ result: {} }); } }, 12000);
    });
    await send('Runtime.enable');
    // 页面可能还在跳转，等它稳一下再问
    await sleep(1200);
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) return '异常: ' + (r.result.exceptionDetails.exception?.description || 'eval 失败');
      return r.result?.result?.value;
    };

    const info = await evalJs(`JSON.stringify({
      url: location.href,
      host: location.hostname,
      coreInjected: typeof __mealPickerCollectorCore,
      mainWorld: window.__mealpickerMainWorld === true,
      snifferOn: window.__mealpickerSnifferOn === true,
      binding: typeof window.__mealPickerRelay,
      bakedTask: window.__mealPickerTask === undefined ? '未设置' : window.__mealPickerTask,
      collector: window.__mealPickerCollector
        ? { platform: window.__mealPickerCollector.platform, relay: window.__mealPickerCollector.relay, mainWorld: window.__mealPickerCollector.mainWorld }
        : null,
      readyState: document.readyState,
      title: document.title,
      bodyLen: (document.body && document.body.innerText || '').length,
      hasLoginWord: /登录|登陆|扫码/.test((document.body && document.body.innerText || '').slice(0, 3000)),
    })`);
    // 直接问页面：它自己能不能摸到中继
    const reach = await evalJs(`(async () => {
      const relay = (window.__mealPickerCollector && window.__mealPickerCollector.relay) || 'http://127.0.0.1:${RELAY_PORT}';
      try {
        const r = await fetch(relay + '/api/health', { cache: 'no-store' });
        return 'ok ' + r.status;
      } catch (e) { return 'ERR ' + e.name + ': ' + e.message; }
    })()`);
    const task = await evalJs(`(async () => {
      const relay = (window.__mealPickerCollector && window.__mealPickerCollector.relay) || 'http://127.0.0.1:${RELAY_PORT}';
      try {
        const r = await fetch(relay + '/api/task?platform=${PLATFORM}', { cache: 'no-store' });
        return (await r.text()).slice(0, 160);
      } catch (e) { return 'ERR ' + e.name + ': ' + e.message; }
    })()`);
    ws.close();

    let o = null;
    try { o = JSON.parse(info); } catch { console.log(`第 ${i + 1} 轮：取不到页面状态 →`, info); continue; }

    console.log(`第 ${i + 1} 轮（${(i + 1) * 2.5}s）`);
    console.log(`  URL        ${String(o.url).slice(0, 110)}`);
    console.log(`  host       ${o.host}`);
    console.log(`  标题       ${String(o.title).slice(0, 60)}   正文 ${o.bodyLen} 字`);
    console.log(`  注入核心   ${o.coreInjected}   主世界 ${o.mainWorld}   嗅探已装 ${o.snifferOn}`);
    console.log(`  采集器对象 ${o.collector ? JSON.stringify(o.collector) : '（无 —— 说明 detectPlatform 没认出来）'}`);
    console.log(`  回传 binding ${o.binding}`);
    console.log(`  注入的任务 ${JSON.stringify(o.bakedTask)}`);
    console.log(`  像登录页   ${o.hasLoginWord}`);
    console.log(`  页面能连中继 ${reach}`);
    console.log(`  领任务     ${task}`);
    if (consoleMsgs.length) {
      console.log('  页面 console：');
      for (const m of consoleMsgs.slice(-8)) console.log('    ' + String(m).slice(0, 160));
    }

    if (o.collector) { done = true; break; }
  }

  /* 采集器要等页面把接口请求发出来，回传得晚一些，单独等一会儿 */
  console.log('\n等采集器回传（最多 60 秒）…');
  let got = null;
  for (let i = 0; i < 24; i++) {
    await sleep(2500);
    const pr = await (await fetch(`${RELAY}/api/prices`)).json();
    if (pr.prices && Object.keys(pr.prices).length) { got = pr; break; }
  }

  const pr = got || await (await fetch(`${RELAY}/api/prices`)).json();
  console.log('\n中继已收到：' + (Object.keys(pr.prices || {}).join(', ') || '（空）'));
  for (const [k, v] of Object.entries(pr.prices || {})) {
    console.log(`  ${k}: ${v.count} 条   页面=${String(v.page).slice(0, 70)}`);
    if (v.warnings?.length) console.log(`     警告：${v.warnings.join('；')}`);
    for (const o of (v.offers || []).slice(0, 3)) {
      const pk = o.packages?.[0] || {};
      console.log(`     · ${o.merchant || '?'} / ${pk.dish || '?'} / ¥${pk.finalPrice ?? '?'}`);
    }
  }
  const h = await (await fetch(`${RELAY}/api/health`)).json();
  console.log('采集器心跳：' + (h.collectorSeen == null ? '从未出现' : `${Math.round(h.collectorSeen / 1000)} 秒前`));
} catch (e) {
  console.error('诊断失败：', e.message);
} finally {
  try { await fetch(`${RELAY}/api/browser/stop`, { method: 'POST' }); } catch { /* ignore */ }
  relay.kill();
  await sleep(500);
  if (process.platform === 'win32') {
    for (const p of [relay]) { try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
  }
  process.exit(0);
}
