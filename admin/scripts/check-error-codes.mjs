#!/usr/bin/env node
// Every server error code (../src/error_codes.txt) has zh + en text in
// src/shared/errors.gen.ts (and nothing else is there). `npm run check`, CI.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const registry = readFileSync(join(here, "../../src/error_codes.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const src = readFileSync(join(here, "../src/shared/errors.gen.ts"), "utf8");
const rows = [...src.matchAll(/^\s*"([a-z0-9_.]+)": \[("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*")\],$/gm)];
const problems = [];
const seen = new Set();
for (const [, code, zh, en] of rows) {
  if (seen.has(code)) problems.push(`mapped twice: ${code}`);
  seen.add(code);
  if (!JSON.parse(zh).trim() || !JSON.parse(en).trim()) problems.push(`empty text: ${code}`);
  if (/[一-鿿]/.test(JSON.parse(en))) problems.push(`Chinese in the English text: ${code}`);
}
const table = new Map(rows.map(([, code, zh, en]) => [code, [JSON.parse(zh), JSON.parse(en)]]));
// The sign-in page's own small table must match the console's.
const login = readFileSync(join(here, "../src/login/app.tsx"), "utf8");
const loginBlock = login.slice(login.indexOf("LOGIN_ERRORS"), login.indexOf("};", login.indexOf("LOGIN_ERRORS")));
const loginRows = [...loginBlock.matchAll(/"([a-z0-9_.]+)": \[("(?:[^"\\]|\\.)*"), ("(?:[^"\\]|\\.)*")\]/g)];
if (!loginRows.length) problems.push("LOGIN_ERRORS not found in src/login/app.tsx");
for (const [, code, zh, en] of loginRows) {
  const want = table.get(code);
  if (!want) problems.push(`LOGIN_ERRORS: unknown code ${code}`);
  else if (want[0] !== JSON.parse(zh) || want[1] !== JSON.parse(en))
    problems.push(`LOGIN_ERRORS: ${code} differs from errors.gen.ts`);
}
const known = new Set(registry);
for (const code of registry) if (!seen.has(code)) problems.push(`no text for server code: ${code}`);
for (const code of seen) if (!known.has(code)) problems.push(`mapping of an unknown code: ${code}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`error codes: ${registry.length} mapped (zh + en)`);
