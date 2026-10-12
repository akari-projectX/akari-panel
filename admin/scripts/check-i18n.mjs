#!/usr/bin/env node
// SH-13: the language switch switches the WHOLE console, so every
// operator-visible Chinese string must have an English twin at its use
// site. A Chinese literal (string, template, JSX text or attribute) is
// accepted only as:
//   - the first argument of `tr("中文", "English")` (any callee ending in
//     `tr`: `tr`, `t.tr`, `trFor(lang)`);
//   - the `zh` property of an object literal that also has `en`
//     (`{ zh: "用户", en: "Users" }`, nav / settings IA / enum tables);
//   - the first element of a two-element array whose second element has no
//     Chinese (`["中文", "English"]` pair tables, e.g. LOGIN_ERRORS);
//   - inside a line marked `// i18n-ok` (data that is the same in both
//     languages, e.g. a sample Chinese site name; say why on the line).
// Comments, tests, errors.gen.ts (checked by check-error-codes.mjs) are
// skipped. `npm run check`; `--list` prints every hit, otherwise the
// first 40 and a per-file count.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../src");
const CJK = /[㐀-鿿！-～　-〿]/;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

const SKIP = new Set(["shared/errors.gen.ts"]);
const KEEP_PROPS = new Set(["keywords", "glyph"]);
const BASELINE_FILE = join(here, "i18n-baseline.json");

function calleeText(call, sf) {
  return call.expression.getText(sf);
}

function accepted(node, sf, lines) {
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
  if (/i18n-ok/.test(lines[line] ?? "")) return true;
  let child = node;
  let p = node.parent;
  // Climb through wrappers that keep the literal "the same value".
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isTemplateSpan(p) ||
      ts.isTemplateExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isSatisfiesExpression?.(p))
  ) {
    child = p;
    p = p.parent;
  }
  if (!p) return false;
  if (ts.isCallExpression(p) && p.arguments[0] === child && /(^|[.)])tr$|^trFor\(.*\)$/.test(calleeText(p, sf)))
    return true;
  if (ts.isPropertyAssignment(p) && p.initializer === child) {
    const name = p.name.getText(sf).replace(/["']/g, "");
    if (name === "zh" && ts.isObjectLiteralExpression(p.parent)) {
      return p.parent.properties.some((q) => q.name && q.name.getText(sf).replace(/["']/g, "") === "en");
    }
  }
  if (ts.isArrayLiteralExpression(p) && p.elements.length === 2 && p.elements[0] === child) {
    return !CJK.test(p.elements[1].getText(sf));
  }
  // `pick(n, "分钟", "min")`: a Chinese argument directly followed by its English twin.
  if (ts.isCallExpression(p)) {
    const i = p.arguments.indexOf(child);
    const next = p.arguments[i + 1];
    if (i >= 0 && next && (ts.isStringLiteral(next) || ts.isTemplateLiteral(next)) && !CJK.test(next.getText(sf)))
      return true;
  }
  // Bilingual search keywords / brand glyphs: not prose shown in one language.
  if (ts.isPropertyAssignment(p) && p.initializer === child && KEEP_PROPS.has(p.name.getText(sf))) return true;
  // `lang === "en" ? "…" : "中文"`.
  if (ts.isConditionalExpression(p) && p.whenFalse === child && /\blang\b|"en"|"zh"/.test(p.condition.getText(sf)))
    return true;
  return false;
}

const hits = [];
for (const file of files(root)) {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (SKIP.has(rel)) continue;
  const text = readFileSync(file, "utf8");
  if (!CJK.test(text)) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = text.split("\n");
  const visit = (node) => {
    let lit = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) lit = node;
    else if (ts.isTemplateExpression(node)) lit = node;
    else if (ts.isJsxText(node)) lit = node;
    const own = !lit
      ? ""
      : ts.isTemplateExpression(lit)
        ? [lit.head.text, ...lit.templateSpans.map((x) => x.literal.text)].join("")
        : ts.isJsxText(lit)
          ? lit.text
          : lit.text;
    if (lit && !CJK.test(own) && ts.isTemplateExpression(lit)) {
      lit.templateSpans.forEach((x) => visit(x.expression));
      return;
    }
    if (lit && CJK.test(own)) {
      // JSX text is never inside tr(); templates: judge the whole template.
      if (ts.isJsxText(lit) || !accepted(lit, sf, lines)) {
        const { line } = sf.getLineAndCharacterOfPosition(lit.getStart(sf));
        if (!/i18n-ok/.test(lines[line] ?? ""))
          hits.push({ rel, line: line + 1, text: lit.getText(sf).trim().slice(0, 70) });
      }
      if (ts.isTemplateExpression(node)) node.templateSpans.forEach((x) => visit(x.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// Ratchet: files written before SH-13 was enforced may keep at most their
// recorded count (scripts/i18n-baseline.json); every other file, and any
// growth, fails. Shrink the baseline when you fix a file
// (`node scripts/check-i18n.mjs --write-baseline` rewrites it from the
// current state — only ever to lower numbers).
const byFileAll = new Map();
for (const h of hits) byFileAll.set(h.rel, (byFileAll.get(h.rel) ?? 0) + 1);
if (process.argv.includes("--write-baseline")) {
  writeFileSync(BASELINE_FILE, JSON.stringify(Object.fromEntries([...byFileAll].sort()), null, 2) + "\n");
  console.log(`check-i18n: baseline written (${hits.length} literals in ${byFileAll.size} files)`);
  process.exit(0);
}
let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
} catch {
  /* no baseline: every hit fails */
}
const over = process.argv.includes("--list")
  ? [...hits]
  : hits.filter((h) => (byFileAll.get(h.rel) ?? 0) > (baseline[h.rel] ?? 0));
const tolerated = hits.length - over.length;
hits.length = 0;
hits.push(...over);
if (tolerated && !hits.length)
  console.log(
    `check-i18n: ${tolerated} known literal(s) in the baseline (scripts/i18n-baseline.json); fix and shrink it`,
  );

if (hits.length) {
  const list = process.argv.includes("--list");
  const byFile = new Map();
  for (const h of hits) byFile.set(h.rel, (byFile.get(h.rel) ?? 0) + 1);
  console.error(`check-i18n: ${hits.length} Chinese literal(s) outside tr() (SH-13: wrap in tr("中文", "English")):`);
  for (const h of list ? hits : hits.slice(0, 40)) console.error(`  src/${h.rel}:${h.line}  ${h.text}`);
  if (!list) for (const [f, n] of byFile) console.error(`  ${n}\tsrc/${f}`);
  process.exit(1);
}
if (!tolerated) console.log("check-i18n: every Chinese literal has an English twin");
