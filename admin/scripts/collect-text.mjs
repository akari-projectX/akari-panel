#!/usr/bin/env node
/*
 * 统计后台界面上会显示的字，给 scripts/subset-admin-font.py 裁字体用（照门户 portal/scripts/collect-text.mjs 的做法，
 * 两个应用不共享源码，R23）。只收源码里的字符串字面量、模板字符串和 JSX 文本——注释里的字不会出现在页面上。
 * fonts-src/extra-chars.txt（可选）：想用网页字体显示、却不在源码与常用字表里的字。
 * 输出一行 JSON：{"sc": "…"}，只含非 ASCII 字符。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield p;
  }
}

const strings = [];
for (const file of sources(path.join(root, "src"))) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, kind);
  const visit = (n) => {
    if (
      ts.isStringLiteralLike(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
    ) {
      if (/\P{ASCII}/u.test(n.text)) strings.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

const extra = path.join(root, "fonts-src/extra-chars.txt");
if (fs.existsSync(extra))
  strings.push(
    ...fs
      .readFileSync(extra, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("#")),
  );

const chars = (list) =>
  [...new Set(list.join(""))]
    .filter((c) => c.codePointAt(0) > 0x7f)
    .sort()
    .join("");
process.stdout.write(JSON.stringify({ sc: chars(strings) }));
