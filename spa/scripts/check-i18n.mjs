#!/usr/bin/env node
/*
 * 英文词典（src/i18n/dict.ts，键 = 简体原文）与界面文案一一对应（CI 必跑）：
 *   · 不能留没人用的条目：「有人用」= 源码某处（测试除外）有一模一样的字符串字面量 / 模板字符串 / JSX 文本
 *     （错误文案 src/i18n/errors.ts 也算）。删功能、改文案时旧条目会留下来，这里让它们当场失败；
 *   · 不能缺翻译：源码里每个含汉字的字符串都要有英文条目（界面上的中文都经 tr()/tp() 显示）。
 *     例外只有不显示的匹配数据（KEYWORDS / keywords：认地区、认平台用的写法）、后台生成的协议表单、开发者日志与断言。
 *
 *   node scripts/check-i18n.mjs          # 检查
 *   node scripts/check-i18n.mjs --fix    # 删掉没人用的条目
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DICT = path.join(root, 'src/i18n/dict.ts');

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && p !== DICT) yield p;
  }
}

const src = fs.readFileSync(DICT, 'utf8');
const dict = ts.createSourceFile(DICT, src, ts.ScriptTarget.Latest, true);
const keys = new Set();
dict.forEachChild(function k(n) {
  if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name)) keys.add(n.name.text);
  n.forEachChild(k);
});

/* 不显示的中文：地区 / 平台的匹配写法，以及开发者日志与断言 */
const SKIP_FILES = new Set(['src/lib/admin-protocols.gen.ts']);
const notShown = (n) => {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isVariableDeclaration(p) && p.name.getText() === 'KEYWORDS') return true;
    if (ts.isPropertyAssignment(p) && p.name.getText() === 'keywords') return true;
    if (ts.isNewExpression(p) && p.expression.getText() === 'Error') return true;
    if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText())) return true;
  }
  return false;
};
const HAN = /[\u4e00-\u9fff]/;

const used = new Set();
const missing = new Map();
for (const file of sources(path.join(root, 'src'))) {
  const rel = path.relative(root, file);
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
  const visit = (n) => {
    let text = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) text = n.text;
    else if (ts.isJsxText(n)) text = n.text.trim();
    if (text !== null) {
      used.add(text);
      if (HAN.test(text) && !keys.has(text) && !SKIP_FILES.has(rel) && !notShown(n)) missing.set(text, rel);
    }
    n.forEachChild(visit);
  };
  visit(sf);
}

const unused = [];
const walk = (n) => {
  if (ts.isPropertyAssignment(n) && ts.isStringLiteral(n.name) && !used.has(n.name.text)) {
    unused.push({ start: n.getStart(dict), end: n.getEnd(), key: n.name.text });
  }
  n.forEachChild(walk);
};
walk(dict);

if (process.argv.includes('--fix')) {
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
}
if (missing.size) {
  console.error([...missing].map(([t, f]) => `✗ no English for (${f}): ${t}`).join('\n'));
}
if (unused.length && !process.argv.includes('--fix')) {
  console.error(unused.map((u) => `✗ unused dict entry: ${u.key}`).join('\n'));
  console.error(`${unused.length} unused entries (node scripts/check-i18n.mjs --fix removes them)`);
}
if (missing.size || (unused.length && !process.argv.includes('--fix'))) process.exit(1);
console.log(`i18n ok: ${keys.size} entries, every one used, every Chinese UI string translated`);
