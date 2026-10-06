// INVENTORY §5 (orders).
import { expect, test } from "@playwright/test";

import { apiJson, dialog, openConsole, openRow, row, sql, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

async function setup(tag: string) {
  const email = `${tag}@e2e.test`;
  const u = await apiJson<{ id: string }>("POST", "/users", { email, password: "order-pass-1" });
  const plan = await apiJson<{ id: string }>("POST", "/plans", {
    name: `${tag}-plan`,
    period: "monthly",
    pricing: {
      on_sale: true,
      prices: [
        { period: "month", price_cents: 1500 },
        { period: "quarter", price_cents: 4000 },
      ],
    },
  });
  return { email, userId: u.id, planId: plan.id };
}

test("ORD-07 ORD-01 ORD-02 ORD-03 ORD-05 ORD-06: manual orders, list and filters, the drawer, refunds (preview, routes, keep plan)", async ({
  page,
}, info) => {
  const tag = uniq(info, "ord");
  const { email } = await setup(tag);
  await openConsole(page, "/orders");
  // ORD-07: a manual order through the one pay path (no amount sent).
  await page.getByRole("button", { name: "新建人工订单" }).click();
  const m = dialog(page, "新建人工订单");
  await m.getByLabel("用户邮箱").fill(email);
  await m.getByRole("button", { name: email }).click();
  await m.getByLabel("套餐").selectOption({ label: `${tag}-plan` });
  await m.getByLabel("周期（有价格的）").selectOption("month");
  await m.getByLabel("原因（必填，写入订单与审计）").fill("e2e offline payment");
  await m.getByRole("button", { name: "创建并开通" }).click();
  await toast(page, "人工订单已创建并开通");
  // A second one (refunded below to a record-only route).
  await page.getByRole("button", { name: "新建人工订单" }).click();
  const m2 = dialog(page, "新建人工订单");
  await m2.getByLabel("用户邮箱").fill(email);
  await m2.getByRole("button", { name: email }).click();
  await m2.getByLabel("套餐").selectOption({ label: `${tag}-plan` });
  await m2.getByLabel("周期（有价格的）").selectOption("quarter");
  await m2.getByLabel("原因（必填，写入订单与审计）").fill("e2e second");
  await m2.getByRole("button", { name: "创建并开通" }).click();
  await toast(page, "人工订单已创建并开通");
  // ORD-02 filters: by user, status, manual.
  await page.getByLabel("用户邮箱").fill(email);
  await expect(page.locator("[data-row]:visible")).toHaveCount(2);
  await page.getByLabel("状态", { exact: true }).selectOption("manual");
  await expect(page.locator("[data-row]:visible")).toHaveCount(2);
  await page.getByLabel("状态", { exact: true }).selectOption("pending");
  await expect(page.getByText("没有匹配的记录")).toBeVisible();
  await page.getByLabel("状态", { exact: true }).selectOption("paid");
  await expect(row(page, "¥15.00")).toBeVisible();
  // ORD-03: the drawer with the amount breakdown.
  await openRow(page, "¥15.00");
  let d = dialog(page);
  await expect(d.getByText("金额拆分")).toBeVisible();
  await expect(d.getByText("e2e offline payment")).toBeVisible();
  // ORD-05: refund to the balance; the subscription effect is shown first.
  await d.getByRole("button", { name: "退款" }).click();
  let r = dialog(page, /^退款 /);
  await expect(r.getByText(/将取消订阅|恢复到|回退/)).toBeVisible();
  await expect(r.getByRole("radio", { name: /原路退回/ })).toBeDisabled();
  await r.getByRole("radio", { name: /退到用户余额/ }).check();
  await r.getByLabel("退款原因（必填，写入审计）").fill("e2e refund");
  await r.getByLabel(/二次确认/).fill((await r.getByRole("heading").first().innerText()).trim().slice(-6));
  await r.getByRole("button", { name: "确认退款" }).click();
  await toast(page, "已退款");
  await expect(d.getByText("e2e refund")).toBeVisible();
  await expect(d.getByText("订阅效果")).toBeVisible();
  await page.keyboard.press("Escape");
  // Record-only refund of the second order, keeping the plan.
  await openRow(page, "¥40.00");
  d = dialog(page);
  await d.getByRole("button", { name: "退款" }).click();
  r = dialog(page, /^退款 /);
  await r.getByRole("radio", { name: /仅登记/ }).check();
  await r.getByLabel("实际退回金额（元）").fill("40");
  await r.getByRole("checkbox", { name: "仅退款，保留套餐" }).click();
  await expect(r.getByText("保留套餐（仅退款）")).toBeVisible();
  await r.getByLabel("退款原因（必填，写入审计）").fill("refunded in the merchant console");
  await r.getByLabel(/二次确认/).fill((await r.getByRole("heading").first().innerText()).trim().slice(-6));
  await r.getByRole("button", { name: "确认退款" }).click();
  await toast(page, "已退款");
  await expect(d.getByText("保留套餐（仅退款）")).toBeVisible();
  await expect(row(page, "¥40.00")).toContainText("已退款");
});

test("ORD-04 ORD-08: mark an unpaid order paid (reason), CSV export", async ({ page }, info) => {
  const tag = uniq(info, "ordpay");
  const { email, planId } = await setup(tag);
  // A customer's unpaid order (the e2e gateway is unreachable: made directly) with a gateway event.
  const no = `E2E${Date.now()}${info.project.name.slice(0, 1)}`;
  sql(
    `INSERT INTO orders (id, out_trade_no, user_id, user_label, plan_id, plan_name, amount_cents, period, list_price_cents, ` +
      `credit_cents, discount_cents, balance_cents, balance_state, subject, expires_at, action) ` +
      `SELECT gen_random_uuid(), '${no}', u.id, 'u-' || left(replace(u.id::text, '-', ''), 8), '${planId}', '${tag}-plan', 1500, 'month', 1500, ` +
      `0, 0, 0, 'none', 'e2e', now() + interval '15 minutes', 'new' FROM users u WHERE u.email = '${email}'`,
  );
  sql(
    `INSERT INTO payment_events (order_id, out_trade_no, source, verified, outcome) SELECT id, out_trade_no, 'precreate', true, 'ok' FROM orders WHERE out_trade_no = '${no}'`,
  );
  await openConsole(page, `/orders?email=${encodeURIComponent(email)}`);
  await openRow(page, "¥15.00");
  const d = dialog(page);
  await expect(d.getByText("支付事件")).toBeVisible();
  await d.getByRole("button", { name: "人工确认付款" }).click();
  const f = dialog(page, "人工确认付款");
  await f.getByLabel("原因（必填，写入审计）").fill("paid by bank transfer");
  await f.getByRole("button", { name: "确认" }).click();
  await toast(page, "已确认付款");
  await expect(d.getByText("已付款").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "导出 CSV" }).click();
  const x = dialog(page, "导出订单 CSV");
  await x.getByLabel("状态").selectOption("paid");
  const dl = page.waitForEvent("download");
  await x.getByRole("link", { name: "下载" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.csv$/);
});
