// Users and finance (v2 shots/people.json). Three sections (list + batch,
// user detail + its dialogs, finance), each with its own shots and setup.
// Not taken (cannot be reproduced deterministically, or prototype-only):
// users-list-empty / -loading / -error, users-job-running,
// users-detail-loading / -error, finance-withdrawals-cap / -empty / -error,
// finance-balances-error, finance-commissions-error, finance-withdrawals-memo
// (needs a TON withdrawal with a memo).
import { expect, type Page } from "@playwright/test";

import { apiJson } from "../helpers";
import { goDialog, goto, need, type Ctx, type Device, type Shot } from "./shared";

// ---- users list, batch, jobs, bulk delete ---------------------------------

/** Tick the first `n` visible rows (a phone enters 选择 mode first). */
async function tickRows(page: Page, device: Device, n: number) {
  if (device === "mobile") await page.getByRole("button", { name: "选择", exact: true }).click();
  const boxes = page.locator("[data-row]:visible").getByRole("checkbox");
  await expect(boxes.first()).toBeVisible();
  if ((await boxes.count()) < n) throw new Error(`fewer than ${n} users in the list`);
  for (let i = 0; i < n; i++) await boxes.nth(i).click();
}

const bar = (page: Page) => page.getByRole("region", { name: "批量操作" });

/** Open the batch wizard from the bar: an action button, or a ⋯ menu item. */
async function batch(page: Page, device: Device, n: number, item: { button?: string; menu?: string }) {
  await goto(page, "/users");
  await tickRows(page, device, n);
  if (item.button) await bar(page).getByRole("button", { name: item.button, exact: true }).click();
  else {
    await bar(page).getByRole("button", { name: "更多批量操作" }).click();
    await page.getByRole("menuitem", { name: item.menu }).click();
  }
  await expect(page.getByRole("dialog")).toBeVisible();
}

const listShots: Shot[] = [
  { name: "users-list-default", open: async (page) => goto(page, "/users") },
  { name: "users-list-view-expiring", open: async (page) => goto(page, "/users?view=expiring&sort=expires") },
  { name: "users-list-plan", open: async (page, c) => goto(page, `/users?view=plan:${need(c.planId, "plan")}`) },
  {
    name: "users-list-filters",
    open: async (page, c) =>
      goto(
        page,
        `/users?view=active&plan=${need(c.planId, "plan")}&reg=${new Date(Date.now() + 86400_000)
          .toISOString()
          .slice(0, 10)}&cols=login,balance,passkeys`,
      ),
  },
  {
    name: "users-list-selection",
    open: async (page, _c, device) => {
      await goto(page, "/users");
      await tickRows(page, device, 3);
      await expect(bar(page)).toBeVisible();
    },
  },
  {
    name: "users-list-selection-all",
    open: async (page, _c, device) => {
      await goto(page, "/users?view=never");
      await tickRows(page, device, 1);
      await bar(page)
        .getByRole("button", { name: /选择全部匹配的/ })
        .click();
      await expect(bar(page)).toContainText("全部匹配的");
    },
  },
  { name: "users-list-nomatch", open: async (page) => goto(page, "/users?q=zzzz@nowhere") },
  {
    name: "users-jobs-panel",
    open: async (page) => {
      await goto(page, "/users?jobs=1");
      await expect(page.locator("[data-slot=popover-content]")).toBeVisible();
    },
  },
  { name: "users-job-detail", open: goDialog((c) => `/users?job=${need(c.extra.jobId, "batch job")}`) },
  { name: "users-batch-pick", open: async (page, _c, device) => batch(page, device, 3, { menu: "选择操作…" }) },
  { name: "users-batch-params", open: async (page, _c, device) => batch(page, device, 3, { button: "延长" }) },
  { name: "users-batch-mail", open: async (page, _c, device) => batch(page, device, 3, { menu: "发送邮件" }) },
  {
    name: "users-batch-preview",
    open: async (page, _c, device) => {
      await batch(page, device, 3, { button: "延长" });
      await page.getByRole("dialog").getByRole("button", { name: "预览", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("将处理");
    },
  },
  {
    name: "users-bulk-delete",
    open: async (page, _c, device) => {
      await goto(page, "/users?view=never");
      await tickRows(page, device, 2);
      await bar(page).getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
];

async function listSetup(ctx: Ctx): Promise<void> {
  // A finished job for the job detail (unban: everyone is skipped, nothing changes).
  if (!ctx.userId) return;
  const job = await apiJson<{ id: string }>("POST", "/users/batch", {
    selection: { ids: [ctx.userId] },
    action: { kind: "unban" },
  });
  ctx.extra.jobId = job.id;
}

// ---- user detail, its dialogs, create user ---------------------------------

const detail = (tab?: string, id: (c: Ctx) => string | undefined = (c) => c.userId) =>
  goDialog((c) => `/users?open=${need(id(c), "user")}${tab ? `&tab=${tab}` : ""}`);

/** Open a detail (optionally a tab), then click a button in it. */
const detailThen =
  (
    tab: string | undefined,
    click: (page: Page) => Promise<void>,
    id: (c: Ctx) => string | undefined = (c) => c.userId,
    role: "dialog" | "alertdialog" = "dialog",
  ) =>
  async (page: Page, c: Ctx): Promise<void> => {
    await goto(page, `/users?open=${need(id(c), "user")}${tab ? `&tab=${tab}` : ""}`);
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await click(page);
    await expect(page.getByRole(role).last()).toBeVisible();
  };

const inDetail = (page: Page) => page.getByRole("dialog").first();

const detailShots: Shot[] = [
  { name: "users-create", open: goDialog(() => "/users?new=1") },
  {
    name: "users-create-errors",
    open: async (page) => {
      await goto(page, "/users?new=1");
      const d = page.getByRole("dialog");
      await d.getByLabel("邮箱", { exact: true }).fill("not-an-email");
      await d.getByRole("button", { name: "创建用户" }).click();
      await expect(d.getByText(/需要修正/)).toBeVisible();
    },
  },
  // The e2e admin is the owner: the owner's view of the same dialog.
  { name: "users-create-owner", open: goDialog(() => "/users?new=1") },
  { name: "users-detail-overview", open: detail() },
  {
    name: "users-detail-overview-sub",
    open: detailThen(undefined, async (page) => {
      await inDetail(page).getByRole("button", { name: "显示", exact: true }).click();
      await expect(inDetail(page).getByRole("img", { name: "订阅链接二维码" })).toBeVisible();
    }),
  },
  { name: "users-detail-banned", open: detail(undefined, (c) => c.extra.bannedId) },
  { name: "users-detail-noplan", open: detail(undefined, (c) => c.extra.noPlanId) },
  { name: "users-detail-traffic", open: detail("traffic") },
  { name: "users-detail-billing", open: detail("billing") },
  { name: "users-detail-security", open: detail("security") },
  { name: "users-detail-security-admin", open: detail("security", (c) => c.extra.adminId) },
  {
    name: "users-dlg-plan",
    open: detailThen(undefined, (p) => inDetail(p).getByRole("button", { name: "更换套餐" }).click()),
  },
  {
    name: "users-dlg-ban",
    open: detailThen(undefined, (p) => inDetail(p).getByRole("button", { name: "封禁", exact: true }).click()),
  },
  {
    name: "users-dlg-ban-other",
    open: detailThen(undefined, async (p) => {
      await inDetail(p).getByRole("button", { name: "封禁", exact: true }).click();
      await p.getByRole("dialog").last().getByRole("radio", { name: /^其他/ }).click();
    }),
  },
  {
    name: "users-dlg-unban",
    open: detailThen(
      undefined,
      (p) => inDetail(p).getByRole("button", { name: "解除封禁" }).first().click(),
      (c) => c.extra.bannedId,
      "alertdialog",
    ),
  },
  {
    name: "users-dlg-balance",
    open: detailThen("billing", (p) => inDetail(p).getByRole("button", { name: "人工调整余额" }).click()),
  },
  {
    name: "users-dlg-balance-error",
    open: detailThen("billing", async (p) => {
      await inDetail(p).getByRole("button", { name: "人工调整余额" }).click();
      const d = p.getByRole("dialog", { name: "人工调整余额" });
      await d.getByRole("button", { name: "扣减" }).click();
      await d.getByLabel("金额（元）").fill("99999");
    }),
  },
  {
    name: "users-dlg-reset-traffic",
    open: detailThen(
      undefined,
      (p) => inDetail(p).getByRole("button", { name: "重置流量" }).first().click(),
      undefined,
      "alertdialog",
    ),
  },
  {
    name: "users-dlg-reset-sub",
    open: detailThen(
      undefined,
      async (p) => {
        await inDetail(p).getByRole("button", { name: "更多操作" }).click();
        await p.getByRole("menuitem", { name: "重置订阅链接…" }).click();
      },
      undefined,
      "alertdialog",
    ),
  },
  {
    name: "users-dlg-cancel-plan",
    open: detailThen(
      undefined,
      (p) => inDetail(p).getByRole("button", { name: "取消套餐" }).click(),
      undefined,
      "alertdialog",
    ),
  },
  {
    name: "users-dlg-delete",
    open: detailThen(
      "security",
      (p) => inDetail(p).getByRole("button", { name: "删除…" }).click(),
      undefined,
      "alertdialog",
    ),
  },
  {
    name: "users-dlg-owner",
    open: detailThen(
      "security",
      (p) => inDetail(p).getByRole("button", { name: "转让", exact: true }).click(),
      (c) => c.extra.adminId,
      "alertdialog",
    ),
  },
  {
    name: "users-dlg-reset-login",
    open: detailThen(
      "security",
      async (p) => {
        const b = inDetail(p).getByRole("button", { name: "重置", exact: true });
        if (await b.isDisabled()) throw new Error("no sign-in method to reset");
        await b.click();
      },
      undefined,
      "alertdialog",
    ),
  },
  {
    name: "users-dlg-password",
    open: detailThen("security", (p) => inDetail(p).getByRole("button", { name: "设置新密码" }).click()),
  },
  {
    name: "users-dlg-kick",
    open: detailThen(
      "security",
      (p) => inDetail(p).getByRole("button", { name: "踢下线", exact: true }).click(),
      undefined,
      "alertdialog",
    ),
  },
];

async function detailSetup(ctx: Ctx): Promise<void> {
  const tag = `${ctx.info.project.name}-${Date.now().toString(36)}`;
  const make = async (local: string, extra: Record<string, unknown> = {}) =>
    (
      await apiJson<{ id: string }>("POST", "/users", {
        email: `screens-${local}-${tag}@e2e.test`,
        password: "screens-pass-1",
        ...extra,
      })
    ).id;
  ctx.extra.noPlanId = await make("noplan");
  ctx.extra.adminId = await make("admin", { role: "admin" });
  const banned = await make("banned", ctx.planId ? { plan: { plan_id: ctx.planId, period: "month" } } : {});
  if (banned) {
    await apiJson("POST", `/users/${banned}/ban`, { reason: "共享账号：多人同时在线" });
    ctx.extra.bannedId = banned;
  }
  if (ctx.userId) await apiJson("POST", `/users/${ctx.userId}/balance`, { amount_cents: 4260, reason: "screens" });
}

// ---- finance ---------------------------------------------------------------

/** Open the first pending withdrawal (the FIN spec or the portal made one), else not taken. */
async function firstPending(page: Page) {
  await goto(page, "/finance/withdrawals");
  const r = page.locator("[data-row]:visible").first();
  if (!(await r.count())) throw new Error("no pending withdrawal in the data");
  await r.click();
  await expect(page.getByRole("form", { name: "确认已打款" })).toBeVisible();
}

const financeShots: Shot[] = [
  { name: "finance-withdrawals-default", open: async (page) => goto(page, "/finance/withdrawals") },
  {
    name: "finance-withdrawals-hash-error",
    open: async (page) => {
      await firstPending(page);
      const f = page.getByRole("form", { name: "确认已打款" });
      await f.getByLabel("交易哈希").fill("bad");
      await f.getByRole("button", { name: "确认已打款" }).click();
    },
  },
  {
    name: "finance-withdrawals-reject",
    open: async (page) => {
      await firstPending(page);
      await page.getByRole("button", { name: "拒绝…" }).click();
      await expect(page.getByRole("group", { name: "拒绝这笔提现" })).toBeVisible();
    },
  },
  { name: "finance-withdrawals-completed", open: async (page) => goto(page, "/finance/withdrawals?status=approved") },
  { name: "finance-balances-default", open: async (page) => goto(page, "/finance/balances") },
  {
    name: "finance-balances-search",
    open: async (page, c) => goto(page, `/finance/balances?q=${encodeURIComponent(need(c.userEmail, "user"))}`),
  },
  { name: "finance-balances-ledger", open: goDialog((c) => `/finance/balances?open=${need(c.userId, "user")}`) },
  {
    name: "finance-balances-adjust",
    open: async (page, c) => {
      await goto(page, `/finance/balances?open=${need(c.userId, "user")}`);
      await page.getByRole("dialog").getByRole("button", { name: "人工调整" }).click();
      await expect(page.getByRole("dialog", { name: "人工调整余额" })).toBeVisible();
    },
  },
  { name: "finance-commissions-default", open: async (page) => goto(page, "/finance/commissions") },
  { name: "finance-commissions-frozen", open: async (page) => goto(page, "/finance/commissions?status=pending") },
  {
    name: "finance-commissions-nomatch",
    open: async (page) => goto(page, "/finance/commissions?email=nobody%40nowhere.example"),
  },
];

async function financeSetup(_ctx: Ctx): Promise<void> {}

// ---------------------------------------------------------------------------

export const shots: Shot[] = [...listShots, ...detailShots, ...financeShots];

export async function setup(ctx: Ctx): Promise<void> {
  await listSetup(ctx);
  await detailSetup(ctx);
  await financeSetup(ctx);
}
