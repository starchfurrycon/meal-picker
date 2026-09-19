/**
 * 实时采集编排
 *
 * 一次比价的完整链路：
 *
 *   1. 探测本地中继是否在跑（http://127.0.0.1:8765）
 *   2. 向中继登记本轮任务（关键词 + 平台清单）——登记时会清空上一轮价格
 *   3. 打开各平台搜索页标签页；采集器脚本在那些页面上领活、采集、回传
 *   4. 轮询中继，拿到价格就往下走；没拿到的平台如实标注
 *
 * 关键取舍：
 *   · 不复用任何缓存价格。每次比价都是新的一轮，中继在开始时整体清空。
 *   · 采集器不在线时不去猜价格，直接告诉用户缺什么、怎么办。
 */

import { platformById } from './catalog.js';
import { normalizeBatch } from './adapters.js';

export const DEFAULT_RELAY_PORT = 8765;

/** 中继地址：允许在设置里改端口 */
export function relayBase(settings) {
  const port = Number(settings?.dataSource?.relayPort) || DEFAULT_RELAY_PORT;
  return `http://127.0.0.1:${port}`;
}

/* ══════════════ 探测 ══════════════ */

export async function probeRelay(settings, { timeoutMs = 1800 } = {}) {
  const base = relayBase(settings);
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeoutMs);
    const res = await fetch(`${base}/api/health`, { signal: c.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!res.ok) return { ok: false, base, error: `中继返回 ${res.status}` };
    const j = await res.json();
    return {
      ok: true,
      base,
      collectorSeen: j.collectorSeen,
      collector: j.collector,
      version: j.version,
    };
  } catch (err) {
    const mixed = location.protocol === 'https:';
    return {
      ok: false,
      base,
      mixedContent: mixed,
      error: err?.name === 'AbortError' ? '连接超时' : (err?.message || String(err)),
    };
  }
}

/* ══════════════ 采集 ══════════════ */

/** 某个平台该打开哪个搜索页 */
export function searchUrlFor(platformId, keyword) {
  const p = platformById(platformId);
  return p?.search ? p.search(keyword) : '';
}

/**
 * 打开各平台的搜索页，让采集器去干活。
 *
 * 必须在用户点击的调用栈里执行，否则会被弹窗拦截。
 * 返回一个 closeAll()，采集结束后可以顺手关掉这些标签页。
 */
export function openCollectorTabs(platformIds, keyword, { background = false } = {}) {
  const opened = [];
  for (const id of platformIds) {
    const url = searchUrlFor(id, keyword);
    if (!url) continue;
    try {
      const w = window.open(url, `mealpicker-${id}-${Date.now()}`, background ? 'noopener' : 'noopener,width=1180,height=820');
      if (w) opened.push(w);
    } catch { /* 被拦截就算了，用户手动打开也一样能采 */ }
  }
  return {
    count: opened.length,
    closeAll() {
      for (const w of opened) { try { w.close(); } catch { /* ignore */ } }
    },
  };
}

/**
 * 完整采集一轮。
 *
 * @param {object} o
 * @param {string} o.keyword
 * @param {string[]} o.platforms      需要实时采集的平台
 * @param {object} o.settings
 * @param {(msg:string, pct:number)=>void} [o.onProgress]
 * @param {()=>boolean} [o.isCancelled]
 * @returns {Promise<{offers:Array, notes:Array, collected:object, missing:string[]}>}
 */
export async function collectRealtime({
  keyword,
  platforms,
  settings,
  onProgress = () => {},
  isCancelled = () => false,
  timeoutMs = 45000,
}) {
  const base = relayBase(settings);
  const notes = [];
  const offers = [];

  if (!platforms.length) return { offers, notes, collected: {}, missing: [] };

  /* 1. 登记任务（顺带清空上一轮） */
  let task = null;
  try {
    const res = await fetch(`${base}/api/collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword,
        platforms,
        timeoutMs,
        urls: Object.fromEntries(platforms.map((id) => [id, searchUrlFor(id, keyword)])),
      }),
    });
    if (!res.ok) throw new Error(`中继返回 ${res.status}`);
    const j = await res.json();
    task = j.task;
  } catch (err) {
    for (const id of platforms) {
      notes.push({ platform: id, source: 'realtime', count: 0, error: '中继不可用' });
    }
    return { offers, notes, collected: {}, missing: platforms, relayError: err?.message || String(err) };
  }

  onProgress(`已登记本轮比价，等待 ${platforms.length} 个平台回传实时价格`, 8);

  /* 2. 轮询取价 */
  const collected = {};
  const started = Date.now();
  let lastCount = -1;

  while (Date.now() - started < timeoutMs) {
    if (isCancelled()) {
      return { offers, notes, collected, missing: platforms.filter((p) => !collected[p]), cancelled: true };
    }

    await new Promise((r) => setTimeout(r, 900));

    let snap;
    try {
      const res = await fetch(`${base}/api/prices`, { cache: 'no-store' });
      if (!res.ok) continue;
      snap = await res.json();
    } catch { continue; }

    const got = snap.prices || {};
    for (const [id, rec] of Object.entries(got)) {
      if (!collected[id] || rec.at > collected[id].at) collected[id] = rec;
    }

    const n = Object.keys(collected).length;
    if (n !== lastCount) {
      lastCount = n;
      const names = Object.keys(collected).map((id) => platformById(id)?.name || id).join(' · ');
      onProgress(`已收到 ${n}/${platforms.length} 个平台的实时价格　${names}`, 8 + (n / platforms.length) * 60);
    }
    if (n >= platforms.length) break;
  }

  /* 3. 整理 */
  const missing = [];
  for (const id of platforms) {
    const rec = collected[id];
    if (!rec) { missing.push(id); continue; }
    if (!rec.offers || !rec.offers.length) {
      missing.push(id);
      notes.push({
        platform: id,
        source: 'realtime',
        count: 0,
        error: rec.warnings?.[0] || '页面上没读到价格（可能未登录，或还没加载出结果）',
        page: rec.page,
      });
      continue;
    }
    const list = normalizeBatch(rec.offers.map((o) => ({ ...o, source: 'realtime' })), id);
    offers.push(...list);
    notes.push({
      platform: id,
      source: 'realtime',
      count: list.length,
      at: rec.at,
      ageMs: Date.now() - rec.at,
      page: rec.page,
    });
  }
  for (const id of missing) {
    if (!notes.some((n) => n.platform === id)) {
      notes.push({
        platform: id,
        source: 'realtime',
        count: 0,
        error: '没等到这个平台回传数据（标签页可能没打开，或页面还没加载完）',
      });
    }
  }

  return { offers, notes, collected, missing };
}
