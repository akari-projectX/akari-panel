#!/usr/bin/env node
/*
 * 门户的文案检查（CI 必跑）。英文词典 src/shared/i18n/dict.ts（键 = 简体原文）与界面文案一一对应：
 *   · 不能缺翻译：每个含汉字的字符串都要有英文条目（界面上的中文都经 t() / tp() 显示）。
 *     src/shared 的 .ts 例外只有不显示的匹配数据（KEYWORDS / keywords：认地区、认平台用的写法）、开发者日志与断言；
 *   · .svelte 标记文本、属性值里不许直接写汉字（写成 {t('…')}）；
 *   · 不能留没人用的条目：「有人用」= src/ 某处（测试与词典本身除外）有一模一样的字符串（错误文案 src/shared/i18n/errors.ts 也算）。
 *     删功能、改文案时旧条目会留下来，这里让它们当场失败。
 *
 *   node scripts/check-i18n.mjs          # 检查
 *   node scripts/check-i18n.mjs --fix    # 删掉没人用的条目
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PORTAL, portalFiles } from './strings.mjs';

const DICT = path.join(PORTAL, 'src/shared/i18n/dict.ts');
const DICT_REL = path.relative(PORTAL, DICT);
const SHARED = `src${path.sep}shared${path.sep}`;
const HAN = /[一-鿿]/;

const src = fs.readFileSync(DICT, 'utf8');
const dict = ts.createSourceFile(DICT, src, ts.ScriptTarget.Latest, true);
const keys = new Set();
dict.forEachChild(function k(n) {
  if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) keys.add(n.name.text);
  n.forEachChild(k);
});

/* src/shared 里不显示的中文：地区 / 平台的匹配写法，以及开发者日志与断言 */
const notShown = (n) => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isVariableDeclaration(p) && p.name.getText() === 'KEYWORDS') return true;
    if (ts.isPropertyAssignment(p) && p.name.getText() === 'keywords') return true;
    if (ts.isNewExpression(p) && p.expression.getText() === 'Error') return true;
    if (ts.isCallExpression(p) && p.expression.getText().startsWith('console.')) return true;
  }
  return false;
};
function sharedShown(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(path.join(PORTAL, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const out = new Set();
  const visit = (n) => {
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && HAN.test(n.text) && !notShown(n)) out.add(n.text);
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

const used = new Set();
const errors = [];
for (const f of portalFiles()) {
  if (f.file === DICT_REL) continue;
  for (const s of f.strings) used.add(s);
  for (const s of f.markup) errors.push(`✗ Chinese written directly in markup (${f.file}): ${s} — use {t('…')}`);
  const shown = f.file.startsWith(SHARED) && f.file.endsWith('.ts') ? sharedShown(f.file) : new Set(f.strings);
  for (const s of shown) if (HAN.test(s) && !keys.has(s)) errors.push(`✗ no English for (${f.file}): ${s}`);
}

const unused = [];
dict.forEachChild(function walk(n) {
  if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name) && !used.has(n.name.text)) {
    unused.push({ start: n.getStart(dict), end: n.getEnd(), key: n.name.text });
  }
  n.forEachChild(walk);
});

const fix = process.argv.includes('--fix');
if (fix && unused.length) {
  let s = src;
  for (const u of [...unused].reverse()) {
    let a = u.start;
    let b = u.end;
    if (s[b] === ',') b++;
    while (a > 0 && s[a - 1] === ' ') a--;
    if (s[b] === '\n') b++;
    s = s.slice(0, a) + s.slice(b);
  }
  fs.writeFileSync(DICT, s);
  console.log(`removed ${unused.length} unused entries`);
} else if (unused.length) {
  errors.push(...unused.map((u) => `✗ unused dict entry: ${u.key}`));
  errors.push(`${unused.length} unused entries (node scripts/check-i18n.mjs --fix removes them)`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`portal i18n ok: ${keys.size - (fix ? unused.length : 0)} entries, every one used, every Chinese UI string translated`);
