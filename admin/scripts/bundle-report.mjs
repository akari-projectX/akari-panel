#!/usr/bin/env node
// Bundle size report (implementation-plan §3: report only, never a gate —
// user ruling 2026-10-07). Writes dist/bundle-report.json (gzip bytes per
// file, grouped: sign-in page, console entry, page chunks, CSS, fonts) and,
// under GitHub Actions, a table in the step summary. With a baseline report
// (BUNDLE_BASELINE=path, CI downloads main's last report) it shows deltas.
//   node scripts/bundle-report.mjs [dist=dist]
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const dist = process.argv[2] ?? "dist";

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** A stable name: the file name without its content hash. */
const stable = (p) => relative(dist, p).replace(/[-.][A-Za-z0-9_-]{8}(?=\.(js|css|woff2)$)/, "");

const entries = {};
for (const f of files(dist)) {
  if (!/\.(js|css|woff2|html)$/.test(f)) continue;
  const raw = readFileSync(f);
  const gz = f.endsWith(".woff2") ? raw.length : gzipSync(raw, { level: 9 }).length;
  entries[stable(f)] = { raw: raw.length, gzip: gz };
}

const group = (name) => {
  if (name.startsWith("login/")) return name.endsWith(".woff2") ? "fonts" : "sign-in page";
  if (name.endsWith(".woff2")) return "fonts";
  if (name.endsWith(".css")) return "console CSS";
  if (/console\/assets\/index\.js$/.test(name)) return "console entry";
  if (name.endsWith(".html")) return "html";
  return "console chunks";
};
const totals = {};
for (const [k, v] of Object.entries(entries)) {
  const g = group(k);
  totals[g] = (totals[g] ?? 0) + v.gzip;
}
const report = { totals, entries };
writeFileSync(join(dist, "bundle-report.json"), JSON.stringify(report, null, 2));

const baseFile = process.env.BUNDLE_BASELINE;
const base = baseFile && existsSync(baseFile) ? JSON.parse(readFileSync(baseFile, "utf8")) : null;
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;
const delta = (now, then) => {
  if (then === undefined) return base ? "new" : "";
  const d = now - then;
  return d === 0 ? "±0" : `${d > 0 ? "+" : "−"}${kb(Math.abs(d))}`;
};

const lines = [
  "### Admin bundle sizes (gzip; fonts raw) — report only",
  "",
  `| group | size | ${base ? "vs main |" : ""}`,
  `|---|---|${base ? "---|" : ""}`,
  ...Object.entries(totals)
    .sort()
    .map(([g, n]) => `| ${g} | ${kb(n)} | ${base ? `${delta(n, base.totals?.[g])} |` : ""}`),
  "",
  "<details><summary>JS chunks</summary>",
  "",
  `| chunk | gzip | ${base ? "vs main |" : ""}`,
  `|---|---|${base ? "---|" : ""}`,
  ...Object.entries(entries)
    .filter(([k]) => k.endsWith(".js"))
    .sort((a, b) => b[1].gzip - a[1].gzip)
    .map(
      ([k, v]) =>
        `| ${basename(k)} (${k.split("/")[0]}) | ${kb(v.gzip)} | ${base ? `${delta(v.gzip, base.entries?.[k]?.gzip)} |` : ""}`,
    ),
  "",
  "</details>",
  "",
];
const md = lines.join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(
  `bundle report: ${Object.entries(totals)
    .map(([g, n]) => `${g} ${kb(n)}`)
    .join(", ")}`,
);
