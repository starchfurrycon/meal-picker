/**
 * 实时数据可行性侦察
 *
 *   node scripts/probe-realtime.mjs
 *
 * 目的：在真实浏览器里，用「无登录态」的干净会话，去探各平台网页版搜索页与
 *      常见接口路径的可达性，把「能不能拿实时价」这个问题用事实回答，而不是猜。
 *
 * 注意：这里只做**只读探测**（GET/HEAD 看状态码与内容类型），不抓数据、不模拟下单、
 *      不绕过任何风控。探测结果只用于判断技术路径是否成立。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
];
const bin = BROWSERS.find((p) => existsSync(p));
if (!bin) { console.log('跳过：没有找到 Chrome'); process.exit(0); }

const PORT = 10500 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'mealpicker-probe-'));
const chrome = spawn(bin, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(t = 15000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch { /* 等 */ }
    await sleep(150);
  }
  throw new Error('DevTools 没起来');
}

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 30000);
    });
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

/* 探测目标：网页版入口 + 常见搜索接口路径 */
const PAGES = [
  { id: 'meituan', name: '美团外卖网页版', url: 'https://waimai.meituan.com/' },
  { id: 'eleme', name: '饿了么网页版', url: 'https://www.ele.me/' },
  { id: 'jd', name: '京东', url: 'https://www.jd.com/' },
  { id: 'taobao', name: '淘宝', url: 'https://www.taobao.com/' },
];

/* 每个平台：先导航到它自己的页面（同源），再在该页面上试调它的接口。
   这样 CORS 不再是变量，剩下的纯粹是「服务端认不认你」。 */
const ORIGIN_TESTS = [
  {
    platform: 'meituan',
    page: 'https://waimai.meituan.com/',
    apis: [
      { name: '外卖搜索 poi/food', url: 'https://wx.waimai.meituan.com/weapp/v1/poi/food?keyword=%E9%9D%A2&page_index=0' },
      { name: 'H5 首页', url: 'https://i.waimai.meituan.com/openh5/homepage?keyword=%E9%9D%A2' },
      { name: '外卖搜索(带地域)', url: 'https://waimai.meituan.com/api/v1/poi/search?keyword=%E9%9D%A2' },
    ],
  },
  {
    platform: 'eleme',
    page: 'https://www.ele.me/',
    apis: [
      { name: 'restapi 搜索 v3', url: 'https://h5.ele.me/restapi/shopping/v3/restaurants/search?keyword=%E9%9D%A2&latitude=39.9&longitude=116.4' },
      { name: 'restapi 搜索 v2', url: 'https://www.ele.me/restapi/shopping/v2/restaurants/search?keyword=%E9%9D%A2&latitude=39.9&longitude=116.4' },
    ],
  },
  {
    platform: 'jd',
    page: 'https://www.jd.com/',
    apis: [
      { name: 'api.m.jd.com search', url: 'https://api.m.jd.com/client.action?functionId=search&keyword=%E9%9D%A2' },
      { name: '秒送搜索', url: 'https://api.m.jd.com/api?appid=jd-cphdeveloper-m&functionId=deliverySearch&keyword=%E9%9D%A2' },
    ],
  },
  {
    platform: 'taobao',
    page: 'https://www.taobao.com/',
    apis: [
      { name: 'mtop 闪购搜索', url: 'https://h5api.m.taobao.com/h5/mtop.taobao.wsearch.h5search/1.0/?q=%E9%9D%A2' },
      { name: 'mtop 推荐', url: 'https://h5api.m.taobao.com/h5/mtop.relationrecommend.wirelessrecommend.recommend/2.0/?q=%E9%9D%A2' },
    ],
  },
];

let cdp;
try {
  await waitForDevtools();
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  cdp = new CDP(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  console.log('浏览器：' + bin);
  console.log('\n══ 一、网页版入口可达性（无登录态） ══\n');

  for (const p of PAGES) {
    const res = await cdp.eval(`(async () => {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 15000);
        const r = await fetch(${JSON.stringify(p.url)}, { signal: c.signal, redirect: 'follow' });
        clearTimeout(t);
        const text = await r.text();
        return JSON.stringify({
          ok: true, status: r.status, type: r.headers.get('content-type') || '',
          finalUrl: r.url, bytes: text.length,
          title: (text.match(/<title[^>]*>([^<]*)<\\/title>/i) || [])[1] || '',
          looksLikeApp: /app|__NEXT_DATA__|window\\.__|vue|react/i.test(text)
        });
      } catch (e) { return JSON.stringify({ ok: false, error: e.name + ': ' + e.message }); }
    })()`);
    const r = JSON.parse(res);
    if (r.ok) {
      console.log(`  ${p.name.padEnd(18)} HTTP ${r.status}  ${(r.bytes / 1024).toFixed(0)}KB  ${r.type.split(';')[0]}`);
      console.log(`  ${''.padEnd(18)} 标题「${r.title}」  最终地址 ${r.finalUrl}`);
    } else {
      console.log(`  ${p.name.padEnd(18)} ✗ ${r.error}`);
    }
  }

  console.log('\n══ 二、在各平台自己的页面上调用它的接口（同源，排除 CORS 干扰） ══');

  for (const t of ORIGIN_TESTS) {
    console.log(`\n── ${t.platform} ──`);
    // 先导航到平台自己的页面
    try {
      await cdp.send('Page.navigate', { url: t.page });
      await sleep(2500);
      const title = await cdp.eval('document.title');
      const origin = await cdp.eval('location.origin');
      console.log(`  页面: ${origin}  标题「${title}」`);
    } catch (e) {
      console.log(`  页面导航失败: ${e.message}`);
    }

    for (const a of t.apis) {
      const res = await cdp.eval(`(async () => {
        try {
          const c = new AbortController();
          const tm = setTimeout(() => c.abort(), 12000);
          const r = await fetch(${JSON.stringify(a.url)}, { signal: tm.signal, credentials: 'include' });
          clearTimeout(tm);
          const text = await r.text();
          let kind = 'other';
          try { JSON.parse(text); kind = 'json'; } catch { kind = /<html/i.test(text) ? 'html' : 'text'; }
          return JSON.stringify({
            ok: true, status: r.status, kind, bytes: text.length,
            head: text.slice(0, 200).replace(/\\s+/g, ' ')
          });
        } catch (e) { return JSON.stringify({ ok: false, error: e.name + ': ' + e.message }); }
      })()`);
      const r = JSON.parse(res);
      if (r.ok) {
        const flag = r.kind === 'json' && r.status === 200 ? '  ← 返回 JSON' : '';
        console.log(`  ${a.name.padEnd(20)} HTTP ${r.status} ${r.kind.padEnd(5)} ${(r.bytes / 1024).toFixed(1)}KB${flag}`);
        console.log(`  ${''.padEnd(20)} ${r.head.slice(0, 150)}`);
      } else {
        console.log(`  ${a.name.padEnd(20)} ✗ ${r.error}`);
      }
    }
  }

  console.log('\n══ 三、结论要点 ══');
  console.log('  · 无登录态 + 无签名的直连请求，能否返回结构化 JSON，直接决定「纯前端直连」是否成立');
  console.log('  · 页面可达 ≠ 接口可调：SPA 外壳返回 200，但内部接口通常需要 Cookie/签名/风控令牌');
  console.log('  · 若接口一律 401/403/签名错误，则唯一可行路径是「在用户自己的浏览器里、用用户的登录态采集」');
} catch (e) {
  console.error('探测失败：', e);
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
