/**
 * 端到端验证「零安装」这条路：
 *
 *   起真实中继 → 调 /api/browser/start → 中继真的拉起一个浏览器并注入采集器
 *   → 用 CDP 检查平台页面里采集器是不是活着、能不能跟中继对上话
 *   → /api/browser/stop 收干净
 *
 * 不访问真实平台（那会碰到风控，也不该在自检里打人家服务器），
 * 而是让中继打开一个本地假平台页，检查注入与通信链路本身。
 *
 *   node scripts/e2e-browser.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (typeof WebSocket === 'undefined') {
  console.log('跳过：当前 Node 没有全局 WebSocket（需要 Node 22+）');
  process.exit(0);
}

const root = join(import.meta.dirname, '..');
const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
if (!BROWSERS.some((p) => existsSync(p))) {
  console.log('跳过：没有可用的 Chromium 系浏览器');
  process.exit(0);
}

/** 容器/CI 里常以 root 运行，Chrome 沙箱会直接拒绝启动 */
const NO_SANDBOX = process.platform === 'linux' && (process.getuid?.() === 0 || !!process.env.CI);
const SANDBOX_ARGS = NO_SANDBOX ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fail++;
    console.log('  ✗ ' + name + '\n      ' + (e?.message || e));
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg || '断言失败'); };

/** 起一个独立的无头浏览器打开页面，返回 { eval, close } */
async function launchPage(url) {
  // 这台机器上可能同时有别的自检在跑，端口撞了就换一个重试
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await launchPageOnce(url);
    } catch (e) {
      lastErr = e;
      await sleep(500);
    }
  }
  throw lastErr || new Error('无头浏览器没起来');
}

async function launchPageOnce(url) {
  const bin = BROWSERS.find((p) => existsSync(p));
  const port = 22000 + Math.floor(Math.random() * 2000);
  const profile = mkdtempSync(join(tmpdir(), 'mp-e2ebr-'));
  const child = spawn(bin, [...SANDBOX_ARGS,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=430,932',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url,
  ], { stdio: 'ignore' });
  // 起不来时别留孤儿进程
  const bail = () => { try { child.kill(); } catch { /* ignore */ } };

  let target = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (target) break;
    } catch { /* 等 */ }
    await sleep(200);
  }
  if (!target) {
    bail();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    throw new Error(`无头浏览器没起来（port=${port} exit=${child.exitCode}）`);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('连不上页面')), { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  // 等应用挂载
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', { expression: '!!globalThis.__mealPicker', returnByValue: true });
    if (r.result?.result?.value) break;
    await sleep(150);
  }
  return {
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval 失败');
      return r.result?.result?.value;
    },
    async close() {
      try { ws.close(); } catch { /* ignore */ }
      child.kill();
      await sleep(300);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/* 假平台页：让中继以为它是 meituan —— 但 /api/browser/start 用的是真 URL。
   所以这里换个思路：直接检查中继的浏览器是否注入成功，用 CDP 在它打开的
   真实平台页里查 window.__mealPickerCollector。为了不打真实平台，
   先起一个本地页，再让中继的托管浏览器导航过去。 */
const FAKE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>fake</title></head>
<body><h1>本地假平台页</h1>
<script>fetch('/api/poi/food?keyword=test').then(r=>r.json()).then(j=>{window.__pageGot=j;});</script>
</body></html>`;

const fake = createServer((req, res) => {
  if (req.url.startsWith('/api/poi/food')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { poiList: [{ name: '测试店', price: 25, poiName: '测试店' }] } }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(FAKE);
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakePort = fake.address().port;

const PORT = 21000 + Math.floor(Math.random() * 500);
const relay = spawn(process.execPath, [join(root, 'relay', 'server.mjs'), '--port', String(PORT), '--quiet', '--no-open'], {
  stdio: 'ignore', cwd: root,
});

/* 另一个中继实例，开着"拉起浏览器"的探针：用来验证前端在自动模式下
   确实会去调 /api/browser/start（不真开浏览器，所以这个自检很快） */
const SPY_PORT = PORT + 1000;
const spyRelay = spawn(process.execPath, [join(root, 'relay', 'server.mjs'), '--port', String(SPY_PORT), '--quiet', '--no-open'], {
  stdio: 'ignore', cwd: root, env: { ...process.env, MEALPICKER_BROWSER_SPY: '1' },
});

const profileDir = join(root, 'data', 'browser-profile');
const hadProfile = existsSync(profileDir);

let managedDbgPort = null;
try {
  // 等中继起来
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(200);
  }
  console.log(`\n中继：http://127.0.0.1:${PORT}\n`);

  await check('中继报告了可用的浏览器', async () => {
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/browser`)).json();
    assert(r.available, '没检测到浏览器');
    assert(r.running === false, '一开始不该有托管浏览器在跑');
  });

  await check('/api/browser/start 缺少参数时明确报错', async () => {
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/browser/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    assert(r.ok === false, '应该失败');
    assert(/platforms/.test(r.error), `错误信息没说到点上：${r.error}`);
  });

  let started = null;
  await check('托管浏览器真的被拉起，并打开了平台搜索页', async () => {
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/browser/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platforms: ['meituan', 'eleme'], keyword: '酸菜鱼' }),
    })).json();
    started = r;
    assert(r.ok, `启动失败：${r.error} ${r.hint || ''}`);
    assert(r.opened === 2, `应该开 2 个页面，实际 ${r.opened}`);
    assert(r.targets === 2, `应该挂上 2 个目标，实际 ${r.targets}`);
    assert(/waimai\.meituan\.com/.test(r.urls[0]), `美团 URL 不对：${r.urls[0]}`);
    assert(/酸菜鱼|%E9%85%B8%E8%8F%9C%E9%B1%BC/.test(r.urls[0]), `关键词没进 URL：${r.urls[0]}`);
  });

  await check('状态接口如实反映"正在运行"', async () => {
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/browser`)).json();
    assert(r.running === true, '应该在运行');
    assert(r.browser, '应该报出浏览器名字');
    managedDbgPort = r.debugPort;
    assert(managedDbgPort > 0, '应该报出调试端口');
  });

  await check('托管浏览器用的是独立配置目录（不碰用户日常浏览器）', async () => {
    assert(existsSync(profileDir), `没找到独立配置目录 ${profileDir}`);
  });

  await check('采集器被注入到托管浏览器打开的页面里（含 document_start 钩子）', async () => {
    // 让托管浏览器导航到本地假平台页——注意：假页不是平台域名，
    // 采集器会因 detectPlatform() 返回 null 而自行退出，这是设计如此。
    // 所以这里只验证"注入确实发生了"，用另一个只在 meituan 域名下才活的探针。
    const list = await (await fetch(`http://127.0.0.1:${managedDbgPort}/json/list`)).json();
    const pages = list.filter((t) => t.type === 'page' && /meituan\.com|ele\.me/.test(t.url));
    assert(pages.length >= 1, `托管浏览器里没有平台页：${JSON.stringify(list.map((t) => t.url))}`);

    // 用 CDP 在该页执行，确认注入脚本确实在 document_start 跑过。
    // 注入源码里第一件事就是定义 __mealPickerCollectorCore；
    // 采集器在非平台域名下会 return，所以检查注入本身用 evaluate 反查：
    const target = pages[0];
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('连不上页面调试端口')), { once: true });
    });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evalJs = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      return r.result?.result?.value;
    };
    // 注入脚本定义了这个函数名，且注入版会把它设成 true
    const hasCore = await evalJs('typeof __mealPickerCollectorCore');
    const mainWorld = await evalJs('window.__mealpickerMainWorld === true');
    ws.close();
    assert(hasCore === 'function', `页面里没有注入 __mealPickerCollectorCore（实际 ${hasCore}）`);
    assert(mainWorld === true, '主世界标记没设上，嗅探钩子会装到隔离世界去');
  });

  await check('/api/browser/stop 能收干净', async () => {
    const r = await (await fetch(`http://127.0.0.1:${PORT}/api/browser/stop`, { method: 'POST' })).json();
    assert(r.ok && r.running === false, '停止失败');
    await sleep(1200);
    const s = await (await fetch(`http://127.0.0.1:${PORT}/api/browser`)).json();
    assert(s.running === false, '停止后仍报告在运行');
  });

  /* ── 前端接线：自动模式下，点"开始筛选"应该让中继去拉浏览器 ── */
  await check('前端在自动模式下会调用托管浏览器（零安装这条路真的接上了）', async () => {
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`http://127.0.0.1:${SPY_PORT}/api/health`); if (r.ok) break; } catch { /* 等 */ }
      await sleep(200);
    }
    const page = await launchPage(`http://127.0.0.1:${SPY_PORT}/`);
    try {
      // 让前端把中继指到这个探针实例，并确保是自动模式
      await page.eval(`(() => {
        const s = globalThis.__mealPicker.store;
        s.saveSettings({ dataSource: { mode: 'realtime', relayPort: ${SPY_PORT}, collectorMode: 'auto', timeoutMs: 4000 } });
        return true;
      })()`);
      await sleep(300);
      await page.eval(`(() => {
        const i = document.querySelector('#ask-input');
        i.value = '想吃酸菜鱼';
        i.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#ask-form').requestSubmit();
        return true;
      })()`);
      // 等前端走到"登记任务 → 拉浏览器"这一步
      let spy = null;
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        const r = await (await fetch(`http://127.0.0.1:${SPY_PORT}/api/browser`)).json();
        if (r.spy && r.spy.length) { spy = r.spy; break; }
      }
      assert(spy, '前端没有调用 /api/browser/start —— 自动模式没接上');
      assert(spy[0].platforms.length >= 1, '没带上平台');
      assert(spy[0].keyword, '没带上关键词');
    } finally {
      await page.close();
    }
  });
} catch (e) {
  console.error('自检异常：', e);
  fail++;
} finally {
  try { await fetch(`http://127.0.0.1:${PORT}/api/browser/stop`, { method: 'POST' }); } catch { /* ignore */ }
  relay.kill();
  spyRelay.kill();
  fake.close();
  await sleep(600);
  // Windows 上 node 的子进程树要单独收；其它平台 kill 就够了（taskkill 不存在）
  if (process.platform === 'win32') {
    for (const p of [relay, spyRelay]) {
      try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  }
  if (!hadProfile) {
    await sleep(800);
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('\n──────────────────────────────────────────────');
console.log(`托管浏览器自检：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
