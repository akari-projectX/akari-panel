#!/usr/bin/env node
/*
 * 把 perf.spec.ts 写的 perf-<门户>-<画像>.json 与 bundle-report.mjs 写的 size-<门户>.json 合并成一张 Markdown 表
 * （只报告，不判定）。门户 = react（spa/）与 svelte（portal/，门户 v2）；同一个面板、同一套测法。
 *   node e2e/perf/summary.mjs <目录>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'test-results/perf';
const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const runs = readdirSync(dir).filter((f) => /^perf-.*\.json$/.test(f)).sort().map(read)
  .map((r) => ({ ...r, portal: r.portal ?? 'react' }));
if (!runs.length) {
  console.log('### Portal performance (report only)\n\nNo results (the measurement did not run or failed; see the job log).');
  process.exit(0);
}
const PORTALS = ['react', 'svelte'].filter((p) => runs.some((r) => r.portal === p));
const PROFILES = [...new Set(runs.map((r) => r.profile))];
const cols = PROFILES.flatMap((profile) => PORTALS.map((portal) => ({ profile, portal })));
const at = (c) => runs.find((r) => r.profile === c.profile && r.portal === c.portal);
const keys = [...new Set(runs.flatMap((r) => Object.keys(r.result)))];
const label = {
  'login.fcp': 'login cold · FCP', 'login.lcp': 'login cold · LCP', 'login.tti': 'login cold · TTI',
  'login.ready': 'login cold · content ready',
  'dashboard.fcp': 'dashboard cold · FCP', 'dashboard.lcp': 'dashboard cold · LCP', 'dashboard.tti': 'dashboard cold · TTI',
  'dashboard.ready': 'dashboard cold · content ready',
};
const lines = [
  '### Portal performance (report only, not a gate)', '',
  `Median of ${runs[0].runs} runs, ms. desktop = no throttling; mobile-mid = Pixel 7 viewport, 4× CPU slowdown, 150 ms RTT, 1.6 Mbps down. ` +
  'Cold = fresh context (empty cache). TTI = end of the last long task after FCP (simplified). Route switch = client navigation to content ready, page transition included.',
  PORTALS.includes('svelte') ? '\n**svelte = portal v2 (portal/) — until the cutover only partly ported: pages not yet ported are placeholders, so its numbers are not a like-for-like comparison yet.**' : '',
  '',
  `| metric | ${cols.map((c) => `${c.profile} · ${c.portal}`).join(' | ')} |`,
  `|---|${cols.map(() => '---:').join('|')}|`,
  ...keys.map((k) => `| ${label[k] ?? k.replace(/^switch\./, 'route switch → ')} | ${cols.map((c) => at(c)?.result[k] ?? '—').join(' | ')} |`),
  '',
];

/* 体积（bundle-report.mjs --json）：首屏 JS 与全部 JS 的 gzip */
const sizes = PORTALS.map((p) => [p, existsSync(join(dir, `size-${p}.json`)) ? read(`size-${p}.json`) : null]).filter(([, s]) => s);
if (sizes.length) {
  const kib = (b) => (b / 1024).toFixed(1);
  lines.push(
    '| bundle (KiB) | ' + sizes.map(([p]) => p).join(' | ') + ' |',
    `|---|${sizes.map(() => '---:').join('|')}|`,
    '| first-load JS (gzip) | ' + sizes.map(([, s]) => kib(s.totals.initialJs)).join(' | ') + ' |',
    '| first-load CSS (gzip) | ' + sizes.map(([, s]) => kib(s.totals.initialCss)).join(' | ') + ' |',
    '| total JS (gzip) | ' + sizes.map(([, s]) => kib(s.totals.totalJs)).join(' | ') + ' |',
    '',
  );
}
console.log(lines.join('\n'));
