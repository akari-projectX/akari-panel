// Shell, login, palette, account, tickets, content (v2 shots/support.json).
// The shell shots live here (sidebar, collapsed sidebar, account menu, alert
// bell, palette modes, "更多", English UI); every mobile shot also shows the
// phone tab bar.
import { expect, type Page } from "@playwright/test";

import { LOGIN } from "../helpers";
import { go, goto, setStorage, type Device, type Shot } from "./shared";

async function palette(page: Page, device: Device, typed = ""): Promise<void> {
  await goto(page, "");
  if (device === "mobile") await page.getByRole("button", { name: "搜索", exact: true }).click();
  else await page.keyboard.press("ControlOrMeta+k");
  const box = page.getByRole("combobox", { name: "搜索" });
  await expect(box).toBeVisible();
  if (typed) {
    await box.fill(typed);
    await page.waitForTimeout(600); // debounced search
  }
}

export const shots: Shot[] = [
  {
    name: "login-default",
    open: async (page) => {
      await page.goto(LOGIN);
      await expect(page.locator("#email")).toBeVisible();
    },
  },
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
  { name: "shell-palette-users", open: (page, _c, device) => palette(page, device, "@") },
  { name: "shell-palette-orders", open: (page, _c, device) => palette(page, device, "#") },
  { name: "shell-palette-search", open: (page, _c, device) => palette(page, device, "screens") },
  {
    name: "shell-account-menu",
    open: async (page) => {
      await goto(page, "/content/announcements");
      await page.getByRole("button", { name: "账户菜单" }).last().click();
      await expect(page.getByRole("menu")).toBeVisible();
    },
  },
  {
    name: "shell-bell",
    open: async (page) => {
      await goto(page, "/content/announcements");
      await page
        .getByRole("button", { name: /^告警（/ })
        .last()
        .click();
      await expect(page.getByRole("dialog").or(page.getByRole("menu")).first()).toBeVisible();
    },
  },
  { name: "shell-more", open: go("/more") },
  {
    name: "shell-lang-en",
    open: async (page) => {
      await goto(page, "/account");
      await setStorage(page, "akari.admin.lang", "en");
      await page.reload();
      await expect(page.locator("main[data-ready]")).toBeVisible({ timeout: 20_000 });
    },
    after: (page) => setStorage(page, "akari.admin.lang", null),
  },
];
