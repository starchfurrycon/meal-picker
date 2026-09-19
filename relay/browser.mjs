/* ─────────────────────────────────────────────
   选餐 · 托管浏览器
   ─────────────────────────────────────────────

   目的：让用户**什么都不用装**。

   原来的流程是「装油猴 → 装采集器脚本 → 再打开工具」，对普通用户太重。
   这里改成：中继自己拉起一个浏览器实例，通过 CDP 把采集器直接注入到
   平台页面的 document_start，用户只需要在这个窗口里登录一次平台。

   为什么不用 --load-extension：
   Chrome 137 起逐步收紧，实测 Chrome 153 上 --load-extension、
   --enable-unsafe-extension-debugging、--disable-features=DisableLoadExtensionCommandLineSwitch
   全部无效（Edge 153 仍可用）。而 CDP 注入在所有 Chromium 系浏览器上都成立，
   所以这里走 CDP。

   安全说明：
   · 用独立 profile 目录（data/browser-profile），不碰用户的日常浏览器数据
   · CDP 端口只监听 127.0.0.1，且只在本次运行期间开放
   · 采集器只读页面自己请求回来的数据，不抓取、不代替登录、不绕风控
   ───────────────────────────────────────────── */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CANDIDATES = [
  { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Chrome', path: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Chrome', path: join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe') },
  { name: 'Edge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'Edge', path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'Chromium', path: '/usr/bin/google-chrome' },
  { name: 'Chromium', path: '/usr/bin/google-chrome-stable' },
  { name: 'Chromium', path: '/usr/bin/chromium' },
  { name: 'Chromium', path: '/usr/bin/chromium-browser' },
  { name: 'Chromium', path: '/snap/bin/chromium' },
  { name: 'Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { name: 'Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
];

/** 找一个可用的 Chromium 系浏览器 */
export function findBrowser() {
  for (const c of CANDIDATES) {
    if (c.path && existsSync(c.path)) return c;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 极简 CDP 客户端：浏览器级连接 + flatten 会话 ── */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
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
    this.ws.addEventListener('close', () => { this.closed = true; });
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 20000);
    });
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * 托管浏览器：拉起实例、给每个页面挂上采集器、按需导航。
 *
 *   const b = await startManagedBrowser({ profileDir, port, log });
 *   await b.open(['https://waimai.meituan.com/...', ...]);
 *   await b.stop();
 */
export async function startManagedBrowser({
  profileDir,
  port,
  log = () => {},
  collectorSource,
  headless = false,
} = {}) {
  const picked = findBrowser();
  if (!picked) {
    const e = new Error('没找到 Chromium 系浏览器（Chrome / Edge / Chromium 都可以）');
    e.code = 'NO_BROWSER';
    throw e;
  }

  // Linux 上没有图形会话时（CI、纯命令行），有头模式起不来，自动退到无头
  const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const useHeadless = headless || noDisplay;
  if (noDisplay) log('没有图形会话（DISPLAY 未设置），改用无头模式');

  const injectSource = String(collectorSource || '').replace(/__RELAY_PORT__/g, String(port));
  if (!injectSource) throw new Error('缺少采集器注入源码');

  mkdirSync(profileDir, { recursive: true });

  const dbgPort = port + 1;
  const args = [
    `--remote-debugging-port=${dbgPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    // 首屏不要每次都被"恢复上次会话"拦一下
    '--hide-crash-restore-bubble',
    '--disable-session-crashed-bubble',
  ];
  // 容器/CI 里常以 root 运行，Chrome 沙箱会直接拒绝启动
  if (process.platform === 'linux' && (process.getuid?.() === 0 || process.env.CI)) {
    args.push('--no-sandbox', '--disable-dev-shm-usage');
  }
  if (useHeadless) args.push('--headless=new', '--disable-gpu');

  log(`拉起浏览器：${picked.name}（独立配置目录，不影响你日常用的浏览器）`);
  const child = spawn(picked.path, args, { stdio: 'ignore', detached: false });

  /* 等 CDP 端口起来 */
  let version = null;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${dbgPort}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  if (!version) {
    try { child.kill(); } catch { /* ignore */ }
    const e = new Error('浏览器起来了但调试端口没响应，可能是被安全软件拦了');
    e.code = 'NO_CDP';
    throw e;
  }
  log(`浏览器已就绪：${version.Browser}`);

  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.raw('Target.setDiscoverTargets', { discover: true });

  /** targetId → 该页面会话的发送函数 */
  const sessions = new Map();
  const injected = new Set();

  async function ensureSession(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    let sessionId;
    try {
      const r = await cdp.raw('Target.attachToTarget', { targetId, flatten: true });
      sessionId = r.sessionId;
    } catch {
      return null;
    }
    const send = (method, params) => cdp.raw(method, params, sessionId);
    try {
      await send('Page.enable');
    } catch { /* 有些目标类型不支持 */ }
    sessions.set(targetId, send);
    return send;
  }

  /** 把采集器挂到某个页面：以后每次导航都在 document_start 先跑它 */
  async function injectInto(targetId) {
    if (injected.has(targetId)) return true;
    const send = await ensureSession(targetId);
    if (!send) return false;
    try {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: injectSource });
      injected.add(targetId);
      return true;
    } catch {
      return false;
    }
  }

  cdp.on('Target.targetCreated', (p) => {
    if (p.targetInfo && p.targetInfo.type === 'page') {
      injectInto(p.targetInfo.targetId).catch(() => {});
    }
  });
  cdp.on('Target.targetDestroyed', (p) => {
    if (p && p.targetId) {
      sessions.delete(p.targetId);
      injected.delete(p.targetId);
    }
  });

  /** 打开一批 URL，每个都在注入生效之后再导航 */
  async function open(urls, { focus = true } = {}) {
    const ids = [];
    for (const url of urls) {
      const { targetId } = await cdp.raw('Target.createTarget', { url: 'about:blank' });
      const ok = await injectInto(targetId);
      if (!ok) log(`⚠ 采集器没能挂到 ${url}，这个平台可能采不到`);
      const send = await ensureSession(targetId);
      if (send) {
        try { await send('Page.navigate', { url }); } catch { /* 页面自己会重试 */ }
      }
      ids.push(targetId);
    }
    // 把第一个平台页切到前台，用户好登录
    if (focus && ids.length) {
      try { await cdp.raw('Target.activateTarget', { targetId: ids[0] }); } catch { /* ignore */ }
    }
    return ids;
  }

  /** 已经开着的平台页（用于"别重复开一堆标签"） */
  async function openPages() {
    try {
      const list = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
      return list.filter((t) => t.type === 'page').map((t) => t.url);
    } catch { return []; }
  }

  async function stop() {
    try { cdp.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(300);
    // Windows 上 chrome.exe 会留子进程，兜底再杀一次
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch { /* ignore */ }
    }
  }

  return {
    browser: picked.name,
    browserPath: picked.path,
    version: version.Browser,
    debugPort: dbgPort,
    open,
    openPages,
    injectInto,
    stop,
    get alive() { return !cdp.closed && child.exitCode === null; },
  };
}

/** 读采集器注入源码（构建产物；没有就现场生成一份） */
export function readCollectorSource(collectorDir) {
  const p = join(collectorDir, 'collector-inject.js');
  if (!existsSync(p)) {
    throw new Error(`缺少 ${p}，先执行 node scripts/gen-collector.mjs`);
  }
  return readFileSync(p, 'utf8');
}

/** 记住用户上次用的浏览器路径，下次直接复用 */
export function saveBrowserChoice(file, browserPath) {
  try { writeFileSync(file, JSON.stringify({ browserPath }, null, 2), 'utf8'); } catch { /* ignore */ }
}
