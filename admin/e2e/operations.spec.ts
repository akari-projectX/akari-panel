// INVENTORY §6 (coupons), §7 (finance); tickets and content are in content.spec.ts.
import { expect, test } from "@playwright/test";

import { ORIGIN, apiAs, apiJson, confirmDialog, dialog, openConsole, openRow, row, sql, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

test("CPN-01 CPN-02 CPN-03 CPN-04: coupons — create, detail, edit, disable, delete", async ({ page }, info) => {
  const code = uniq(info, "SAVE10")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  await openConsole(page, "/coupons");
  await page.getByRole("button", { name: "新建优惠券" }).click();
  const c = dialog(page, "新建优惠券");
  await c.getByLabel(/优惠码/).fill(code);
  await c.getByLabel("备注名称").fill("e2e coupon");
  await c.getByLabel("减免比例（%）").fill("10");
  await c.getByLabel("总次数（空 = 不限）").fill("5");
  await c.getByRole("checkbox", { name: "月付" }).click();
  await c.getByRole("button", { name: "创建" }).click();
  await toast(page, "优惠券已创建");
  await expect(row(page, code)).toContainText("10% 折扣");
  await expect(row(page, code)).toContainText("0 / 5");
  await openRow(page, code);
  const d = dialog(page);
  await expect(d.getByText("还没有人使用。")).toBeVisible();
  await expect(d.getByText("月付")).toBeVisible();
  await d.getByLabel("总次数（空 = 不限）").fill("9");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "已保存");
  await expect(row(page, code)).toContainText("0 / 9");
  await d.getByRole("button", { name: "停用" }).click();
  await confirmDialog(page);
  await toast(page, "已保存");
  await expect(row(page, code)).toContainText("停用");
  await d.getByRole("button", { name: "删除" }).click();
  await confirmDialog(page);
  await toast(page, "已删除");
  await expect(row(page, code)).toHaveCount(0);
});

test("CPN-05: code batches — generate, CSV, revoke", async ({ page }, info) => {
  const name = uniq(info, "batch");
  await openConsole(page, "/coupons");
  await page.getByRole("button", { name: "批量生成优惠码" }).click();
  const b = dialog(page, "批量生成优惠码");
  await b.getByLabel("批次名称").fill(name);
  await b.getByLabel("前缀（可选）").fill("E2E");
  await b.getByLabel("数量（1–5000）").fill("3");
  await b.getByRole("button", { name: "固定金额（元）" }).click();
  await b.getByLabel("减免金额（元）").fill("2");
  await b.getByRole("button", { name: "生成" }).click();
  await toast(page, "已生成");
  const item = page.getByRole("listitem").filter({ hasText: name });
  await expect(item).toContainText("3 个码");
  const dl = page.waitForEvent("download");
  await item.getByRole("link", { name: "导出 CSV" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.csv$/);
  await item.getByRole("button", { name: "作废" }).click();
  await confirmDialog(page, "3");
  await toast(page, "已作废");
  await expect(item).toContainText("已作废");
});

test("FIN-01 FIN-02 FIN-03 FIN-04 FIN-05: invite settings, commissions, withdrawals (USDT), balances", async ({
  page,
}, info) => {
  const tag = uniq(info, "fin");
  await openConsole(page, "/finance/settings");
  // FIN-05: on, 10 %, no hold; chains (Plasma among them) and a reference rate.
  const on = page.getByRole("switch", { name: "开启邀请返利" });
  if ((await on.getAttribute("aria-checked")) !== "true") await on.click();
  await page.getByLabel("返利比例（%）").fill("10");
  await page.getByLabel("冻结天数").fill("0");
  await page.getByLabel("最低提现（元）").fill("1");
  await page.getByLabel(/参考汇率/).fill("7.20");
  await expect(page.getByRole("checkbox", { name: "Plasma" })).toBeChecked();
  await page.getByRole("button", { name: "保存" }).click();
  await toast(page, "设置已保存");
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
  // FIN-04: the commission (credited by the next settlement pass).
  await page.goto(page.url().replace(/\/finance\/settings.*/, "/finance/commissions"));
  await page.getByLabel("邀请人邮箱").fill(inviter);
  await expect(row(page, inviter)).toContainText("¥10.00");
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
  await page.goto(page.url().replace(/\/finance\/commissions.*/, "/finance"));
  await page.getByLabel("用户邮箱（精确）").fill(inviter);
  await expect(row(page, "¥5.00")).toContainText("TRC20");
  await expect(row(page, "¥5.00")).toContainText("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
  await expect(row(page, "¥5.00")).toContainText("≈ 0.69 USDT");
  await row(page, "¥5.00").getByRole("button", { name: "通过", exact: true }).click();
  const ap = dialog(page, "通过提现");
  await ap.getByLabel("实付 USDT").fill("0.69");
  await ap.getByLabel("交易哈希（txid）").fill("0xe2e0000000000000000000000000000000000000000000000000000000000001");
  await ap.getByRole("button", { name: "确认已打款" }).click();
  await toast(page, "已标记为已打款");
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
  await expect(row(page, "¥2.00")).toContainText("已拒绝");
  // FIN-03: balances — find anyone, adjust.
  await page.goto(page.url().replace(/\/finance.*/, "/finance/balances"));
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
