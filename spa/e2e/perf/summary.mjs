#!/usr/bin/env node
/*
 * 把 perf.spec.ts 写的 perf-<画像>.json 合并成一张 Markdown 表（只报告，不判定）。
 *   node e2e/perf/summary.mjs <目录>
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'test-results/perf';
const files = readdirSync(dir).filter((f) => /^perf-.*\.json$/.test(f)).sort();
const runs = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
if (!runs.length) {
  console.log('### Portal performance (report only)\n\nNo results (the measurement did not run or failed; see the job log).');
  process.exit(0);
}
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
  'Cold = fresh context (empty cache). TTI = end of the last long task after FCP (simplified). Route switch = client navigation to content ready, page transition included.', '',
  `| metric | ${runs.map((r) => r.profile).join(' | ')} |`,
  `|---|${runs.map(() => '---:').join('|')}|`,
  ...keys.map((k) => `| ${label[k] ?? k.replace(/^switch\./, 'route switch → ')} | ${runs.map((r) => r.result[k] ?? '—').join(' | ')} |`),
  '',
];
console.log(lines.join('\n'));
