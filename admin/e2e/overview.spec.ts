// INVENTORY §2 (dashboard) and §3 (system status).
import { expect, test } from "@playwright/test";

import { CONSOLE, apiJson, dialog, openConsole, uniq, watch } from "./helpers";

test.describe.configure({ mode: "serial" });

test("DSH-01 DSH-02 DSH-03 DSH-04 DSH-05 DSH-07: tiles, traffic, needs-attention links, latest orders", async ({
  page,
}, info) => {
  const problems = watch(page);
  const u = await apiJson<{ id: string }>("POST", "/users", {
    email: `${uniq(info, "dash")}@e2e.test`,
    password: "dash-pass-1",
  });
  const plan = await apiJson<{ id: string }>("POST", "/plans", {
    name: uniq(info, "dash plan"),
    period: "monthly",
    pricing: { on_sale: false, prices: [{ period: "month", price_cents: 4200 }] },
  });
  const { id } = await apiJson<{ id: string }>("POST", "/orders/manual", {
    user_id: u.id,
    plan_id: plan.id,
    period: "month",
    reason: "dashboard",
  });
  const { order } = await apiJson<{ order: { out_trade_no: string } }>("GET", `/orders/${id}`);
  await openConsole(page, "");
  await expect(page.getByRole("heading", { level: 1, name: "仪表盘" })).toBeVisible();
  for (const t of ["今日营收", "有效订阅", "当前在线用户", "服务器在线"])
    await expect(page.getByText(t, { exact: true })).toBeVisible();
  await expect(page.getByText(/¥42\.00/).first()).toBeVisible();
  await expect(page.getByText("近 14 天全网流量（计费）")).toBeVisible();
  await expect(page.getByText("流量最多的节点")).toBeVisible();
  await expect(page.getByText("已删除的节点")).toBeVisible();
  // Latest orders → the order drawer.
  await page.getByRole("button", { name: new RegExp(order.out_trade_no) }).click();
  await expect(dialog(page, order.out_trade_no)).toBeVisible();
  await page.keyboard.press("Escape");
  // Needs attention → the filtered view.
  await page.goto(CONSOLE);
  await page.getByRole("button", { name: /待审核提现/ }).click();
  await expect(page).toHaveURL(/\/finance\?status=pending/);
  await page.goBack();
  await page.getByRole("button", { name: /已付款未开通的订单/ }).click();
  await expect(page).toHaveURL(/\/orders\?unfulfilled=1/);
  await page.goBack();
  await page.getByRole("button", { name: /发送失败的邮件/ }).click();
  await expect(page).toHaveURL(/\/settings\/mail\?outbox=dead/);
  await page.goBack();
  // Refresh (and the 30 s poll) re-reads.
  const reread = page.waitForResponse((r) => r.url().endsWith("/api/v1/dashboard"));
  await page.getByRole("button", { name: "刷新" }).click();
  await reread;
  expect(problems).toEqual([]);
});

test("ST-01 ST-02 ST-03 ST-04: panel instances, PostgreSQL, Valkey, proxy, background jobs", async ({ page }) => {
  await openConsole(page, "/status");
  await expect(page.getByRole("heading", { level: 1, name: "系统状态" })).toBeVisible();
  await expect(page.getByText("当前实例")).toBeVisible();
  await expect(page.getByRole("img", { name: /^CPU/ }).or(page.getByText("未知").first())).toBeVisible();
  await expect(page.getByText("面板进程内存")).toBeVisible();
  await expect(page.getByText("PostgreSQL")).toBeVisible();
  await expect(page.getByText("Valkey")).toBeVisible();
  await expect(page.getByText("反向代理（Caddy）")).toBeVisible();
  for (const j of ["流量结算", "支付对账", "邮件发件箱", "告警评估"]) await expect(page.getByText(j)).toBeVisible();
  // ST-04: dead letters link to the mail settings (none yet: the banner is absent).
  await expect(page.getByText(/封邮件发送失败/)).toHaveCount(0);
});
