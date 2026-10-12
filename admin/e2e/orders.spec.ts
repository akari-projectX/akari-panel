// INVENTORY §5 (orders).
import { expect, test, type Locator, type Page } from "@playwright/test";

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

/** The refund dialog (stacked on the order dialog). */
const refundDialog = (page: Page) => page.getByRole("dialog", { name: "退款", exact: true });

/** Fill the refund's confirmation with the order number's last 6 characters. */
async function confirmTail(r: Locator): Promise<void> {
  const tail = (await r.locator("code").first().innerText()).trim();
  await r.getByLabel(/输入订单号后 6 位/).fill(tail);
}

test("ORD-07 ORD-01 ORD-02 ORD-03 ORD-05 ORD-06: manual orders (3 steps), the day ledger and its filters, the order dialog, refunds (preview, routes, keep plan)", async ({
  page,
}, info) => {
  const tag = uniq(info, "ord");
  const { email } = await setup(tag);
  await openConsole(page, "/orders");
  // ORD-07: a manual order through the one pay path (no amount sent), three steps.
  const create = async (period: "月付" | "季付", reason: string, checks: boolean) => {
    await page.getByRole("button", { name: "新建人工订单", exact: true }).first().click();
    const m = dialog(page, "新建人工订单");
    const next = m.getByRole("button", { name: "下一步" });
    // ① the user: nothing chosen = no next step; an unknown prefix says so.
    await expect(next).toBeDisabled();
    if (checks) {
      await m.getByLabel("用户邮箱").fill("nobody-such-user");
      await expect(m.getByText(/没有邮箱以「nobody-such-user」开头的用户/)).toBeVisible();
    }
    await m.getByLabel("用户邮箱").fill(email);
    await m.getByRole("option", { name: new RegExp(email) }).click();
    await next.click();
    // ② plan and term: only priced terms, each with its price; the server's price shown.
    await m.getByRole("radio", { name: new RegExp(`^${tag}-plan`) }).click();
    await m.getByRole("radio", { name: new RegExp(`^${period}`) }).click();
    await expect(m.getByText("预计成交价")).toBeVisible();
    if (checks) await expect(m.getByTestId("manual-price")).toHaveText("¥15.00");
    await next.click();
    // ③ confirm: gift switch (its text and the summary agree), the reason is required.
    if (checks) {
      const gift = m.getByRole("switch", { name: "赠送" });
      await gift.click();
      await expect(m.getByText("（¥0）")).toBeVisible();
      await gift.click();
      await expect(m.getByTestId("manual-price")).toHaveText("¥15.00");
      await m.getByRole("button", { name: "创建订单并开通" }).click();
      await expect(m.getByText("请写明原因（会记入审计日志）")).toBeVisible();
      await expect(m.getByText("1 处需要修正")).toBeVisible();
    }
    await m.getByLabel("原因").fill(reason);
    await m.getByRole("button", { name: "创建订单并开通" }).click();
    await toast(page, "人工订单已创建并开通");
    await expect(m).toBeHidden();
  };
  await create("月付", "e2e offline payment", true);
  await create("季付", "e2e second", false);
  // ORD-02: one search box (@ = the buyer's email, in the URL), method, status segments.
  await page.getByLabel("搜索订单号或邮箱").fill(`@${email}`);
  await expect(page).toHaveURL(/q=%40/);
  await expect(page.locator("[data-row]:visible")).toHaveCount(2);
  await expect(page.getByText("用户邮箱包含")).toBeVisible();
  await page.getByLabel("付款方式").selectOption("manual");
  await expect(page.locator("[data-row]:visible")).toHaveCount(2);
  const statuses = page.getByRole("group", { name: "订单状态" });
  await statuses.getByRole("button", { name: /^待支付/ }).click();
  // Nothing matches: says so, with a way back.
  await expect(page.getByText("没有符合条件的订单")).toBeVisible();
  await expect(page.getByRole("button", { name: "清除筛选", exact: true })).toBeVisible();
  await statuses.getByRole("button", { name: /^已付款/ }).click();
  await expect(row(page, "¥15.00")).toBeVisible();
  await expect(page.getByText("共 2 条 · 已全部加载")).toBeVisible();
  // The day header: today, its count and net from the server (not from the loaded rows).
  const today = page.locator("section[data-day]").first();
  await expect(today.getByRole("heading", { name: /^今天/ })).toBeVisible();
  await expect(today).toContainText("2 笔");
  await expect(today).toContainText("净收 ¥55.00");
  // ORD-03: the order dialog — status hero, receipt, the manual reason.
  await openRow(page, "¥15.00");
  const d = dialog(page, /^订单 /);
  await expect(d.getByText("已付款并开通")).toBeVisible();
  await expect(d.getByText(/^原价/).first()).toBeVisible();
  await expect(d.getByText("e2e offline payment")).toBeVisible();
  // ORD-05: refund to the balance; what it undoes is shown first.
  await d.getByRole("button", { name: "退款", exact: true }).click();
  let r = refundDialog(page);
  await expect(r.getByText(/取消订阅|恢复到|到期日/)).toBeVisible();
  // A manual order has no provider refund: the card is disabled and says why.
  await expect(r.getByRole("radio", { name: /原路退回/ })).toBeDisabled();
  await expect(r.getByText(/人工订单没有支付渠道可以原路退/).first()).toBeVisible();
  await r.getByRole("radio", { name: /退到余额/ }).click();
  await r.getByRole("button", { name: /^退款/ }).click();
  await expect(r.getByText("2 处需要修正")).toBeVisible();
  await r.getByLabel("原因").fill("e2e refund");
  await confirmTail(r);
  await r.getByRole("button", { name: /^退款 ¥15\.00/ }).click();
  await toast(page, "已退款");
  await r.getByRole("button", { name: "完成" }).click();
  await expect(r).toBeHidden();
  // The dialog and the list show the refund without a reload.
  await expect(d.getByText("e2e refund")).toBeVisible();
  await expect(d.getByRole("button", { name: "退款", exact: true })).toBeDisabled();
  await expect(row(page, "¥15.00")).toContainText("已退款");
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  // Record-only refund of the second order, keeping the plan.
  await openRow(page, "¥40.00");
  await d.getByRole("button", { name: "退款", exact: true }).click();
  r = refundDialog(page);
  await r.getByRole("radio", { name: /仅登记/ }).click();
  // The amount is checked in place (more than was paid is refused before sending).
  await r.getByLabel("实际已退金额").fill("41");
  await expect(r.getByText(/超出实付 ¥40\.00/)).toBeVisible();
  await r.getByLabel("实际已退金额").fill("40");
  await expect(r.getByText(/超出实付/)).toHaveCount(0);
  await r.getByRole("checkbox", { name: "仅退款，保留套餐" }).click();
  await r.getByLabel("原因").fill("refunded in the merchant console");
  await confirmTail(r);
  await r.getByRole("button", { name: /^登记退款 ¥40\.00/ }).click();
  await toast(page, "已退款");
  await r.getByRole("button", { name: "完成" }).click();
  await expect(d.getByText("保留套餐（仅退款）")).toBeVisible();
  await expect(d.getByText("仅登记（商家平台已退）").first()).toBeVisible();
  await expect(row(page, "¥40.00")).toContainText("已退款");
  await page.keyboard.press("Escape");
});

test("ORD-04 ORD-08: mark an unpaid order paid (reason), payment events in words, CSV export (dates checked)", async ({
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
  // The user page's old link (?email=) lands on the ledger's search.
  await openConsole(page, `/orders?email=${encodeURIComponent(email)}`);
  await expect(page).toHaveURL(/q=%40/);
  await openRow(page, "¥15.00");
  const d = dialog(page, /^订单 /);
  await expect(d.getByText("等待用户付款")).toBeVisible();
  // Events are worded (the raw values are folded away).
  await expect(d.getByText("经过")).toBeVisible();
  await expect(d.getByText("创建支付")).toBeVisible();
  await expect(d.getByText("已生成付款码")).toBeVisible();
  await d.getByRole("button", { name: "人工确认付款" }).click();
  const f = dialog(page, "人工确认付款");
  await f.getByRole("button", { name: "确认付款并开通" }).click();
  await expect(f.getByText("请写明原因（会记入审计日志）")).toBeVisible();
  await f.getByLabel("原因").fill("paid by bank transfer");
  await f.getByRole("button", { name: "确认付款并开通" }).click();
  await toast(page, "已确认付款");
  await expect(f).toBeHidden();
  await expect(d.getByText("已付款并开通")).toBeVisible();
  await expect(d.getByRole("button", { name: "人工确认付款" })).toHaveCount(0);
  await expect(row(page, "¥15.00")).toContainText("已完成");
  await page.keyboard.press("Escape");
  await expect(d).toBeHidden();
  await page.getByRole("button", { name: "导出 CSV" }).click();
  const x = dialog(page, "导出订单 CSV");
  // A reversed or too long range is refused in place (no download, no JSON page).
  // (by position: a field's error text is part of its label)
  const [from, to] = [x.locator('input[type="date"]').first(), x.locator('input[type="date"]').last()];
  await from.fill("2026-02-01");
  await to.fill("2026-01-01");
  await expect(x.getByText("结束日期不能早于开始日期")).toBeVisible();
  await expect(x.getByRole("button", { name: "导出", exact: true })).toBeDisabled();
  await from.fill("2025-01-01");
  await to.fill("2026-06-01");
  await expect(x.getByText(/最多 366 天/)).toBeVisible();
  await x.getByRole("button", { name: "近 30 天" }).click();
  await expect(x.getByText("共 30 天")).toBeVisible();
  await x.getByRole("group", { name: "状态" }).last().getByRole("button", { name: "已付款" }).click();
  const dl = page.waitForEvent("download");
  await x.getByRole("button", { name: "导出", exact: true }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.csv$/);
  await toast(page, /已开始下载/);
});
