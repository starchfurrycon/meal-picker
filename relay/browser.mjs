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

   ── 为什么价格不通过 fetch 回传 ──

   平台页是 https，中继是 http://127.0.0.1，实测在真实平台页上：

     Access to fetch at 'http://127.0.0.1:PORT/api/health' from origin
     'https://waimai.meituan.com' has been blocked by CORS policy:
     Permission was denied for this request to access the `loopback` address

   这是 Chrome 的 Private Network Access：https 公网页面默认不允许访问回环地址，
   采集器就算读到了价格也发不出来。所以托管模式改用 CDP 的 Runtime.addBinding ——
   页面调用一个由调试器注入的函数，数据走 DevTools 通道回到中继，
   完全不经过网络栈，因此不受 CORS / PNA / 混合内容 / 页面 CSP 的任何限制。

   复现：node scripts/probe-relay-from-platform.mjs
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

/** 采集器通过它把价格交回中继（CDP binding 名，采集器源码里也用同一个常量） */
export const BINDING_NAME = '__mealPickerRelay';

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
  /** 采集器通过 CDP binding 回传数据时的回调：(payload, meta) => void */
  onCollect = null,
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

  const baseSource = String(collectorSource || '').replace(/__RELAY_PORT__/g, String(port));
  if (!baseSource) throw new Error('缺少采集器注入源码');

  /**
   * 每个页面注入时都把这一轮的搜索任务写进去。
   * 为什么不用 /api/task 去拉：托管模式下页面是 https，拉不动 http://127.0.0.1
   * （见文件头关于 Private Network Access 的说明），所以任务得在注入时就带下去。
   *
   * 注意 activeTask 是模块级的：Target.createTarget 会先触发 targetCreated，
   * 那时候注入就已经发生了。所以任务必须在 createTarget 之前就设好，
   * 否则先挂上的那份脚本里没有任务，采集器会空等。
   */
  let activeTask = null;
  function buildInjectSource(task = activeTask) {
    const baked = task ? {
      keyword: task.keyword || '',
      platforms: task.platforms || [],
      timeoutMs: task.timeoutMs || 20000,
    } : null;
    return `window.__mealPickerTask = ${JSON.stringify(baked)};\n${baseSource}`;
  }

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
  /** sessionId → targetId，回传时要认得出是哪个平台页 */
  const sessionTargets = new Map();
  /** targetId → 该页面的 URL（页面自己会跳转，靠事件跟一下） */
  const targetUrls = new Map();
  /** 回传通道是否建立成功（诊断用） */
  let bindingOk = 0;
  let bindingFail = null;

  async function ensureSession(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    let sessionId;
    try {
      const r = await cdp.raw('Target.attachToTarget', { targetId, flatten: true });
      sessionId = r.sessionId;
    } catch {
      return null;
    }
    sessionTargets.set(sessionId, targetId);
    const send = (method, params) => cdp.raw(method, params, sessionId);
    try {
      await send('Page.enable');
    } catch { /* 有些目标类型不支持 */ }
    try {
      // Runtime 域开着才会把 bindingCalled 事件发过来
      await send('Runtime.enable');
      // 采集器回传价格的通道。页面调用 window.__mealPickerRelay(payload)，
      // 数据走 DevTools 通道回到这里 —— 不经过网络，所以不受
      // CORS / Private Network Access / 混合内容 / 页面 CSP 影响。
      await send('Runtime.addBinding', { name: BINDING_NAME });
      bindingOk++;
    } catch (e) {
      // 老版本浏览器可能不支持；采集器会退回 fetch（只在本机 http 页面上有效）
      bindingFail = e.message;
      log(`⚠ 回传通道没能建立（${e.message}），托管模式下可能收不到价格`);
    }
    sessions.set(targetId, send);
    return send;
  }

  /**
   * 把采集器挂到某个页面：以后每次导航都在 document_start 先跑它。
   *
   * 关键：`targetCreated` 事件里挂的那一次，脚本里还没有任务
   * （那时 open() 还没来得及设 activeTask）。所以这里不按 target 去重，
   * 而是每次都追加一份带当前任务的脚本 —— addScriptToEvaluateOnNewDocument
   * 是"以后每次导航都跑"，后加的那份会覆盖先加的，顺序正好。
   */
  const injectedTask = new Map();
  async function injectInto(targetId, task = activeTask) {
    const send = await ensureSession(targetId);
    if (!send) return false;
    const stamp = task ? `${task.keyword}|${(task.platforms || []).join(',')}` : '';
    if (injectedTask.get(targetId) === stamp) return true;   // 同一轮已经挂过
    try {
      await send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectSource(task) });
      injectedTask.set(targetId, stamp);
      return true;
    } catch {
      return false;
    }
  }

  cdp.on('Target.targetCreated', (p) => {
    if (p.targetInfo && p.targetInfo.type === 'page') {
      targetUrls.set(p.targetInfo.targetId, p.targetInfo.url || '');
      injectInto(p.targetInfo.targetId).catch(() => {});
    }
  });
  cdp.on('Target.targetInfoChanged', (p) => {
    if (p.targetInfo) targetUrls.set(p.targetInfo.targetId, p.targetInfo.url || '');
  });
  cdp.on('Target.targetDestroyed', (p) => {
    if (p && p.targetId) {
      sessions.delete(p.targetId);
      injectedTask.delete(p.targetId);
      targetUrls.delete(p.targetId);
      for (const [sid, tid] of sessionTargets) if (tid === p.targetId) sessionTargets.delete(sid);
    }
  });

  /* 采集器回传：bindingCalled 里带着平台页塞进来的 JSON */
  cdp.on('Runtime.bindingCalled', (p, sessionId) => {
    if (!p || p.name !== BINDING_NAME) return;
    let payload;
    try { payload = JSON.parse(p.payload); } catch { return; }
    const targetId = sessionTargets.get(sessionId);
    if (onCollect) {
      try { onCollect(payload, { targetId, url: targetUrls.get(targetId) || '' }); } catch { /* ignore */ }
    }
  });

  /**
   * 打开一批 URL，每个都在注入生效之后再导航。
   *
   * 已经开着的同域名页面会被复用（只是换个搜索词重新导航）——
   * 这样第二轮、第三轮比价不会攒出一堆标签页，登录态也一直在。
   */
  async function open(urls, { focus = true, task = null } = {}) {
    // 必须在 createTarget 之前设好：targetCreated 事件一到，注入就发生了
    activeTask = task;
    const ids = [];
    for (const url of urls) {
      let host = '';
      try { host = new URL(url).host; } catch { /* 用不上 */ }

      // 找找有没有已经开着的同站页面
      let targetId = null;
      if (host) {
        for (const [tid, u] of targetUrls) {
          try { if (u && new URL(u).host === host && !ids.includes(tid)) { targetId = tid; break; } } catch { /* ignore */ }
        }
      }

      if (targetId) {
        // 复用：先挂上新任务的注入脚本，再导航过去（导航会重新跑一遍采集器）
        const send = await ensureSession(targetId);
        if (send) {
          try { await send('Page.addScriptToEvaluateOnNewDocument', { source: buildInjectSource(task) }); } catch { /* ignore */ }
          try { await send('Page.navigate', { url }); } catch { /* ignore */ }
          ids.push(targetId);
          continue;
        }
      }

      const created = await cdp.raw('Target.createTarget', { url: 'about:blank' });
      targetId = created.targetId;
      const ok = await injectInto(targetId, task);
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
    /** 回传通道状态，诊断用 */
    get binding() { return { ok: bindingOk, fail: bindingFail }; },
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
