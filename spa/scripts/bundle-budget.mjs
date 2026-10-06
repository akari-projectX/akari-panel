#!/usr/bin/env node
/*
 * 产物体积预算（CI 必跑）。读 dist/.vite/manifest.json 与 dist/index.html：
 *   · initialJs  = 入口 + 它的全部静态 import（首屏必下的 JS），按 gzip 计；
 *   · initialCss = index.html 里 <link rel="stylesheet"> 的样式表（挡首帧），gzip；
 *   · totalJs / totalCss = dist/assets 下全部 .js / .css 的 gzip 之和（含按需加载的分包、字体声明）；
 *   · fonts = 全部 .woff2 的原始字节（已压缩，不再 gzip；按 unicode-range 用到哪片才下载哪片）。
 * 超出预算即非零退出。`--report` 只打印不判定（测基线用）。
 * 预算的来源与调整规则见 README「体积预算」。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const DIST = 'dist';
const KB = 1024;
/* 单位 KiB。调高前先看清楚是谁变大了（vite build 的输出表 + 本脚本的明细） */
const BUDGET = {
  initialJs: 145,
  initialCss: 30,
  totalJs: 440,
  totalCss: 40,
  fonts: 1450,
};

const gz = (file) => gzipSync(readFileSync(file), { level: 9 }).length;
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

const manifest = JSON.parse(readFileSync(join(DIST, '.vite', 'manifest.json'), 'utf8'));
const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry);
if (!entryKey) throw new Error('no entry in manifest');

const initial = new Set();
const visit = (key) => {
  const c = manifest[key];
  if (!c || initial.has(c.file)) return;
  initial.add(c.file);
  (c.imports ?? []).forEach(visit);
};
visit(entryKey);

const assets = walk(join(DIST, 'assets'));
const sum = (files) => files.reduce((n, f) => n + gz(f), 0);
const initialJs = sum([...initial].filter((f) => f.endsWith('.js')).map((f) => join(DIST, f)));
const totalJs = sum(assets.filter((f) => f.endsWith('.js')));
const totalCss = sum(assets.filter((f) => f.endsWith('.css')));
const fonts = assets.filter((f) => f.endsWith('.woff2')).reduce((n, f) => n + statSync(f).size, 0);
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const linkedCss = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"]+)"/g)].map((m) => join(DIST, m[1]));
const initialCss = sum(linkedCss);

const actual = { initialJs, initialCss, totalJs, totalCss, fonts };
const report = process.argv.includes('--report');
let failed = false;
console.log('initial chunks:', [...initial].join(', '));
for (const [k, v] of Object.entries(actual)) {
  const kib = v / KB;
  const over = kib > BUDGET[k];
  if (over && !report) failed = true;
  console.log(`${over ? 'OVER' : 'ok  '} ${k.padEnd(10)} ${kib.toFixed(1).padStart(8)} KiB  (budget ${BUDGET[k]} KiB${k === 'fonts' ? ', raw' : ', gzip'})`);
}
if (failed) {
  console.error('bundle budget exceeded');
  process.exit(1);
}
