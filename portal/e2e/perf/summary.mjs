#!/usr/bin/env node
/*
 * 把 perf.spec.ts 写的 perf-svelte-<画像>.json 与 bundle-report.mjs 写的 size-svelte.json 合并成一张 Markdown 表
 * （只报告，不判定），旁边是 React 门户切换前最后一次同一套测法的结果（e2e/perf/baseline/：perf-react-<画像>.json、
 * size-react.json、source.json = 那次 CI 运行）。
 *   node e2e/perf/summary.mjs <目录>
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'test-results/perf';
const BASE = join(import.meta.dirname, 'baseline');
const read = (d, f) => JSON.parse(readFileSync(join(d, f), 'utf8'));
const list = (d) => (existsSync(d) ? readdirSync(d).filter((f) => /^perf-.*\.json$/.test(f)).sort() : []);
const runs = [...list(dir).map((f) => read(dir, f)), ...list(BASE).map((f) => read(BASE, f))]
  .map((r) => ({ ...r, portal: r.portal ?? 'react' }));
if (!runs.some((r) => r.portal === 'svelte')) {
  console.log('### Portal performance (report only)\n\nNo results (the measurement did not run or failed; see the job log).');
  process.exit(0);
}
const source = existsSync(join(BASE, 'source.json')) ? read(BASE, 'source.json') : null;
const sourceV2 = existsSync(join(BASE, 'source-v2.json')) ? read(BASE, 'source-v2.json') : null;
const PORTALS = ['react', 'v2', 'svelte'].filter((p) => runs.some((r) => r.portal === p));
const NAME = { react: 'react', v2: 'v2.0.0', svelte: 'svelte' };
const PROFILES = [...new Set(runs.filter((r) => r.portal === 'svelte').map((r) => r.profile))];
const at = (profile, portal) => runs.find((r) => r.profile === profile && r.portal === portal);
const keys = [...new Set(runs.flatMap((r) => Object.keys(r.result)))];
const label = {
  'login.fcp': 'login cold · FCP', 'login.lcp': 'login cold · LCP', 'login.tti': 'login cold · TTI',
  'login.ready': 'login cold · content ready',
  'dashboard.fcp': 'dashboard cold · FCP', 'dashboard.lcp': 'dashboard cold · LCP', 'dashboard.tti': 'dashboard cold · TTI',
  'dashboard.ready': 'dashboard cold · content ready',
};
const delta = (a, b) => (a == null || b == null || !a ? '—' : `${b <= a ? '−' : '+'}${Math.round((Math.abs(b - a) / a) * 100)}%`);
/* 对比的基准：有 v2.0.0 就以它为准（Δ = 本次相对 v2.0.0），否则是 React 门户 */
const REF = PORTALS.includes('v2') ? 'v2' : PORTALS.includes('react') ? 'react' : null;
const header = PROFILES.flatMap((p) => [...PORTALS.map((q) => `${p} · ${NAME[q]}`), ...(REF ? [`Δ vs ${NAME[REF]}`] : [])]);
const row = (k) => PROFILES.flatMap((p) => [
  ...PORTALS.map((q) => at(p, q)?.result[k] ?? '—'),
  ...(REF ? [delta(at(p, REF)?.result[k], at(p, 'svelte')?.result[k])] : []),
]);
const lines = [
  '### Portal performance (report only, not a gate)', '',
  `Median of ${runs[0].runs} runs, ms. desktop = no throttling; mobile-mid = Pixel 7 viewport, 4× CPU slowdown, 150 ms RTT, 1.6 Mbps down. ` +
  'Cold = fresh context (empty cache). TTI = end of the last long task after FCP (simplified). Route switch = client navigation to content ready, page transition included.',
  [
    source && PORTALS.includes('react') ? `react = the React portal before the cutover (same harness, CI run ${source.run}, ${source.sha.slice(0, 7)})` : '',
    sourceV2 && PORTALS.includes('v2') ? `v2.0.0 = the Svelte portal as released (CI run ${sourceV2.run}, ${sourceV2.tag})` : '',
    'svelte = this run',
  ].filter(Boolean).map((x, i) => (i ? `; ${x}` : `\n${x}`)).join('') + '.',
  '',
  `| metric | ${header.join(' | ')} |`,
  `|---|${header.map(() => '---:').join('|')}|`,
  ...keys.map((k) => `| ${label[k] ?? k.replace(/^switch\./, 'route switch → ').replace(/^bare\./, 'route switch (without the fade-out) → ')} | ${row(k).join(' | ')} |`),
  '',
];

/* 体积（bundle-report.mjs --json）：首屏与全部 JS / CSS 的 gzip */
const size = (p) => (existsSync(join(dir, `size-${p}.json`)) ? read(dir, `size-${p}.json`)
  : existsSync(join(BASE, `size-${p}.json`)) ? read(BASE, `size-${p}.json`) : null);
const sizes = PORTALS.map((p) => [p, size(p)]).filter(([, s]) => s);
if (sizes.length) {
  const kib = (b) => (b / 1024).toFixed(1);
  const both = sizes.length >= 2;
  const refSize = sizes.find(([p]) => p === REF)?.[1];
  const mine = sizes.find(([p]) => p === 'svelte')?.[1];
  const line = (name, k) => `| ${name} | ${sizes.map(([, s]) => kib(s.totals[k])).join(' | ')}${both && refSize && mine ? ` | ${delta(refSize.totals[k], mine.totals[k])}` : ''} |`;
  lines.push(
    `| bundle (KiB, gzip) | ${sizes.map(([p]) => NAME[p]).join(' | ')}${both && REF ? ` | Δ vs ${NAME[REF]}` : ''} |`,
    `|---|${sizes.map(() => '---:').join('|')}${both && REF ? '|---:' : ''}|`,
    line('first-load JS', 'initialJs'),
    line('first-load CSS', 'initialCss'),
    line('total JS', 'totalJs'),
    line('total CSS', 'totalCss'),
    '',
  );
}
console.log(lines.join('\n'));
