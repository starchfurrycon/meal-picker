/* ─────────────────────────────────────────────
   由 scripts/gen-collector.mjs 从 relay/platform-urls.js 复制而来。
   不要直接改这个文件 —— 改 relay/platform-urls.js 再跑 npm run collector。
   之所以复制而不是 import：线上 Pages 只发布 web/，指向 relay/ 的 import 会 404。
   ───────────────────────────────────────────── */
/**
 * 平台搜索页地址（唯一真源）
 *
 * 前端和中继都要用同一套地址：
 *   · 前端在用户自己的浏览器里打开这些页面（油猴采集器在那干活）
 *   · 中继在托管的浏览器里打开这些页面（CDP 注入采集器）
 * 两边必须一致，否则"采到的平台"和"点选的平台"会对不上。
 *
 * 注意：这里给的是各平台的**搜索页**，不是官方 API。
 * 采集器只读页面自己请求回来的数据，不抓取、不代替登录、不绕风控。
 */

export const PLATFORM_SEARCH = {
  meituan: (kw) => `https://waimai.meituan.com/search?keyword=${encodeURIComponent(kw)}`,
  eleme: (kw) => `https://www.ele.me/search?keyword=${encodeURIComponent(kw)}`,
  taobao: (kw) => `https://s.taobao.com/search?q=${encodeURIComponent(kw)}`,
  jd: (kw) => `https://search.jd.com/Search?keyword=${encodeURIComponent(kw)}`,
};

/** 某个平台的搜索页；未知平台返回空串 */
export function platformSearchUrl(platformId, keyword) {
  const fn = PLATFORM_SEARCH[platformId];
  return typeof fn === 'function' ? fn(String(keyword ?? '')) : '';
}

/** 平台 id → 中文名（中继日志用，前端另有更完整的目录） */
export const PLATFORM_LABEL = {
  meituan: '美团',
  eleme: '饿了么',
  taobao: '淘宝闪购',
  jd: '京东',
};
