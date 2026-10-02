#!/usr/bin/env node
// W21 (M6): every server error code has a SPA mapping.
//
// The panel's error bodies carry stable codes (src/error_codes.txt, kept
// equal to the source by the Rust test `auth::error_code_tests`). This
// fails when a code has no text in the SPA:
//   - codes the portal can meet (namespaces below) must be in
//     src/lib/errors.ts CODE_KEYS (zh + en dictionary keys; tsc checks the
//     keys exist);
//   - every other code must be in CODE_KEYS or in the console's
//     src/lib/admin-errors.ts ADMIN_CODES (Chinese);
//   - mappings of codes the server no longer has, and codes mapped twice,
//     fail too.
// Run by `make check` and the CI spa job.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spa = join(here, "..");
const repo = join(spa, "..");

/** Namespaces whose codes users of the portal can meet. */
export const USER_NAMESPACES = [
  "auth",
  "account",
  "signup",
  "shop",
  "order",
  "coupon",
  "balance",
  "withdrawal",
  "invite",
  "ticket",
  "request",
];

const registry = readFileSync(join(repo, "src/error_codes.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));

/** The quoted keys of `export const <name>: Record<...> = { ... };` in a file. */
function mapKeys(file, name) {
  const src = readFileSync(join(spa, file), "utf8");
  const start = src.indexOf(`export const ${name}`);
  if (start < 0) throw new Error(`${file}: ${name} not found`);
  const open = src.indexOf("{", src.indexOf("=", start));
  const close = src.indexOf("\n};", open);
  const body = src.slice(open, close);
  return [...body.matchAll(/^\s*"([a-z0-9_.]+)":/gm)].map((m) => m[1]);
}

const user = mapKeys("src/lib/errors.ts", "CODE_KEYS");
const admin = mapKeys("src/lib/admin-errors.ts", "ADMIN_CODES");
const known = new Set(registry);
const problems = [];
const userSet = new Set(user);
const adminSet = new Set(admin);
for (const code of registry) {
  const ns = code.split(".")[0];
  if (USER_NAMESPACES.includes(ns)) {
    if (!userSet.has(code)) problems.push(`${code}: portal code without a CODE_KEYS entry (src/lib/errors.ts)`);
  } else if (!userSet.has(code) && !adminSet.has(code)) {
    problems.push(`${code}: no mapping (src/lib/admin-errors.ts ADMIN_CODES or src/lib/errors.ts CODE_KEYS)`);
  }
}
for (const code of [...user, ...admin]) {
  if (!known.has(code)) problems.push(`${code}: mapped but not a server code (src/error_codes.txt)`);
}
for (const code of user) if (adminSet.has(code)) problems.push(`${code}: mapped in both CODE_KEYS and ADMIN_CODES`);
const dup = (list) => list.filter((c, i) => list.indexOf(c) !== i);
for (const code of [...dup(user), ...dup(admin)]) problems.push(`${code}: mapped twice`);

if (problems.length) {
  console.error(`check-error-codes: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-error-codes: ${registry.length} codes mapped (${user.length} portal, ${admin.length} console)`);
