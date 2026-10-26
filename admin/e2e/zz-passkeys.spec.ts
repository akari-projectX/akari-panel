// INVENTORY SH-02 SH-03 SH-04 ACC-03: passkeys need a secure context and a
// main domain, so this file (run last) makes e2e.localhost:<port> the main
// domain (Chromium resolves *.localhost to loopback and treats it as secure
// over http), drives a CDP virtual authenticator there, talks to the API on
// the IP literal (always served), and puts the domains back afterwards.
import { expect, request, test, type APIRequestContext, type Page } from "@playwright/test";

import { ADMIN, ADMIN_PW, LOGIN, MAILPIT, PREFIX, SMTP_PORT, apiJson, confirmDialog, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

const local = new URL(LOGIN);
local.hostname = "e2e.localhost";
const L_LOGIN = `${local.origin}/${PREFIX}/app`;
const L_CONSOLE = `${local.origin}/${PREFIX}/admin`;
const ip = new URL(LOGIN);
ip.hostname = "127.0.0.1";
const L_ORIGIN = ip.origin;
const L_API = `${L_ORIGIN}/${PREFIX}/api/v1`;

let admin: APIRequestContext;

async function signInApi(email: string, pw: string): Promise<APIRequestContext> {
  const ctx = await request.newContext();
  const opts = await (await ctx.get(`${L_ORIGIN}/${PREFIX}/auth/options`)).json();
  await new Promise((r) => setTimeout(r, (opts.guard?.form_min_secs ?? 0) * 1000 + 300));
  const r = await ctx.post(`${L_ORIGIN}/${PREFIX}/auth/login`, {
    data: { email, password: pw, guard: { form_token: opts.guard?.form_token ?? null } },
  });
  expect(r.status(), await r.text()).toBe(200);
  return ctx;
}

async function call(method: string, path: string, data?: unknown) {
  const r = await admin.fetch(`${L_API}${path}`, { method, data });
  expect(r.status(), `${method} ${path}: ${await r.text()}`).toBeLessThan(300);
  const t = await r.text();
  return t ? JSON.parse(t) : undefined;
}

async function authPolicy(patch: Record<string, unknown>) {
  const a = await call("GET", "/settings/auth");
  await call("PUT", "/settings/auth", {
    version: a.version,
    turnstile_site_key: a.turnstile_site_key,
    turnstile_login: a.turnstile_login,
    turnstile_register: a.turnstile_register,
    turnstile_reset: a.turnstile_reset,
    honeypot: a.honeypot,
    min_submit_secs: a.min_submit_secs,
    passkey_only_admins: a.passkey_only_admins,
    passkey_only_users: a.passkey_only_users,
    passkey_prompt: a.passkey_prompt,
    ...patch,
  });
}

/** Mail goes to the Mailpit sink. */
async function smtpToMailpit() {
  const m = await call("GET", "/settings/mail");
  await call("PUT", "/settings/mail", {
    version: m.version,
    enabled: true,
    provider: "smtp",
    host: "127.0.0.1",
    port: SMTP_PORT,
    security: "none",
    username: null,
    from_addr: "panel@e2e.test",
    from_name: "Akari",
    notify_order_paid: m.notify_order_paid,
    notify_expiry_days: m.notify_expiry_days,
    notify_expired: m.notify_expired,
    notify_quota: m.notify_quota,
    notify_refund: m.notify_refund,
  });
}

/** The newest message to `to` (Mailpit) whose subject matches: its text. */
async function mailText(to: string, subject: RegExp): Promise<string> {
  let text = "";
  await expect(async () => {
    const found = await (await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to}`)}`)).json();
    const hit = (found.messages ?? []).find((m: { Subject: string }) => subject.test(m.Subject));
    expect(hit).toBeTruthy();
    text = (await (await fetch(`${MAILPIT}/message/${hit.ID}`)).json()).Text as string;
  }).toPass({ timeout: 30_000 });
  return text;
}

/** A CDP virtual authenticator; the returned function forgets its credentials. */
async function authenticator(page: Page): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return async () => {
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
  };
}

test.beforeAll(async () => {
  // Main domain = http://localhost:<port> (the current Host is then refused: confirmed).
  const s = await apiJson<{
    version: number;
    sub: { domains: { domain: string }[] };
    node: { domains: { domain: string }[] };
    sub_domain_per_user: boolean;
  }>("GET", "/settings");
  await apiJson("PUT", "/settings", {
    version: s.version,
    main_domains: [local.host],
    sub_domains: s.sub.domains.map((d) => d.domain),
    node_domains: s.node.domains.map((d) => d.domain),
    sub_domain_per_user: s.sub_domain_per_user,
    trust_cloudflare: null,
    force_node_cloudflare: false,
    confirm_host_change: true,
    confirm_removal: false,
  });
  admin = await signInApi(ADMIN, ADMIN_PW);
});

test.afterAll(async () => {
  await authPolicy({ passkey_only_admins: false, passkey_prompt: false });
  const s = await call("GET", "/settings");
  await call("PUT", "/settings", {
    version: s.version,
    main_domains: [],
    sub_domains: s.sub.domains.map((d: { domain: string }) => d.domain),
    node_domains: s.node.domains.map((d: { domain: string }) => d.domain),
    sub_domain_per_user: s.sub_domain_per_user,
    trust_cloudflare: null,
    force_node_cloudflare: false,
    confirm_host_change: true,
    confirm_removal: true,
  });
});

test("SH-04 SH-02 SH-03 ACC-03: bind after a password sign-in, sign in with the passkey, passkey-only admins, manage passkeys", async ({
  page,
}, info) => {
  const email = `${uniq(info, "pk")}@e2e.test`;
  await call("POST", "/users", { email, password: "passkey-pass-1", role: "admin" });
  await authPolicy({ passkey_prompt: true });
  const forget = await authenticator(page);
  // SH-04: the password sign-in offers a passkey; bind it now.
  await page.goto(L_LOGIN);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill("passkey-pass-1");
  await page.locator("form button[type=submit]").click();
  await expect(page.getByRole("heading", { name: "为这个账户绑定通行密钥" })).toBeVisible();
  await page.getByRole("button", { name: "绑定通行密钥" }).click();
  await page.waitForURL(new RegExp(`/${PREFIX}/admin`));
  await expect(page.getByRole("button", { name: "账户菜单" })).toBeVisible();
  // ACC-03: listed, renamed, a second one added.
  await page.goto(`${L_CONSOLE}/account`);
  const list = page.locator("[data-passkeys]");
  await expect(list.getByText("最后使用").first()).toBeVisible();
  await list
    .getByRole("button", { name: / 的操作$/ })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "改名" }).click();
  await list.getByRole("textbox", { name: "名称", exact: true }).fill("e2e key");
  await list.getByRole("button", { name: "保存", exact: true }).click();
  await toast(page, "已改名");
  await expect(list.getByText("e2e key")).toBeVisible();
  // Replace it: delete (the last one: the confirmation warns; type its name), then add another
  // (one authenticator holds one credential per account).
  await list.getByRole("button", { name: "e2e key 的操作" }).click();
  await page.getByRole("menuitem", { name: "删除…" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("这是你最后一个可用的通行密钥");
  await expect(page.getByRole("alertdialog")).toContainText("只剩密码");
  await confirmDialog(page, "e2e key");
  await toast(page, "已删除「e2e key」");
  await expect(list.getByText("e2e key")).toHaveCount(0);
  await expect(list.getByText("还没有通行密钥。")).toBeVisible();
  await forget();
  // Added with a default name (browser · system), renamed in place.
  await list.getByRole("button", { name: "添加通行密钥" }).click();
  await toast(page, "通行密钥已添加");
  await list
    .getByRole("button", { name: / 的操作$/ })
    .first()
    .click();
  await page.getByRole("menuitem", { name: "改名" }).click();
  await list.getByRole("textbox", { name: "名称", exact: true }).fill("second");
  await list.getByRole("button", { name: "保存", exact: true }).click();
  await expect(list.getByText("second")).toBeVisible();
  // SH-02: sign out, sign in with the passkey (discoverable: no email asked).
  await page.getByRole("main").getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(`${L_LOGIN}?signed_out=1`);
  await page.getByRole("button", { name: "使用通行密钥登录" }).click();
  await page.waitForURL(new RegExp(`/${PREFIX}/admin`));
  await expect(page.getByRole("button", { name: "账户菜单" })).toBeVisible();
  // SH-03: admins passkey-only — the page shows the passkey button and the recovery command; passwords refused.
  await authPolicy({ passkey_only_admins: true });
  const other = await page.context().browser()!.newContext();
  const p2 = await other.newPage();
  await p2.goto(L_LOGIN);
  // The right password of a passkey-only admin: refused (403), the page switches to the passkey alone.
  await p2.locator("#email").fill(email);
  await p2.locator("#password").fill("passkey-pass-1");
  const refused = p2.waitForResponse((r) => r.url().endsWith("/auth/login"));
  await p2.locator("form button[type=submit]").click();
  expect((await refused).status()).toBe(403);
  await expect(p2.getByRole("button", { name: "使用通行密钥登录" })).toBeVisible();
  await expect(p2.getByText(/akari admin reset-login/)).toBeVisible();
  await expect(p2.locator("#password")).toHaveCount(0);
  // Passkeys unusable: password + a code mailed to the verified address.
  if (MAILPIT && SMTP_PORT) {
    await smtpToMailpit();
    await p2.getByRole("button", { name: "通行密钥用不了？改用密码 + 邮箱验证码" }).click();
    const fb = p2.getByTestId("passkey-fallback");
    await expect(fb.locator("#fallback-email")).toHaveValue(email);
    await fb.locator("#fallback-password").fill("wrong-pass-1");
    await fb.getByRole("button", { name: "发送邮箱验证码" }).click();
    await expect(p2.getByText("邮箱或密码不正确")).toBeVisible();
    await fb.locator("#fallback-password").fill("passkey-pass-1");
    await fb.getByRole("button", { name: "发送邮箱验证码" }).click();
    await expect(fb.getByText("验证码已发送到账户的已验证邮箱")).toBeVisible();
    const code = /\b(\d{6})\b/.exec(await mailText(email, /登录验证码/))![1];
    await fb.locator("#fallback-code").fill(code === "000000" ? "111111" : "000000");
    await fb.getByRole("button", { name: "登录", exact: true }).click();
    await expect(p2.getByText("验证码不正确或已失效")).toBeVisible();
    await fb.locator("#fallback-code").fill(code);
    await fb.getByRole("button", { name: "登录", exact: true }).click();
    await p2.waitForURL(new RegExp(`/${PREFIX}/admin`));
    await expect(p2.getByRole("button", { name: "账户菜单" })).toBeVisible();
    // The fallback sign-in is announced to the verified address.
    await mailText(email, /账号安全提醒/);
  }
  await other.close();
  await authPolicy({ passkey_only_admins: false });
  // ACC-03: passkey-only for this account (on, off), then delete both passkeys.
  await page.goto(`${L_CONSOLE}/account`);
  const only = page.getByRole("switch", { name: /只用通行密钥登录/ });
  // Turning it on asks first (how to recover is spelled out); cancelling changes nothing.
  await only.click();
  const ask = page.getByRole("dialog", { name: "只用通行密钥登录？" });
  await expect(ask).toContainText("akari admin reset-login");
  await expect(ask).toContainText("second");
  await ask.getByRole("button", { name: "取消" }).click();
  await expect(only).toHaveAttribute("aria-checked", "false");
  await only.click();
  // "开启" waits for the acknowledgement.
  await expect(ask.getByRole("button", { name: "开启" })).toBeDisabled();
  await ask.getByRole("checkbox").check();
  await ask.getByRole("button", { name: "开启" }).click();
  await toast(page, "已改为只用通行密钥登录");
  await expect(only).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("main").getByText("已关闭", { exact: true })).toBeVisible();
  await only.click();
  await expect(only).toHaveAttribute("aria-checked", "false");
  for (const n of ["second"]) {
    await list.getByRole("button", { name: `${n} 的操作` }).click();
    await page.getByRole("menuitem", { name: "删除…" }).click();
    await confirmDialog(page, n);
    await expect(list.getByText(n)).toHaveCount(0);
  }
  await expect(list.getByText("还没有通行密钥。")).toBeVisible();
});

test("SH-03b: a browser that refuses the site's passkeys gets the emailed-code fallback up front", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.credentials.get = () => Promise.reject(new DOMException("related origin not allowed", "SecurityError"));
  });
  await page.goto(L_LOGIN);
  await page.getByRole("button", { name: "使用通行密钥登录" }).click();
  const fb = page.getByTestId("passkey-fallback");
  await expect(page.getByText("这个浏览器无法使用本站的通行密钥").first()).toBeVisible();
  await expect(fb.getByRole("button", { name: "发送邮箱验证码" })).toBeVisible();
  await expect(fb.getByRole("button", { name: "使用通行密钥登录" })).toHaveCount(0);
});
