// Screenshot set for design review (not an assertion suite): the same
// screens, viewports and themes as the design drafts
// (design/admin-redesign-2026-10/prototype/scripts/screenshots.mjs:
// 1440×900 and 390×844 @2x, light + dark, viewport-only), taken from the
// real app after the other specs left data behind. Written to
// test-results/screens/<name>-<desktop|mobile>-<light|dark>.png and
// uploaded by CI as the `admin-screens` artifact; the lead puts them next
// to the drafts in design/admin-redesign-2026-10/compare/. A screen that
// cannot be taken is reported, not failed.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

import { CONSOLE, LOGIN, api, apiJson, uniq } from "./helpers";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "test-results", "screens");
const VP = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
} as const;
type Device = keyof typeof VP;
type Theme = "light" | "dark";
type Ctx = { userId?: string; entranceId?: string };
type Screen = [name: string, open: (page: Page, c: Ctx, device: Device) => Promise<void>];

test.describe.configure({ mode: "serial" });

const ready = (page: Page) => expect(page.locator("main[data-ready]")).toBeVisible({ timeout: 20_000 });
const go = (path: string) => async (page: Page) => {
  await page.goto(`${CONSOLE}${path}`);
  await ready(page);
};

// Every draft that has all four variants.
const PAGES: Screen[] = [
  [
    "login",
    async (page) => {
      await page.goto(LOGIN);
      await expect(page.locator("#email")).toBeVisible();
    },
  ],
  ["dashboard", go("")],
  ["users", go("/users")],
  [
    "users-detail",
    async (page, c) => {
      await go(`/users?open=${c.userId}`)(page);
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  ],
  ["nodes", go("/nodes")],
  [
    "nodes-entrance-edit",
    async (page, c) => {
      if (!c.entranceId) throw new Error("no entrance in the data");
      await go(`/nodes?open=entrance:${c.entranceId}`)(page);
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  ],
  ["orders", go("/orders")],
  ["settings-overview", go("/settings")],
  ["settings-domains", go("/settings/domains")],
  ["settings-payments", go("/settings/payments")],
  ["settings-signup", go("/settings/signup")],
  ["mail-templates", go("/settings/mail-templates")],
];

// Interaction states: desktop light + phone dark, like the drafts.
const EXTRAS: Screen[] = [
  [
    "palette",
    async (page, _c, device) => {
      await go("")(page);
      if (device === "mobile") await page.getByRole("button", { name: "搜索", exact: true }).click();
      else await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("combobox", { name: "搜索" })).toBeVisible();
    },
  ],
  [
    "danger-confirm",
    async (page, c) => {
      if (!c.entranceId) throw new Error("no relay entrance in the data");
      await go(`/nodes?open=entrance:${c.entranceId}`)(page);
      await page.getByRole("dialog").getByRole("button", { name: /删除/ }).last().click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  ],
  [
    "users-bulk-delete",
    async (page) => {
      await go("/users")(page);
      const boxes = page.locator("[data-row]:visible").getByRole("checkbox");
      await boxes.nth(0).click();
      await boxes.nth(1).click();
      await page.getByRole("button", { name: /删除/ }).last().click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  ],
  ["orders-empty", go("/orders?q=no-such-order-zzzz")],
  [
    "more",
    async (page, _c, device) => {
      await go(device === "mobile" ? "/more" : "")(page);
    },
  ],
];

async function take(
  browser: Browser,
  device: Device,
  theme: Theme,
  screens: Screen[],
  c: Ctx,
  failed: string[],
): Promise<void> {
  const ctx = await browser.newContext({ ...VP[device], colorScheme: theme, reducedMotion: "reduce", locale: "zh-CN" });
  await ctx.addCookies((await (await api()).storageState()).cookies);
  const page = await ctx.newPage();
  page.setDefaultTimeout(15_000);
  for (const [name, open] of screens) {
    try {
      await open(page, c, device);
      await Promise.race([page.evaluate(() => document.fonts.ready.then(() => undefined)), page.waitForTimeout(5_000)]);
      await page.waitForTimeout(500); // charts
      await page.screenshot({ path: join(OUT, `${name}-${device}-${theme}.png`) });
    } catch (e) {
      failed.push(`${name}-${device}-${theme}: ${(e as Error).message.split("\n")[0]}`);
    }
    await page.keyboard.press("Escape").catch(() => {});
  }
  await ctx.close();
}

test("screens: the drafted screens from the real app", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "one set, taken from the desktop project");
  test.setTimeout(900_000);
  mkdirSync(OUT, { recursive: true });
  // Some data of our own, so no screen is empty even if other specs failed.
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
  // A node with a relay entrance of our own (the node specs may have failed or cleaned up).
  const c: Ctx = { userId: u.id };
  try {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const node = await apiJson<{ id: string }>("POST", "/nodes", {
      name: uniq(info, "screens-node"),
      region: "JP",
      inbound: { protocol: "vmess", port, settings: { clients: [] } },
    });
    const relay = await apiJson<{ id: string }>("POST", `/nodes/${node.id}/entrances`, {
      name: "IPLC 专线",
      connect_host: "relay.example.com",
      connect_port: 30001,
      listen_port: port + 1,
      source_cidrs: ["203.0.113.7/32"],
      rate: 1.5,
    });
    c.entranceId = relay.id;
  } catch (e) {
    console.log(`screens: no relay entrance of our own (${(e as Error).message.split("\n")[0]})`);
    const servers = await apiJson<{ nodes?: { entrances?: { id: string; kind: string }[] }[] }[]>("GET", "/servers");
    const all = servers.flatMap((s) => (s.nodes ?? []).flatMap((n) => n.entrances ?? []));
    c.entranceId = (all.find((e) => e.kind === "relay") ?? all[0])?.id;
  }
  const failed: string[] = [];
  for (const device of ["desktop", "mobile"] as const)
    for (const theme of ["light", "dark"] as const) await take(browser, device, theme, PAGES, c, failed);
  await take(browser, "desktop", "light", EXTRAS, c, failed);
  await take(browser, "mobile", "dark", EXTRAS, c, failed);
  if (failed.length) console.log(`screens not taken:\n${failed.join("\n")}`);
  info.annotations.push({ type: "screens", description: failed.length ? failed.join("; ") : "all taken" });
});
