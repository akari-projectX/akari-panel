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

test("ORD-07 ORD-01 ORD-02 ORD-03 ORD-05 ORD-06: manual orders, list and filters, the order dialog, refunds (preview, routes, keep plan)", async ({
  page,
}, info) => {
  const tag = uniq(info, "ord");
  const { email } = await setup(tag);
  await openConsole(page, "/orders");
  // ORD-07: a manual order through the one pay path (no amount sent).
  await page.getByRole("button", { name: "新建人工订单" }).click();
  const m = dialog(page, "新建人工订单");
  // Nothing chosen yet: the fields say what is missing (nothing is sent).
  await m.getByRole("button", { name: "创建并开通" }).click();
  await expect(m.getByText("请选择一个用户")).toBeVisible();
  await m.getByLabel("用户邮箱").fill("nobody-such-user");
  await expect(m.getByText(/没有匹配的用户/)).toBeVisible();
  await m.getByLabel("用户邮箱").fill(email);
  await m.getByRole("button", { name: email }).click();
  await m.getByLabel("套餐").selectOption({ label: `${tag}-plan` });
  await m.getByLabel("周期（有价格的）").selectOption("month");
  // The resulting price; a gift is 0 (the box and its text name the same thing).
  await expect(m.getByText("预计成交价")).toBeVisible();
  await expect(m.getByTestId("manual-price")).toHaveText("¥15.00");
  const gift = m.getByRole("checkbox", { name: "赠送（金额记 0，不算营收）" });
  await gift.click();
  await expect(m.getByTestId("manual-price")).toContainText("¥0.00");
  await gift.click();
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
  // ORD-02 filters: by user (in the URL), payment method, status.
  await page.getByLabel("搜索订单号或邮箱").fill(email);
  await expect(page.locator("[data-row]:visible")).toHaveCount(2);
  await expect(page).toHaveURL(/email=/);
  await page.getByLabel("付款方式").selectOption("manual");
  await expect(page.locator("[data-row]:visible")).toHaveCount(2);
  const statuses = page.getByRole("group", { name: "订单状态" });
  await statuses.getByRole("button", { name: "待付款" }).click();
  await expect(page.getByText("没有匹配的记录")).toBeVisible();
  await statuses.getByRole("button", { name: "已付款" }).click();
  await expect(row(page, "¥15.00")).toBeVisible();
  await expect(page.getByText("共 2 条")).toBeVisible();
  // ORD-03: the order dialog with the amount breakdown.
  await openRow(page, "¥15.00");
  let d = dialog(page);
  await expect(d.getByText("金额拆分")).toBeVisible();
  await expect(d.getByText("e2e offline payment")).toBeVisible();
  // ORD-05: refund to the balance; the subscription effect is shown first.
  await d.getByRole("button", { name: "退款" }).click();
  let r = dialog(page, /^退款 /);
  await expect(r.getByText(/将取消订阅|恢复到|回退/)).toBeVisible();
  // Manual orders have no provider refund: the route is not offered, and it says why.
  await expect(r.getByRole("button", { name: "原路退回" })).toHaveCount(0);
  await expect(r.getByText(/该支付方式未开启原路退款/)).toBeVisible();
  await r.getByRole("button", { name: "退到余额" }).click();
  await r.getByLabel("退款原因（必填，写入审计）").fill("e2e refund");
  await r.getByLabel(/二次确认/).fill((await r.getByRole("heading").first().innerText()).trim().slice(-6));
  await r.getByRole("button", { name: "确认退款" }).click();
  await toast(page, "已退款");
  // The dialog and the list show the refund without a reload.
  await expect(d.getByText("e2e refund")).toBeVisible();
  await expect(d.getByText("订阅效果")).toBeVisible();
  await expect(row(page, "¥15.00")).toContainText("已退款");
  await d.getByRole("button", { name: "关闭", exact: true }).last().click();
  // Record-only refund of the second order, keeping the plan.
  await openRow(page, "¥40.00");
  d = dialog(page);
  await d.getByRole("button", { name: "退款" }).click();
  r = dialog(page, /^退款 /);
  await r.getByRole("button", { name: "仅登记" }).click();
  // The amount is checked in place (more than was paid is refused before sending).
  await r.getByLabel("实际退回金额（元）").fill("41");
  await r.getByLabel("退款原因（必填，写入审计）").fill("refunded in the merchant console");
  await r.getByLabel(/二次确认/).fill((await r.getByRole("heading").first().innerText()).trim().slice(-6));
  await r.getByRole("button", { name: "确认退款" }).click();
  await expect(r.getByText(/金额无效/)).toBeVisible();
  await r.getByLabel("实际退回金额（元）").fill("40");
  await r.getByRole("checkbox", { name: "仅退款，保留套餐" }).click();
  await expect(r.getByText("保留套餐（仅退款）")).toBeVisible();
  await r.getByRole("button", { name: "确认退款" }).click();
  await toast(page, "已退款");
  await expect(d.getByText("保留套餐（仅退款）")).toBeVisible();
  await expect(row(page, "¥40.00")).toContainText("已退款");
});

test("ORD-04 ORD-08: mark an unpaid order paid (reason), payment events, CSV export (dates checked)", async ({
  page,
}, info) => {
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
  // Events are worded (the raw values are folded away).
  await expect(d.getByText("支付事件")).toBeVisible();
  await expect(d.getByText("创建支付")).toBeVisible();
  await expect(d.getByText("已生成付款码")).toBeVisible();
  await d.getByRole("button", { name: "人工确认付款" }).click();
  const f = dialog(page, "人工确认付款");
  await f.getByLabel("原因（必填，写入审计）").fill("paid by bank transfer");
  await f.getByRole("button", { name: "确认", exact: true }).click();
  await toast(page, "已确认付款");
  await expect(d.getByText("已付款").first()).toBeVisible();
  await expect(d.getByRole("button", { name: "人工确认付款" })).toHaveCount(0);
  await expect(row(page, "¥15.00")).toContainText("已付款");
  await d.getByRole("button", { name: "关闭", exact: true }).last().click();
  await page.getByRole("button", { name: "导出 CSV" }).click();
  const x = dialog(page, "导出订单 CSV");
  // A reversed range is refused in place (no download, no JSON page).
  await x.getByLabel("从").fill("2026-02-01");
  await x.getByLabel("到").fill("2026-01-01");
  await expect(x.getByText("开始日期不能晚于结束日期")).toBeVisible();
  await expect(x.getByRole("button", { name: "下载" })).toBeDisabled();
  await x.getByLabel("从").fill("2025-01-01");
  await x.getByLabel("到").fill("2026-06-01");
  await expect(x.getByText(/不能超过 366 天/)).toBeVisible();
  await x.getByLabel("从").fill(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
  await x.getByLabel("到").fill(new Date(Date.now() + 86_400_000).toISOString().slice(0, 10));
  await x.getByLabel("状态").selectOption("paid");
  const dl = page.waitForEvent("download");
  await x.getByRole("button", { name: "下载" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.csv$/);
  await toast(page, "已开始下载");
});
