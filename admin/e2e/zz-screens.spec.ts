// Screenshot set for design review (not an assertion suite): the v2 design
// shots (design/admin-redesign-2026-10/screenshots-v2/, prototype/scripts/
// screenshots.mjs: 1440×900 and 390×844 @2x, light + dark) taken from the
// real app after the other specs left data behind. Shots are declared per
// area in e2e/screens/<area>.ts (same areas and names as the prototype's
// scripts/shots/<area>.json; format in e2e/screens/README.md). Written to
// test-results/screens/<name>-<desktop|mobile>-<light|dark>.png and uploaded
// by CI as the `admin-screens` artifact; the lead puts them next to the
// drafts in design/admin-redesign-2026-10/compare/. A shot that cannot be
// taken is reported (annotation + log), not failed.
//
// Time: the four variants run in parallel (one browser context each, reused
// for every shot), within SCREENS_BUDGET_MIN minutes (default 10; the CI
// e2e step has 50 minutes for both suites). Shots left when the budget runs
// out are reported as skipped. SCREENS_ONLY=people,nodes and
// SCREENS_MATCH=detail narrow the set.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, type Browser } from "@playwright/test";

import { api } from "./helpers";
import * as commerce from "./screens/commerce";
import * as nodes from "./screens/nodes";
import * as ops from "./screens/ops";
import * as people from "./screens/people";
import * as settings from "./screens/settings";
import { buildCtx, type Ctx, type Device, type Shot, type Theme } from "./screens/shared";
import * as support from "./screens/support";

type Area = { shots: Shot[]; setup?: (c: Ctx) => Promise<void> };
const AREAS: Record<string, Area> = { ops, people, commerce, nodes, settings, support };

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results", "screens");
const VP = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;
const BUDGET_MS = Number(process.env.SCREENS_BUDGET_MIN ?? 10) * 60_000;

test.describe.configure({ mode: "serial" });

async function take(
  browser: Browser,
  device: Device,
  theme: Theme,
  shots: Shot[],
  c: Ctx,
  deadline: number,
  failed: string[],
): Promise<number> {
  const ctx = await browser.newContext({
    ...VP[device],
    colorScheme: theme,
    reducedMotion: "reduce",
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  await ctx.addCookies((await (await api()).storageState()).cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  // A settings section with unsaved edits asks before unload: leave anyway.
  page.on("dialog", (d) => void d.accept().catch(() => {}));
  let taken = 0;
  for (const s of shots) {
    const id = `${s.name}-${device}-${theme}`;
    if (s.devices && !s.devices.includes(device)) continue;
    if (Date.now() > deadline) {
      failed.push(`${id}: skipped (time budget)`);
      continue;
    }
    try {
      await s.open(page, c, device);
      await Promise.race([page.evaluate(() => document.fonts.ready.then(() => undefined)), page.waitForTimeout(5_000)]);
      await page.waitForTimeout(400); // charts, transitions
      if (s.full) {
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.setViewportSize({ width: VP[device].viewport.width, height: Math.min(Math.max(h, 1), 6000) });
        await page.waitForTimeout(200);
      }
      await page.screenshot({ path: join(OUT, `${id}.png`) });
      taken++;
    } catch (e) {
      failed.push(`${id}: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      if (s.full) await page.setViewportSize(VP[device].viewport).catch(() => {});
      if (s.after) await s.after(page).catch(() => {});
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
  await ctx.close();
  return taken;
}

test("screens: the v2 design shots from the real app", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "one set, taken from the desktop project");
  test.setTimeout(BUDGET_MS + 5 * 60_000);
  const start = Date.now();
  mkdirSync(OUT, { recursive: true });
  const only = process.env.SCREENS_ONLY?.split(",").map((s) => s.trim());
  const match = process.env.SCREENS_MATCH;
  const failed: string[] = [];

  const c = await buildCtx(info);
  const shots: Shot[] = [];
  for (const [name, area] of Object.entries(AREAS)) {
    if (only && !only.includes(name)) continue;
    try {
      await area.setup?.(c);
    } catch (e) {
      failed.push(`${name} setup: ${(e as Error).message.split("\n")[0]}`);
    }
    shots.push(...area.shots.filter((s) => !match || s.name.includes(match)));
  }
  const seen = new Set<string>();
  for (const s of shots) {
    if (seen.has(s.name)) failed.push(`${s.name}: duplicate shot name`);
    seen.add(s.name);
  }

  const deadline = start + BUDGET_MS;
  const variants = (["desktop", "mobile"] as const).flatMap((d) =>
    (["light", "dark"] as const).map((t) => [d, t] as const),
  );
  const counts = await Promise.all(variants.map(([d, t]) => take(browser, d, t, shots, c, deadline, failed)));
  const taken = counts.reduce((a, b) => a + b, 0);
  const summary = `${taken} screenshots of ${shots.length} shots in ${Math.round((Date.now() - start) / 1000)}s`;
  console.log(`screens: ${summary}`);
  if (failed.length) console.log(`screens not taken:\n${failed.join("\n")}`);
  info.annotations.push({ type: "screens", description: failed.length ? `${summary}; ${failed.join("; ")}` : summary });
});
