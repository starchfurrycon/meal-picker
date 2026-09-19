/**
 * 把 assets/dishes 下的插画**内联**进 web/js/art-data.js
 *
 * 为什么要内联：零构建单页工具要支持直接双击（file://）打开，
 * 而 file:// 下 fetch 本地文件会被浏览器拦截。内联后：
 *   - file:// 直接打开 = 有插画
 *   - 离线使用 = 有插画
 *   - 零外部请求
 *
 * 用法： node scripts/embed-art.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const srcDir = join(root, 'assets', 'dishes');
const outFile = join(root, 'web', 'js', 'art-data.js');

const manifest = JSON.parse(readFileSync(join(srcDir, 'manifest.json'), 'utf8'));

/** 去掉根 <svg> 包装，只留内部图形，并统一规范空白 */
function inner(svgText) {
  const m = svgText.match(/<svg[^>]*>([\s\S]*)<\/svg>\s*$/);
  if (!m) throw new Error('无法解析 SVG');
  return m[1]
    .replace(/\s*\n\s*/g, '')
    .replace(/>\s+</g, '><')
    .trim();
}

const files = readdirSync(srcDir).filter((f) => /^dish-.*\.svg$/.test(f));
const art = {};
for (const f of files) {
  const id = f.replace(/\.svg$/, '');
  art[id] = inner(readFileSync(join(srcDir, f), 'utf8'));
}

const missing = manifest.filter((m) => !art[m.id]);
if (missing.length) throw new Error('缺少插画文件：' + missing.map((m) => m.id).join(', '));

const body = `/**
 * 自动生成，请勿手改。
 * 源文件：assets/dishes/*.svg
 * 重新生成：node scripts/embed-art.mjs
 *
 * 插画统一风格：200×200 画布、#FFF4E6 光晕 + #F0DFC8 底座 + 扁平色块，
 * 全部 stroke="#4A3B2E" stroke-width="4"，与界面设计令牌同一套色板。
 */

export const ART = ${JSON.stringify(art, null, 2)};

export const ART_MANIFEST = ${JSON.stringify(manifest, null, 2)};
`;

writeFileSync(outFile, body, 'utf8');
console.log(`✔ 已内联 ${Object.keys(art).length} 张插画 → web/js/art-data.js (${body.length} 字节)`);
