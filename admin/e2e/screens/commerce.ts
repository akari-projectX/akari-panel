// Orders, coupons, plans, node groups (v2 shots/commerce.json). The coupon
// and plan shots live in commerce-coupons.ts / commerce-plans.ts; this file
// is the area the screens spec loads. Not taken (cannot be reproduced with
// real data, or prototype demos): orders-ledger-empty / -error / -loading /
// -loadmore, orders-detail-refund-pending / -autorefund,
// orders-confirm-expired, orders-retry-dialog,
// orders-refund-loading / -usdt / -done, orders-export-error.
import { expect, type Page } from "@playwright/test";

import { apiJson } from "../helpers";
import { type Ctx, go, goDialog, goto, need, type Shot } from "./shared";
import * as coupons from "./commerce-coupons";
import * as plans from "./commerce-plans";

async function refundDialog(page: Page, c: Ctx): Promise<void> {
  await goto(page, `/orders?open=${need(c.orderId, "order")}`);
  await page.getByRole("dialog").getByRole("button", { name: "退款", exact: true }).click();
  const r = page.getByRole("dialog", { name: "退款", exact: true });
  await expect(r.getByRole("radio").first()).toBeVisible();
}

async function manual(page: Page, c: Ctx, step: number): Promise<void> {
  await goto(page, "/orders?new=1");
  const m = page.getByRole("dialog", { name: "新建人工订单" });
  const email = need(c.userEmail, "user");
  await m.getByLabel("用户邮箱").fill(email.slice(0, 8));
  if (step === 0) return void (await expect(m.getByRole("option").first()).toBeVisible());
  await m.getByRole("option", { name: new RegExp(email) }).click();
  await m.getByRole("button", { name: "下一步" }).click();
  await m.getByRole("radio").first().click();
  if (step === 1) return void (await expect(m.getByText("预计成交价")).toBeVisible());
  await m.getByRole("button", { name: "下一步" }).click();
  await m.getByLabel("原因").fill("微信转账，已核对流水");
}

const orders: Shot[] = [
  { name: "orders-ledger-default", open: go("/orders") },
  { name: "orders-ledger-unfulfilled", open: go("/orders?status=unfulfilled") },
  {
    name: "orders-ledger-search",
    open: async (page, c) => goto(page, `/orders?q=${encodeURIComponent(`@${need(c.userEmail, "user")}`)}&via=manual`),
  },
  { name: "orders-ledger-nomatch", open: go("/orders?q=A9999-no-such-order") },
  { name: "orders-detail-completed-coupon", open: goDialog((c) => `/orders?open=${need(c.orderId, "order")}`) },
  {
    name: "orders-detail-unfulfilled",
    open: goDialog((c) => `/orders?open=${need(c.extra.unfulfilledOrder, "unfulfilled order")}`),
  },
  {
    name: "orders-detail-pending",
    open: goDialog((c) => `/orders?open=${need(c.extra.pendingOrder, "pending order")}`),
  },
  { name: "orders-detail-gift", open: goDialog((c) => `/orders?open=${need(c.extra.giftOrder, "gift order")}`) },
  { name: "orders-refund-dialog", open: refundDialog },
  {
    name: "orders-refund-invalid",
    open: async (page, c) => {
      await refundDialog(page, c);
      const r = page.getByRole("dialog", { name: "退款", exact: true });
      await r.getByRole("radio", { name: /仅登记/ }).click();
      await r.getByLabel("实际已退金额").fill("200");
      await r.getByLabel(/输入订单号后 6 位/).fill("1205");
      await r.getByRole("button", { name: /^登记退款/ }).click();
      await expect(r.getByText(/处需要修正/)).toBeVisible();
    },
  },
  { name: "orders-manual-search", open: (page, c) => manual(page, c, 0) },
  {
    name: "orders-manual-nomatch",
    open: async (page) => {
      await goto(page, "/orders?new=1");
      const m = page.getByRole("dialog", { name: "新建人工订单" });
      await m.getByLabel("用户邮箱").fill("nobody@example.cn");
      await expect(m.getByText(/没有邮箱以/)).toBeVisible();
    },
  },
  { name: "orders-manual-plan", open: (page, c) => manual(page, c, 1) },
  { name: "orders-manual-confirm", open: (page, c) => manual(page, c, 2) },
  { name: "orders-export-dialog", open: goDialog(() => "/orders?export=1") },
  {
    name: "orders-export-invalid",
    open: async (page) => {
      await goto(page, "/orders?export=1");
      const x = page.getByRole("dialog", { name: "导出订单 CSV" });
      await x.locator('input[type="date"]').first().fill("2025-09-01");
      await expect(x.getByText(/最多 366 天/)).toBeVisible();
    },
  },
];

export const shots: Shot[] = [...orders, ...coupons.shots, ...plans.shots];

export async function setup(ctx: Ctx): Promise<void> {
  if (ctx.userId && ctx.planId) {
    const gift = await apiJson<{ id: string }>("POST", "/orders/manual", {
      user_id: ctx.userId,
      plan_id: ctx.planId,
      period: "month",
      gift: true,
      reason: "推广合作赠送 1 个月",
    });
    ctx.extra.giftOrder = gift.id;
  }
  await coupons.setup(ctx);
  await plans.setup(ctx);
}
