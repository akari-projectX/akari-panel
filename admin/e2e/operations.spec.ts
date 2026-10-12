// INVENTORY §6 (coupons), §7 (finance); tickets and content are in content.spec.ts.
import { expect, test } from "@playwright/test";

import { ORIGIN, apiAs, apiJson, confirmDialog, dialog, openConsole, openRow, row, sql, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

test("CPN-01 CPN-02 CPN-03 CPN-04: coupons — create (checked numbers), search, dialog, edit, disable, delete", async ({
  page,
}, info) => {
  const code = uniq(info, "SAVE10")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  await openConsole(page, "/coupons");
  await page.getByRole("button", { name: "新建优惠券" }).click();
  const c = dialog(page, "新建优惠券");
  await c.getByLabel(/优惠码/).fill(code);
  await c.getByLabel("备注名称").fill("e2e coupon");
  await c.getByLabel("减免比例（%）").fill("10");
  // A bad number is refused in place (never saved as "unlimited").
  await c.getByLabel("总次数（空 = 不限）").fill("5x");
  await c.getByRole("button", { name: "创建" }).click();
  await expect(c.getByText("请输入整数")).toBeVisible();
  await c.getByLabel("总次数（空 = 不限）").fill("5");
  await c.getByRole("checkbox", { name: "月付" }).click();
  await c.getByRole("button", { name: "创建" }).click();
  await toast(page, "优惠券已创建");
  // Search (in the URL) finds it; the list refreshed without a reload.
  await page.getByLabel("搜索优惠码或名称").fill(code);
  await expect(page).toHaveURL(/q=/);
  await expect(row(page, code)).toContainText("10% 折扣");
  await expect(row(page, code)).toContainText("0 / 5");
  await page.getByRole("group", { name: "优惠券状态" }).getByRole("button", { name: "停用" }).click();
  await expect(page.getByText("没有匹配的记录")).toBeVisible();
  await page.getByRole("group", { name: "优惠券状态" }).getByRole("button", { name: "全部" }).click();
  await openRow(page, code);
  const d = dialog(page);
  await expect(d.getByText("还没有人使用。")).toBeVisible();
  await expect(d.getByText("月付")).toBeVisible();
  await d.getByLabel("总次数（空 = 不限）").fill("9");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "已保存");
  await expect(row(page, code)).toContainText("0 / 9");
  await d.getByRole("button", { name: "停用", exact: true }).click();
  await confirmDialog(page);
  await toast(page, "已保存");
  await expect(row(page, code)).toContainText("停用");
  // Delete asks for the code.
  await d.getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("alertdialog").getByRole("button", { name: "删除" })).toBeDisabled();
  await confirmDialog(page, code);
  await toast(page, "已删除");
  await expect(row(page, code)).toHaveCount(0);
});

test("CPN-05: code batches — generate, CSV, revoke (type the batch name)", async ({ page }, info) => {
  const name = uniq(info, "batch");
  await openConsole(page, "/coupons");
  await page.getByRole("button", { name: "批量生成优惠码" }).click();
  const b = dialog(page, "批量生成优惠码");
  await b.getByLabel("批次名称").fill(name);
  await b.getByLabel("前缀（可选）").fill("E2E");
  await b.getByLabel("数量（1–5000）").fill("0");
  await b.getByRole("button", { name: "生成" }).click();
  await expect(b.getByText("范围 1–5000")).toBeVisible();
  await b.getByLabel("数量（1–5000）").fill("3");
  await b.getByRole("button", { name: "固定金额（元）" }).click();
  await b.getByLabel("减免金额（元）").fill("2");
  await b.getByRole("button", { name: "生成" }).click();
  await toast(page, "已生成");
  const item = row(page, name);
  await expect(item).toContainText("3 个码");
  const dl = page.waitForEvent("download");
  await item.getByRole("button", { name: "导出 CSV" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.csv$/);
  await item.getByRole("button", { name: "作废" }).click();
  await confirmDialog(page, name, "作废");
  await toast(page, "已作废");
  await expect(row(page, name)).toContainText("已作废");
});

test("FIN-01 FIN-02 FIN-03 FIN-04: commissions, withdrawals (USDT), balances", async ({ page }, info) => {
  const tag = uniq(info, "fin");
  // The programme settings live in 系统设置 → 邀请返利 (settings.spec.ts): set
  // them here through the API — on, 10 %, no hold, minimum 1 yuan, rate 7.20.
  const cur = await apiJson<Record<string, unknown>>("GET", "/commission-settings");
  await apiJson("PUT", "/commission-settings", {
    ...cur,
    enabled: true,
    rate_percent: 10,
    hold_days: 0,
    min_withdrawal_cents: 100,
    usdt_rate_cents: 720,
  });
  // The old settings tab sends the operator to the new place.
  await openConsole(page, "/finance/settings");
  await expect(page).toHaveURL(/\/admin\/settings\/commission/);
  // An inviter earns a commission from the invitee's paid (manual) order.
  const inviter = `${tag}-inviter@e2e.test`;
  const a = await apiJson<{ id: string }>("POST", "/users", { email: inviter, password: "inviter-pass-1" });
  const b = await apiJson<{ id: string }>("POST", "/users", {
    email: `${tag}-invitee@e2e.test`,
    password: "invitee-pass-1",
  });
  sql(`UPDATE users SET inviter_id = '${a.id}' WHERE id = '${b.id}'`);
  const plan = await apiJson<{ id: string }>("POST", "/plans", {
    name: `${tag}-plan`,
    period: "monthly",
    pricing: { on_sale: false, prices: [{ period: "month", price_cents: 10000 }] },
  });
  await apiJson("POST", "/orders/manual", { user_id: b.id, plan_id: plan.id, period: "month", reason: "commission" });
  // FIN-04: the commission (credited by the next settlement pass); filters are in the URL.
  await openConsole(page, "/finance/commissions");
  await expect(page.getByRole("link", { name: "系统设置 → 邀请返利" })).toBeVisible();
  await page.getByLabel("邀请人邮箱").fill(inviter);
  await expect(row(page, inviter)).toContainText("¥10.00");
  await expect(page).toHaveURL(/email=/);
  await expect(async () => {
    await page.reload();
    await page.getByLabel("邀请人邮箱").fill(inviter);
    await expect(row(page, inviter)).toContainText("已入账", { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  // The inviter asks for 5 yuan in USDT on TRC20.
  const me = await apiAs(inviter, "inviter-pass-1", true);
  const w = await me.post(`${ORIGIN}/api/v1/me/withdrawals`, {
    data: { amount_cents: 500, chain: "trc20", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  });
  expect(w.status(), await w.text()).toBeLessThan(300);
  // FIN-01/02: review — approve one with the USDT paid + hash, reject the other.
  await openConsole(page, "/finance");
  await page.getByLabel("用户邮箱（精确）").fill(inviter);
  await expect(row(page, "¥5.00")).toContainText("TRC20");
  await expect(row(page, "¥5.00")).toContainText("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  await expect(row(page, "¥5.00")).toContainText("≈ 0.69 USDT");
  await row(page, "¥5.00").getByRole("button", { name: "通过", exact: true }).click();
  const ap = dialog(page, "通过提现");
  await ap.getByLabel("实付 USDT").fill("0.69");
  // The hash is checked before anything is sent.
  await ap.getByLabel("交易哈希（txid）").fill("not a hash");
  await ap.getByRole("button", { name: "确认已打款" }).click();
  await expect(ap.getByText(/格式不对/)).toBeVisible();
  await ap.getByLabel("交易哈希（txid）").fill("0xe2e0000000000000000000000000000000000000000000000000000000000001");
  await ap.getByRole("button", { name: "确认已打款" }).click();
  await toast(page, "已标记为已打款");
  // The pending list drops it without a reload.
  await expect(row(page, "¥5.00")).toHaveCount(0);
  const w2 = await me.post(`${ORIGIN}/api/v1/me/withdrawals`, {
    data: { amount_cents: 200, chain: "trc20", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  });
  expect(w2.status(), await w2.text()).toBeLessThan(300);
  await page.reload();
  await page.getByLabel("用户邮箱（精确）").fill(inviter);
  await row(page, "¥2.00").getByRole("button", { name: "拒绝", exact: true }).click();
  const rj = dialog(page, "拒绝提现");
  await rj.getByLabel("拒绝原因（用户可见）").fill("e2e reject");
  await rj.getByRole("button", { name: "拒绝", exact: true }).click();
  await toast(page, "已拒绝");
  await page.getByLabel("状态", { exact: true }).selectOption("all");
  await expect(row(page, "¥5.00")).toContainText("已打款");
  await expect(row(page, "¥5.00")).toContainText("0xe2e0");
  await expect(row(page, "¥5.00").getByRole("button", { name: "复制哈希" })).toBeVisible();
  await expect(row(page, "¥2.00")).toContainText("已拒绝");
  // FIN-03: balances — find anyone, adjust.
  await openConsole(page, "/finance/balances");
  await page.getByLabel("按邮箱查找任意用户").fill(inviter);
  await expect(row(page, inviter)).toContainText("¥5.00");
  await row(page, inviter).getByRole("button", { name: "调整", exact: true }).click();
  const adj = dialog(page, "调整余额");
  await adj.getByLabel("金额（元）").fill("1");
  await adj.getByLabel("原因（必填，写入审计）").fill("e2e credit");
  await adj.getByRole("button", { name: "确认调整" }).click();
  await toast(page, "余额已调整");
  await expect(row(page, inviter)).toContainText("¥6.00");
});
