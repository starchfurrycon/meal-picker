/**
 * 线上页面走一遍真实用户路径：首页 → 输入 → 过场 → 结果/错误页，
 * 每一步都记录几何信息，找出"看起来崩了"到底崩在哪。
 *
 *   node scripts/diagnose.mjs [url]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] || 'https://starchfurrycon.github.io/meal-picker/';
const W = Number(process.argv[3] || 430);
const H = Number(process.argv[4] || 932);

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const bin = BROWSERS.find((p) => existsSync(p));
if (!bin) { console.log('没有浏览器'); process.exit(0); }

const PORT = 10600 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'mp-diag-'));
const chrome = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', `--window-size=${W},${H}`,
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const errs = [];
const failed = [];
let cdp;

/** 描述当前屏：每个可见子元素的盒子，以及溢出情况 */
const SNAP = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const visible = (n) => {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (n, depth) => {
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    const overflowX = r.right > vw + 1 || r.left < -1;
    return {
      tag: n.tagName.toLowerCase(),
      id: n.id || '',
      cls: (n.className && typeof n.className === 'string') ? n.className : '',
      w: Math.round(r.width), h: Math.round(r.height),
      x: Math.round(r.x), y: Math.round(r.y),
      pos: cs.position, disp: cs.display, op: cs.opacity,
      overflowX,
      text: (n.children.length === 0 ? (n.textContent || '').trim().slice(0, 40) : ''),
    };
  };
  const view = document.querySelector('.view.is-on');
  const out = { view: document.body.dataset.view, vw, vh, docW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight, nodes: [], overflowers: [] };
  // 设计令牌是否真的生效（v2.0.0 的 Pages 版漏了 tokens.css，全靠这一项才看得出来）
  const probe = ['--s-5', '--s-6', '--surface', '--line-strong', '--c-orange', '--font', '--r-pill', '--bg', '--text'];
  const rootCS = getComputedStyle(document.documentElement);
  const bodyCS = getComputedStyle(document.body);
  out.tokens = probe.map((k) => ({ k, v: rootCS.getPropertyValue(k).trim() }));
  out.bodyStyle = { margin: bodyCS.margin, overflow: bodyCS.overflow, background: bodyCS.backgroundColor, font: bodyCS.fontFamily.slice(0, 40) };
  out.tokenMissing = out.tokens.filter((t) => !t.v).map((t) => t.k);
  // 定位祖先：找出 .home-foot 这类 absolute 元素的包含块到底是谁
  const foot = document.querySelector('.home-foot');
  if (foot) {
    const chain = [];
    let n = foot.parentElement;
    while (n) {
      const cs = getComputedStyle(n);
      const name = n.tagName.toLowerCase()
        + (n.id ? '#' + n.id : '')
        + ((n.className && typeof n.className === 'string') ? '.' + n.className.trim().split(/\\s+/).join('.') : '');
      chain.push(name + ' pos=' + cs.position + ' h=' + Math.round(n.getBoundingClientRect().height) + ' y=' + Math.round(n.getBoundingClientRect().y));
      n = n.parentElement;
    }
    const fr = foot.getBoundingClientRect();
    out.foot = {
      rect: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) },
      bottom: getComputedStyle(foot).bottom,
      left: getComputedStyle(foot).left,
      right: getComputedStyle(foot).right,
      chain,
    };
  }
  if (!view) return JSON.stringify(out);
  const walk = (n, depth) => {
    if (depth > 3) return;
    for (const c of n.children) {
      if (!visible(c)) continue;
      const d = describe(c, depth);
      out.nodes.push(d);
      if (d.overflowX) out.overflowers.push(d);
      walk(c, depth + 1);
    }
  };
  walk(view, 0);
  // 全局找横向溢出
  for (const n of document.querySelectorAll('body *')) {
    if (!visible(n)) continue;
    const r = n.getBoundingClientRect();
    if (r.right > vw + 2 || r.left < -2) {
      out.overflowers.push({ ...describe(n), reason: r.right > vw ? 'right' : 'left' });
    }
  }
  return JSON.stringify(out);
})()`;

function print(label, json) {
  const o = JSON.parse(json);
  console.log(`\n──── ${label} ────`);
  console.log(`view=${o.view}  视口 ${o.vw}×${o.vh}  文档 ${o.docW}×${o.docH}`);
  console.log(`  body: margin=${o.bodyStyle.margin} overflow=${o.bodyStyle.overflow} bg=${o.bodyStyle.background} font=${o.bodyStyle.font}`);
  if (o.tokenMissing.length) {
    console.log(`  ⚠ 设计令牌没生效（共 ${o.tokenMissing.length} 个）：${o.tokenMissing.join(' ')}`);
  } else {
    console.log('  ✓ 设计令牌齐全');
  }
  if (o.foot) {
    console.log(`  .home-foot rect=${JSON.stringify(o.foot.rect)} bottom=${o.foot.bottom} left=${o.foot.left} right=${o.foot.right}`);
    console.log('  定位祖先链：');
    for (const c of o.foot.chain) console.log('    ' + c);
  }
  for (const n of o.nodes) {
    const id = n.id ? '#' + n.id : '';
    const cls = n.cls ? '.' + n.cls.trim().split(/\s+/).join('.') : '';
    console.log(`  ${(n.tag + id + cls).padEnd(42)} ${String(n.w).padStart(4)}×${String(n.h).padStart(4)} @(${String(n.x).padStart(4)},${String(n.y).padStart(4)}) ${n.disp}/${n.pos}${n.overflowX ? '  ←横向溢出' : ''}${n.text ? '  「' + n.text + '」' : ''}`);
  }
  if (o.overflowers.length) {
    console.log('  ⚠ 横向溢出元素：');
    const seen = new Set();
    for (const n of o.overflowers) {
      const k = n.tag + n.id + n.cls;
      if (seen.has(k)) continue;
      seen.add(k);
      console.log(`     ${(n.tag + (n.id ? '#' + n.id : '') + (n.cls ? '.' + n.cls.trim().split(/\s+/).join('.') : '')).padEnd(40)} w=${n.w} x=${n.x} right=${n.x + n.w} (视口 ${o.vw})`);
    }
  } else {
    console.log('  ✓ 没有横向溢出');
  }
}

try {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch { /* 等 */ }
    await sleep(150);
  }
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = new CDP(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.ready();
  cdp.on('Runtime.exceptionThrown', (p) => errs.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text));
  cdp.on('Network.loadingFailed', (p) => failed.push(`${p.type} ${p.errorText}`));
  cdp.on('Network.responseReceived', (p) => { if (p.response.status >= 400) failed.push(`HTTP ${p.response.status} ${p.response.url}`); });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  console.log(`打开：${URL_}  （窗口 ${W}×${H}）`);
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(4500);
  print('首页', await cdp.eval(SNAP));

  await cdp.eval(`(() => {
    const i = document.querySelector('#ask-input');
    i.value = '想吃点辣的，一个人，四十以内';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#ask-form').requestSubmit();
    return true;
  })()`);
  await sleep(900);
  print('过场', await cdp.eval(SNAP));

  await sleep(6000);
  print('结果', await cdp.eval(SNAP));

  const extra = await cdp.eval(`JSON.stringify({
    view: document.body.dataset.view,
    card: !!document.querySelector('.card'),
    empty: !!document.querySelector('.empty'),
    emptyText: document.querySelector('.empty')?.innerText || '',
    thinkMeta: document.querySelector('#think-meta')?.textContent || '',
    resultNote: document.querySelector('.result__note')?.innerText || '',
    toast: document.querySelector('.toast')?.innerText || '',
  })`);
  const o = JSON.parse(extra);
  console.log('\n结果页内容：');
  console.log('  card  :', o.card);
  console.log('  empty :', o.empty);
  if (o.emptyText) console.log('  emptyText:\n' + o.emptyText.split('\n').map((l) => '    ' + l).join('\n'));
  if (o.resultNote) console.log('  resultNote:\n' + o.resultNote.split('\n').map((l) => '    ' + l).join('\n'));

  if (errs.length) { console.log('\n页面异常：'); for (const e of errs) console.log('  ' + e); }
  if (failed.length) { console.log('\n请求失败：'); for (const e of [...new Set(failed)]) console.log('  ' + e); }
} catch (e) {
  console.error('体检失败：', e);
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
