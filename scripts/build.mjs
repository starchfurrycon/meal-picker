/**
 * 打包
 *
 *   node scripts/build.mjs
 *
 * 产出 dist/：
 *   meal-picker.html        单文件版 —— 双击即可离线使用（CSS/JS 全部内联）
 *   web/                    目录版 —— 可直接丢到任意静态托管 / gh-pages
 *   meal-picker-<ver>.zip   发行包 —— 解压即用
 *   SHA256SUMS.txt          校验和
 *
 * esbuild 只用于「把多模块打成单文件」，通过 npx 按需拉取，不写入项目依赖。
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
  statSync, readdirSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 自己实现递归复制。
 * Node 25 的 fs.cpSync 在「含非 ASCII 的路径 + 递归目录」下会让进程直接崩溃
 * （退出码 0xC0000409，无任何错误输出），所以这里绕开它。
 */
function copyTree(src, dest) {
  const st = statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dest, name));
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist');
const web = join(root, 'web');
const dishes = join(root, 'assets', 'dishes');
const tmp = join(root, '.build-tmp');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

const log = (m) => console.log(m);

/* ══════════ 清理 ══════════ */
rmSync(dist, { recursive: true, force: true });
rmSync(tmp, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
mkdirSync(tmp, { recursive: true });

/* ══════════ 1. 打成一个 JS ══════════ */
log('▸ 打包 JS 模块…');
const bundlePath = join(tmp, 'bundle.js');
// 用相对路径调用：项目路径里可能带空格（Windows 走 shell 时会被拆词）
const esbuildArgs = [
  '--yes', 'esbuild',
  'web/js/app.js',
  '--bundle',
  '--format=esm',
  '--target=es2020',
  '--minify',
  '--outfile=.build-tmp/bundle.js',
  '--log-level=warning',
];
try {
  // Windows 下 npx 是 .cmd，走 shell 会被 Node 警告参数未转义；
  // 这里直接定位 node 自带的 npx-cli.js，用 node 执行，彻底避开 shell。
  const npxCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const useNodeCli = existsSync(npxCli);
  const cmd = useNodeCli ? process.execPath : 'npx';
  const args = useNodeCli ? [npxCli, ...esbuildArgs] : esbuildArgs;
  const r = spawnSync(cmd, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: root,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`esbuild 退出码 ${r.status}`);
} catch (err) {
  console.error('\n打包失败。请确认能访问 npm registry（脚本会用 npx 临时拉取 esbuild）。');
  throw err;
}
const bundle = readFileSync(bundlePath, 'utf8');
log(`  JS 体积：${(bundle.length / 1024).toFixed(1)} KB（minify 后）`);

/* ══════════ 2. 单文件 HTML ══════════ */
log('▸ 生成单文件版…');
const indexHtml = readFileSync(join(web, 'index.html'), 'utf8');
const tokensCss = readFileSync(join(web, 'styles', 'tokens.css'), 'utf8');
const appCss = readFileSync(join(web, 'styles', 'app.css'), 'utf8');

let single = indexHtml
  .replace(
    '<link rel="stylesheet" href="styles/app.css" />',
    `<style>\n${tokensCss}\n${appCss}\n</style>`
  )
  .replace(
    '<script type="module" src="js/app.js"></script>',
    `<script type="module">\n${bundle}\n</script>`
  );

if (single.includes('styles/app.css') || single.includes('js/app.js')) {
  throw new Error('内联失败：HTML 里仍残留外部引用');
}
single = single.replace(
  '<title>',
  `<!-- 选餐 v${version} · 单文件离线版 · 生成于 ${new Date().toISOString()} -->\n<title>`
);

const singlePath = join(dist, 'meal-picker.html');
writeFileSync(singlePath, single, 'utf8');
log(`  单文件体积：${(statSync(singlePath).size / 1024).toFixed(1)} KB`);

/* ══════════ 3. 目录版 ══════════ */
log('▸ 复制目录版…');
copyTree(web, join(dist, 'web'));
// 插画源文件也带上：方便单独引用 / 二次创作
if (existsSync(dishes)) copyTree(dishes, join(dist, 'assets', 'dishes'));
// 预览页在发行包里没意义，去掉
rmSync(join(dist, 'assets', 'dishes', 'preview.html'), { force: true });
log('  目录版就绪');

/* ══════════ 4. 发行包 zip ══════════ */
log('▸ 生成发行包…');
const stage = join(tmp, `meal-picker-${version}`);
mkdirSync(stage, { recursive: true });
copyFileSync(singlePath, join(stage, 'meal-picker.html'));
copyTree(join(dist, 'web'), join(stage, 'web'));
for (const extra of ['README.md', 'LICENSE']) {
  const p = join(root, extra);
  if (existsSync(p)) copyFileSync(p, join(stage, extra));
}

const zipPath = join(dist, `meal-picker-${version}.zip`);
if (process.platform === 'win32') {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force`],
  { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Compress-Archive 失败');
} else {
  const r = spawnSync('zip', ['-qr', zipPath, '.'], { cwd: stage, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('zip 失败');
}
log(`  ${relative(root, zipPath)}：${(statSync(zipPath).size / 1024).toFixed(1)} KB`);

/* ══════════ 5. 校验和 ══════════ */
log('▸ 计算校验和…');
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const lines = [
  `${sha256(singlePath)}  meal-picker.html`,
  `${sha256(zipPath)}  meal-picker-${version}.zip`,
];
writeFileSync(join(dist, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8');

rmSync(tmp, { recursive: true, force: true });

/* ══════════ 汇总 ══════════ */
const walk = (dir, base = dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, base));
    else out.push({ path: relative(base, p), size: st.size });
  }
  return out;
};

log('\n✔ 打包完成，dist/ 内容：');
const files = walk(dist).sort((a, b) => a.path.localeCompare(b.path));
const sep = process.platform === 'win32' ? '\\' : '/';
const top = files.filter((f) => !f.path.startsWith('web' + sep) && !f.path.startsWith('assets' + sep));
for (const f of top) log(`   ${(f.size / 1024).toFixed(1).padStart(8)} KB  ${f.path}`);
log(`   另有 ${files.length - top.length} 个文件在 web/ 与 assets/ 下`);
