// Timing suite (implementation-plan §3), REPORT-ONLY for now: first screen
// (navigation → `main[data-ready]`, and LCP), page switches (sidebar / tab
// bar click → the target's `main[data-ready]`) dashboard → users → nodes →
// orders → settings, and scrolling a 2,000-row user list (rAF gaps), on a
// desktop and on a "mid phone" (Pixel 7 viewport, CDP CPU ×4, Fast 3G).
// Every metric: 5 runs, the first (cold cache) reported apart as "first
// visit", the median of the other 4 against admin/perf-budget.json. The
// results go to test-results/perf.json and the GitHub step summary; budget
// overruns are printed, not failed (until the budgets are settled).
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { devices, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { CONSOLE, api, sql } from "./helpers";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGET = JSON.parse(readFileSync(join(HERE, "..", "perf-budget.json"), "utf8")) as Record<
  string,
  Record<string, number>
>;
const RUNS = 5;
const SWITCHES: [string, string][] = [
  ["用户", "users"],
  ["节点", "nodes"],
  ["订单", "orders"],
  ["系统设置", "settings"],
  ["仪表盘", "dashboard"],
];

type Env = "desktop" | "phone";
type Result = { env: Env; metric: string; first: number; median: number; budget?: number; over: boolean };

test.describe.configure({ mode: "serial" });

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function context(browser: Browser, env: Env): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    ...(env === "desktop" ? devices["Desktop Chrome"] : devices["Pixel 7"]),
    locale: "zh-CN",
  });
  await ctx.addCookies((await (await api()).storageState()).cookies);
  return ctx;
}

async function throttle(page: Page, env: Env): Promise<void> {
  if (env !== "phone") return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });
}

async function ready(page: Page, id: string): Promise<void> {
  await expect(page.locator(`main[data-page="${id}"][data-ready]`)).toBeVisible({ timeout: 60_000 });
}

/** Where the first screen's time goes: every request (start → end, bytes on the wire), relative to navigation start. */
type Timeline = { readyMs: number; requests: { name: string; start: number; end: number; kb: number }[] };
const timelines: Record<string, Timeline> = {};

/** First screen: goto → ready, and the LCP the browser reports. */
async function firstScreen(page: Page, label?: string): Promise<{ ready: number; lcp: number }> {
  const t0 = Date.now();
  await page.goto(CONSOLE);
  await ready(page, "dashboard");
  const readyMs = Date.now() - t0;
  if (label)
    timelines[label] = {
      readyMs,
      requests: await page.evaluate(() =>
        [...performance.getEntriesByType("navigation"), ...performance.getEntriesByType("resource")].map((e) => {
          const r = e as PerformanceResourceTiming;
          return {
            name: r.name.replace(/^https?:\/\/[^/]+/, "").replace(/^\/[^/]+\//, "/"),
            start: Math.round(r.startTime),
            end: Math.round(r.responseEnd),
            kb: Math.round((r.transferSize || 0) / 102.4) / 10,
          };
        }),
      ),
    };
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let last = 0;
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) last = e.startTime;
        }).observe({ type: "largest-contentful-paint", buffered: true });
        setTimeout(() => resolve(last), 300);
      }),
  );
  return { ready: readyMs, lcp };
}

async function click(page: Page, env: Env, name: string): Promise<void> {
  if (env === "desktop") {
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name, exact: true }).click();
    return;
  }
  const tabs = page.getByRole("navigation", { name: "标签栏" });
  const tab = tabs.getByRole("link", { name: new RegExp(`^${name}`) });
  if (await tab.count()) return tab.first().click();
  await tabs.getByRole("link", { name: /^更多/ }).click();
  await ready(page, "more");
  await page
    .getByRole("navigation", { name: "全部页面" })
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .click();
}

/** rAF gaps while scrolling the user list to the bottom (p95, ms). */
async function scrollJank(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const gaps: number[] = [];
    let last = performance.now();
    let on = true;
    const tick = (t: number) => {
      gaps.push(t - last);
      last = t;
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    for (let i = 0; i < 60; i++) {
      window.scrollBy(0, 400);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    on = false;
    gaps.sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length * 0.95)] ?? 0;
  });
}

type Add = (env: Env, metric: string, xs: number[]) => void;

async function measure(browser: Browser, bigList: boolean, add: Add): Promise<void> {
  for (const env of ["desktop", "phone"] as const) {
    const ctx = await context(browser, env);
    const page = await ctx.newPage();
    await throttle(page, env);
    const fsReady: number[] = [];
    const lcp: number[] = [];
    const sw: Record<string, number[]> = {};
    for (let run = 0; run < RUNS; run++) {
      const f = await firstScreen(page, run === 0 ? `${env}-cold` : run === 1 ? `${env}-warm` : undefined);
      fsReady.push(f.ready);
      lcp.push(f.lcp);
      for (const [name, id] of SWITCHES) {
        const t0 = Date.now();
        await click(page, env, name);
        await ready(page, id);
        (sw[id] ??= []).push(Date.now() - t0);
      }
    }
    add(env, "first_screen_ready_ms", fsReady);
    add(env, "lcp_ms", lcp);
    for (const [id, xs] of Object.entries(sw)) add(env, `switch_${id}_ms`, xs);
    if (env === "desktop" && bigList) {
      const jank: number[] = [];
      for (let run = 0; run < RUNS; run++) {
        await page.goto(`${CONSOLE}/users?size=2000`);
        await ready(page, "users");
        jank.push(await scrollJank(page));
      }
      add(env, "list_scroll_raf_p95_ms", jank);
    }
    await ctx.close();
  }
}

test("perf: first screen, page switches, big list (report-only)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "both environments are measured from the desktop project");
  test.setTimeout(900_000);
  const results: Result[] = [];
  const add = (env: Env, metric: string, xs: number[]) => {
    const budget = BUDGET[env]?.[metric];
    const m = median(xs.slice(1));
    results.push({
      env,
      metric,
      first: Math.round(xs[0]),
      median: Math.round(m),
      budget,
      over: !!budget && m > budget,
    });
  };
  // 2,000 users for the list (beyond what the other specs created); skipped if the insert fails.
  let bigList = true;
  try {
    sql(
      "INSERT INTO users (id, email) SELECT gen_random_uuid(), 'perf-' || g || '@e2e.test' FROM generate_series(1, 2000) g ON CONFLICT DO NOTHING",
    );
  } catch (e) {
    bigList = false;
    console.log(`perf: no big list (${(e as Error).message.split("\n")[0]})`);
  }
  try {
    await measure(browser, bigList, add);
  } finally {
    // The phone project runs every spec after this one: leave no extra users behind.
    if (bigList) sql("DELETE FROM users WHERE email LIKE 'perf-%@e2e.test'");
  }
  const out = join(HERE, "..", "test-results");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "perf.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(out, "perf-timeline.json"), JSON.stringify(timelines, null, 2));
  for (const [label, t] of Object.entries(timelines))
    console.log(
      `perf timeline ${label}: ready ${t.readyMs} ms\n` +
        t.requests
          .sort((a, b) => a.start - b.start)
          .map(
            (r) =>
              `  ${String(r.start).padStart(5)}–${String(r.end).padStart(5)} ms ${String(r.kb).padStart(7)} KB ${r.name}`,
          )
          .join("\n"),
    );
  const rows = results.map(
    (r) =>
      `| ${r.env} | ${r.metric} | ${r.first} | ${r.median} | ${r.budget ?? "—"} | ${r.over ? "over (report-only)" : "ok"} |`,
  );
  const md = [
    "### Admin timing (report-only)",
    "",
    "| env | metric | first visit | median (warm, 4 runs) | budget | |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
});
