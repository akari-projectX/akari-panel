// Shell, sign-in page, palette, my account (v2 shots/support.json; the
// tickets and content shots are in support-content.ts). Every mobile shot
// also shows the phone tab bar.
//
// Not taken (the real app cannot show them deterministically here): the
// sign-in page's turnstile / passkey-busy / passkey-only / not-admin / bind
// states (they need Turnstile switched on, a pending WebAuthn ceremony, a
// passkey-only account, or a user sign-in that would replace this
// context's admin session) and the account's adding / rename-error /
// delete / delete-last / passkey-only / loading / error states (they need
// passkeys on the admin account — none exist in the e2e data — or a stalled
// request).
import { expect, type Page } from "@playwright/test";

import { LOGIN, PREFIX, apiJson } from "../helpers";
import { go, goto, need, setStorage, type Ctx, type Device, type Shot } from "./shared";

async function palette(page: Page, device: Device, typed = ""): Promise<void> {
  await goto(page, "");
  if (device === "mobile") await page.getByRole("button", { name: "搜索", exact: true }).click();
  else await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("combobox", { name: "搜索" });
  await expect(box).toBeVisible();
  if (typed) {
    // "@" / "#" switch the mode (a chip); the rest is the search term.
    await box.pressSequentially(typed);
    await page.waitForTimeout(600); // debounced search
  }
}

async function orderNo(c: Ctx): Promise<string> {
  const { order } = await apiJson<{ order: { out_trade_no: string } }>("GET", `/orders/${need(c.orderId, "order")}`);
  return order.out_trade_no;
}

async function signInPage(page: Page, path = ""): Promise<void> {
  await page.goto(`${LOGIN}${path}`);
  await expect(page.locator("#email")).toBeVisible();
}

export const shots: Shot[] = [
  { name: "shell-sidebar-default", open: go("/content/announcements") },
  {
    name: "shell-sidebar-collapsed",
    devices: ["desktop"],
    open: async (page) => {
      await goto(page, "/content/kb");
      await setStorage(page, "akari.admin.sidebar", "collapsed");
      await page.reload();
      await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();
    },
    after: (page) => setStorage(page, "akari.admin.sidebar", null),
  },
  { name: "shell-palette", open: (page, _c, device) => palette(page, device) },
  {
    name: "shell-palette-users",
    open: async (page, c, device) => palette(page, device, `@${need(c.userEmail, "user").slice(0, 4)}`),
  },
  { name: "shell-palette-orders", open: async (page, c, device) => palette(page, device, `#${await orderNo(c)}`) },
  { name: "shell-palette-search", open: (page, _c, device) => palette(page, device, "邮件") },
  {
    name: "shell-account-menu",
    open: async (page) => {
      await goto(page, "/content/announcements?demo=account-menu");
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    name: "shell-bell",
    open: async (page) => {
      await goto(page, "/content/announcements?demo=bell");
      await expect(page.getByRole("dialog", { name: "正在告警" })).toBeVisible();
      // The list (or "一切正常") has arrived.
      await expect(page.getByRole("dialog", { name: "正在告警" }).getByRole("status")).toHaveCount(0);
    },
  },
  { name: "shell-more", open: go("/more") },
  // One page in English (?lang= is not remembered).
  { name: "shell-lang-en", open: go("/account?lang=en") },

  { name: "login-default", open: (page) => signInPage(page) },
  {
    name: "login-error",
    open: async (page) => {
      await signInPage(page);
      // An unknown address gets the same answer (and no admin's sign-in limit is spent).
      await page.locator("#email").fill("nobody@screens.invalid");
      await page.locator("#password").fill("not-the-password-1");
      await page.locator("form button[type=submit]").click();
      await expect(page.getByRole("alert")).toContainText("邮箱或密码不正确");
    },
  },
  {
    name: "login-session-expired",
    open: (page) => signInPage(page, `?next=${encodeURIComponent(`/${PREFIX}/admin/users`)}`),
  },
  {
    name: "login-signed-out",
    open: async (page) => {
      await signInPage(page, "?signed_out=1");
      await expect(page.getByText("已退出登录。")).toBeVisible();
    },
  },

  {
    name: "account-default",
    open: async (page) => {
      await goto(page, "/account");
      await expect(page.locator("[data-passkeys]")).toBeVisible();
    },
  },
  {
    name: "account-password-error",
    open: async (page) => {
      await goto(page, "/account");
      await page.getByLabel("当前密码").fill("hunter22");
      await page.getByLabel(/^新密码/).fill("Lantern-42");
      await page.getByLabel("再输一次新密码").fill("Lantern-24");
      await page.getByRole("button", { name: "修改密码" }).click();
      await expect(page.getByText("两次输入的新密码不一致")).toBeVisible();
    },
  },
];
