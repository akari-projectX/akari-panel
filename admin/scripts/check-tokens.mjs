#!/usr/bin/env node
// Motion tokens (SPRINT admin-redesign-1012): the admin console uses the
// portal's motion variables under the same names and values. R23 forbids
// sharing source between the two apps, so this compares values only:
// every --ease-* / --dur-* custom property the portal declares on :root in
// ../spa/src/index.css must be declared in src/shared/index.css with the
// same value (numbers normalised: ".2s" = "0.2s"). Admin-only tokens
// (e.g. --ease-spring) are allowed.
//   node scripts/check-tokens.mjs [portalCss] [adminCss]
import { existsSync, readFileSync } from "node:fs";

const [portalCss = "../spa/src/index.css", adminCss = "src/shared/index.css"] = process.argv.slice(2);

/** `--name: value;` pairs of the motion tokens in the plain `:root {…}` blocks. */
function tokens(file) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map();
  for (const root of css.matchAll(/(?:^|[\n}])\s*:root\s*\{([^}]*)\}/g))
    for (const m of root[1].matchAll(/(--(?:ease|dur)-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], norm(m[2]));
  return out;
}
const norm = (v) =>
  v
    .trim()
    .replace(/\s+/g, "")
    .replace(/(^|[^0-9.])\.(\d)/g, "$10.$2")
    .replace(/(\.\d*?)0+(?=[^0-9]|$)/g, "$1")
    .replace(/\.(?=[^0-9]|$)/g, "");

if (!existsSync(portalCss)) {
  console.error(`tokens: ${portalCss} missing (the portal must be checked out next to admin/)`);
  process.exit(1);
}
const portal = tokens(portalCss);
const admin = tokens(adminCss);
const problems = [];
if (portal.size === 0)
  problems.push(`${portalCss}: no --ease-*/--dur-* tokens found (check-tokens would pass vacuously)`);
for (const [k, v] of portal) {
  if (!admin.has(k)) problems.push(`${adminCss}: missing ${k} (portal: ${v})`);
  else if (admin.get(k) !== v) problems.push(`${k}: admin ${admin.get(k)} ≠ portal ${v}`);
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`tokens: ${portal.size} motion tokens match the portal`);
