import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

import { expect, test, type APIRequestContext, type ConsoleMessage, type Page } from "@playwright/test";

const BASE = must("E2E_BASE"); // http://host:port/<prefix>/app (user portal + shared login)
const ADMIN_BASE = BASE.replace(/\/app$/, "/admin"); // the console (R23): admin sessions only
const ORIGIN = new URL(BASE).origin;
const ADMIN = must("E2E_ADMIN");
const ADMIN_PW = must("E2E_ADMIN_PW");
const USER = must("E2E_USER");
const USER_PW = must("E2E_USER_PW");
// W20: a user that ends up quota-exhausted (its own account: no interference).
const QUOTA_USER = process.env.E2E_QUOTA_USER ?? "";
const E2E_DB = process.env.E2E_DB ?? "";

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

// W20 (M9): password first; the code field appears only when the server
// answers `totp_required` (accounts with 2FA).
async function login(page: Page, user: string, pw: string, code?: string) {
  await page.locator("#login").fill(user);
  await page.locator("#password").fill(pw);
  await page.locator("form button[type=submit]").click();
  if (code !== undefined) {
    await page.locator("#code").fill(code);
    await page.locator("form button[type=submit]").click();
  }
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
  // Uniform, localized credential error; no code field for a wrong password.
  await expect(page.getByLabel("邮箱或账号")).toBeVisible();
  await expect(page.locator("#code")).toHaveCount(0);
  await login(page, USER, "wrong-password");
  await expect(page.getByRole("alert")).toHaveText("账号或密码错误");
  await expect(page.locator("#code")).toHaveCount(0);
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
  await expect(link).toHaveValue(/\/sub\/[A-Za-z0-9_-]{43}$/);
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
  // W20 two-step: the password alone only reveals the code field.
  await login(page, ADMIN, ADMIN_PW);
  await expect(page.getByLabel("两步验证码")).toBeVisible();
  await expect(page.getByText("该账户已开启两步验证")).toBeVisible();
  await page.locator("#code").fill("000000");
  await page.locator("form button[type=submit]").click();
  await expect(page.getByRole("alert")).toHaveText("验证码错误或已使用，请输入新的验证码");
  const next = await nextCode(secret, usedStep); // the confirm step is spent
  usedStep = next.step;
  await page.locator("#code").fill(next.code);
  await page.locator("form button[type=submit]").click();
  await expect(page).toHaveURL(ADMIN_BASE);
  await expect(page.getByRole("heading", { name: "仪表盘", exact: true })).toBeVisible(); // W21 landing view
  await expect(page.getByText("建议开启两步验证")).toHaveCount(0);
  // Deep links (a full page load of /admin/<view>) for every console view.
  for (const [view, label, heading] of [
    ["dashboard", "仪表盘", "仪表盘"],
    ["users", "用户", "用户"],
    ["nodes", "节点", "节点"],
    ["orders", "订单", "订单"],
    ["coupons", "优惠券", "优惠券"],
    ["finance", "资金", "提现审核"],
    ["tickets", "工单", "工单管理"],
    ["alerts", "告警", "告警中心"],
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

test("W11 nodes: xboard-style form, live status, detail page, 立即测速", async ({ browser }) => {
  test.skip(!secret, "needs the enrollment test");
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  const problems = watch(page);
  await page.goto(`${BASE}/nodes`);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(page, ADMIN, ADMIN_PW, next.code);
  await expect(page).toHaveURL(`${ADMIN_BASE}/nodes`);
  await page.getByRole("button", { name: "新建节点" }).click();
  await page.getByLabel("名称（内部，唯一）").fill("e2e-w11");
  await page.getByLabel("公网地址（IP 或域名）").fill("198.51.100.20");
  await page.getByLabel("显示名称（用户可见）").fill("东京 01");
  await page.getByLabel("标签（逗号分隔）").fill("日本, IPLC");
  await page.getByLabel("倍率").fill("0.5");
  await page.getByRole("button", { name: "创建并生成安装命令" }).click();
  await expect(page.getByText(/curl .*install/).first()).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "东京 01" });
  await expect(row).toBeVisible();
  await expect(row.getByText("0.5x")).toBeVisible();
  await expect(row.getByText("IPLC")).toBeVisible();
  await expect(row.getByText("未测")).toBeVisible();
  // Detail page (deep link) with its charts and the latency test button.
  await row.getByRole("button", { name: /详情/ }).click();
  await expect(page).toHaveURL(new RegExp(`${ADMIN_BASE}/nodes/[0-9a-f-]{36}$`));
  await expect(page.getByRole("heading", { name: "节点详情「东京 01」" })).toBeVisible();
  await expect(page.getByText("暂无数据").first()).toBeVisible();
  await page.getByRole("button", { name: "立即测速" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已发起测速" })).toBeVisible();
  await page.getByRole("button", { name: "立即测速" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "刚刚测过" })).toBeVisible();
  await page.reload(); // the deep link survives a full load
  await expect(page.getByRole("heading", { name: "节点详情「东京 01」" })).toBeVisible();
  await page.getByRole("button", { name: "返回列表" }).click();
  await expect(page).toHaveURL(`${ADMIN_BASE}/nodes`);
  // 展示与计费: connect port override + multiplier, saved without a rebuild.
  await row.getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "配置" }).click();
  const card = page.locator("div.rounded-lg").filter({ has: page.getByRole("heading", { name: /展示与计费/ }) });
  await card.getByLabel("连接端口").first().fill("30443");
  await card.getByLabel("倍率").fill("2");
  await card.getByRole("button", { name: "保存" }).click();
  await expect(card.getByText("已保存")).toBeVisible();
  await expect(row.getByText("2x")).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});

test("W16: coupon + balance purchase (paid without the gateway), console coupons and balances", async ({ browser }) => {
  test.skip(!secret, "needs the enrollment test");
  // Admin: a priced plan (API, same session), a coupon and a balance (UI).
  const actx = await browser.newContext({ locale: "zh-CN" });
  const admin = await actx.newPage();
  const problems = watch(admin);
  await admin.goto(`${BASE}/coupons`);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(admin, ADMIN, ADMIN_PW, next.code);
  await expect(admin).toHaveURL(`${ADMIN_BASE}/coupons`);
  const api = `${ADMIN_BASE.replace(/\/admin$/, "")}/api/v1`;
  const plan = await actx.request.post(`${api}/plans`, { data: { name: "e2e-w16", period: "monthly" } });
  expect(plan.status()).toBe(201);
  const planId = (await plan.json()).id as string;
  const prices = await actx.request.put(`${api}/plans/${planId}/prices`, {
    data: { on_sale: true, prices: [{ period: "month", price_cents: 2000 }] },
  });
  expect(prices.status()).toBe(204);
  await admin.getByLabel("优惠码（3–32 位字母、数字、- 或 _）").fill("E2E50");
  await admin.getByLabel("减免百分比").fill("50");
  await admin.getByRole("button", { name: "创建优惠券" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "已创建优惠码 E2E50" })).toBeVisible();
  await expect(admin.getByRole("cell", { name: "E2E50" })).toBeVisible();
  await admin.getByRole("link", { name: "资金", exact: true }).click();
  await expect(admin.getByRole("heading", { name: "提现审核" })).toBeVisible();
  await admin.getByLabel("用户名（精确）").fill(USER);
  await admin.getByRole("button", { name: "查找" }).click();
  await admin.getByRole("button", { name: "明细与调整" }).click();
  await admin.getByLabel("调整金额（元）").fill("10");
  await admin.getByLabel("调整原因（必填）").fill("e2e 充值");
  await admin.getByRole("button", { name: "调整余额" }).click();
  await admin.getByRole("alertdialog").getByRole("button", { name: "确认调整" }).click(); // W21 ConfirmDialog
  await expect(admin.getByRole("status").filter({ hasText: "余额已调整" })).toBeVisible();
  await expect(admin.getByText(`${USER}：余额 ¥10.00`)).toBeVisible();
  expect(problems).toEqual([]);
  await actx.close();

  // User: coupon 50% off ¥20 = ¥10, the rest from the balance: paid at once.
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  const uproblems = watch(page);
  await page.goto(`${BASE}/shop`);
  await login(page, USER, USER_PW);
  await expect(page.getByRole("heading", { level: 1, name: "购买套餐" })).toBeVisible();
  await page.getByLabel("优惠码").fill("e2e50");
  await page.getByRole("button", { name: "使用", exact: true }).click();
  await expect(page.getByText("已使用优惠码 E2E50", { exact: true })).toBeVisible();
  await expect(page.getByText("优惠券优惠 ¥10.00", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "使用余额支付（余额 ¥10.00）" }).check();
  await expect(page.getByText("余额支付 ¥10.00", { exact: true })).toBeVisible();
  await expect(page.getByText("应付 ¥0.00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "购买", exact: true }).click();
  // W20: the checkout summary (only the parts that apply), then pay.
  const sheet = page.getByRole("dialog", { name: "确认订单" });
  await expect(sheet).toContainText("优惠券");
  await expect(sheet).toContainText("余额支付");
  await expect(sheet).not.toContainText("当前套餐抵扣");
  await sheet.getByRole("button", { name: "确认开通" }).click();
  const pay = page.getByRole("dialog", { name: "付款" });
  await expect(pay.getByText("付款成功，套餐已开通。", { exact: true })).toBeVisible();
  await expect(pay.getByText("E2E50 · 优惠券优惠 ¥10.00")).toBeVisible();
  await pay.getByRole("button", { name: "关闭" }).click();
  await page.getByRole("navigation", { name: "主导航" }).first().getByRole("link", { name: "邀请与钱包" }).click();
  await expect(page.getByText("余额 ¥0.00", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "订单支付" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "人工调整" })).toBeVisible();
  // English too.
  await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "Balance", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My invitations" })).toBeVisible();
  expect(uproblems).toEqual([]);
  await ctx.close();
});

test("W21: dashboard, user search + create dialog, plan dialog, settings tabs, confirm dialog, phone layout", async ({
  browser,
}) => {
  test.skip(!secret, "needs the enrollment test");
  const ctx = await browser.newContext({ locale: "en-US" }); // the console stays Chinese
  const page = await ctx.newPage();
  const problems = watch(page);
  const urls = requests(page);
  const failed: string[] = [];
  page.on("response", (r) => {
    if (r.status() >= 400 && consoleUrl(r.url())) failed.push(`${r.status()} ${r.url()}`);
  });
  await page.goto(BASE);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(page, ADMIN, ADMIN_PW, next.code);
  await expect(page).toHaveURL(ADMIN_BASE);

  // Dashboard (landing view), its own lazily loaded chunk under the prefix.
  await expect(page.getByRole("heading", { name: "仪表盘", exact: true })).toBeVisible();
  await expect(page.getByText("营收（支付宝实收）")).toBeVisible();
  await expect(page.getByText("近 30 天")).toBeVisible();
  await expect(page.getByRole("link", { name: /待回复工单/ })).toBeVisible();
  await expect(page).toHaveTitle("仪表盘 · Akari 管理后台");
  const chunks = urls.filter((u) => /\/admin\/assets\/[^/]+\.js$/.test(new URL(u).pathname));
  expect(chunks.length).toBeGreaterThan(1); // code-split: the shell + the view
  expect(chunks.every((u) => new URL(u).pathname.startsWith(new URL(ADMIN_BASE).pathname))).toBe(true);

  // Users: create in a dialog (email set), find by search, status chip.
  await page.getByRole("link", { name: "用户", exact: true }).click();
  await page.getByRole("button", { name: "新建用户" }).click();
  const dialog = page.getByRole("dialog", { name: "新建用户" });
  await dialog.getByLabel("账号", { exact: true }).fill("e2e-w21-user");
  await dialog.getByLabel("密码", { exact: true }).fill("e2e-w21-password");
  await dialog.getByLabel(/邮箱/).fill("w21@e2e.test");
  await dialog.getByLabel(/到期日/).fill("2099-12-31");
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(page.getByText(/的订阅令牌（之后也可以/)).toBeVisible();
  await page.getByLabel("搜索").fill("E2E-W21");
  await expect(page.getByText("找到 1 个用户")).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: "e2e-w21-user" });
  await expect(row.getByText("w21@e2e.test")).toBeVisible();
  await expect(row.getByText("2099-12-31")).toBeVisible(); // a Beijing day, not shifted by UTC
  await expect(row.getByText("正常")).toBeVisible();
  await page.getByRole("button", { name: "已停用" }).click();
  await expect(page.getByText("没有符合条件的用户。")).toBeVisible();
  await page.getByRole("button", { name: "全部" }).click();
  // A server error comes back in Chinese (coded error, W21 M6).
  await page.getByRole("button", { name: "新建用户" }).click();
  await dialog.getByLabel("账号", { exact: true }).fill("e2e-w21-user");
  await dialog.getByLabel("密码", { exact: true }).fill("e2e-w21-password");
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("该账号已存在");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Plans: fields + prices + on sale in one dialog, one request.
  await page.getByRole("link", { name: "套餐", exact: true }).click();
  await page.getByRole("button", { name: "新建套餐" }).click();
  const pd = page.getByRole("dialog", { name: "新建套餐" });
  await expect(pd.getByLabel(/设备数/)).toHaveCount(0); // R25: hidden
  await pd.getByLabel("名称", { exact: true }).fill("e2e-w21-plan");
  await pd.getByLabel(/流量额度/).fill("100");
  await pd.getByLabel("季付", { exact: true }).check();
  await pd.getByLabel("季付 价格", { exact: true }).fill("30");
  await pd.getByLabel("月付", { exact: true }).check();
  await pd.getByLabel("月付 价格", { exact: true }).fill("12.5");
  await pd.getByLabel(/上架/).check();
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/v1/plans")) writes.push(`${r.method()} ${r.url()}`);
  });
  await pd.getByRole("button", { name: "创建套餐" }).click();
  await expect(pd).toHaveCount(0);
  const prow = page.getByRole("row").filter({ hasText: "e2e-w21-plan" });
  await expect(prow.getByText("月付 ¥12.50")).toBeVisible();
  await expect(prow.getByText("季付 ¥30.00")).toBeVisible();
  await expect(prow.getByText("在售")).toBeVisible();
  expect(writes).toHaveLength(1);
  // 停用 asks first (ConfirmDialog, not window.confirm): cancel, then confirm.
  await prow.getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "停用" }).click();
  const ask = page.getByRole("alertdialog", { name: "停用套餐「e2e-w21-plan」？" });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "取消" }).click();
  await expect(prow.getByText("在售")).toBeVisible();
  await prow.getByRole("button", { name: /更多操作/ }).click();
  await page.getByRole("menuitem", { name: "停用" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "停用" }).click();
  await expect(prow.getByText("已停用")).toBeVisible();

  // Settings: tabs as deep links; the site name feeds the titles.
  await page.goto(`${ADMIN_BASE}/settings/probe`);
  await expect(page.getByRole("tab", { name: "测速" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("测速间隔（分钟）")).toBeVisible();
  await page.getByRole("tab", { name: "站点" }).click();
  await expect(page).toHaveURL(`${ADMIN_BASE}/settings/site`);
  await page.getByLabel("站点名称", { exact: true }).fill("星云 e2e");
  await page.getByRole("button", { name: "保存站点名称" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已保存。" })).toBeVisible();
  await expect(page).toHaveTitle("系统设置 · 星云 e2e 管理后台");
  await page.getByLabel("站点名称", { exact: true }).fill("");
  await page.getByRole("button", { name: "保存站点名称" }).click();
  await expect(page).toHaveTitle("系统设置 · Akari 管理后台");

  // Audit: Chinese action names and a field diff.
  await page.getByRole("link", { name: "审计", exact: true }).click();
  await expect(page.getByRole("cell", { name: /^修改站点名称/ }).first()).toBeVisible();

  // Phone (390 px): no page-level horizontal scroll; tables scroll inside
  // named regions; the row menu still works.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const view of ["dashboard", "users", "plans", "nodes", "orders", "settings", "audit"]) {
    await page.goto(`${ADMIN_BASE}/${view}`);
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const { overflow, culprits } = await page.evaluate(() => {
      const w = window.innerWidth;
      // Elements sticking out of the viewport that no scroller clips (an
      // absolutely positioned element is clipped only by a scroller that is
      // also its containing block: the W21 sr-only bug).
      const clipped = (el: Element) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden") return true;
        }
        return false;
      };
      const out = [...document.body.querySelectorAll("*")]
        .filter((el) => el.getBoundingClientRect().right > w + 1 && !clipped(el))
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
      return { overflow: document.documentElement.scrollWidth - w, culprits: out };
    });
    expect(overflow, `${view}: ${culprits.join(" | ")}`).toBeLessThanOrEqual(0);
  }
  await page.goto(`${ADMIN_BASE}/plans`);
  const region = page.getByRole("region", { name: "套餐列表" });
  await expect(region).toBeVisible();
  await page
    .getByRole("row")
    .filter({ hasText: "e2e-w21-plan" })
    .getByRole("button", { name: /更多操作/ })
    .click();
  await expect(page.getByRole("menuitem", { name: "启用" })).toBeVisible();
  await page.keyboard.press("Escape");
  expect(problems).toEqual([]);
  expect(failed).toEqual([]);
  await ctx.close();
});

// W15: Mailpit (scripts/e2e.sh) is the SMTP sink; the test reads mail like a user.
const MAILPIT = process.env.E2E_MAILPIT ?? "";
const SMTP_PORT = process.env.E2E_SMTP_PORT ?? "";
async function mailTo(to: string, n: number): Promise<{ subject: string; text: string }> {
  for (let i = 0; i < 60; i++) {
    const list = (await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as {
      messages: { ID: string }[];
    };
    if (list.messages.length >= n) {
      const m = (await (await fetch(`${MAILPIT}/message/${list.messages[0].ID}`)).json()) as {
        Subject: string;
        Text: string;
      };
      return { subject: m.Subject, text: m.Text };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no message #${n} to ${to}`);
}

test("W17: ticket both sides (portal zh/en, console desk), alert center settings", async ({ browser }) => {
  test.skip(!secret, "needs the enrollment test");
  // User opens a ticket in the portal.
  const uctx = await browser.newContext({ locale: "zh-CN" });
  const user = await uctx.newPage();
  const uproblems = watch(user);
  const urls = requests(user);
  await user.goto(BASE);
  await login(user, USER, USER_PW);
  await user.getByRole("navigation", { name: "主导航" }).first().getByRole("link", { name: "工单" }).click();
  await expect(user.getByRole("heading", { level: 2, name: "工单" })).toBeVisible();
  await user.getByRole("button", { name: "新建工单" }).click();
  await user.getByLabel("标题").fill("e2e：节点连不上");
  await user.getByLabel("分类").selectOption("technical");
  await user.getByLabel("问题描述").fill("e2e 工单内容\n第二行");
  await user.getByRole("button", { name: "提交工单" }).click();
  await expect(user.getByRole("status").filter({ hasText: "工单已提交" })).toBeVisible();
  await expect(user.getByText("第二行")).toBeVisible();

  // Staff replies from the console.
  const actx = await browser.newContext({ locale: "zh-CN" });
  const admin = await actx.newPage();
  const aproblems = watch(admin);
  await admin.goto(`${BASE}/tickets`);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(admin, ADMIN, ADMIN_PW, next.code);
  await expect(admin).toHaveURL(`${ADMIN_BASE}/tickets`);
  await expect(admin.getByRole("heading", { name: "工单管理" })).toBeVisible();
  const trow = admin.getByRole("row").filter({ hasText: "e2e：节点连不上" });
  await expect(trow.getByText("未读")).toBeVisible();
  await trow.getByRole("button", { name: "处理" }).click();
  await expect(admin).toHaveURL(new RegExp(`${ADMIN_BASE}/tickets/[0-9a-f-]{36}$`));
  await expect(admin.getByRole("heading", { name: "e2e：节点连不上" })).toBeVisible();
  await admin.getByLabel("回复").fill("e2e 客服回复：请重启客户端");
  await admin.getByRole("button", { name: "回复", exact: true }).click();
  await expect(admin.getByText("e2e 客服回复：请重启客户端")).toBeVisible();
  await expect(admin.getByText("已回复", { exact: true }).first()).toBeVisible();

  // Alert center: no alerts (no agents here); its settings (W21: 系统设置 →
  // 告警) save, a channel test.
  await admin.goto(`${ADMIN_BASE}/alerts`);
  await expect(admin.getByRole("heading", { name: "告警中心" })).toBeVisible();
  await expect(admin.getByText("当前没有告警。")).toBeVisible();
  await admin.getByRole("link", { name: "系统设置 → 告警" }).click();
  await expect(admin).toHaveURL(`${ADMIN_BASE}/settings/alerts`);
  await admin.getByLabel("重复告警冷却（分钟）").fill("45");
  await admin.getByLabel("CPU 高于（%）").fill("");
  await admin.getByRole("button", { name: "保存告警设置" }).click();
  await expect(admin.getByRole("status").filter({ hasText: "已保存。" })).toBeVisible();
  await admin.reload();
  await expect(admin.getByLabel("重复告警冷却（分钟）")).toHaveValue("45");
  await expect(admin.getByLabel("CPU 高于（%）")).toHaveValue("");
  await admin.getByRole("button", { name: "发送测试" }).nth(1).click();
  await expect(admin.getByRole("alert").filter({ hasText: "Webhook 测试失败" })).toBeVisible();
  expect(aproblems).toEqual([]);
  await actx.close();

  // The user sees the reply (unread), as "Support" in English, and closes.
  await user.reload();
  await expect(user.getByText("有新回复")).toBeVisible();
  await user.getByRole("button", { name: "English" }).click();
  await expect(user.getByRole("heading", { name: "Support tickets" })).toBeVisible();
  await user.getByRole("button", { name: "View" }).click();
  await expect(user.getByText("e2e 客服回复：请重启客户端")).toBeVisible();
  await expect(user.getByText("Support", { exact: true })).toBeVisible();
  await user.getByRole("button", { name: "Close ticket" }).click();
  // W20: an in-page confirmation (not the browser's English-only confirm()).
  await user.getByRole("alertdialog").getByRole("button", { name: "Close ticket" }).click();
  await expect(user.getByText("This ticket is closed.", { exact: false })).toBeVisible();
  expect(urls.filter(consoleUrl)).toEqual([]);
  expect(uproblems).toEqual([]);
  await uctx.close();
});

// W20 (M2): a quota-exhausted user is led to the traffic reset pack.
test("W20: quota-exhausted user lands on the reset pack", async ({ browser }) => {
  test.skip(!secret || !QUOTA_USER || !E2E_DB, "needs the enrollment test and scripts/e2e.sh");
  const actx = await browser.newContext({ locale: "zh-CN" });
  const admin = await actx.newPage();
  await admin.goto(BASE);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(admin, ADMIN, ADMIN_PW, next.code);
  await expect(admin).toHaveURL(ADMIN_BASE);
  const api = `${ADMIN_BASE.replace(/\/admin$/, "")}/api/v1`;
  const plan = await actx.request.post(`${api}/plans`, {
    data: { name: "e2e-w20", period: "monthly", traffic_quota_bytes: 1048576 },
  });
  expect(plan.status()).toBe(201);
  const planId = (await plan.json()).id as string;
  expect(
    (
      await actx.request.put(`${api}/plans/${planId}/prices`, {
        data: {
          on_sale: true,
          prices: [
            { period: "month", price_cents: 1000 },
            { period: "reset", price_cents: 300 },
          ],
        },
      })
    ).status(),
  ).toBe(204);
  const users = (
    (await (await actx.request.get(`${api}/users?limit=200`)).json()) as { users: { id: string; login: string }[] }
  ).users;
  const uid = users.find((u) => u.login === QUOTA_USER)?.id;
  expect(uid).toBeTruthy();
  expect((await actx.request.put(`${api}/users/${uid}/plan`, { data: { plan_id: planId } })).status()).toBe(200);
  // Traffic only comes from agents; here the counter is set directly and the
  // enforcement pass (5 s) disables the account for quota.
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "akari",
      "-d",
      E2E_DB,
      "-qc",
      `UPDATE users SET traffic_used_bytes = 2097152 WHERE login = '${QUOTA_USER}'`,
    ],
    { cwd: "..", stdio: "ignore" },
  );
  await expect
    .poll(
      async () =>
        (
          (await (await actx.request.get(`${api}/users?limit=200`)).json()) as {
            users: { login: string; disabled_reason: string | null }[];
          }
        ).users.find((u) => u.login === QUOTA_USER)?.disabled_reason,
      { timeout: 20_000 },
    )
    .toBe("quota");
  await actx.close();

  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  const problems = watch(page);
  await page.goto(BASE);
  await login(page, QUOTA_USER, USER_PW);
  await expect(page.getByRole("alert").filter({ hasText: "你的流量已用完" })).toBeVisible();
  await expect(page.getByLabel("订阅链接", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "购买流量重置包" }).click();
  await expect(page).toHaveURL(`${BASE}/shop`);
  await expect(page.getByText("流量已用完：已为你选好流量重置包。")).toBeVisible();
  await expect(page.getByLabel(/^流量重置包/)).toBeChecked();
  await page.getByRole("button", { name: "购买重置包" }).click();
  await expect(page.getByRole("dialog", { name: "确认订单" })).toContainText("已用流量清零");
  await expect(page.getByRole("button", { name: "去支付 ¥3.00" })).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});

test("W22: traffic history in the portal (zh/en) and on the console's user page", async ({ browser }) => {
  test.skip(!secret, "needs the enrollment test");
  const uctx = await browser.newContext({ locale: "zh-CN" });
  const user = await uctx.newPage();
  const uproblems = watch(user);
  const urls = requests(user);
  await user.goto(BASE);
  await login(user, USER, USER_PW);
  // Seeded by e2e.sh: 1 GiB + 2 GiB over two UTC days on a deleted node.
  // W20 nav: its own view at /app/traffic.
  await user.getByRole("navigation", { name: "主导航" }).first().getByRole("link", { name: "流量明细" }).click();
  await expect(user).toHaveURL(`${BASE}/traffic`);
  await expect(user.getByRole("heading", { level: 1, name: "流量明细" })).toBeVisible();
  await expect(user.getByRole("heading", { level: 2, name: "流量记录" })).toBeVisible();
  await expect(user.getByText("其他节点")).toBeVisible();
  await expect(user.getByRole("img", { name: /共 3\.0 GiB/ })).toBeVisible();
  await user.getByRole("button", { name: "近 7 天" }).click();
  await expect(user.getByRole("button", { name: "近 7 天" })).toHaveAttribute("aria-pressed", "true");
  await expect(user.getByRole("img", { name: /共 3\.0 GiB/ })).toBeVisible();
  await user.getByRole("button", { name: "English" }).click();
  await expect(user.getByRole("heading", { level: 1, name: "Traffic", exact: true })).toBeVisible();
  await expect(user.getByRole("heading", { level: 2, name: "Usage history" })).toBeVisible();
  await expect(user.getByText("Other nodes")).toBeVisible();
  expect(urls.filter(consoleUrl)).toEqual([]);
  expect(uproblems).toEqual([]);
  await uctx.close();

  const actx = await browser.newContext({ locale: "zh-CN" });
  const admin = await actx.newPage();
  const aproblems = watch(admin);
  await admin.goto(`${BASE}/users`);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(admin, ADMIN, ADMIN_PW, next.code);
  await expect(admin).toHaveURL(`${ADMIN_BASE}/users`);
  await admin
    .getByRole("row")
    .filter({ has: admin.getByRole("cell", { name: USER, exact: true }) })
    .getByRole("button", { name: "管理" })
    .click();
  const section = admin.getByRole("region", { name: `${USER} 的流量明细` });
  await expect(section.getByText("已删除的节点")).toBeVisible();
  await expect(section.getByText(/合计：上传 1\.5 GiB · 下载 1\.5 GiB · 计费 1\.5 GiB/)).toBeVisible();
  expect(aproblems).toEqual([]);
  await actx.close();
});

// Last: it sets the main domain (reset links need it) and opens registration.
test("W15: 系统设置 注册/邮件, sign up by email code, reset the password by link", async ({ browser }) => {
  test.skip(!MAILPIT || !SMTP_PORT, "needs Mailpit (scripts/e2e.sh)");
  const actx = await browser.newContext({ locale: "zh-CN" });
  const ap = await actx.newPage();
  const adminProblems = watch(ap);
  ap.on("dialog", (d) => void d.accept());
  await ap.goto(BASE);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(ap, ADMIN, ADMIN_PW, next.code);
  await expect(ap).toHaveURL(ADMIN_BASE);
  await ap.goto(`${ADMIN_BASE}/settings/mail`);
  // 邮件 first (registration needs it), then the main domain, then 注册.
  await ap.getByLabel("启用邮件发送").check();
  await ap.getByLabel("SMTP 服务器").fill("127.0.0.1");
  await ap.getByLabel("加密方式").selectOption("none");
  await ap.getByLabel("端口", { exact: true }).fill(SMTP_PORT);
  await ap.getByLabel("用户名").fill("");
  await ap.getByLabel("发件地址").fill("noreply@e2e.test");
  await ap.getByRole("button", { name: "保存邮件设置" }).click();
  await expect(ap.getByText("已保存。").first()).toBeVisible();
  await ap.getByLabel("发送测试邮件（使用已保存的设置）").fill("admin@e2e.test");
  await ap.getByRole("button", { name: "发送测试邮件" }).click();
  await expect(ap.getByText(/测试邮件已发出/)).toBeVisible();
  expect((await mailTo("admin@e2e.test", 1)).subject).toContain("测试邮件");
  await ap.getByRole("tab", { name: "站点" }).click();
  await ap.locator("#settings-main").fill(new URL(BASE).host);
  await ap.getByRole("button", { name: "保存", exact: true }).click();
  // (The domain form remounts on the new version, so wait for the effective value.)
  await expect(ap.getByText(`当前生效：https://${new URL(BASE).host}`).first()).toBeVisible();
  await ap.getByRole("tab", { name: "注册" }).click();
  await ap.reload();
  await ap.getByLabel("开放注册").check();
  await ap.getByLabel("允许通过邮件找回密码").check();
  await ap.getByRole("button", { name: "保存注册设置" }).click();
  await expect(ap.getByText("已保存。").first()).toBeVisible();
  expect(adminProblems).toEqual([]);
  await actx.close();

  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  const problems = watch(page);
  const email = `e2e-${Date.now()}@e2e.test`;
  await page.goto(BASE);
  await page.getByRole("link", { name: "Sign up" }).click();
  await expect(page).toHaveURL(`${BASE}/register`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect(page.getByRole("status")).toContainText("If this address can sign up");
  const codeMail = await mailTo(email, 1);
  expect(codeMail.subject).toContain("sign-up code");
  const code = /\b\d{6}\b/.exec(codeMail.text)?.[0] ?? "";
  await page.getByLabel("Email code").fill(code);
  await page.getByLabel("Password", { exact: true }).fill("e2e-password-1");
  await page.getByLabel("Repeat password").fill("e2e-password-1");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  await page.goto(`${BASE}/account`);
  await expect(page.getByText(`${email} · verified`)).toBeVisible();
  // W20 (Minor 6): registration is open, so the first invite code exists already.
  await page.goto(`${BASE}/wallet`);
  await expect(page.getByLabel("Your invite link")).toHaveValue(/\/app\/register\?invite=[a-z2-9]{10}$/);
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByRole("link", { name: "Forgot password?" }).click();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("If this address belongs to an account");
  const resetMail = await mailTo(email, 2);
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(resetMail.text)?.[1] ?? "";
  expect(token).toHaveLength(43);
  await page.goto(`${BASE}/reset#token=${token}`);
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe(""); // the token left the address bar
  await page.getByLabel("New password", { exact: true }).fill("e2e-password-2");
  await page.getByLabel("Repeat new password").fill("e2e-password-2");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("status")).toContainText("has been reset");
  await page.getByRole("link", { name: "Back to sign in" }).click();
  await login(page, email, "e2e-password-1");
  await expect(page.getByRole("alert")).toBeVisible();
  await login(page, email, "e2e-password-2");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});

test("W24: 系统设置 → 支付 (imported + added method, 测试连接), sign-up without email verification, method picker", async ({
  browser,
}) => {
  test.skip(!secret, "needs the enrollment test");
  test.setTimeout(180_000);
  const payDir = process.env.E2E_PAY_DIR ?? "";
  test.skip(!payDir, "needs scripts/e2e.sh");
  const { readFileSync } = await import("node:fs");
  const actx = await browser.newContext({ locale: "zh-CN" });
  const ap = await actx.newPage();
  const adminProblems = watch(ap);
  await ap.goto(BASE);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(ap, ADMIN, ADMIN_PW, next.code);
  await expect(ap).toHaveURL(ADMIN_BASE);
  await ap.goto(`${ADMIN_BASE}/settings/payments`);
  // The obsolete panel.toml section was imported once at the first start.
  await expect(ap.getByRole("heading", { name: "支付方式" })).toBeVisible();
  const imported = ap.locator("li", { hasText: "支付宝当面付" }).first();
  await expect(imported).toContainText("支付宝");
  await expect(ap.getByText(/panel.toml 中仍有已废弃的 \[payments\] 段/)).toBeVisible();
  // 测试连接 reports the (unreachable) gateway in Chinese.
  await imported.getByRole("button", { name: "测试连接" }).click();
  // (3 attempts; the closed port may time out instead of refusing.)
  await expect(imported.getByRole("alert")).toContainText("无法连接支付宝网关", { timeout: 60_000 });
  // Add a second method through the form (keys pasted; never shown back).
  await ap.getByLabel("添加支付方式").selectOption("alipay_f2f");
  await ap.getByRole("button", { name: "添加", exact: true }).click();
  await ap.getByLabel("名称（用户可见）").fill("支付宝 B");
  await ap.getByLabel("环境").selectOption("custom");
  await ap.getByLabel("网关地址（仅自定义）").fill("http://127.0.0.1:9/gateway.do");
  await ap.getByLabel("APPID").fill("2021000000000002");
  await ap.getByLabel("应用私钥", { exact: true }).fill(readFileSync(`${payDir}/app-key.pem`, "utf8"));
  await ap.getByLabel("支付宝公钥", { exact: true }).fill(readFileSync(`${payDir}/alipay-pub.pem`, "utf8"));
  await ap.getByLabel("启用（用户下单时可选）").check();
  await ap.getByRole("button", { name: "保存", exact: true }).click();
  const added = ap.locator("li", { hasText: "支付宝 B" });
  await expect(added).toContainText("已启用");
  await added.getByRole("button", { name: "编辑" }).click();
  await expect(ap.getByText(/已设置（公钥指纹/)).toBeVisible();
  await expect(ap.getByLabel("应用私钥", { exact: true })).toHaveValue("");
  await expect(ap.getByLabel("异步通知地址")).toHaveValue(/\/pay\/[0-9a-f-]{36}\/notify$/);
  await ap.getByRole("button", { name: "取消" }).click();
  // 注册: no email verification.
  await ap.getByRole("tab", { name: "注册" }).click();
  await ap.getByLabel("注册需要邮箱验证").selectOption("off");
  await ap.getByRole("button", { name: "保存注册设置" }).click();
  await expect(ap.getByText("已保存。").first()).toBeVisible();
  expect(adminProblems).toEqual([]);
  await actx.close();

  // Sign up with email + password only (the proof of work runs in the page).
  const ctx = await browser.newContext({ locale: "en-US" });
  const page = await ctx.newPage();
  const problems = watch(page);
  const email = `e2e-nov-${Date.now()}@e2e.test`;
  await page.goto(`${BASE}/register`);
  await expect(page.getByLabel("Email code")).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill("e2e-password-1");
  await page.getByLabel("Repeat password").fill("e2e-password-1");
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible({ timeout: 20_000 });
  await page.goto(`${BASE}/account`);
  await expect(page.getByText(`${email} · not verified`)).toBeVisible();
  // Two methods enabled: the checkout asks which one.
  await page.goto(`${BASE}/shop`);
  await page.getByRole("button", { name: "Buy", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Confirm your order" });
  await expect(sheet.getByRole("group", { name: "Payment method" })).toBeVisible();
  const payBtn = sheet.getByRole("button", { name: /^Pay / });
  await expect(payBtn).toBeDisabled();
  await sheet.getByLabel("支付宝 B").check();
  await expect(payBtn).toBeEnabled();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  expect(problems).toEqual([]);
  await ctx.close();
});

test("W25: settings imported from an old panel.toml, 节点通信 and 安全 forms", async ({ browser }) => {
  test.skip(!secret, "needs the enrollment test");
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  const problems = watch(page);
  await page.goto(BASE);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(page, ADMIN, ADMIN_PW, next.code);
  await expect(page).toHaveURL(ADMIN_BASE);
  // The obsolete keys of scripts/e2e.sh's panel.toml were imported once
  // (node domain from grpc.advertise, names, audit retention) and are named
  // in a banner asking to delete them.
  await page.goto(`${ADMIN_BASE}/settings/node`);
  await expect(page.getByText(/panel\.toml 中还有已废弃的配置项/)).toBeVisible();
  await expect(page.getByText(/grpc\.advertise/).first()).toBeVisible();
  await expect(page.locator("#settings-node")).toHaveValue(/^127\.0\.0\.1:\d+$/);
  await expect(page.getByRole("cell", { name: "myapp.test" })).toBeVisible();
  // 节点通信: ACME staging + no download fallback, then back to defaults.
  await page.getByLabel("ACME 目录").fill("https://acme-staging-v02.api.letsencrypt.org/directory");
  await page.getByLabel("备用下载地址").selectOption("none");
  await page.getByRole("button", { name: "保存安装与证书设置" }).click();
  await expect(page.getByText("已保存，所有面板实例已生效。")).toBeVisible();
  await expect(page.getByText(/当前生效：不使用/)).toBeVisible();
  await page.getByLabel("ACME 目录").fill("");
  await page.getByLabel("备用下载地址").selectOption("default");
  await page.getByRole("button", { name: "保存安装与证书设置" }).click();
  await expect(page.getByText(/当前生效：https:\/\/github\.com/)).toBeVisible();
  // 安全: the imported retention, a bad CIDR refused in Chinese, then saved.
  await page.getByRole("tab", { name: "安全" }).click();
  await expect(page).toHaveURL(`${ADMIN_BASE}/settings/security`);
  await expect(page.getByLabel("审计日志保留天数")).toHaveValue("180");
  await expect(page.getByText(/key-f2ad18a8bb718a1a\s*（官方，内置）/)).toBeVisible();
  await page.getByLabel("Cloudflare 网段").fill("not-a-range");
  await page.getByRole("button", { name: "保存安全设置" }).click();
  await expect(page.getByRole("alert")).toContainText("不是有效的 CIDR");
  await page.getByLabel("Cloudflare 网段").fill("");
  await page.getByLabel("流量明细保留天数").fill("90");
  await page.getByRole("button", { name: "保存安全设置" }).click();
  await expect(page.getByText("已保存，所有面板实例已生效。")).toBeVisible();
  await expect(page.getByText(/当前生效：\s*90 天/)).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});

test("agent update check: 检查更新 fetches the signed release, 有新版本 badge on the node list", async ({
  browser,
}) => {
  test.skip(!secret, "needs the enrollment test");
  const source = process.env.E2E_RELEASE_SOURCE ?? "";
  test.skip(!source || !E2E_DB, "needs scripts/e2e.sh");
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const page = await ctx.newPage();
  const problems = watch(page);
  await page.goto(`${BASE}/updates`);
  const next = await nextCode(secret, usedStep);
  usedStep = next.step;
  await login(page, ADMIN, ADMIN_PW, next.code);
  await expect(page).toHaveURL(`${ADMIN_BASE}/updates`);
  await expect(page.getByRole("heading", { name: "检查更新" })).toBeVisible();
  // The local stand-in for GitHub (e2e.sh), saved through the form.
  await page.getByLabel("发布源（GitHub 最新发布 API）").fill(source);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("status").filter({ hasText: "已保存" })).toBeVisible();
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText(/检查：已保存 v0\.9\.0（linux\/amd64、linux\/arm64）/)).toBeVisible({ timeout: 30_000 });
  const releases = page.getByRole("region", { name: "发布列表" });
  await expect(releases.getByRole("row").filter({ hasText: "linux/amd64" })).toContainText("就绪");
  await expect(releases.getByRole("row").filter({ hasText: "linux/arm64" })).toContainText("就绪");
  // A second check: nothing new.
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText(/检查：已是最新（v0\.9\.0）/)).toBeVisible({ timeout: 30_000 });
  // A node on an older agent (W11's node, as if it had connected).
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "akari",
      "-d",
      E2E_DB,
      "-qc",
      "UPDATE nodes SET agent_version = 'v0.1.0', agent_os = 'linux', agent_arch = 'amd64', agent_protocol = 3",
    ],
    { cwd: "..", stdio: "ignore" },
  );
  await page.goto(`${ADMIN_BASE}/nodes`);
  const badge = page.getByRole("link", { name: "有新版本 v0.9.0" });
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(page).toHaveURL(`${ADMIN_BASE}/updates`);
  // The rollout form now offers the fetched version.
  await expect(page.getByLabel("版本", { exact: true })).toContainText("v0.9.0");
  expect(problems).toEqual([]);
  await ctx.close();
});
