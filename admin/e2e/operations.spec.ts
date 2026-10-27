// INVENTORY §6 (coupons), §7 (finance); tickets and content are in content.spec.ts.
import { expect, test } from "@playwright/test";

import { ORIGIN, apiAs, apiJson, confirmDialog, dialog, openConsole, openRow, row, sql, toast, uniq } from "./helpers";

test.describe.configure({ mode: "serial" });

test("CPN-01 CPN-02 CPN-03 CPN-04: coupons — create (checked numbers, ticket preview), search and status in the URL, detail (usage / settings), disable, delete", async ({
  page,
}, info) => {
  const code = uniq(info, "SAVE10")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  await openConsole(page, "/coupons");
  await page.getByRole("button", { name: "新建优惠券" }).first().click();
  const c = dialog(page, "新建优惠券");
  // The code is upper-cased as it is typed.
  await c.getByLabel("代码").fill(code.toLowerCase());
  await expect(c.getByLabel("代码")).toHaveValue(code);
  await c.getByLabel("名称").fill("e2e coupon");
  await c.getByLabel("减免比例").fill("10");
  await expect(c.getByText("= 9 折")).toBeVisible();
  // A bad number is refused in place (never saved as "unlimited").
  await c.getByLabel("总次数").fill("5x");
  await c.getByRole("button", { name: "创建优惠券" }).click();
  await expect(c.getByText("请输入整数")).toBeVisible();
  await expect(c.getByText("1 处需要修正")).toBeVisible();
  await c.getByLabel("总次数").fill("5");
  await c.getByRole("group", { name: "适用周期" }).last().getByRole("button", { name: "月付", exact: true }).click();
  // The ticket preview follows the form.
  await expect(c.getByRole("img", { name: "优惠券预览" })).toContainText(code);
  await c.getByRole("button", { name: "创建优惠券" }).click();
  await toast(page, `已创建 ${code}`);
  await expect(c).toBeHidden();
  // Search (in the URL) finds it; the list refreshed without a reload; the rule reads as a sentence.
  await page.getByLabel("搜索代码或名称").fill(code);
  await expect(page).toHaveURL(/q=/);
  await expect(row(page, code)).toContainText("9 折");
  await expect(row(page, code)).toContainText("仅月付");
  await expect(row(page, code)).toContainText("0 / 5");
  await expect(row(page, code)).toContainText("近 7 天无核销");
  const states = page.getByRole("group", { name: "优惠券状态" });
  await states.getByRole("button", { name: /^已停用/ }).click();
  await expect(page).toHaveURL(/status=disabled/);
  await expect(page.getByText("没有符合条件的优惠券")).toBeVisible();
  await states.getByRole("button", { name: /^全部/ }).click();
  await openRow(page, code);
  const d = page.getByRole("dialog").filter({ hasText: "使用情况" });
  await expect(d.getByText("还没有人用过这张优惠券。")).toBeVisible();
  await expect(d.getByText("共优惠")).toBeVisible();
  // Settings: the limit is checked in place, saved, and the list follows.
  await d.getByRole("tab", { name: "设置" }).click();
  await d.getByLabel("总次数").fill("abc");
  await expect(d.getByText("请输入整数")).toBeVisible();
  await expect(d.getByRole("button", { name: "保存" })).toBeDisabled();
  await d.getByLabel("总次数").fill("9");
  await d.getByRole("button", { name: "保存" }).click();
  await toast(page, "已保存");
  await expect(row(page, code)).toContainText("0 / 9");
  await d.getByRole("button", { name: "停用", exact: true }).click();
  await confirmDialog(page, undefined, "停用");
  await toast(page, "已停用");
  await expect(row(page, code)).toContainText("已停用");
  // Delete asks for the code (never used, so it is allowed).
  await d.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("alertdialog").getByRole("button", { name: "删除优惠券" })).toBeDisabled();
  await confirmDialog(page, code);
  await toast(page, `已删除 ${code}`);
  await expect(d).toBeHidden();
  await expect(row(page, code)).toHaveCount(0);
});

test("CPN-05: code batches — generate (checked numbers, examples), CSV, void (type the batch name)", async ({
  page,
}, info) => {
  const name = uniq(info, "batch");
  await openConsole(page, "/coupons/batches");
  await page.getByRole("button", { name: "批量生成" }).first().click();
  const b = dialog(page, "批量生成优惠码");
  await b.getByLabel("批次名").fill(name);
  await b.getByLabel("前缀").fill("e2e");
  await expect(b.getByLabel("前缀")).toHaveValue("E2E");
  await b.getByLabel("数量").fill("0");
  await b.getByRole("button", { name: /^生成/ }).click();
  await expect(b.getByText("不能小于 1")).toBeVisible();
  await b.getByLabel("数量").fill("3");
  await b.getByRole("button", { name: "固定金额" }).click();
  await b.getByLabel("减免金额").fill("2");
  await b.getByRole("button", { name: "生成 3 个码" }).click();
  await toast(page, "已生成 3 个码");
  const item = row(page, name);
  await expect(item).toContainText("/ 3 个已用");
  await expect(item).toContainText("立减 ¥2.00");
  const dl = page.waitForEvent("download");
  await item.getByRole("button", { name: "导出 CSV" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.csv$/);
  await item.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "作废整批" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("立即失效");
  await confirmDialog(page, name, "作废整批");
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
  // FIN-04: the commission ledger (day groups; credited by the next settlement pass);
  // the rules banner links to the settings; filters are in the URL.
  await openConsole(page, "/finance/commissions");
  await expect(page.getByRole("link", { name: "去设置" })).toHaveAttribute("href", /settings\/commission/);
  await page.getByLabel("邀请人邮箱").fill(inviter);
  await expect(row(page, inviter)).toContainText("¥10.00");
  await expect(page).toHaveURL(/email=/);
  await expect(async () => {
    await page.reload();
    await expect(row(page, inviter)).toContainText("已入账", { timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  // The inviter asks for 5 yuan in USDT on TRC20.
  const me = await apiAs(inviter, "inviter-pass-1", true);
  const w = await me.post(`${ORIGIN}/api/v1/me/withdrawals`, {
    data: { amount_cents: 500, chain: "trc20", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  });
  expect(w.status(), await w.text()).toBeLessThan(300);
  // FIN-01/02: the review queue (stat strip, oldest first) — approve one with the
  // USDT paid + a hash checked per chain, reject the other.
  await openConsole(page, "/finance");
  await expect(page).toHaveURL(/\/finance\/withdrawals/);
  await page.getByLabel("按用户邮箱筛选").fill(inviter);
  await expect(row(page, "¥5.00")).toContainText("TRC20");
  await expect(row(page, "¥5.00")).toContainText("≈ 0.69 USDT");
  await expect(row(page, "¥5.00")).toContainText("等待");
  await openRow(page, "¥5.00");
  const ap = page.getByRole("form", { name: "确认已打款" });
  await expect(page.getByText("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t").first()).toBeVisible();
  await ap.getByLabel("实付 USDT").fill("0.69");
  // The hash is checked (per chain) before anything is sent.
  await ap.getByLabel("交易哈希").fill("not a hash");
  await ap.getByRole("button", { name: "确认已打款" }).click();
  await expect(ap.getByText(/格式不对/)).toBeVisible();
  await ap.getByLabel("交易哈希").fill("0xe2e0000000000000000000000000000000000000000000000000000000000001");
  await expect(ap.getByText(/TRC20 交易哈希应为/)).toBeVisible();
  const txid = "e2e0000000000000000000000000000000000000000000000000000000000001";
  await ap.getByLabel("交易哈希").fill(txid);
  await ap.getByRole("button", { name: "确认已打款" }).click();
  await toast(page, "已标记为已打款");
  // The pending queue drops it without a reload.
  await expect(row(page, "¥5.00")).toHaveCount(0);
  const w2 = await me.post(`${ORIGIN}/api/v1/me/withdrawals`, {
    data: { amount_cents: 200, chain: "trc20", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  });
  expect(w2.status(), await w2.text()).toBeLessThan(300);
  await page.reload();
  await openRow(page, "¥2.00");
  await page.getByRole("button", { name: "拒绝…" }).click();
  const rj = page.getByRole("group", { name: "拒绝这笔提现" });
  await rj.getByLabel("原因（用户可见）").selectOption({ label: "其他" });
  await rj.getByRole("button", { name: "拒绝并退回" }).click();
  await expect(rj.getByText("选了「其他」，请写说明")).toBeVisible();
  await rj.getByLabel("说明（必填）").fill("e2e reject");
  await expect(rj).toContainText("将退回该用户的余额");
  await rj.getByRole("button", { name: "拒绝并退回" }).click();
  await toast(page, "已拒绝");
  await page.getByRole("group", { name: "提现状态" }).getByRole("button", { name: /^全部/ }).click();
  await expect(row(page, "¥5.00")).toContainText("e2e0000");
  await expect(row(page, "¥2.00")).toContainText("e2e reject");
  await openRow(page, "¥5.00");
  await expect(page.getByText(txid).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "复制哈希" }).first()).toBeVisible();
  // FIN-03: balances — find anyone (with the latest entry), open the ledger, adjust.
  await openConsole(page, "/finance/balances");
  await page.getByLabel("按邮箱查找任意用户").fill(inviter);
  await expect(row(page, inviter)).toContainText("¥5.00");
  await openRow(page, inviter);
  const lg = dialog(page, "余额明细");
  await expect(lg).toContainText("邀请返利");
  await lg.getByRole("button", { name: "人工调整" }).click();
  const adj = dialog(page, "人工调整余额");
  await adj.getByLabel("金额（元）").fill("1");
  await adj.getByLabel("原因（必填，写入审计）").fill("e2e credit");
  await adj.getByRole("button", { name: "确认调整" }).click();
  await toast(page, "余额已调整");
  await expect(lg).toContainText("e2e credit");
  await lg.getByRole("button", { name: "关闭" }).first().click();
  await expect(row(page, inviter)).toContainText("¥6.00");
});
