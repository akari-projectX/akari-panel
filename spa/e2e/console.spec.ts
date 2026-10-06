import { expect, test, type APIRequestContext, type ConsoleMessage, type Page } from "@playwright/test";

// W33-b: the portal at `/` (D11); the admin app (sign-in page, console)
// has its own end-to-end suite in admin/e2e.
const BASE = must("E2E_BASE").replace(/\/$/, ""); // http://host:port (the portal)
const ADMIN_BASE = must("E2E_ADMIN_BASE"); // http://host:port/<prefix>/admin: admin sessions only
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

// D1: everyone signs in with the email address and the password.
async function login(page: Page, email: string, pw: string) {
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(pw);
  await page.locator("form button[type=submit]").click();
}

test.describe.configure({ mode: "serial" });

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
  await expect(page.getByLabel("邮箱")).toBeVisible();
  await login(page, USER, "wrong-password");
  await expect(page.getByRole("alert")).toHaveText("邮箱或密码错误");
  await expect(page).toHaveTitle("登录 · Akari");
  expect(problems).toEqual([]);
  await ctx.close();
});

test("user portal: views with navigation and deep links, permanent subscription link; never loads the console", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ locale: "zh-CN", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const problems = watch(page);
  const urls = requests(page);
  await page.goto(BASE);
  await login(page, USER, USER_PW);
  await expect(page.getByRole("heading", { level: 1, name: "仪表盘" })).toBeVisible();
  await expect(page).toHaveTitle("仪表盘 · Akari");
  // W20 (B1): the subscription link is always shown (issued on first view,
  // stored encrypted, the same on every load) and it works.
  const link = page.getByLabel("订阅链接", { exact: true });
  // D11: `/<site-wide random path>/<token>`, never under the admin prefix.
  await expect(link).toHaveValue(/:\/\/[^/]+\/[0-9a-f]{16}\/[A-Za-z0-9_-]{43}$/);
  const first = await link.inputValue();
  await page.getByRole("button", { name: "复制链接" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已复制到剪贴板" })).toBeVisible();
  // (Over plain http the Clipboard API is absent; the copy then uses the
  // legacy selection path, so only read back where the API exists.)
  if (await page.evaluate(() => window.isSecureContext)) {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
  }
  await page.getByRole("button", { name: "显示二维码" }).click();
  await expect(page.getByRole("img", { name: "订阅链接二维码" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Clash Verge / mihomo" })).toHaveAttribute(
    "href",
    /^clash:\/\/install-config\?url=/,
  );
  await expect(page.getByRole("link", { name: "Shadowrocket" })).toHaveAttribute(
    "href",
    /^shadowrocket:\/\/add\/sub:\/\//,
  );
  await expect(page.getByRole("link", { name: "sing-box" })).toHaveAttribute(
    "href",
    /^sing-box:\/\/import-remote-profile\?url=/,
  );
  expect((await ctx.request.get(first)).status()).toBe(200);
  await page.reload();
  await expect(page.getByLabel("订阅链接", { exact: true })).toHaveValue(first);
  // M1: one view per nav entry, real URLs, Back works.
  const nav = page.getByRole("navigation", { name: "主导航" }).first();
  await nav.getByRole("link", { name: "购买套餐" }).click();
  await expect(page).toHaveURL(`${BASE}/shop`);
  await expect(page.getByRole("heading", { level: 1, name: "购买套餐" })).toBeVisible();
  await nav.getByRole("link", { name: "节点" }).click();
  await expect(page).toHaveURL(`${BASE}/nodes`);
  await expect(page.getByRole("heading", { name: "节点状态" })).toBeVisible();
  await expect(page.getByText("暂无可用节点。")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`${BASE}/shop`);
  for (const [view, h1, h2] of [
    ["orders", "订单", "我的订单"],
    ["wallet", "邀请与钱包", "余额"],
    ["tickets", "工单", "工单"],
    ["account", "账户设置", "修改密码"],
    ["shop", "购买套餐", "购买套餐"],
  ]) {
    await page.goto(`${BASE}/${view}`);
    await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: h2, exact: true }).first()).toBeVisible();
    await expect(nav.getByRole("link", { name: h1, exact: true })).toHaveAttribute("aria-current", "page");
  }
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Buy a plan" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  // Phone: a bottom tab bar instead of the top nav.
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = page.getByRole("navigation", { name: "Main navigation" }).last();
  await expect(tabs).toBeVisible();
  // Only one navigation is exposed at this width (the top nav is display:none).
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveCount(1);
  await tabs.getByRole("link", { name: "Orders" }).click();
  await expect(page).toHaveURL(`${BASE}/orders`);
  await expect(page.getByRole("heading", { level: 1, name: "Orders" })).toBeVisible();
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

test("D4/D11: the portal at /, admins sign in only under the admin prefix", async ({ browser }) => {
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  const problems = watch(page);
  const prefix = new URL(ADMIN_BASE).pathname.split("/")[1];
  await page.goto(`${ORIGIN}/`);
  await login(page, USER, USER_PW);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.goto(`${ORIGIN}/orders`);
  await expect(page.getByRole("heading", { level: 1, name: "Orders" })).toBeVisible();
  expect(await page.content()).not.toContain(prefix);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  // The right admin password at the portal gets the wrong password's answer.
  await login(page, ADMIN, ADMIN_PW);
  await expect(page.getByText("Wrong email or password.")).toBeVisible();
  await expect(page).toHaveURL(`${ORIGIN}/`);
  expect(problems).toEqual([]);
  // Public paths never work under the prefix; the admin sign-in page does.
  const reject = await rejection(ctx.request);
  for (const p of ["/sub/x", "/install/x", "/pay/alipay/notify"]) {
    expect(await observe(ctx.request, `${ORIGIN}/${prefix}${p}`)).toBe(reject);
  }
  expect((await ctx.request.get(`${ORIGIN}/${prefix}/app`)).status()).toBe(200);
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
