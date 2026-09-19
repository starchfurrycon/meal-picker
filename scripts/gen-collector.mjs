/**
 * 生成两条交付路径共用的采集器产物（唯一真源是 collector/collector-core.js）：
 *
 *   1. collector/meal-picker-collector.user.js   —— 油猴脚本（给自带浏览器的用户）
 *   2. collector/collector-inject.js             —— 中继通过 CDP 注入的版本
 *
 * 两者内容一样，只有 __RELAY_PORT__ 的替换值不同：
 * 油猴脚本里先留占位符，由 build.mjs 落成 8765；
 * 注入版由中继在响应时替换成实际端口。
 *
 *   node scripts/gen-collector.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const collectorDir = join(root, 'collector');

const header = readFileSync(join(collectorDir, 'userscript-header.txt'), 'utf8');
const core = readFileSync(join(collectorDir, 'collector-core.js'), 'utf8');

if (!core.includes('__RELAY_PORT__')) {
  throw new Error('collector-core.js 里没有 __RELAY_PORT__ 占位符，端口替换会失效');
}

/** 注入版：中继读它、替换端口后注入到平台页面 */
const inject = [
  '/* 由 scripts/gen-collector.mjs 生成，请勿直接编辑 —— 改 collector/collector-core.js */',
  core.trim(),
  '',
  '// 中继通过 CDP 注入时，脚本直接跑在页面主世界，不需要再插 <script>',
  'window.__mealpickerMainWorld = true;',
  '__mealPickerCollectorCore();',
  '',
].join('\n');
writeFileSync(join(collectorDir, 'collector-inject.js'), inject, 'utf8');

/** 油猴脚本：头部 + 核心 + 调用 */
const userscript = `${header.trimEnd()}\n\n${core.trim()}\n\n__mealPickerCollectorCore();\n`;
writeFileSync(join(collectorDir, 'meal-picker-collector.user.js'), userscript, 'utf8');

console.log(`✔ 采集器已生成：userscript ${(userscript.length / 1024).toFixed(1)} KB，注入版 ${(inject.length / 1024).toFixed(1)} KB`);
