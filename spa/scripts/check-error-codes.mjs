#!/usr/bin/env node
/*
 * 门户对面板错误码的覆盖检查（CI 必跑）。
 *
 * 面板的错误体带稳定的 code（面板 src/error_codes.txt）。门户必须为用户可能遇到的每一个码准备中英文案：
 * src/i18n/errors.ts 的 CODE_KEYS。用户可能遇到的码 = 面板错误码表里这些命名空间的码 + kb.query_long。
 *
 *   node scripts/check-error-codes.mjs                       # 用 scripts/user-error-codes.txt（主题仓库里的那份）
 *   node scripts/check-error-codes.mjs --registry ../src/error_codes.txt   # 直接读面板的错误码表（并入面板仓库后用这个）
 *
 * 映射了面板已经没有的码、或者一个码映射两次，也算失败。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAMESPACES = ['auth', 'account', 'signup', 'shop', 'order', 'coupon', 'balance', 'withdrawal', 'invite', 'ticket', 'request'];
const EXTRA = ['kb.query_long'];

const lines = (file) => readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const i = process.argv.indexOf('--registry');
const userCodes = i > 0
  ? lines(process.argv[i + 1]).filter((c) => NAMESPACES.includes(c.split('.')[0]) || EXTRA.includes(c))
  : lines(join(root, 'scripts/user-error-codes.txt'));

const src = readFileSync(join(root, 'src/i18n/errors.ts'), 'utf8');
const start = src.indexOf('export const CODE_KEYS');
const block = src.slice(src.indexOf('{', start), src.indexOf('\n};', start));
const mapped = [...block.matchAll(/^\s*'([a-z0-9_.]+)':/gm)].map((m) => m[1]);

const problems = [];
const want = new Set(userCodes);
const seen = new Set();
for (const c of mapped) {
  if (seen.has(c)) problems.push(`mapped twice: ${c}`);
  seen.add(c);
  if (!want.has(c)) problems.push(`mapped but not a user-visible panel code (removed?): ${c}`);
}
for (const c of userCodes) if (!seen.has(c)) problems.push(`no portal text for panel code: ${c}`);

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`error codes ok: ${userCodes.length} user-visible panel codes mapped`);
