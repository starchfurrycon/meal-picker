/**
 * 插画选择与渲染
 *
 * 插画已内联（art-data.js），file:// 直接打开也有图，且不产生任何外部请求。
 * 关键词 → 插画 id 的匹配在这里完成：先精确命中 manifest 关键词，再退化为
 * 品类 id，最后兜底 dish-default。
 *
 * 源文件在 assets/dishes/，改动后执行 node scripts/embed-art.mjs 重新内联。
 */

import { ART, ART_MANIFEST } from './art-data.js';

/** 关键词索引：word → artId（长词优先） */
const WORD_INDEX = (() => {
  const idx = new Map();
  for (const item of ART_MANIFEST) {
    for (const kw of item.keywords || []) {
      const key = String(kw).toLowerCase();
      if (!idx.has(key) || key.length > idx.get(key).word.length) {
        idx.set(key, { id: item.id, word: key });
      }
    }
    // 品类 id 也作为关键词（engine 里用 art 名匹配）
    const short = item.id.replace(/^dish-/, '');
    if (!idx.has(short)) idx.set(short, { id: item.id, word: short });
  }
  return idx;
})();

const SORTED_WORDS = Array.from(WORD_INDEX.keys()).sort((a, b) => b.length - a.length);

/**
 * 从关键词 / 品类 / 店名里挑一张插画
 * @param {{keywords?:string[], kinds?:string[], art?:string, raw?:string}} input
 * @returns {string} artId
 */
export function pickArt(input = {}) {
  // 1) 明确的 art 字段
  if (input.art) {
    const id = String(input.art).startsWith('dish-') ? String(input.art) : `dish-${input.art}`;
    if (ART[id]) return id;
  }
  // 2) 品类 id
  for (const k of input.kinds || []) {
    const id = `dish-${k}`;
    if (ART[id]) return id;
  }
  // 3) 关键词（长词优先，命中即返回）
  const hay = [
    ...(input.keywords || []),
    input.raw || '',
  ].join(' ').toLowerCase();

  for (const w of SORTED_WORDS) {
    if (w.length >= 2 && hay.includes(w)) return WORD_INDEX.get(w).id;
  }
  // 4) 单字兜底（只在没有别的线索时）
  for (const w of SORTED_WORDS) {
    if (w.length === 1 && hay.includes(w)) return WORD_INDEX.get(w).id;
  }
  return 'dish-default';
}

/** 取插画内部图形（不含 <svg> 包装） */
export function artBody(artId) {
  return ART[artId] || ART['dish-default'] || '';
}

/**
 * 渲染成可直接插入 DOM 的 <svg> 字符串
 * @param {string} artId
 * @param {{label?:string, className?:string}} opts
 */
export function artSvg(artId, { label = '', className = '' } = {}) {
  const id = ART[artId] ? artId : 'dish-default';
  const lab = label || (ART_MANIFEST.find((m) => m.id === id)?.label || '餐食');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" `
    + `aria-label="${escapeAttr(lab)}"${className ? ` class="${escapeAttr(className)}"` : ''}>`
    + artBody(id)
    + '</svg>';
}

/** 生成 data URI（用于分享图 / og:image） */
export function artDataUri(artId, label = '') {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(artSvg(artId, { label }));
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const ART_IDS = Object.keys(ART);
