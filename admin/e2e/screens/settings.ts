// System settings and the mail template editor (v2 shots/settings.json).
// Every shot opens the real page; dialogs and states are reached with real
// clicks and edits, never saved (a shot that edits leaves the save bar up;
// the next shot's navigation discards it — goto() is a full page load).
// Not taken (prototype-only or not reproducible deterministically):
// settings-overview-error, settings-section-loading, settings-section-error,
// settings-payments-owner-locked / -editor-locked and settings-access-locked
// (`?as=admin`: the e2e session is the owner), settings-payments-add-type's
// 易支付/USDT kinds (only 支付宝当面付 exists), settings-templates-error
// (a deliberately broken template is not kept), settings-block-ruleset-delete
// (needs a custom rule set; the editor shot covers the dialog).
import { expect, type Page } from "@playwright/test";

import { go, goto, type Shot } from "./shared";

/** Edit a field without saving (the save bar shows up). */
async function edit(page: Page, label: string, value: string) {
  await page.getByLabel(label, { exact: true }).first().fill(value);
  await expect(page.getByRole("region", { name: "保存栏" })).toBeVisible();
}

/** Click the bar's 保存 and wait for the confirmation it asks. */
async function saveAsks(page: Page) {
  await page.getByRole("region", { name: "保存栏" }).getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
}

async function flip(page: Page, name: string) {
  await page.getByRole("switch", { name }).first().click();
}

export const shots: Shot[] = [
  { name: "settings-overview", open: go("/settings"), full: true },
  { name: "settings-overview-search", open: go("/settings?q=%E9%82%AE%E7%AE%B1") },
  { name: "settings-legacy-redirect", open: go("/settings?section=payments") },
  ...(
    [
      ["settings-site", "site"],
      ["settings-brand", "brand"],
      ["settings-links", "links"],
      ["settings-domains", "domains"],
      ["settings-signup", "signup"],
      ["settings-login", "login"],
      ["settings-cleanup", "cleanup"],
      ["settings-subscription", "subscription"],
      ["settings-routing", "routing"],
      ["settings-install", "install"],
      ["settings-probe", "probe"],
      ["settings-block", "block"],
      ["settings-updates", "updates"],
      ["settings-payments", "payments"],
      ["settings-commission", "commission"],
      ["settings-mail", "mail"],
      ["settings-notify", "notices"],
      ["settings-alerts", "alerts"],
      ["settings-access", "access"],
      ["settings-retention", "retention"],
      ["settings-passkeys", "account"],
    ] as const
  ).map(([name, id]): Shot => ({ name, open: go(`/settings/${id}`) })),
  // The common skeleton: the save bar with changes / with errors, the leave guard.
  {
    name: "settings-savebar-dirty",
    open: async (page) => {
      await goto(page, "/settings/signup");
      await flip(page, "注册需要邀请码");
    },
  },
  {
    name: "settings-savebar-invalid",
    open: async (page) => {
      await goto(page, "/settings/signup");
      await edit(page, "每个用户最多的邀请码数量", "-3");
    },
  },
  {
    name: "settings-unsaved-guard",
    devices: ["desktop"],
    open: async (page) => {
      await goto(page, "/settings/site");
      await edit(page, "站点名称", "Akari 灯");
      await page
        .getByRole("navigation", { name: "设置分类" })
        .getByRole("link", { name: /注册与邀请/ })
        .click();
      await expect(page.getByRole("dialog", { name: "有未保存的修改" })).toBeVisible();
    },
  },
  {
    name: "settings-site-tz-picker",
    open: async (page) => {
      await goto(page, "/settings/site");
      await page.getByRole("button", { name: "站点时区" }).click();
      await page.getByLabel("搜索时区").fill("asia/t");
    },
  },
  {
    name: "settings-site-tz-confirm",
    open: async (page) => {
      await goto(page, "/settings/site");
      await page.getByRole("button", { name: "站点时区" }).click();
      await page.getByLabel("搜索时区").fill("Asia/Tokyo");
      await page.getByRole("option", { name: "Asia/Tokyo", exact: true }).click();
      await saveAsks(page);
    },
  },
  {
    name: "settings-links-invalid",
    open: async (page) => {
      await goto(page, "/settings/links");
      await edit(page, "隐私政策链接", "akari.example/privacy");
    },
  },
  {
    name: "settings-domains-add",
    open: async (page) => {
      await goto(page, "/settings/domains");
      await page.getByRole("button", { name: "添加主域名" }).click();
      const d = page.getByRole("dialog", { name: "添加域名" });
      await d.getByLabel(/^域名/).fill("portal.example.com");
      await expect(d.getByText("即时检测")).toBeVisible();
    },
  },
  {
    name: "settings-domains-add-invalid",
    open: async (page) => {
      await goto(page, "/settings/domains");
      await page.getByRole("button", { name: "添加订阅域名" }).click();
      const d = page.getByRole("dialog", { name: "添加域名" });
      await d.getByLabel(/^域名/).fill("https://sub.akari");
      await expect(d.getByText("1 处需要修正")).toBeVisible();
    },
  },
  {
    name: "settings-domains-remove-impact",
    open: async (page) => {
      await goto(page, "/settings/domains");
      const menus = page.getByRole("button", { name: /^更多操作 / });
      for (let i = 0; i < (await menus.count()); i++) {
        await menus.nth(i).click();
        const remove = page.getByRole("menuitem", { name: "移除…" });
        if (await remove.isEnabled()) {
          await remove.click();
          await saveAsks(page);
          return;
        }
        await page.keyboard.press("Escape");
      }
      throw new Error("no removable domain");
    },
  },
  {
    name: "settings-domains-rpid",
    open: async (page) => {
      await goto(page, "/settings/domains");
      await page
        .getByRole("region", { name: "危险操作" })
        .getByRole("button", { name: /^(设置|更换)…$/ })
        .click();
      await expect(page.getByRole("dialog", { name: "通行密钥中心域名" })).toBeVisible();
    },
  },
  {
    name: "settings-login-invalid",
    open: async (page) => {
      await goto(page, "/settings/login");
      await edit(page, "最短提交时间（秒，0 = 关闭）", "90");
    },
  },
  {
    name: "settings-login-admin-passkey-confirm",
    open: async (page) => {
      await goto(page, "/settings/login");
      await flip(page, "管理员只能用通行密钥登录");
      await saveAsks(page);
    },
  },
  {
    name: "settings-cleanup-dirty",
    open: async (page) => {
      await goto(page, "/settings/cleanup");
      await edit(page, "注册超过 N 天", "14");
    },
  },
  {
    name: "settings-cleanup-auto-confirm",
    open: async (page) => {
      await goto(page, "/settings/cleanup");
      await flip(page, "自动清理");
      await saveAsks(page);
    },
  },
  {
    name: "settings-subscription-save-confirm",
    open: async (page) => {
      await goto(page, "/settings/subscription");
      await flip(page, "订阅格式 通用链接（v2rayN、Shadowrocket…）");
      await saveAsks(page);
    },
  },
  {
    name: "settings-subscription-rotate",
    open: async (page) => {
      await goto(page, "/settings/subscription");
      await page.getByRole("button", { name: "轮换订阅路径…" }).click();
      await expect(page.getByRole("dialog", { name: "轮换订阅路径" })).toBeVisible();
    },
  },
  {
    name: "settings-routing-invalid",
    open: async (page) => {
      await goto(page, "/settings/routing");
      await page.getByRole("button", { name: "添加规则" }).click();
      await expect(page.getByRole("region", { name: "保存栏" })).toBeVisible();
    },
  },
  {
    name: "settings-probe-tcp-confirm",
    open: async (page) => {
      await goto(page, "/settings/probe");
      const tcp = page.getByRole("switch", { name: "面板 TCP 测速" });
      if ((await tcp.getAttribute("aria-checked")) !== "true") throw new Error("the TCP probe is off");
      await tcp.click();
      await saveAsks(page);
    },
  },
  {
    name: "settings-block-ruleset-editor",
    open: async (page) => {
      await goto(page, "/settings/block");
      await page.getByRole("button", { name: "新建自定义规则" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "settings-updates-keys-confirm",
    open: async (page) => {
      await goto(page, "/settings/updates");
      const remove = page.getByRole("button", { name: /^删除公钥/ });
      if ((await remove.count()) === 0) throw new Error("no extra release key");
      await remove.first().click();
      await saveAsks(page);
    },
  },
  {
    name: "settings-payments-add-type",
    open: async (page) => {
      await goto(page, "/settings/payments");
      await page.getByRole("button", { name: "添加渠道" }).click();
      await expect(page.getByRole("dialog", { name: "添加支付方式" })).toBeVisible();
    },
  },
  {
    name: "settings-payments-editor",
    open: async (page) => {
      await goto(page, "/settings/payments");
      await page
        .getByRole("button", { name: /^编辑 / })
        .first()
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "settings-payments-disable-confirm",
    open: async (page) => {
      await goto(page, "/settings/payments");
      const on = page.locator('[role=switch][aria-checked="true"][aria-label^="启用 "]');
      if ((await on.count()) === 0) throw new Error("no enabled payment method");
      await on.first().click();
      await saveAsks(page);
    },
  },
  {
    name: "settings-commission-invalid",
    open: async (page) => {
      await goto(page, "/settings/commission");
      await edit(page, "返利比例（%）", "120");
    },
  },
  {
    name: "settings-mail-diagnose",
    open: async (page) => {
      await goto(page, "/settings/mail?diagnose=1");
      await expect(page.getByRole("dialog", { name: "测试发信" })).toBeVisible();
    },
  },
  {
    name: "settings-mail-smtp-invalid",
    open: async (page) => {
      await goto(page, "/settings/mail");
      await page.getByRole("radio", { name: /^SMTP/ }).click();
      await edit(page, "端口", "70000");
    },
  },
  {
    name: "settings-alerts-dirty",
    open: async (page) => {
      await goto(page, "/settings/alerts");
      await edit(page, "CPU 超过 %", "85");
    },
  },
  {
    name: "settings-access-self-excluded",
    open: async (page) => {
      await goto(page, "/settings/access");
      await page.getByLabel("添加地址或网段").fill("192.0.2.0/24");
      await page.getByRole("button", { name: "添加", exact: true }).click();
      await expect(page.getByRole("region", { name: "保存栏" })).toBeVisible();
    },
  },
  {
    name: "settings-access-rotate-prefix",
    open: async (page) => {
      await goto(page, "/settings/access");
      await page
        .getByRole("button", { name: /轮换前缀/ })
        .first()
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "settings-retention-shorten-confirm",
    open: async (page) => {
      await goto(page, "/settings/retention");
      await edit(page, "审计日志保留天数", "30");
      await page.getByRole("region", { name: "保存栏" }).getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  // The template editor (full width).
  { name: "settings-templates", open: go("/settings/templates") },
  { name: "settings-templates-phone-preview", devices: ["mobile"], open: go("/settings/templates?tab=preview") },
  { name: "settings-templates-phone-vars", devices: ["mobile"], open: go("/settings/templates?tab=vars") },
  {
    name: "settings-templates-reset-confirm",
    open: async (page) => {
      await goto(page, "/settings/templates");
      const reset = page.getByRole("button", { name: "恢复默认" });
      if (await reset.isDisabled()) throw new Error("the template is the default");
      await reset.click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    name: "settings-templates-send-draft",
    open: async (page) => {
      await goto(page, "/settings/templates");
      await page
        .getByRole("button", { name: /发送测试/ })
        .first()
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
];
