#!/usr/bin/env node
/**
 * 选餐 · 本地中继服务
 *
 *   node relay/server.mjs            # 默认 127.0.0.1:8765
 *   node relay/server.mjs --port 9000
 *
 * 它同时干四件事：
 *   1. 把工具页面托管在 http://127.0.0.1:<port>/ —— 和采集器同源，
 *      绕开「https 页面不能请求 http://127.0.0.1」的混合内容限制。
 *   2. 接收用户脚本采集到的实时价格（POST /api/prices）。
 *   3. 给工具页面提供取价接口（GET /api/prices），并管理"一次采集任务"的生命周期。
 *   4. 提供采集器脚本的下载与安装引导（GET /collector.user.js、GET /install）。
 *
 * 设计取向：
 *   · 只用 Node 内置模块，零依赖 —— 用户拿到就能跑，不用 npm install。
 *   · 价格只存内存，且**每轮比价开始时整体清空**：你要的是实时价，不是缓存复用。
 *   · 只监听 127.0.0.1，不对外暴露。
 *   · 无活动 30 分钟后自动退出（可用 --keep-alive 关掉）。
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* ══════════ 参数 ══════════ */
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = Number(argOf('port', process.env.MEALPICKER_PORT || 8765));
const HOST = '127.0.0.1';
const KEEP_ALIVE = argv.includes('--keep-alive');
const IDLE_MS = 30 * 60 * 1000;
const QUIET = argv.includes('--quiet');

/* ══════════ 静态文件 ══════════ */
const WEB_ROOT = join(root, 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function safeJoin(base, target) {
  const p = normalize(join(base, target));
  if (!p.startsWith(base + sep) && p !== base) return null;
  return p;
}

/* ══════════ 内存状态 ══════════ */
/** 本轮采集：platform -> { offers, at, page, keyword } */
let priceStore = new Map();
/** 当前任务 */
let task = null;
/** 采集器最近一次心跳 */
let collectorSeenAt = 0;
let collectorInfo = null;
/** 调试用：最近收到的原始样本（便于为新平台写适配） */
const debugSamples = [];

let lastActivity = Date.now();
const touch = () => { lastActivity = Date.now(); };

/* ══════════ 工具函数 ══════════ */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ __raw: raw }); }
    });
    req.on('error', reject);
  });
}

/** 任务是否已集齐 */
function taskProgress() {
  if (!task) return null;
  const got = task.platforms.filter((p) => priceStore.has(p));
  return {
    id: task.id,
    keyword: task.keyword,
    platforms: task.platforms,
    received: got,
    missing: task.platforms.filter((p) => !priceStore.has(p)),
    done: got.length >= task.platforms.length,
    startedAt: task.startedAt,
    elapsedMs: Date.now() - task.startedAt,
  };
}

/* ══════════ 路由 ══════════ */
const server = createServer(async (req, res) => {
  touch();
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  /* ── API ── */
  try {
    if (path === '/api/health') {
      return json(res, 200, {
        ok: true,
        app: 'meal-picker-relay',
        version: '2.0.0',
        collectorSeen: collectorSeenAt ? Date.now() - collectorSeenAt : null,
        collector: collectorInfo,
        task: taskProgress(),
        platforms: Array.from(priceStore.keys()),
        now: Date.now(),
      });
    }

    // 采集器心跳 / 上报自身信息
    if (path === '/api/hello' && req.method === 'POST') {
      const body = await readBody(req);
      collectorSeenAt = Date.now();
      collectorInfo = {
        version: body.version || '?',
        ua: String(body.ua || '').slice(0, 120),
        platforms: body.platforms || [],
      };
      return json(res, 200, { ok: true, task: taskProgress() });
    }

    // 采集器拉取待办任务（工具页面打开的标签页会主动来领活）
    if (path === '/api/task' && req.method === 'GET') {
      const platform = url.searchParams.get('platform');
      const t = taskProgress();
      if (!t || t.done) return json(res, 200, { task: null });
      if (platform && !t.platforms.includes(platform)) return json(res, 200, { task: null });
      if (platform && t.received.includes(platform)) return json(res, 200, { task: null });
      return json(res, 200, { task: t });
    }

    // 工具页面：开始新一轮采集（清空上一轮，保证每次都是实时价）
    if (path === '/api/collect' && req.method === 'POST') {
      const body = await readBody(req);
      const platforms = Array.isArray(body.platforms) ? body.platforms.filter(Boolean) : [];
      const keyword = String(body.keyword || '').trim();
      if (!platforms.length || !keyword) {
        return json(res, 400, { ok: false, error: '需要 platforms 与 keyword' });
      }
      priceStore = new Map();           // ← 清空：不复用任何旧价格
      debugSamples.length = 0;
      task = {
        id: randomUUID(),
        keyword,
        platforms,
        urls: body.urls || {},
        startedAt: Date.now(),
        timeoutMs: Number(body.timeoutMs) || 45000,
      };
      return json(res, 200, { ok: true, task: taskProgress() });
    }

    // 采集器回传价格
    if (path === '/api/prices' && req.method === 'POST') {
      const body = await readBody(req);
      collectorSeenAt = Date.now();
      const platform = String(body.platform || '');
      const offers = Array.isArray(body.offers) ? body.offers : [];
      if (!platform) return json(res, 400, { ok: false, error: '缺少 platform' });

      // 只接受当前任务里点名的平台，避免页面乱逛时灌进来无关数据
      if (task && !task.platforms.includes(platform)) {
        return json(res, 200, { ok: true, ignored: true, reason: '不在本轮任务内' });
      }

      priceStore.set(platform, {
        platform,
        offers,
        keyword: body.keyword || task?.keyword || '',
        page: body.page || '',
        at: Date.now(),
        count: offers.length,
        warnings: body.warnings || [],
      });

      if (body.debug) {
        debugSamples.push({ platform, at: Date.now(), sample: body.debug });
        while (debugSamples.length > 12) debugSamples.shift();
      }

      return json(res, 200, { ok: true, progress: taskProgress() });
    }

    // 工具页面：读取已采到的价格
    if (path === '/api/prices' && req.method === 'GET') {
      const only = url.searchParams.get('platform');
      const out = {};
      for (const [k, v] of priceStore) {
        if (only && k !== only) continue;
        out[k] = v;
      }
      return json(res, 200, { ok: true, progress: taskProgress(), prices: out, now: Date.now() });
    }

    // 调试：看采集器丢进来的原始样本，方便给新平台写适配
    if (path === '/api/debug') {
      return json(res, 200, { ok: true, samples: debugSamples });
    }

    // 采集器脚本
    if (path === '/collector.user.js') {
      const p = join(root, 'collector', 'meal-picker-collector.user.js');
      if (!existsSync(p)) return json(res, 404, { ok: false, error: '找不到采集器脚本' });
      const src = readFileSync(p, 'utf8')
        .replace('__RELAY_PORT__', String(PORT));
      res.writeHead(200, {
        ...CORS,
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(src);
      return;
    }

    // 安装引导页
    if (path === '/install' || path === '/install/') {
      return serveFile(res, join(here, 'install.html'));
    }

    /* ── 静态资源 ── */
    let rel = path === '/' ? '/index.html' : path;
    // 单文件版也走中继托管
    if (rel === '/single' || rel === '/single/') {
      const p = join(root, 'dist', 'meal-picker.html');
      if (existsSync(p)) return serveFile(res, p);
    }
    const file = safeJoin(WEB_ROOT, decodeURIComponent(rel));
    if (file && existsSync(file) && statSync(file).isFile()) return serveFile(res, file);

    res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  } catch (err) {
    json(res, 500, { ok: false, error: err?.message || String(err) });
  }
});

function serveFile(res, file) {
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      ...CORS,
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

/* ══════════ 启动 ══════════ */
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。`);
    console.error(`  如果中继已经在跑，直接打开 http://${HOST}:${PORT}/ 就行。`);
    console.error(`  想换端口：node relay/server.mjs --port 8899\n`);
  } else {
    console.error('\n  启动失败：', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const base = `http://${HOST}:${PORT}`;
  if (!QUIET) {
    console.log('');
    console.log('  选餐 · 本地中继已启动');
    console.log('  ────────────────────────────────────────────');
    console.log(`  工具页面   ${base}/`);
    console.log(`  采集器安装 ${base}/install`);
    console.log(`  健康检查   ${base}/api/health`);
    console.log('');
    console.log('  这个服务只监听本机，不对外暴露；价格只存在内存里，');
    console.log('  每轮比价开始时会整体清空，不会复用旧价格。');
    console.log('');
    console.log('  按 Ctrl+C 退出。');
    console.log('');
  }
  // 自动打开浏览器（可用 --no-open 关掉）
  if (!argv.includes('--no-open')) openBrowser(base + '/');
});

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* 打不开就算了，地址已经打印出来了 */ }
}

/* 空闲自动退出 */
if (!KEEP_ALIVE) {
  const timer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_MS) {
      console.log('\n  空闲超时，中继自动退出。\n');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1500);
    }
  }, 60_000);
  timer.unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  已停止。\n');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  });
}
