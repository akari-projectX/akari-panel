// Screenshot set for review (not an assertion suite): the main screens on a
// desktop and a phone, light and dark, written to test-results/screens/ and
// uploaded by CI as the `admin-screens` artifact. Runs once (in the desktop
// project) with its own browser contexts per device × colour scheme.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { devices, expect, test, type Browser, type Page } from "@playwright/test";

import { CONSOLE, LOGIN, api, apiJson, uniq } from "./helpers";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results", "screens");
const DEVICES = { desktop: devices["Desktop Chrome"], mobile: devices["Pixel 7"] } as const;
const SCHEMES = ["light", "dark"] as const;
const PAGES: [string, string][] = [
  ["02-dashboard", ""],
  ["04-users", "/users"],
  ["05-orders", "/orders"],
  ["06-nodes", "/nodes"],
  ["07-plans", "/plans"],
  ["08-tickets", "/tickets"],
  ["09-settings", "/settings"],
  ["09-settings-domains", "/settings/domains"],
  ["09-settings-payments", "/settings/payments"],
  ["09-mail-templates", "/settings/mail-templates"],
  ["11-finance", "/finance"],
  ["11-coupons", "/coupons"],
  ["12-alerts", "/alerts"],
  ["12-updates", "/updates"],
  ["12-audit", "/audit"],
  ["10-status", "/status"],
];

test.describe.configure({ mode: "serial" });

async function shot(page: Page, file: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await Promise.race([page.evaluate(() => document.fonts.ready.then(() => undefined)), page.waitForTimeout(5_000)]);
  await page.waitForTimeout(700); // charts and the page-in transition
  await page.screenshot({ path: join(OUT, `${file}.png`), fullPage: true, animations: "disabled" });
}

async function ready(page: Page): Promise<void> {
  await expect(page.locator("main[data-ready]")).toBeVisible({ timeout: 20_000 });
}

/** Run `fn`, keep going on failure (a screenshot set, not a test of the pages). */
async function attempt(what: string, fn: () => Promise<void>, failed: string[]): Promise<void> {
  try {
    await fn();
  } catch (e) {
    failed.push(`${what}: ${(e as Error).message.split("\n")[0]}`);
  }
}

async function screens(
  browser: Browser,
  device: keyof typeof DEVICES,
  scheme: "light" | "dark",
  userId: string,
): Promise<string[]> {
  const failed: string[] = [];
  const ctx = await browser.newContext({ ...DEVICES[device], locale: "zh-CN", colorScheme: scheme });
  const page = await ctx.newPage();
  // A stuck step must not eat the whole set: every action and wait gives up quickly.
  page.setDefaultTimeout(15_000);
  const tag = `${device}-${scheme}`;
  await attempt(
    "login",
    async () => {
      await page.goto(LOGIN);
      await expect(page.locator("#email")).toBeVisible();
      await shot(page, `01-login-${tag}`);
    },
    failed,
  );
  await ctx.addCookies((await (await api()).storageState()).cookies);
  for (const [name, path] of PAGES)
    await attempt(
      name,
      async () => {
        await page.goto(`${CONSOLE}${path}`);
        await ready(page);
        await shot(page, `${name}-${tag}`);
      },
      failed,
    );
  await attempt(
    "user detail",
    async () => {
      await page.goto(`${CONSOLE}/users?open=${userId}`);
      await expect(page.getByRole("dialog")).toBeVisible();
      await shot(page, `04-users-detail-${tag}`);
    },
    failed,
  );
  await attempt(
    "palette",
    async () => {
      await page.goto(CONSOLE);
      await ready(page);
      if (device === "mobile") await page.getByRole("button", { name: "搜索", exact: true }).click();
      else await page.keyboard.press("ControlOrMeta+k");
      const input = page.getByRole("dialog").getByLabel("搜索");
      await expect(input).toBeVisible();
      await input.fill("u");
      await shot(page, `03-palette-${tag}`);
      await page.keyboard.press("Escape");
    },
    failed,
  );
  if (device === "mobile")
    await attempt(
      "more",
      async () => {
        await page.getByRole("navigation", { name: "标签栏" }).getByRole("link", { name: /更多/ }).click();
        await ready(page);
        await shot(page, `03-more-${tag}`);
      },
      failed,
    );
  else
    await attempt(
      "sidebar collapsed",
      async () => {
        await page.getByRole("button", { name: "收起侧边栏" }).click();
        await shot(page, `03-sidebar-collapsed-${tag}`);
        await page.getByRole("button", { name: "展开侧边栏" }).click();
      },
      failed,
    );
  await ctx.close();
  return failed;
}

test("screens: desktop + phone × light + dark", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "one set, taken from the desktop project");
  test.setTimeout(600_000);
  // A little data so the dashboard and lists are not empty.
  const u = await apiJson<{ id: string }>("POST", "/users", {
    email: `${uniq(info, "screens")}@e2e.test`,
    password: "screens-pass-1",
  });
  const plan = await apiJson<{ id: string }>("POST", "/plans", {
    name: uniq(info, "screens 月付"),
    period: "monthly",
    pricing: { on_sale: false, prices: [{ period: "month", price_cents: 2900 }] },
  });
  await apiJson("POST", "/orders/manual", { user_id: u.id, plan_id: plan.id, period: "month", reason: "screens" });
  const failed: string[] = [];
  for (const device of ["desktop", "mobile"] as const)
    for (const scheme of SCHEMES)
      failed.push(...(await screens(browser, device, scheme, u.id)).map((f) => `${device}/${scheme} ${f}`));
  // Reported, not fatal: the set is for review.
  if (failed.length) console.log(`screens not taken:\n${failed.join("\n")}`);
  info.annotations.push({ type: "screens", description: failed.length ? failed.join("; ") : "all taken" });
});
