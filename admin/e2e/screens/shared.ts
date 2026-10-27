// Screens for design compare (zz-screens.spec.ts): the shared types, the
// context every area's shots receive, and small open helpers. Area files
// (`<area>.ts`, same names as design/…/prototype/scripts/shots/*.json)
// export `shots` and optionally `setup` (extra data for their own shots).
// See README.md.
import { expect, type Page, type TestInfo } from "@playwright/test";

import { CONSOLE, apiJson, uniq } from "../helpers";

export type Device = "desktop" | "mobile";
export type Theme = "light" | "dark";

/** Data the shots open. Areas add their own ids in `setup` (put them in `extra`). */
export type Ctx = {
  info: TestInfo;
  userId?: string;
  userEmail?: string;
  planId?: string;
  orderId?: string;
  nodeId?: string;
  serverId?: string;
  /** A relay entrance of our own (falls back to any entrance in the data). */
  entranceId?: string;
  extra: Record<string, string | undefined>;
};

export type Shot = {
  /** The v2 PNG name without `-<device>-<theme>.png` (e.g. "users-list-default"). */
  name: string;
  /** Navigate and wait until the screen is shown; throw if it cannot be. */
  open: (page: Page, ctx: Ctx, device: Device) => Promise<void>;
  /** Whole page, like the v2 shot's `fullPage` (viewport grown to the page height, ≤6000px). */
  full?: boolean;
  /** Only these devices (default both). */
  devices?: Device[];
  /** Undo what `open` changed in the reused browser context (localStorage …); runs even when the shot failed. */
  after?: (page: Page) => Promise<void>;
};

/** Set (or remove, null) a localStorage key of the console origin. */
export async function setStorage(page: Page, key: string, value: string | null): Promise<void> {
  await page.evaluate(
    ([k, v]) => (v === null ? localStorage.removeItem(k!) : localStorage.setItem(k!, v)),
    [key, value],
  );
}

/** The page's data has arrived (shell.tsx sets main[data-ready]). */
const ready = (page: Page) => expect(page.locator("main[data-ready]")).toBeVisible({ timeout: 20_000 });

/** Open a console path ("" = dashboard, "/users?open=…") and wait for its data. */
export async function goto(page: Page, path: string): Promise<void> {
  await page.goto(`${CONSOLE}${path}`);
  await ready(page);
}

/** A shot that only opens a console path. */
export const go =
  (path: string) =>
  async (page: Page): Promise<void> =>
    goto(page, path);

/** Open a path, then wait for a dialog (or alertdialog) to be visible. */
export const goDialog =
  (path: (c: Ctx) => string, role: "dialog" | "alertdialog" = "dialog") =>
  async (page: Page, c: Ctx): Promise<void> => {
    await goto(page, path(c));
    await expect(page.getByRole(role).first()).toBeVisible();
  };

/** Throw (the shot is reported as not taken) when a ctx id is missing. */
export function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`no ${what} in the data`);
  return v;
}

/**
 * The shared data: a user with a plan bought through a manual order, and a
 * node with a relay entrance — made here so no screen is empty even if the
 * other specs failed or cleaned up.
 */
export async function buildCtx(info: TestInfo): Promise<Ctx> {
  const c: Ctx = { info, extra: {} };
  const email = `${uniq(info, "screens")}@e2e.test`;
  const u = await apiJson<{ id: string }>("POST", "/users", { email, password: "screens-pass-1" });
  c.userId = u.id;
  c.userEmail = email;
  const plan = await apiJson<{ id: string }>("POST", "/plans", {
    name: uniq(info, "screens 月付"),
    period: "monthly",
    pricing: { on_sale: false, prices: [{ period: "month", price_cents: 2900 }] },
  });
  c.planId = plan.id;
  const order = await apiJson<{ id: string }>("POST", "/orders/manual", {
    user_id: u.id,
    plan_id: plan.id,
    period: "month",
    reason: "screens",
  });
  c.orderId = order.id;
  try {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const node = await apiJson<{ id: string; server_id?: string }>("POST", "/nodes", {
      name: uniq(info, "screens-node"),
      region: "JP",
      inbound: { protocol: "vmess", port, settings: { clients: [] } },
    });
    c.nodeId = node.id;
    c.serverId = node.server_id;
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
    const servers = await apiJson<
      { id: string; nodes?: { id: string; entrances?: { id: string; kind: string }[] }[] }[]
    >("GET", "/servers");
    const all = servers.flatMap((s) => (s.nodes ?? []).flatMap((n) => n.entrances ?? []));
    c.entranceId = (all.find((e) => e.kind === "relay") ?? all[0])?.id;
    c.serverId ??= servers[0]?.id;
  }
  return c;
}
