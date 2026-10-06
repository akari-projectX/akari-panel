#!/usr/bin/env node
/*
 * 统计界面上会显示的字，给 scripts/subset-akari-font.py 裁字体用（常用 3500 字以外的界面用字也要收）。
 *
 * 只收源码里的字符串字面量、模板字符串和 JSX 文本——注释里的字不会出现在页面上。
 * 这套代码的注释大多是中文，按「源码里出现过的字」统计会多收几百个用不到的字。
 *
 * fonts-src/akari/extra-chars.txt（可选）：站长在后台写的、但源码和常用字表里都没有的字，
 * 比如首屏自定义的标题、套餐名里的生僻字。写进去重跑，这些字也会裁进字体。
 *
 * 输出一行 JSON：{"sc": "…"}，只含非 ASCII 字符。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

const strings = [];
for (const file of sources(path.join(root, 'src'))) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, kind);
  const visit = (n) => {
    if (ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) {
      if (/\P{ASCII}/u.test(n.text)) strings.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const extra = path.join(root, 'fonts-src/akari/extra-chars.txt');
if (fs.existsSync(extra)) strings.push(...fs.readFileSync(extra, 'utf8').split('\n').filter((l) => !l.startsWith('#')));

const chars = (list) => [...new Set(list.join(''))].filter((c) => c.codePointAt(0) > 0x7f).sort().join('');
process.stdout.write(JSON.stringify({ sc: chars(strings) }));
