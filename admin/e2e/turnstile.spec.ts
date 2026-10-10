// INVENTORY SH-05 SET-14 follow-up (next-01, "人机验证未通过"): Turnstile with Cloudflare's always-pass test
// keys and a 2 s minimum submit time. The console card saves without touching the stored secret;
// the sign-in page then logs in on the first attempt; a single-use widget token is never sent
// twice (after a refused non-admin account, a wrong password, a success).
import { expect, test, type Page } from "@playwright/test";

import { ADMIN, ADMIN_PW, CONSOLE, LOGIN, USER, USER_PW, apiJson, openConsole, toast } from "./helpers";

// Cloudflare's documented test keys: the widget always passes, siteverify always accepts.
const SITE_KEY = "1x00000000000000000000AA";
const SECRET = "1x0000000000000000000000000000000AA";

type Auth = Record<string, unknown> & { version: number; turnstile_secret_set: boolean; min_submit_secs: number };
const authBody = (o: Auth, patch: Record<string, unknown> = {}) => {
  const m = { ...o, ...patch };
  return {
    version: m.version,
    turnstile_site_key: m.turnstile_site_key ?? null,
    turnstile_login: m.turnstile_login,
    turnstile_register: m.turnstile_register,
    turnstile_reset: m.turnstile_reset,
    honeypot: m.honeypot,
    min_submit_secs: m.min_submit_secs,
    passkey_only_admins: m.passkey_only_admins,
    passkey_only_users: m.passkey_only_users,
    passkey_prompt: m.passkey_prompt,
    ...("turnstile_secret" in patch ? { turnstile_secret: patch.turnstile_secret } : {}),
  };
};

let before: Auth;
test.beforeEach(async () => {
  before = await apiJson<Auth>("GET", "/settings/auth");
  await apiJson(
    "PUT",
    "/settings/auth",
    authBody(before, {
      turnstile_site_key: SITE_KEY,
      turnstile_secret: SECRET,
      turnstile_login: true,
      min_submit_secs: 2,
    }),
  );
});
test.afterEach(async () => {
  const cur = await apiJson<Auth>("GET", "/settings/auth");
  await apiJson(
    "PUT",
    "/settings/auth",
    authBody(
      { ...before, version: cur.version },
      {
        turnstile_login: false,
        turnstile_register: false,
        turnstile_reset: false,
        turnstile_site_key: null,
        turnstile_secret: "",
      },
    ),
  );
});

/** Every sign-in request's Turnstile token, in order. */
function tokens(page: Page): string[] {
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/auth/login")) {
      sent.push(String((JSON.parse(r.postData() ?? "{}") as { guard?: { turnstile?: string } }).guard?.turnstile));
    }
  });
  return sent;
}

test("SET-14 SH-05: saving the bot-protection card (minimum time 2 s) keeps the stored secret; an admin then signs in at the first attempt", async ({
  page,
  browser,
}) => {
  await openConsole(page, "/settings/signup");
  const secretField = page.getByLabel("Turnstile 密钥（只写）");
  await expect(secretField).toHaveAttribute("autocomplete", "new-password");
  await expect(secretField).toHaveAttribute("data-1p-ignore", "true");
  await expect(secretField).toHaveValue("");
  const puts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PUT" && r.url().endsWith("/settings/auth")) puts.push(r.postData() ?? "");
  });
  const min = page.getByLabel("最短提交时间（秒，0 = 关闭）");
  for (const v of ["0", "2"]) {
    await min.fill(v);
    const saved = page.waitForResponse((r) => r.url().endsWith("/settings/auth") && r.request().method() === "PUT");
    await page.getByRole("button", { name: "保存", exact: true }).last().click();
    const res = await saved;
    expect(res.status(), await res.text()).toBe(200);
    await toast(page, "人机验证设置已保存");
  }
  expect(puts).toHaveLength(2);
  for (const b of puts) expect(b).not.toContain("turnstile_secret");
  const now = await apiJson<Auth>("GET", "/settings/auth");
  expect(now.turnstile_secret_set).toBe(true);
  expect(now.min_submit_secs).toBe(2);

  // A fresh browser: Cloudflare's real widget and siteverify with the stored (test) secret. A
  // replaced secret would answer 503 auth.captcha_unavailable here.
  const ctx = await browser.newContext({ locale: "zh-CN" });
  const p = await ctx.newPage();
  try {
    await p.goto(LOGIN);
    await p.locator("#email").fill(ADMIN);
    await p.locator("#password").fill(ADMIN_PW);
    await expect(p.locator("form button[type=submit]")).toBeEnabled({ timeout: 30_000 });
    const answer = p.waitForResponse((r) => r.url().endsWith("/auth/login"));
    await p.locator("form button[type=submit]").click();
    expect((await answer).status()).toBe(200);
    await p.waitForURL(new RegExp(`^${CONSOLE}`), { timeout: 20_000 });
  } finally {
    await ctx.close();
  }
});

// A stand-in widget that hands out a new token on every render and reset (Cloudflare's test
// sitekey always returns the same dummy string, so reuse would be invisible); siteverify is
// still Cloudflare's, with the always-pass test secret.
const STUB =
  "(function(){var n=0,w={};window.turnstile={render:function(el,o){var id='w'+(++n);" +
  "w[id]=function(){setTimeout(function(){o.callback('tok-'+id+'-'+Date.now()+'-'+Math.random().toString(36).slice(2))},50)};" +
  "w[id]();return id},reset:function(id){w[id]&&w[id]()},remove:function(){}}})();";

test("SH-05: a refused non-admin account and a wrong password each get a fresh token; the admin then signs in", async ({
  page,
}) => {
  await page.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({ contentType: "text/javascript", body: STUB }),
  );
  const sent = tokens(page);
  await page.goto(LOGIN);
  const submit = page.locator("form button[type=submit]");
  // Submitted at once: the page waits out the minimum time instead of being trapped.
  await page.locator("#email").fill(USER);
  await page.locator("#password").fill(USER_PW);
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText("这不是管理员账户。用户请在门户登录。");
  await page.locator("#email").fill(ADMIN);
  await page.locator("#password").fill("not-the-password");
  await submit.click();
  await expect(page.getByRole("alert")).toHaveText("邮箱或密码错误");
  await page.locator("#password").fill(ADMIN_PW);
  await submit.click();
  await page.waitForURL(new RegExp(`^${CONSOLE}`), { timeout: 20_000 });
  expect(sent).toHaveLength(3);
  expect(new Set(sent).size, sent.join("\n")).toBe(3);
  for (const t of sent) expect(t).toMatch(/^tok-/);
});

// The widget fails its first challenge (what a blocked headless browser gets); a reset passes.
const FAILING =
  "(function(){var n=0,w={};window.turnstile={render:function(el,o){var id='w'+(++n),k=0;" +
  "w[id]=function(){k++;setTimeout(function(){k===1?o['error-callback']('300030'):o.callback('tok-'+id+'-'+k)},50)};" +
  "w[id]();return id},reset:function(id){w[id]&&w[id]()},remove:function(){}}})();";

test("SH-05: a failed or blocked Turnstile says so, with a retry, instead of a network error", async ({ page }) => {
  await page.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({ contentType: "text/javascript", body: FAILING }),
  );
  await page.goto(LOGIN);
  await page.locator("#email").fill(ADMIN);
  await page.locator("#password").fill(ADMIN_PW);
  const alert = page.getByRole("alert").filter({ hasText: "人机验证加载失败，请刷新重试" });
  await expect(alert).toBeVisible();
  await expect(page.getByText(/网络/)).toHaveCount(0);
  const submit = page.locator("form button[type=submit]");
  await expect(submit).toBeDisabled();
  await alert.getByRole("button", { name: "重试" }).click();
  await expect(alert).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await submit.click();
  await page.waitForURL(new RegExp(`^${CONSOLE}`), { timeout: 20_000 });
  // A blocked script: the same message; retry reloads the page. (Leave the console first: its
  // session check would race the next navigation once the cookie is gone.)
  await page.goto("about:blank");
  await page.context().clearCookies();
  await page.unroute("https://challenges.cloudflare.com/**");
  await page.route("https://challenges.cloudflare.com/**", (r) => r.abort());
  await page.goto(LOGIN);
  await expect(alert).toBeVisible();
  const reloaded = page.waitForResponse((r) => r.request().resourceType() === "document");
  await alert.getByRole("button", { name: "重试" }).click();
  await reloaded;
});

// The widget's look: invisible unless an interaction is needed, as wide as the inputs, in the
// page's theme and language; re-rendered when either changes. "Verifying" shows until a token.
const RECORDING =
  "(function(){var n=0;window.__ts=[];window.turnstile={render:function(el,o){var id='w'+(++n);" +
  "window.__ts.push({appearance:o.appearance,size:o.size,theme:o.theme,language:o.language});" +
  "setTimeout(function(){o.callback('tok-'+id)},400);return id},reset:function(){},remove:function(){}}})();";

test("SH-05: Turnstile follows the page (interaction-only, flexible, theme, language)", async ({ page }) => {
  await page.route("https://challenges.cloudflare.com/**", (r) =>
    r.fulfill({ contentType: "text/javascript", body: RECORDING }),
  );
  await page.goto(LOGIN);
  await expect(page.getByText("正在进行人机验证…")).toBeVisible();
  await expect(page.getByText("正在进行人机验证…")).toHaveCount(0);
  const seen = () => page.evaluate(() => (window as unknown as { __ts: Record<string, string>[] }).__ts);
  const first = (await seen())[0];
  expect(first).toMatchObject({ appearance: "interaction-only", size: "flexible", language: "zh-cn" });
  const theme = first.theme;
  expect(["light", "dark"]).toContain(theme);
  await page.getByRole("button", { name: "切换主题" }).click();
  await expect.poll(async () => (await seen()).at(-1)?.theme).toBe(theme === "dark" ? "light" : "dark");
});
