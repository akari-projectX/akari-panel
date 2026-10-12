// Plan and node group shots for design compare (part of the commerce area,
// see commerce.ts). Not taken: plans-board-empty / -error and
// plans-groups-empty (the e2e data always has plans and groups; errors
// cannot be reproduced), plans-editor-groups-none (needs a database without
// any node group).
import { expect, type Page } from "@playwright/test";

import { apiJson } from "../helpers";
import { type Ctx, go, goDialog, goto, need, type Shot } from "./shared";

const plan = (c: Ctx) => need(c.planId, "plan");
const planName = (c: Ctx) => need(c.extra.planName, "plan name");

async function editor(page: Page, id: string, tab = ""): Promise<Page> {
  await goto(page, `/plans?open=${id}${tab ? `&tab=${tab}` : ""}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  return page;
}

async function act(page: Page, label: string, item: string): Promise<void> {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

export const shots: Shot[] = [
  { name: "plans-board-default", open: go("/plans") },
  { name: "plans-prices-default", open: go("/plans?view=prices") },
  {
    name: "plans-prices-dirty",
    open: async (page, c) => {
      await goto(page, "/plans?view=prices");
      const n = planName(c);
      await page.getByLabel(`${n} 年价格`).fill("219");
      await page.getByLabel(`${n} 半年价格`).fill("22.8.0");
      await page.getByLabel(`${n} 季价格`).fill("79");
      await expect(page.getByRole("region", { name: "未保存的价格" })).toBeVisible();
    },
  },
  { name: "plans-editor-basic", open: async (page, c) => void (await editor(page, plan(c))) },
  { name: "plans-editor-traffic", open: async (page, c) => void (await editor(page, plan(c), "traffic")) },
  { name: "plans-editor-groups", open: async (page, c) => void (await editor(page, plan(c), "groups")) },
  { name: "plans-editor-prices", open: async (page, c) => void (await editor(page, plan(c), "prices")) },
  { name: "plans-editor-stock", open: async (page, c) => void (await editor(page, plan(c), "stock")) },
  { name: "plans-editor-new", open: goDialog(() => "/plans?open=new") },
  {
    name: "plans-editor-invalid",
    open: async (page, c) => {
      const d = (await editor(page, plan(c), "prices")).getByRole("dialog");
      await d.getByLabel("半年付价格").fill("238.505");
      await d.getByRole("button", { name: "保存" }).click();
      await expect(d.getByText(/处需要修正/)).toBeVisible();
    },
  },
  {
    name: "plans-impact-confirm",
    open: async (page, c) => {
      const d = (await editor(page, plan(c), "traffic")).getByRole("dialog").first();
      await d.getByLabel("流量", { exact: true }).fill("300");
      await d.getByRole("button", { name: "保存" }).click();
      await expect(page.getByRole("dialog", { name: "这次改动会影响现有用户" })).toBeVisible();
    },
  },
  {
    name: "plans-disable-confirm",
    open: async (page, c) => {
      await goto(page, "/plans");
      await act(page, `套餐 ${planName(c)} 的操作`, "停用");
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  {
    name: "plans-delete-blocked",
    open: async (page, c) => {
      await goto(page, "/plans");
      await act(page, `套餐 ${planName(c)} 的操作`, "删除");
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "plans-delete-confirm",
    open: async (page, c) => {
      await goto(page, "/plans");
      await act(page, `套餐 ${need(c.extra.sparePlanName, "spare plan")} 的操作`, "删除");
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  { name: "plans-groups-default", open: go("/plans/groups") },
  {
    name: "plans-groups-editor",
    open: goDialog((c) => `/plans/groups?open=${need(c.extra.group, "node group")}`),
  },
  {
    name: "plans-groups-editor-search",
    open: async (page) => {
      await goto(page, "/plans/groups?open=new");
      const d = page.getByRole("dialog");
      await d.getByRole("searchbox", { name: "搜索入口" }).or(d.getByLabel("搜索入口")).first().fill("IPLC");
    },
  },
  {
    name: "plans-groups-delete",
    open: async (page, c) => {
      await goto(page, "/plans/groups");
      await act(page, `节点组 ${need(c.extra.groupName, "node group")} 的操作`, "删除");
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
];

/** A group on the shared plan (with the relay entrance), more prices on sale, and a plan nobody holds. */
export async function setup(ctx: Ctx): Promise<void> {
  const tag = Math.random().toString(36).slice(2, 7);
  const groupName = `专业 ${tag}`;
  const g = await apiJson<{ id: string }>("POST", "/node-groups", {
    name: groupName,
    description: "直连 + 中转",
    entrance_ids: ctx.entranceId ? [ctx.entranceId] : [],
  });
  ctx.extra.group = g.id;
  ctx.extra.groupName = groupName;
  if (ctx.planId) {
    const p = await apiJson<{ name: string }>("PATCH", `/plans/${ctx.planId}`, {
      description: "中转线路，晚高峰不掉速",
      traffic_quota_bytes: 200 * 1024 ** 3,
      group_ids: [g.id],
      capacity: 500,
      pricing: {
        on_sale: true,
        prices: [
          { period: "month", price_cents: 2900 },
          { period: "quarter", price_cents: 7900 },
          { period: "half_year", price_cents: 14800 },
          { period: "year", price_cents: 26900 },
        ],
      },
    });
    ctx.extra.planName = p.name;
  }
  const spare = `体验 ${tag}`;
  await apiJson("POST", "/plans", {
    name: spare,
    period: "none",
    traffic_quota_bytes: 10 * 1024 ** 3,
    pricing: { on_sale: false, prices: [{ period: "onetime", days: 7, price_cents: 500 }] },
  });
  ctx.extra.sparePlanName = spare;
}
