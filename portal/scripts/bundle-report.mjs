#!/usr/bin/env node
/*
 * 产物体积报告（只报告，不判定，永远退出 0；2026-10-07 用户裁决取消硬性体积预算）。
 * 读 dist/app/.vite/manifest.json 与 dist/app/index.html：
 *   · initialJs  = 入口 + 它的全部静态 import（首屏必下的 JS），gzip；
 *   · initialCss = index.html 里 <link rel="stylesheet"> 的样式表，gzip；
 *   · totalJs / totalCss = dist/app/assets 下全部 .js / .css 的 gzip 之和；
 *   · fonts = 全部 .woff2 的原始字节（按 unicode-range 用到哪片才下载哪片）。
 * 另列每个 JS / CSS 分包（按清单里的源文件名归并，内容哈希不影响对比）。
 *
 *   node scripts/bundle-report.mjs [dist] [--json out.json] [--base base.json] [--markdown out.md]
 *
 * --base 给出另一次构建（如 main）的 --json 结果时，输出带差值；CI 把 Markdown 写进任务摘要。
 * 衡量体验以真实性能指标为准（e2e/perf.spec.ts：首屏可交互、LCP、切页耗时）。
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { gzipSync } from 'node:zlib';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const DIST = args[0] && !args[0].startsWith('--') ? args[0] : 'dist/app';
const KB = 1024;

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

/* 分包的稳定名字：清单里的源（src/pages/dash/shop.tsx）或分包名（vendor-react）；没有就去掉文件名里的哈希 */
const nameOf = new Map();
const cwd = `${process.cwd()}/`;
for (const [key, c] of Object.entries(manifest)) {
  const n = (c.src ?? (c.name ? `[${c.name}]` : key)).replace(cwd, '');
  nameOf.set(c.file, n);
  for (const css of c.css ?? []) if (!nameOf.has(css)) nameOf.set(css, `${n} (css)`);
}
const stable = (rel) => nameOf.get(rel) ?? basename(rel).replace(/-[\w-]{8}(?=\.\w+$)/, '');

const assets = walk(join(DIST, 'assets'));
const rel = (f) => f.slice(DIST.length + 1);
const chunks = {};
for (const f of assets.filter((f) => /\.(js|css)$/.test(f))) {
  const r = rel(f);
  const k = stable(r);
  chunks[k] = (chunks[k] ?? 0) + gz(f);
}
const sum = (files) => files.reduce((n, f) => n + gz(f), 0);
const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const linkedCss = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\/([^"]+)"/g)].map((m) => join(DIST, m[1]));
const totals = {
  initialJs: sum([...initial].filter((f) => f.endsWith('.js')).map((f) => join(DIST, f))),
  initialCss: sum(linkedCss),
  totalJs: sum(assets.filter((f) => f.endsWith('.js'))),
  totalCss: sum(assets.filter((f) => f.endsWith('.css'))),
  fonts: assets.filter((f) => f.endsWith('.woff2')).reduce((n, f) => n + statSync(f).size, 0),
};
const result = { totals, chunks, initial: [...[...initial].map(stable), ...linkedCss.map((f) => stable(rel(f)))] };

const jsonOut = opt('--json');
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 2));

const baseFile = opt('--base');
const base = baseFile && existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, 'utf8')) : null;

const kib = (b) => (b / KB).toFixed(1);
const delta = (now, was) => {
  if (was === undefined) return base ? 'new' : '';
  const d = now - was;
  if (Math.abs(d) < 52) return '±0';
  const pct = was ? ` (${d > 0 ? '+' : ''}${((d / was) * 100).toFixed(1)}%)` : '';
  return `${d > 0 ? '+' : ''}${kib(d)}${pct}`;
};

const lines = [];
lines.push('### Portal bundle size (report only, not a gate)', '');
lines.push(`| metric | KiB | ${base ? 'Δ vs base |' : ''}`, `|---|---:|${base ? '---:|' : ''}`);
for (const [k, v] of Object.entries(totals)) {
  lines.push(`| ${k}${k === 'fonts' ? ' (raw)' : ' (gzip)'} | ${kib(v)} | ${base ? `${delta(v, base.totals[k])} |` : ''}`);
}
lines.push('', '<details><summary>Per chunk (gzip)</summary>', '');
lines.push(`| chunk | initial | KiB | ${base ? 'Δ |' : ''}`, `|---|:-:|---:|${base ? '---:|' : ''}`);
const names = new Set([...Object.keys(chunks), ...Object.keys(base?.chunks ?? {})]);
const sorted = [...names].sort((a, b) => (chunks[b] ?? 0) - (chunks[a] ?? 0));
for (const n of sorted) {
  const now = chunks[n];
  const was = base?.chunks?.[n];
  const d = now === undefined ? 'removed' : delta(now, was);
  if (base && d === '±0' && !result.initial.includes(n)) continue;
  lines.push(`| \`${n}\` | ${result.initial.includes(n) ? '●' : ''} | ${now === undefined ? '—' : kib(now)} | ${base ? `${d} |` : ''}`);
}
lines.push('', base ? 'Unchanged lazy chunks omitted.' : '', '</details>', '');
const md = lines.join('\n');

const mdOut = opt('--markdown');
if (mdOut) writeFileSync(mdOut, md);
console.log(md);
