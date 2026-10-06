// Shared e2e helpers: environment, sign-in (UI and API), the database (setup
// that has no UI on purpose, e.g. a firing alert), CSP watching, and
// layout-neutral locators (rows render as a table on desktop and as cards
// on a phone; only the visible one is used).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expect,
  request,
  type APIRequestContext,
  type ConsoleMessage,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

export function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (run scripts/e2e.sh)`);
  return v;
}

export const LOGIN = must("E2E_LOGIN"); // http://host:port/<prefix>/app
export const CONSOLE = LOGIN.replace(/\/app$/, "/admin");
export const ORIGIN = new URL(LOGIN).origin;
export const PREFIX = new URL(LOGIN).pathname.split("/")[1];
export const API = `${ORIGIN}/${PREFIX}/api/v1`;
export const ADMIN = must("E2E_ADMIN");
export const ADMIN_PW = must("E2E_ADMIN_PW");
export const USER = must("E2E_USER");
export const USER_PW = must("E2E_USER_PW");
export const DB = must("E2E_DB");
export const MAILPIT = process.env.E2E_MAILPIT ?? "";
export const SMTP_PORT = Number(process.env.E2E_SMTP_PORT ?? 0);
export const PAY_DIR = process.env.E2E_PAY_DIR ?? "";
export const RELEASE_SOURCE = process.env.E2E_RELEASE_SOURCE ?? "";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A name unique to this project run ("desktop" / "mobile"). */
export function uniq(info: TestInfo, base: string): string {
  return `${base}-${info.project.name}`;
}

export function isMobile(info: TestInfo): boolean {
  return info.project.name === "mobile";
}

/** psql against the e2e database (setup that the console must not offer). */
export function sql(query: string): string {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "akari", "-d", DB, "-At", "-c", query],
    {
      cwd: REPO,
      encoding: "utf8",
    },
  ).trim();
}

/** Every CSP report and uncaught page error fails the test. */
export function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (/Content Security Policy|Refused to (load|execute|apply|frame)/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

/** Sign in on the admin sign-in page and land in the console. */
export async function signIn(page: Page, email = ADMIN, pw = ADMIN_PW, next = ""): Promise<void> {
  await page.goto(next ? `${LOGIN}?next=${encodeURIComponent(`/${PREFIX}/admin${next}`)}` : LOGIN);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(pw);
  await page.locator("form button[type=submit]").click();
  await page.waitForURL(new RegExp(`/${PREFIX}/admin`), { timeout: 20_000 });
  await expect(page.getByRole("button", { name: /账户菜单|Account menu/ })).toBeVisible();
}

/** Open a console path with the cached admin session (no UI sign-in per test). */
export async function openConsole(page: Page, path = ""): Promise<void> {
  const state = await (await api()).storageState();
  await page.context().addCookies(state.cookies);
  await page.goto(`${CONSOLE}${path}`);
  await expect(page.getByRole("button", { name: /账户菜单|Account menu/ })).toBeVisible();
}

/** Forget the cached admin session (after something ended every admin session). */
export function resetAdmin(): void {
  adminApi = null;
}

/** Sign in through the API (the form token wants the minimum submit time). */
export async function apiAs(email: string, pw: string, portal = false): Promise<APIRequestContext> {
  const base = portal ? ORIGIN : `${ORIGIN}/${PREFIX}`;
  const ctx = await request.newContext({ baseURL: base });
  const opts = await (await ctx.get(`${base}/auth/options`)).json();
  await new Promise((r) => setTimeout(r, (opts.guard?.form_min_secs ?? 0) * 1000 + 300));
  const r = await ctx.post(`${base}/auth/login`, {
    data: { email, password: pw, guard: { form_token: opts.guard?.form_token ?? null } },
  });
  expect(r.status(), await r.text()).toBe(200);
  return ctx;
}

let adminApi: APIRequestContext | null = null;
/** The admin API (`/{prefix}/api/v1`), for setup and checks. */
export async function api(): Promise<APIRequestContext> {
  adminApi ??= await apiAs(ADMIN, ADMIN_PW);
  return adminApi;
}

export async function apiJson<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
): Promise<T> {
  const ctx = await api();
  const r = await ctx.fetch(`${API}${path}`, { method, data });
  expect(r.status(), `${method} ${path}: ${await r.text()}`).toBeLessThan(300);
  const t = await r.text();
  return (t ? JSON.parse(t) : undefined) as T;
}

/** A visible data row (table row or phone card) containing `text`. */
export function row(page: Page, text: string | RegExp): Locator {
  return page.locator("[data-row]:visible", { hasText: text }).first();
}

/** Open a row: on a phone the card's button, on desktop the row itself. */
export async function openRow(page: Page, text: string | RegExp): Promise<void> {
  const r = row(page, text);
  await expect(r).toBeVisible();
  const card = r.locator('[role="button"]').first();
  if (await card.count()) await card.click();
  else await r.click();
}

/** The open dialog / drawer. */
export function dialog(page: Page, name?: string | RegExp): Locator {
  return name ? page.getByRole("dialog", { name }) : page.getByRole("dialog").last();
}

/** Wait for a toast with `text`. */
export async function toast(page: Page, text: string | RegExp): Promise<void> {
  await expect(page.locator("[data-toast]", { hasText: text }).first()).toBeVisible();
}

/** Confirm the open confirmation (typing the phrase when asked). */
export async function confirmDialog(
  page: Page,
  typed?: string,
  button: string | RegExp = /确认|永久删除|开始|删除|确认退款/,
): Promise<void> {
  const d = dialog(page);
  if (typed !== undefined) await d.getByLabel("确认文字").fill(typed);
  await d.getByRole("button", { name: button }).last().click();
}

/** Open the mobile navigation drawer when on a phone, then click `name`. */
export async function nav(page: Page, info: TestInfo, name: string): Promise<void> {
  if (isMobile(info)) await page.getByRole("button", { name: "菜单", exact: true }).click();
  await page.getByRole("navigation", { name: "主导航" }).last().getByRole("link", { name, exact: true }).click();
}

/** The canonical rejection as a client sees it (status, headers minus Date, body). */
export async function observe(req: APIRequestContext, url: string): Promise<string> {
  const res = await req.get(url, { maxRedirects: 0 });
  const headers = Object.entries(res.headers())
    .filter(([k]) => k !== "date")
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([res.status(), headers, (await res.body()).toString("base64")]);
}

/** A 1×1 PNG (branding uploads). */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lN6M1QAAAABJRU5ErkJggg==",
  "base64",
);
