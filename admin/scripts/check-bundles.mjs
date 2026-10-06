#!/usr/bin/env node
// W33-b bundle guard (R23): the admin app and the user portal share
// nothing.
//   node scripts/check-bundles.mjs [adminDist=dist] [portalDist=../spa/dist/app]
// - the console bundle carries the console markers (else the check below
//   would pass vacuously);
// - the public sign-in page (dist/login) carries none of them;
// - the portal bundle (when present) carries none of them;
// - no admin bundle carries portal-only markers;
// - no admin JS has Vite's preload helper or absolute asset URLs (they
//   would bypass the admin prefix rewrite of src/console.rs).
// Runs after `npm run build`; smoke runs it again on the served files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const [adminDist = "dist", portalDist = "../spa/dist/app"] = process.argv.slice(2);

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
for (const [f, t] of [...consoleText, ...loginText].filter(([f]) => f.endsWith(".js"))) {
  if (t.includes("__vitePreload")) problems.push(`${f}: Vite preload helper (absolute URLs)`);
  for (const abs of ['"/admin/assets/', '"/app/assets/'])
    if (t.includes(abs)) problems.push(`${f}: absolute asset URL ${abs}`);
  if (/\bimport\(/.test(t)) problems.push(`${f}: dynamic import (one chunk per bundle)`);
}
const portal = text(portalDist);
for (const [f, t] of portal)
  for (const m of CONSOLE) if (t.includes(m)) problems.push(`${f}: console marker ${m} in the portal`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  `bundles: console ${consoleText.length} files, sign-in ${loginText.length}, portal ${portal.length} checked`,
);
