#!/usr/bin/env node
/*
 * 门户产物里不能有任何后台代码（R23、D4；CI 与 smoke 都跑：smoke 对面板实际下发的文件再查一遍）。
 *
 * 后台是另一个应用（akari-panel admin/，在秘密前缀下，只对管理员会话下发）。门户与它不共享源码，
 * 这里按「后台才有的东西」在门户产物的每个文件里找：后台 API 路径（门户的接口都以 /me、/auth、/pages 开头，
 * 路由名是 /shop、/nodes… 这类，所以只列和门户路由不重名的后台路径）、后台独有的标题文案。
 * 每个标记都带一个它必须命中的样例，标记写错（永远匹配不到）时脚本自己先失败，不会空跑通过。
 *
 *   node scripts/check-bundles.mjs [门户产物目录，默认 dist/app]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist/app';
const Q = '[`"\']';
/* [说明, 正则, 必须命中的样例] */
const MARKERS = [
  ['admin API /users', new RegExp(`${Q}/users\\b`), "get('/users')"],
  ['admin API /servers', new RegExp(`${Q}/servers\\b`), '"/servers/x"'],
  ['admin API /node-groups', /\/node-groups/, '/node-groups'],
  ['admin API /plans', new RegExp(`${Q}/plans\\b`), "'/plans'"],
  ['admin API /plan-prices', /\/plan-prices/, '/plan-prices'],
  ['admin API /entrances', new RegExp(`${Q}/entrances\\b`), '`/entrances/1`'],
  ['admin API /audit', new RegExp(`${Q}/audit\\b`), "'/audit'"],
  ['admin API /agent-releases', /\/agent-releases/, '/agent-releases'],
  ['admin API /agent-updates', /\/agent-updates/, '/agent-updates'],
  ['admin API /rollouts', new RegExp(`${Q}/rollouts\\b`), "'/rollouts'"],
  ['admin API /inbound-templates', /\/inbound-templates/, '/inbound-templates'],
  ['admin API /settings', new RegExp(`${Q}/settings\\b`), "'/settings/site'"],
  ['admin API /coupons', new RegExp(`${Q}/coupons\\b`), "'/coupons'"],
  ['admin API /coupon-batches', /\/coupon-batches/, '/coupon-batches'],
  ['admin API /commissions', new RegExp(`${Q}/commissions\\b`), "'/commissions'"],
  ['admin API /balances', new RegExp(`${Q}/balances\\b`), "'/balances'"],
  ['admin API /admin-badges', /\/admin-badges/, '/admin-badges'],
  ['admin API /block-rules', /\/block-rules/, '/block-rules'],
  ['admin API /system/status', /\/system\/status/, '/system/status'],
  ['admin API /kb/', new RegExp(`${Q}/kb/`), "'/kb/articles'"],
  ['admin API export.csv', /export\.csv/, 'users/export.csv'],
  ['admin API enroll-token', /enroll-token/, 'enroll-token'],
  ['console title 管理后台', /管理后台/, '管理后台'],
  ['heading 审计日志', /审计日志/, '审计日志'],
  ['heading 系统设置', /系统设置/, '系统设置'],
  ['heading 提现审核', /提现审核/, '提现审核'],
  ['heading 灰度更新', /灰度更新/, '灰度更新'],
];

const problems = [];
for (const [label, re, sample] of MARKERS) {
  if (!re.test(sample)) problems.push(`marker "${label}" does not match its own sample (stale marker)`);
}
const walk = (d) =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk(dir).filter((f) => /\.(js|css|html)$/.test(f));
if (files.length === 0) problems.push(`${dir}: no built files (run vite build first)`);
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const [label, re] of MARKERS) if (re.test(src)) problems.push(`${f}: ${label}`);
}
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`portal bundle ok: ${files.length} files, none carries admin code (${MARKERS.length} markers)`);
