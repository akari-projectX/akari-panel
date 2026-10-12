// Coupon shots for design compare (part of the commerce area, see
// commerce.ts). Not taken: coupons-list-empty / -error and
// coupons-batches-empty (the e2e data always has coupons and batches;
// errors cannot be reproduced).
import { expect, type Page } from "@playwright/test";

import { apiJson } from "../helpers";
import { type Ctx, go, goDialog, goto, need, type Shot } from "./shared";

const coupon = (c: Ctx) => need(c.extra.coupon, "coupon");

async function detail(page: Page, id: string, tab = ""): Promise<Page> {
  await goto(page, `/coupons?open=${id}${tab ? `&tab=${tab}` : ""}`);
  await expect(page.getByRole("dialog").getByRole("tab").first()).toBeVisible();
  return page;
}

export const shots: Shot[] = [
  { name: "coupons-list-default", open: go("/coupons") },
  { name: "coupons-list-live", open: go("/coupons?status=live") },
  { name: "coupons-list-nomatch", open: go("/coupons?q=XMAS-NO-SUCH") },
  { name: "coupons-new-dialog", open: goDialog(() => "/coupons?open=new") },
  {
    name: "coupons-new-invalid",
    open: async (page) => {
      await goto(page, "/coupons?open=new");
      const d = page.getByRole("dialog", { name: "新建优惠券" });
      await d.getByLabel("代码").fill("AUTUMN 20");
      await d.getByLabel("减免比例").fill("120");
      await d.getByLabel("总次数").fill("abc");
      await d.getByLabel("每人次数").fill("0");
      await d.getByRole("button", { name: "创建优惠券" }).click();
      await expect(d.getByText(/处需要修正/)).toBeVisible();
    },
  },
  { name: "coupons-detail-usage", open: async (page, c) => void (await detail(page, coupon(c))) },
  { name: "coupons-detail-edit", open: async (page, c) => void (await detail(page, coupon(c), "settings")) },
  {
    name: "coupons-detail-unused",
    open: async (page, c) => void (await detail(page, need(c.extra.couponUnused, "unused coupon"))),
  },
  {
    name: "coupons-disable-confirm",
    open: async (page, c) => {
      await detail(page, coupon(c));
      await page.getByRole("dialog").getByRole("button", { name: "停用", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    name: "coupons-delete-confirm",
    open: async (page, c) => {
      await detail(page, need(c.extra.couponUnused, "unused coupon"));
      await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  { name: "coupons-batches-default", open: go("/coupons/batches") },
  { name: "coupons-batches-generate", open: goDialog(() => "/coupons/batches?open=new") },
  {
    name: "coupons-batches-generate-invalid",
    open: async (page) => {
      await goto(page, "/coupons/batches?open=new");
      const d = page.getByRole("dialog", { name: "批量生成优惠码" });
      await d.getByLabel("数量").fill("8000");
      await d.getByLabel("随机部分长度").fill("3");
      await d.getByRole("button", { name: /^生成/ }).click();
      await expect(d.getByText(/处需要修正/)).toBeVisible();
    },
  },
  {
    name: "coupons-batches-void",
    open: async (page, c) => {
      await goto(page, "/coupons/batches");
      const item = page.locator(`[data-row="${need(c.extra.batch, "batch")}"]`);
      await item.getByRole("button", { name: "更多操作" }).click();
      await page.getByRole("menuitem", { name: "作废整批" }).click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
];

/** A used-looking coupon (with limits and a window), an unused one, and a batch. */
export async function setup(ctx: Ctx): Promise<void> {
  const tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  const ends = new Date(Date.now() + 19 * 86_400_000).toISOString();
  const a = await apiJson<{ id: string }>("POST", "/coupons", {
    code: `AUTUMN${tag}`,
    name: "秋季促销",
    kind: "percent",
    value: 20,
    periods: ["year", "half_year"],
    min_amount_cents: 3000,
    ends_at: ends,
    max_uses: 500,
    per_user_limit: 1,
    new_users_only: true,
  });
  ctx.extra.coupon = a.id;
  const b = await apiJson<{ id: string }>("POST", "/coupons", {
    code: `XMAS${tag}`,
    name: "圣诞立减",
    kind: "fixed",
    value: 1000,
  });
  ctx.extra.couponUnused = b.id;
  const batch = await apiJson<{ id: string }>("POST", "/coupon-batches", {
    name: `双十一 KOL 渠道 ${tag}`,
    prefix: "KOL11",
    count: 20,
    length: 8,
    kind: "percent",
    value: 30,
    max_uses: 1,
  });
  ctx.extra.batch = batch.id;
}
