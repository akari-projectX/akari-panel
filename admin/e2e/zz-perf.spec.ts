// Timing suite (implementation-plan §3): first screen
// (navigation → `main[data-ready]`, and LCP), page switches (sidebar / tab
// bar tap → the target's `main[data-ready]`, both stamped in the page) dashboard → users → nodes →
// orders → settings, and scrolling a 2,000-row user list (rAF gaps), on a
// desktop and on a "mid phone" (Pixel 7 viewport, CDP CPU ×4, Fast 3G).
// Every metric: 7 runs, the first (cold cache) reported apart as "first
// visit", the median of the other 6 against admin/perf-budget.json, divided
// by the host factor (below). The results go to test-results/perf.json and
// the GitHub step summary. Budget overruns fail the test only when
// perf-budget.json has `"blocking": true` (or PERF_BLOCKING=1); otherwise
// they are printed.
// Host factor: the same code measured on different CI runners differs by up
// to 3x (phone "users" switch: 299-894 ms over 26 runs, 0.93 correlated with
// the desktop run of the same job), which is more than any budget's headroom.
// So each environment first times a fixed amount of main-thread work under its
// own throttle (`hostCpuMs`); a runner slower than the reference one
// (perf-budget.json `host.reference_cpu_ms`) gets its medians divided by the
// slowdown (at most `host.max_factor`), a faster one is not held to a
// tighter budget. A real regression slows the app, not the probe, so it still
// shows.
// Where the time goes: test-results/perf-timeline.json has the first
// screen's request timeline (cold, warm) and, for every warm switch, the
// requests since the click (start / end / KB), the main thread's long tasks,
// when the click reached the page and when the first API response ended.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { devices, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { CONSOLE, api, sql } from "./helpers";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUDGET_FILE = JSON.parse(readFileSync(join(HERE, "..", "perf-budget.json"), "utf8")) as {
  blocking?: boolean;
  host: { reference_cpu_ms: Record<Env, number>; max_factor: number };
  desktop: Record<string, number>;
  phone: Record<string, number>;
};
const BLOCKING = BUDGET_FILE.blocking === true || process.env.PERF_BLOCKING === "1";
// The median of 6 warm runs: one slow switch (a noisy neighbour on a shared runner) moves it less than the median of 4.
const RUNS = 7;
const SWITCHES: [string, string][] = [
  ["用户", "users"],
  ["节点", "nodes"],
  ["订单", "orders"],
  ["系统设置", "settings"],
  ["仪表盘", "dashboard"],
];

type Env = "desktop" | "phone";
type Result = {
  env: Env;
  metric: string;
  first: number;
  median: number;
  /** The slowdown of this runner against the reference one (>= 1) the median is divided by. */
  hostFactor: number;
  /** `median / hostFactor`: what the budget is compared with. */
  adjusted: number;
  budget?: number;
  over: boolean;
};

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
  // Per document: long tasks, the last click's time, and when each page became ready.
  await ctx.addInitScript(() => {
    type W = typeof window & { __perf?: { long: [number, number][]; clicks: number[]; ready: Record<string, number> } };
    const p: NonNullable<W["__perf"]> = { long: [], clicks: [], ready: {} };
    (window as W).__perf = p;
    performance.setResourceTimingBufferSize(5000);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) p.long.push([Math.round(e.startTime), Math.round(e.duration)]);
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // No long-task timing in this browser.
    }
    addEventListener("click", () => p.clicks.push(performance.now()), true);
    new MutationObserver(() => {
      const m = document.querySelector("main[data-ready]");
      const id = m?.getAttribute("data-page");
      if (id && !(id in p.ready)) p.ready[id] = performance.now();
    }).observe(document, { subtree: true, attributes: true, childList: true, attributeFilter: ["data-ready"] });
  });
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

/** What `hostCpuMs` measured per environment (the throttle included). */
const hostCpu: Partial<Record<Env, number>> = {};

/**
 * How fast this runner is: a fixed amount of integer work on the page's main
 * thread, timed in the page under the environment's own throttle; the best of
 * 7 (the others carry the scheduler's noise, the first the JIT warm-up).
 */
async function hostCpuMs(page: Page): Promise<number> {
  const runs: number[] = [];
  for (let i = 0; i < 7; i++)
    runs.push(
      await page.evaluate(() => {
        let x = 123456789;
        const t0 = performance.now();
        for (let n = 0; n < 4_000_000; n++) {
          x ^= x << 13;
          x ^= x >>> 17;
          x ^= x << 5;
        }
        // Read the result, or the loop may be optimised away.
        return x === 0 ? -1 : performance.now() - t0;
      }),
    );
  return Math.min(...runs);
}

/** The runner's slowdown against the reference one, 1 at the fastest (never below). */
function hostFactor(env: Env): number {
  const measured = hostCpu[env];
  const reference = BUDGET_FILE.host.reference_cpu_ms[env];
  if (measured === undefined || !(reference > 0)) return 1;
  return Math.min(BUDGET_FILE.host.max_factor, Math.max(1, measured / reference));
}

async function ready(page: Page, id: string): Promise<void> {
  await expect(page.locator(`main[data-page="${id}"][data-ready]`)).toBeVisible({ timeout: 60_000 });
}

/** Where the first screen's time goes: every request (start → end, bytes on the wire), relative to navigation start. */
type Req = { name: string; start: number; end: number; kb: number };
type Timeline = { readyMs: number; requests: Req[] };
const timelines: Record<string, Timeline> = {};

/**
 * Where a switch's time goes, relative to the moment before the click (ms):
 * when the (first) click reached the page, the requests since (chunks from
 * the cache show 0 KB), the long tasks (start, duration), the first API
 * response's end, and when main[data-ready] appeared for the target.
 */
type SwitchTrace = {
  /** Tap → ready, in the page (the reported switch time). */
  totalMs: number;
  /** Before the click → ready seen by the test (includes Playwright's round trips). */
  wallMs: number;
  clickAt: number | null;
  readyAt: number | null;
  firstApiEnd: number | null;
  longTasksMs: number;
  long: [number, number][];
  requests: Req[];
};
const switches: Record<string, SwitchTrace> = {};

async function traceStart(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

async function traceEnd(page: Page, t0: number, id: string, totalMs: number, wallMs: number): Promise<SwitchTrace> {
  const t = await page.evaluate(
    ([t0, id]) => {
      type W = typeof window & {
        __perf?: { long: [number, number][]; clicks: number[]; ready: Record<string, number> };
      };
      const p = (window as W).__perf ?? { long: [], clicks: [], ready: {} };
      const rel = (x: number) => Math.round(x - t0);
      const requests = performance
        .getEntriesByType("resource")
        .filter((e) => e.startTime >= t0)
        .map((e) => {
          const r = e as PerformanceResourceTiming;
          return {
            name: r.name.replace(/^https?:\/\/[^/]+/, "").replace(/^\/[^/]+\//, "/"),
            start: rel(r.startTime),
            end: rel(r.responseEnd),
            kb: Math.round((r.transferSize || 0) / 102.4) / 10,
          };
        });
      const api = requests.filter((r) => r.name.startsWith("/api/"));
      const long = p.long.filter(([s]) => s >= t0).map(([s, d]) => [rel(s), d] as [number, number]);
      const click = p.clicks.find((c) => c >= t0);
      return {
        clickAt: click === undefined ? null : rel(click),
        readyAt: id in p.ready ? rel(p.ready[id]) : null,
        firstApiEnd: api.length ? Math.min(...api.map((r) => r.end)) : null,
        longTasksMs: long.reduce((n, [, d]) => n + d, 0),
        long,
        requests,
      };
    },
    [t0, id] as const,
  );
  return { totalMs, wallMs, ...t };
}

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
    hostCpu[env] = await hostCpuMs(page);
    const fsReady: number[] = [];
    const lcp: number[] = [];
    const sw: Record<string, number[]> = {};
    for (let run = 0; run < RUNS; run++) {
      const f = await firstScreen(page, run === 0 ? `${env}-cold` : run === 1 ? `${env}-warm` : undefined);
      fsReady.push(f.ready);
      lcp.push(f.lcp);
      for (const [name, id] of SWITCHES) {
        const p0 = await traceStart(page);
        const t0 = Date.now();
        await click(page, env, name);
        await ready(page, id);
        const wall = Date.now() - t0;
        // The switch = the tap on the target's link → its main[data-ready],
        // both stamped in the page (Playwright's own round trips and its
        // assertion polling are not the user's wait). Behind "更多" that is
        // the second tap; the wall-clock time stays in the timeline.
        const inPage = await page.evaluate(
          ([p0, id]) => {
            const p = (window as typeof window & { __perf?: { clicks: number[]; ready: Record<string, number> } })
              .__perf;
            const r = p?.ready[id];
            const c = r === undefined ? undefined : p?.clicks.filter((x) => x >= p0 && x <= r).pop();
            return r === undefined || c === undefined ? null : Math.round(r - c);
          },
          [p0, id] as const,
        );
        const ms = inPage ?? wall;
        (sw[id] ??= []).push(ms);
        if (run > 0) switches[`${env}-${id}-run${run}`] = await traceEnd(page, p0, id, ms, wall);
        // Ready times are recorded once per page id: clear them so the next visit (e.g. "more" again) is timed anew.
        await page.evaluate(() => {
          const p = (window as typeof window & { __perf?: { ready: Record<string, number> } }).__perf;
          if (p) p.ready = {};
        });
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

test("perf: first screen, page switches, big list", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "both environments are measured from the desktop project");
  test.setTimeout(900_000);
  const results: Result[] = [];
  const add = (env: Env, metric: string, xs: number[]) => {
    const budget = BUDGET_FILE[env]?.[metric];
    const m = median(xs.slice(1));
    const factor = hostFactor(env);
    results.push({
      env,
      metric,
      first: Math.round(xs[0]),
      median: Math.round(m),
      hostFactor: Math.round(factor * 100) / 100,
      adjusted: Math.round(m / factor),
      budget,
      over: !!budget && m / factor > budget,
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
  writeFileSync(join(out, "perf-timeline.json"), JSON.stringify({ firstScreen: timelines, switches }, null, 2));
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
  // Every warm switch in one line; run 2's in full (requests and long tasks).
  for (const [label, t] of Object.entries(switches)) {
    console.log(
      `perf switch ${label}: total ${t.totalMs} ms (wall ${t.wallMs} ms) · click at ${t.clickAt ?? "—"} · first API end ${t.firstApiEnd ?? "—"} · ready at ${t.readyAt ?? "—"} · long tasks ${t.longTasksMs} ms (${t.long.length}) · ${t.requests.length} requests`,
    );
    if (!label.endsWith("-run2")) continue;
    for (const r of [...t.requests].sort((a, b) => a.start - b.start))
      console.log(
        `  ${String(r.start).padStart(5)}–${String(r.end).padStart(5)} ms ${String(r.kb).padStart(7)} KB ${r.name}`,
      );
    if (t.long.length) console.log(`  long tasks (start+duration): ${t.long.map(([a, d]) => `${a}+${d}`).join(" ")}`);
  }
  const mark = (r: Result) => (r.over ? (BLOCKING ? "**over**" : "over (report-only)") : "ok");
  const rows = results.map(
    (r) =>
      `| ${r.env} | ${r.metric} | ${r.first} | ${r.median} | ${r.hostFactor} | ${r.adjusted} | ${r.budget ?? "—"} | ${mark(r)} |`,
  );
  const md = [
    `### Admin timing (${BLOCKING ? "blocking" : "report-only"})`,
    "",
    `Runner speed probe (best of 7, ms; reference ${JSON.stringify(BUDGET_FILE.host.reference_cpu_ms)}): ${JSON.stringify(hostCpu)}`,
    "",
    "| env | metric | first visit | median (warm, 6 runs) | host factor | median / host factor | budget | |",
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  if (BLOCKING)
    expect(
      results
        .filter((r) => r.over)
        .map(
          (r) =>
            `${r.env} ${r.metric}: median ${r.median} ms / host factor ${r.hostFactor} = ${r.adjusted} ms > budget ${r.budget} ms`,
        ),
      "perf budget (admin/perf-budget.json)",
    ).toEqual([]);
});
