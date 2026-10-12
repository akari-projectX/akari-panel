// INVENTORY §1 (shell, sign-in, common interaction).
import { expect, test } from "@playwright/test";

import {
  ADMIN,
  API,
  CONSOLE,
  LOGIN,
  ORIGIN,
  PREFIX,
  USER,
  USER_PW,
  api,
  apiAs,
  apiJson,
  accountMenu,
  dialog,
  isMobile,
  nav,
  observe,
  openConsole,
  signIn,
  uniq,
  watch,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("SH-01 SH-06 SH-07 SH-08 SH-13 SH-18: sign-in page, non-admins refused, the console gated, sessions end", async ({
  page,
  request,
}, info) => {
  const problems = watch(page);
  const res = await page.goto(LOGIN);
  expect(res?.headers()["content-security-policy"]).toBe("default-src 'self'; style-src 'self' 'unsafe-inline'");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/管理后台/);
  await expect(page).toHaveTitle(/管理后台登录/);
  // W27 guard: the honeypot is in the form, invisible.
  await expect(page.locator("input[name=website]")).toBeAttached();
  await expect(page.locator("input[name=website]")).not.toBeInViewport();
  // Wrong password: the uniform answer.
  await page.locator("#email").fill(ADMIN);
  await page.locator("#password").fill("wrong-password-1");
  await page.locator("form button[type=submit]").click();
  await expect(page.getByRole("alert")).toHaveText("邮箱或密码错误");
  // A user's right password: not an admin (and no session left behind).
  await page.locator("#email").fill(USER);
  await page.locator("#password").fill(USER_PW);
  await page.locator("form button[type=submit]").click();
  await expect(page.getByRole("alert")).toContainText("不是管理员账户");
  // No session: the console and its paths are the canonical rejection.
  const reject = await observe(request, `${ORIGIN}/definitely-not-here`);
  for (const p of ["", "/users", "/settings/site", "/assets/missing.js"])
    expect(await observe(request, `${CONSOLE}${p}`)).toBe(reject);
  // A second admin (its sessions are ended below without touching the main one).
  const email = `${uniq(info, "admin2")}@e2e.test`;
  await apiJson("POST", "/users", { email, password: "admin2-password", role: "admin" });
  await signIn(page, email, "admin2-password", "/users");
  await expect(page).toHaveURL(`${CONSOLE}/users`);
  await expect(page).toHaveTitle("用户 · Akari 管理后台");
  // The session ends elsewhere: the next request brings the sign-in page back with the view to return to.
  const other = await apiAs(email, "admin2-password");
  await other.post(`${ORIGIN}/${PREFIX}/auth/logout`);
  await nav(page, info, "订单");
  await expect(page).toHaveURL(new RegExp(`/app\\?next=${encodeURIComponent(`/${PREFIX}/admin/orders`)}`));
  await expect(page.locator("#email")).toBeVisible();
  // Sign out from the account menu.
  await signIn(page, email, "admin2-password");
  await page.getByRole("button", { name: "账户菜单" }).click();
  await page.getByRole("menuitem", { name: "退出登录" }).click();
  await expect(page).toHaveURL(LOGIN);
  expect((await page.request.get(CONSOLE)).status()).toBe(404);
  expect(problems).toEqual([]);
});

test("SH-05: Turnstile on sign-ins widens the sign-in page's CSP and gates the form", async ({ page }) => {
  const before = await apiJson<Record<string, unknown>>("GET", "/settings/auth");
  const put = (o: Record<string, unknown>) =>
    apiJson("PUT", "/settings/auth", {
      version: o.version,
      turnstile_site_key: o.turnstile_site_key ?? null,
      turnstile_login: o.turnstile_login,
      turnstile_register: o.turnstile_register,
      turnstile_reset: o.turnstile_reset,
      honeypot: o.honeypot,
      min_submit_secs: o.min_submit_secs,
      passkey_only_admins: o.passkey_only_admins,
      passkey_only_users: o.passkey_only_users,
      passkey_prompt: o.passkey_prompt,
      ...("turnstile_secret" in o ? { turnstile_secret: o.turnstile_secret } : {}),
    });
  const on = await put({
    ...before,
    turnstile_site_key: "1x00000000000000000000AA",
    turnstile_secret: "1x0000000000000000000000000000000AA",
    turnstile_login: true,
  });
  try {
    const res = await page.goto(LOGIN);
    expect(res?.headers()["content-security-policy"]).toContain("https://challenges.cloudflare.com");
    await expect(page.getByTestId("turnstile")).toBeAttached();
    await page.locator("#email").fill(ADMIN);
    await page.locator("#password").fill("anything-1");
    await expect(page.locator("form button[type=submit]")).toBeDisabled();
  } finally {
    await put({
      ...(on as Record<string, unknown>),
      turnstile_login: false,
      turnstile_site_key: null,
      turnstile_secret: "",
    });
  }
  const res = await page.goto(LOGIN);
  expect(res?.headers()["content-security-policy"]).not.toContain("cloudflare");
});

test("SH-09 SH-10 SH-12 SH-16: sidebar / tab bar, toolbar, language, theme, badges, deep links and Back", async ({
  page,
}, info) => {
  const problems = watch(page);
  // A customer ticket: the nav badge counts it.
  const user = await apiAs(USER, USER_PW, true);
  expect(
    (
      await user.post(`${ORIGIN}/api/v1/me/tickets`, {
        data: { subject: uniq(info, "badge ticket"), category: "general", message: "hello" },
      })
    ).status(),
  ).toBe(201);
  await openConsole(page, "/users");
  if (isMobile(info)) {
    // Phone: no sidebar; a bottom tab bar (仪表盘/用户/订单/工单/更多) with the badge.
    await expect(page.getByRole("navigation", { name: "主导航" })).toBeHidden();
    const tabs = page.getByRole("navigation", { name: "标签栏" });
    for (const t of ["仪表盘", "用户", "订单", "工单", "更多"])
      await expect(tabs.getByRole("link", { name: new RegExp(`^${t}`) })).toBeVisible();
    await expect(tabs.getByRole("link", { name: /^工单/ }).getByLabel(/条待处理/)).toBeVisible();
    await expect(tabs.getByRole("link", { name: /^用户/ })).toHaveAttribute("aria-current", "page");
    await tabs.getByRole("link", { name: /^订单/ }).click();
  } else {
    const side = page.getByRole("navigation", { name: "主导航" });
    await expect(side.getByLabel(/条待处理/)).toBeVisible();
    await side.getByRole("link", { name: "订单" }).click();
    // Collapse: remembered across reloads.
    await page.getByRole("button", { name: "收起侧边栏" }).click();
    await page.reload();
    await expect(page.locator("aside[data-collapsed=true]")).toBeVisible();
    await page.getByRole("button", { name: "展开侧边栏" }).click();
    await expect(page.locator("aside[data-collapsed=false]")).toBeVisible();
    // Breadcrumb: group › page.
    await expect(page.getByRole("navigation", { name: "当前位置" })).toContainText(/运营.*订单/);
  }
  await expect(page).toHaveURL(`${CONSOLE}/orders`);
  await expect(page.getByRole("heading", { level: 1, name: "订单" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(`${CONSOLE}/users`);
  await expect(page.getByRole("heading", { level: 1, name: "用户" })).toBeVisible();
  // Theme and language (remembered): the toolbar on a desktop, the account menu on a phone.
  if (isMobile(info)) await accountMenu(page, "切换深色 / 浅色");
  else await page.getByRole("button", { name: "切换主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  if (isMobile(info)) await accountMenu(page, "English");
  else await page.getByRole("button", { name: "English" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Users" })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
  if (isMobile(info)) {
    // The More page lists every page and carries language and theme too.
    await page.getByRole("navigation", { name: "Tab bar" }).getByRole("link", { name: /^More/ }).click();
    const all = page.getByRole("navigation", { name: "All pages" });
    for (const t of ["System status", "Coupons", "Nodes", "Settings", "Audit log"])
      await expect(all.getByRole("link", { name: new RegExp(`^${t}`) })).toBeVisible();
    await page.getByRole("button", { name: /^Language/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "更多" })).toBeVisible();
    await page.getByRole("button", { name: /^深色模式/ }).click();
  } else {
    await page.getByRole("button", { name: "中文" }).click();
    await page.getByRole("button", { name: "切换主题" }).click();
  }
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  // The bell goes to the alert center.
  await page.getByRole("link", { name: /告警（/ }).click();
  await expect(page).toHaveURL(`${CONSOLE}/alerts`);
  expect(problems).toEqual([]);
});

test("SH-11: command palette — pages, actions, users by email, orders by number", async ({ page }, info) => {
  const email = `${uniq(info, "palette")}@e2e.test`;
  const u = await apiJson<{ id: string }>("POST", "/users", { email, password: "palette-pass-1" });
  const plan = await apiJson<{ id: string }>("POST", "/plans", {
    name: uniq(info, "palette plan"),
    period: "monthly",
    pricing: { on_sale: false, prices: [{ period: "month", price_cents: 100 }] },
  });
  const { id } = await apiJson<{ id: string }>("POST", "/orders/manual", {
    user_id: u.id,
    plan_id: plan.id,
    period: "month",
    gift: true,
    reason: "palette",
  });
  const { order } = await apiJson<{ order: { out_trade_no: string; id: string } }>("GET", `/orders/${id}`);
  await openConsole(page, "");
  const open = async () => {
    if (isMobile(info)) await page.getByRole("button", { name: "搜索", exact: true }).click();
    else await page.keyboard.press("ControlOrMeta+k");
    await expect(page.getByRole("combobox", { name: "搜索" })).toBeVisible();
  };
  await open();
  const box = page.getByRole("combobox", { name: "搜索" });
  await box.fill("系统状态");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${CONSOLE}/status`);
  await open();
  await box.fill("新建用户");
  await page.getByRole("option", { name: "新建用户" }).click();
  await expect(page.getByRole("dialog", { name: "新建用户" })).toBeVisible();
  await page.keyboard.press("Escape");
  await open();
  // "@" searches users only.
  await box.fill(`@${email.slice(0, 12)}`);
  await page.getByRole("option", { name: email }).click();
  await expect(page.getByRole("dialog", { name: email })).toBeVisible();
  await page.keyboard.press("Escape");
  await open();
  // "#" searches orders only.
  await box.fill(`#${order.out_trade_no}`);
  await page.getByRole("option", { name: order.out_trade_no }).click();
  await expect(page).toHaveURL(new RegExp(`/orders\\?open=${order.id}`));
  await expect(page.getByRole("dialog", { name: order.out_trade_no })).toBeVisible();
});

test("SH-14 SH-15 SH-17: error state with retry, empty state, site time zone in dates", async ({ page }) => {
  await page.route(`${API}/servers`, (r) => r.fulfill({ status: 500, body: "{}" }));
  await openConsole(page, "/nodes");
  await expect(page.getByText("加载失败")).toBeVisible();
  await page.unroute(`${API}/servers`);
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "节点" })).toBeVisible();
  await expect(page.getByText("加载失败")).toHaveCount(0);
  // Empty state with a next step.
  await page.goto(`${CONSOLE}/alerts?kind=disk`);
  await expect(page.getByText("没有匹配的记录")).toBeVisible();
  // Q3: the site time zone, not the browser's.
  const s = await apiJson<{ version: number }>("GET", "/settings");
  await apiJson("PUT", "/settings/site", { version: s.version, timezone: "UTC" });
  try {
    await page.goto(CONSOLE);
    await expect(page.getByText(/（UTC）/)).toBeVisible();
  } finally {
    const s2 = await apiJson<{ version: number }>("GET", "/settings");
    await apiJson("PUT", "/settings/site", { version: s2.version, timezone: null });
  }
  await (await api()).get(`${API}/me`);
});

test("SH-14: layers — Esc closes only the top one; typed changes ask before they are dropped", async ({
  page,
}, info) => {
  const problems = watch(page);
  await openConsole(page, "/users");
  const openCreate = async () => {
    if (isMobile(info)) await page.getByRole("button", { name: "搜索", exact: true }).click();
    else await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox", { name: "搜索" }).fill("新建用户");
    await page.getByRole("option", { name: "新建用户" }).click();
  };
  await openCreate();
  const create = dialog(page, "新建用户");
  await expect(create).toBeVisible();
  // Untouched: Esc closes at once.
  await page.keyboard.press("Escape");
  await expect(create).toBeHidden();
  // Typed: Esc asks; Esc on the question closes only the question.
  await openCreate();
  await expect(create).toBeVisible();
  await create
    .getByRole("textbox")
    .first()
    .fill(`${uniq(info, "dirty")}@e2e.test`);
  await page.keyboard.press("Escape");
  const ask = page.getByRole("alertdialog", { name: "放弃未保存的修改？" });
  await expect(ask).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(ask).toBeHidden();
  await expect(create).toBeVisible();
  await expect(create.getByRole("textbox").first()).toHaveValue(/dirty/);
  // Asked again; "放弃修改" drops the draft.
  await page.keyboard.press("Escape");
  await ask.getByRole("button", { name: "放弃修改" }).click();
  await expect(create).toBeHidden();
  expect(problems).toEqual([]);
});

test("SH-19: every page's chunks load under the admin prefix (no 404, no CSP report)", async ({ page }, info) => {
  test.skip(isMobile(info), "same bundle; the desktop run covers it");
  const problems = watch(page);
  const bad: string[] = [];
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (
      u.origin === ORIGIN &&
      r.status() >= 400 &&
      !u.pathname.startsWith(`/${PREFIX}/api/`) &&
      !/favicon|\/brand\//.test(u.pathname)
    )
      bad.push(`${r.status()} ${u.pathname}`);
    if (u.origin === ORIGIN && /\/assets\//.test(u.pathname) && !u.pathname.startsWith(`/${PREFIX}/admin/assets/`))
      bad.push(`outside the prefix: ${u.pathname}`);
  });
  const pages = [
    "",
    "/status",
    "/users",
    "/orders",
    "/coupons",
    "/finance",
    "/tickets",
    "/content",
    "/nodes",
    "/plans",
    "/alerts",
    "/updates",
    "/settings",
    "/audit",
    "/account",
    "/more",
  ];
  await openConsole(page, "");
  for (const p of pages) {
    await page.goto(`${CONSOLE}${p}`);
    await expect(page.locator("main[data-ready]")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  // Client-side switches too (chunks fetched on demand from the prefix).
  for (const name of ["用户", "节点", "订单", "系统设置", "仪表盘"]) {
    await nav(page, info, name);
    await expect(page.locator("main[data-ready]")).toBeVisible({ timeout: 20_000 });
  }
  expect(bad).toEqual([]);
  expect(problems).toEqual([]);
});
