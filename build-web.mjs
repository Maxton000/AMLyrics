/**
 * 构建 AMLL 前端（原封不动使用 homo-lyrics-master/web 的 React + AMLL 组件）
 * 输出到 renderer/，供 Electron 本地加载。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, 'renderer/src');
const outDir = path.join(__dirname, 'renderer');

fs.mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [path.join(srcDir, 'index.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  outfile: path.join(outDir, 'amll.bundle.js'),
  define: {
    'process.env.NODE_ENV': '"production"'
  },
  loader: {
    '.png': 'dataurl',
    '.svg': 'dataurl',
    '.woff2': 'file',
    '.woff': 'file',
    '.ttf': 'file',
    '.eot': 'file'
  },
  logLevel: 'info'
});

fs.copyFileSync(path.join(srcDir, 'index.html'), path.join(outDir, 'index.html'));

console.log('[build-web] renderer bundle ready at', outDir);
