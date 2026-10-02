import { createHmac } from "node:crypto";

import { expect, test, type APIRequestContext, type ConsoleMessage, type Page } from "@playwright/test";

const BASE = must("E2E_BASE"); // http://host:port/<prefix>/app (user portal + shared login)
const ADMIN_BASE = BASE.replace(/\/app$/, "/admin"); // the console (R23): admin sessions only
const ORIGIN = new URL(BASE).origin;
const ADMIN = must("E2E_ADMIN");
const ADMIN_PW = must("E2E_ADMIN_PW");
const USER = must("E2E_USER");
const USER_PW = must("E2E_USER_PW");

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (run scripts/e2e.sh)`);
  return v;
}

// RFC 6238 (SHA-1, 6 digits, 30 s) for the step after `after`.
function base32(s: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of s.replace(/=+$/, "")) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
async function nextCode(secret: string, after: number): Promise<{ code: string; step: number }> {
  for (;;) {
    const step = Math.floor(Date.now() / 1000 / 30);
    if (step > after) return { code: totp(secret, step), step };
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Every console message about CSP (violations are reported there by
// Chromium) fails the test; so do uncaught page errors.
function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (/Content Security Policy|Refused to (load|execute|apply)/i.test(m.text())) problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

// Every URL the page requested (R23: the portal must never touch the console's files).
function requests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  return urls;
}
const consoleUrl = (u: string) => /\/admin(\/|$)/.test(new URL(u).pathname);

// What a client observes of a response, minus Date: status, headers, body.
async function observe(req: APIRequestContext, url: string): Promise<string> {
  const res = await req.get(url, { maxRedirects: 0 });
  const headers = Object.entries(res.headers())
    .filter(([k]) => k !== "date")
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([res.status(), headers, (await res.body()).toString("base64")]);
}

// The panel's canonical rejection (an unknown path under the prefix).
async function rejection(req: APIRequestContext): Promise<string> {
  const r = await observe(req, `${ORIGIN}/definitely-not-here`);
  expect(JSON.parse(r)[0]).toBe(404);
  return r;
}

async function login(page: Page, user: string, pw: string, code?: string) {
  await page.locator("#login").fill(user);
  await page.locator("#password").fill(pw);
  await page.locator("#code").fill(code ?? "");
  await page.locator("form button[type=submit]").click();
}

test.describe.configure({ mode: "serial" });

let secret = "";
let usedStep = -1;

test("login page: real CSP, language switch persists, <html lang> follows", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  const problems = watch(page);
  const res = await page.goto(BASE);
  expect(res?.headers()["content-security-policy"]).toContain("default-src 'self'");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.getByRole("button", { name: "中文" }).click();
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await page.reload();
  await expect(page.getByRole("heading", { name: "登录" })).toBeVisible();
  // Uniform, localized credential error.
  await login(page, USER, "wrong-password");
  await expect(page.getByRole("alert")).toHaveText("账号、密码或验证码错误");
  expect(problems).toEqual([]);
  await ctx.close();
});

test("user portal: password login, language switch; never loads the console", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  const problems = watch(page);
  const urls = requests(page);
  await page.goto(BASE);
  await login(page, USER, USER_PW);
  await expect(page.getByRole("heading", { name: "我的账户" })).toBeVisible();
  // Purchase and orders (R18-3) speak the portal's language too.
  await expect(page.getByRole("heading", { name: "购买套餐" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "我的订单" })).toBeVisible();
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "My account" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Buy a plan" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My orders" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  // R23: nothing of the console was requested, and with this user's session
  // the console is the canonical rejection, byte-identical.
  expect(urls.filter(consoleUrl)).toEqual([]);
  expect(urls.some((u) => /\/assets\/[^/]+\.js$/.test(u))).toBe(true);
  const reject = await rejection(ctx.request);
  for (const p of ["", "/users", "/settings"]) expect(await observe(ctx.request, `${ADMIN_BASE}${p}`)).toBe(reject);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});

test("no session: the console does not exist (canonical rejection)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const reject = await rejection(ctx.request);
  for (const p of ["", "/users", "/audit", "/assets/missing.js"]) {
    expect(await observe(ctx.request, `${ADMIN_BASE}${p}`)).toBe(reject);
  }
  const page = await ctx.newPage();
  const res = await page.goto(`${ADMIN_BASE}/nodes`);
  expect(res?.status()).toBe(404);
  await ctx.close();
});

test("admin: optional 2FA, styled console, routable views, enroll with QR", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  const problems = watch(page);
  const urls = requests(page);
  await page.goto(`${BASE}/audit`); // the shared login; the view survives it
  await login(page, ADMIN, ADMIN_PW);
  await expect(page).toHaveURL(`${ADMIN_BASE}/audit`); // R23: sent to the console bundle
  await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();
  expect(urls.some((u) => new URL(u).pathname.includes("/admin/assets/"))).toBe(true);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN"); // console: Chinese only
  // Styled by the bundled stylesheet (a CSP regression leaves it unstyled).
  const styles = await page.getByRole("link", { name: "审计" }).evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderRadius, bg: s.backgroundColor, font: getComputedStyle(document.body).fontFamily };
  });
  expect(styles.radius).toBe("8px");
  expect(styles.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(styles.font).toContain("system-ui");
  // Routable views + back button.
  await page.getByRole("link", { name: "用户" }).click();
  await expect(page).toHaveURL(`${ADMIN_BASE}/users`);
  await expect(page.getByRole("heading", { name: "用户", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`${ADMIN_BASE}/audit`);
  // Recommended, not forced: the banner leads to the account page.
  await expect(page.getByText("建议开启两步验证")).toBeVisible();
  await page.getByRole("link", { name: "去设置" }).click();
  await expect(page).toHaveURL(`${ADMIN_BASE}/account`);
  await page.getByRole("button", { name: "开启两步验证" }).click();
  const qr = page.getByRole("img", { name: "两步验证二维码" });
  await expect(qr).toBeVisible();
  expect(Number(await qr.getAttribute("data-qr-version"))).toBeGreaterThan(0);
  secret = (await page.locator("pre").first().innerText()).trim();
  const first = await nextCode(secret, usedStep);
  usedStep = first.step;
  await page.getByLabel("App 中显示的验证码").fill(first.code);
  await page.getByRole("button", { name: "启用" }).click();
  await expect(page.getByText("恢复码：丢失身份验证器时")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 .txt" })).toBeVisible();
  await page.getByRole("button", { name: "我已保存" }).click();
  await expect(page.getByText(/已开启 · 剩余 10 个恢复码/)).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  // Logged out: back on the portal's login page; the console is gone.
  await expect(page).toHaveURL(BASE);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(await observe(ctx.request, ADMIN_BASE)).toBe(await rejection(ctx.request));
  expect(problems).toEqual([]);
  await ctx.close();
});

test("admin with 2FA: password alone refused, TOTP code accepted", async ({ browser }) => {
  test.skip(!secret, "needs the enrollment test");
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  const problems = watch(page);
  await page.goto(BASE);
  await login(page, ADMIN, ADMIN_PW);
  await expect(page.getByRole("alert")).toHaveText("账号、密码或验证码错误");
  const next = await nextCode(secret, usedStep); // the confirm step is spent
  usedStep = next.step;
  await login(page, ADMIN, ADMIN_PW, next.code);
  await expect(page).toHaveURL(ADMIN_BASE);
  await expect(page.getByRole("heading", { name: "用户", exact: true })).toBeVisible();
  await expect(page.getByText("建议开启两步验证")).toHaveCount(0);
  // Deep links (a full page load of /admin/<view>) for every console view.
  for (const [view, label, heading] of [
    ["nodes", "节点", "节点"],
    ["orders", "订单", "订单"],
    ["updates", "更新", "灰度更新"],
    ["plans", "套餐", "套餐"],
    ["settings", "系统设置", "系统设置"],
    ["audit", "审计", "审计日志"],
    ["account", "账户", "两步验证"],
  ]) {
    await page.goto(`${ADMIN_BASE}/${view}`);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
  }
  expect(problems).toEqual([]);
  await ctx.close();
});
