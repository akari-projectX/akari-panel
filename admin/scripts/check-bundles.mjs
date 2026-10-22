#!/usr/bin/env node
// W33-b bundle guard (R23): the admin app and the user portal share
// nothing; and (2026-10 redesign) the console's per-page chunks must load
// under the secret admin prefix.
//   node scripts/check-bundles.mjs [adminDist=dist] [portalDist=../portal/dist/app]
// - the console bundle carries the console markers (else the check below
//   would pass vacuously);
// - the public sign-in page (dist/login) carries none of them, and is one
//   chunk (no lazy imports);
// - the portal bundle (when present) carries none of them;
// - no admin bundle carries portal-only markers;
// - no admin JS or CSS has an absolute asset URL ("/admin/assets/…",
//   "/app/assets/…"): src/console.rs rewrites those only in the HTML, so a
//   chunk or font referred to that way would miss the prefix. Chunks refer
//   to each other relatively (vite.config.ts `renderBuiltUrl`);
// - every chunk a JS file imports (static or dynamic) and every url() in
//   the CSS exists next to it;
// - the console has more than one chunk (the per-page split happened).
// Runs after `npm run build`; smoke runs it again on the served files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const [adminDist = "dist", portalDist = "../portal/dist/app"] = process.argv.slice(2);

/** API paths and texts only the console has. */
const CONSOLE = [
  "/users/batch",
  "/users/delete/preview",
  "/rollouts",
  "/agent-releases",
  "/settings/access",
  "/block-rules",
  "/system/status",
  "/entrances/",
  "/rate-rules",
  "/commission-settings",
  "/coupon-batches",
  "/orders/manual",
  "/refund-preview",
  "/settings/mail-templates",
  "/kb/articles",
  "审计日志",
];
/** API paths only the portal calls. */
const PORTAL = ["/me/shop", "/me/orders", "/me/withdrawals", "/me/tickets", "/auth/register", "/me/invite-codes"];

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const text = (dir, ext = /\.(js|html|css)$/) =>
  files(dir)
    .filter((f) => ext.test(f))
    .map((f) => [f, readFileSync(f, "utf8")]);

const problems = [];
const consoleText = text(join(adminDist, "console"));
const loginText = text(join(adminDist, "login"));
if (!consoleText.length) problems.push(`no console bundle in ${adminDist}/console`);
if (!loginText.length) problems.push(`no sign-in bundle in ${adminDist}/login`);
const all = consoleText.map(([, t]) => t).join("\n");
for (const m of CONSOLE) if (!all.includes(m)) problems.push(`console bundle lacks marker ${m} (update CONSOLE)`);
for (const [f, t] of loginText)
  for (const m of CONSOLE) if (t.includes(m)) problems.push(`${f}: console marker ${m} in the public sign-in page`);
for (const [f, t] of [...consoleText, ...loginText])
  for (const m of PORTAL) if (t.includes(m)) problems.push(`${f}: portal marker ${m} in the admin app`);

const code = [...consoleText, ...loginText].filter(([f]) => /\.(js|css)$/.test(f));
for (const [f, t] of code) {
  for (const abs of ["/admin/assets/", "/app/assets/"]) {
    // Quoted string or url( … ) starting with the absolute asset path.
    const re = new RegExp(`(["'\`]|url\\(\\s*["']?)${abs.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`);
    if (re.test(t)) problems.push(`${f}: absolute asset URL ${abs} (bypasses the admin prefix rewrite)`);
  }
  const here = dirname(f);
  const refs = f.endsWith(".js")
    ? [
        ...t.matchAll(/\bimport\(\s*["'`](\.{1,2}\/[^"'`]+)["'`]\s*\)/g),
        ...t.matchAll(/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g),
        ...t.matchAll(/\bimport\s*["'](\.{1,2}\/[^"']+)["']/g),
        ...t.matchAll(/new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g),
      ]
    : [...t.matchAll(/url\(\s*["']?(\.{0,2}\/?[^"')]+?)["']?\s*\)/g)].filter(
        (m) => !/^(data:|https?:|#)/.test(m[1]) && !m[1].startsWith("/"),
      );
  for (const m of refs) {
    const target = normalize(join(here, m[1].split(/[?#]/)[0]));
    if (!existsSync(target)) problems.push(`${f}: refers to ${m[1]}, which is not in the build`);
  }
}

// The sign-in page: one JS chunk, no lazy imports (vite.config.ts loginGuard
// keeps console modules and console-only libraries out of its graph).
const loginJs = loginText.filter(([f]) => f.endsWith(".js"));
if (loginJs.length !== 1)
  problems.push(`sign-in page has ${loginJs.length} JS chunks (expected 1: keep it small and isolated)`);
for (const [f, t] of loginJs) {
  if (/\bimport\(/.test(t)) problems.push(`${f}: dynamic import in the sign-in page`);
}
const consoleJs = consoleText.filter(([f]) => f.endsWith(".js"));
if (consoleJs.length < 2) problems.push(`console has ${consoleJs.length} JS chunk(s): the per-page split is missing`);

const portal = text(portalDist);
for (const [f, t] of portal)
  for (const m of CONSOLE) if (t.includes(m)) problems.push(`${f}: console marker ${m} in the portal`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `bundles: console ${consoleText.length} files (${consoleJs.length} JS chunks), sign-in ${loginText.length}, portal ${portal.length} checked`,
);
