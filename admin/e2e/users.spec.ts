// INVENTORY §4 (users).
import { expect, test, type Page } from "@playwright/test";

import {
  ADMIN,
  CONSOLE,
  apiAs,
  apiJson,
  confirmDialog,
  dialog,
  isMobile,
  openConsole,
  openRow,
  resetAdmin,
  row,
  sql,
  toast,
  uniq,
  watch,
} from "./helpers";

test.describe.configure({ mode: "serial" });

async function plan(name: string): Promise<string> {
  const p = await apiJson<{ id: string }>("POST", "/plans", {
    name,
    period: "monthly",
    traffic_quota_bytes: 100 * 1024 ** 3,
    pricing: { on_sale: true, prices: [{ period: "month", price_cents: 1000 }] },
  });
  return p.id;
}

async function user(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await apiJson<{ id: string }>("POST", "/users", { email, password: "user-password-1", ...extra })).id;
}

async function openUser(page: Page, email: string) {
  await page.getByLabel("搜索邮箱或 ID").fill(email);
  await openRow(page, email);
  await expect(dialog(page, email)).toBeVisible();
  return dialog(page, email);
}

/** Close the user's detail dialog (it is not a form: no discard question). */
async function closeUser(page: Page, email: string) {
  await dialog(page, email).getByRole("button", { name: "关闭" }).first().click();
  await expect(page.getByRole("dialog", { name: email })).toHaveCount(0);
}

/** A detail tab (概览 / 流量 / 订单 / 账户与安全). */
async function tab(page: Page, email: string, name: string) {
  await dialog(page, email).getByRole("tab", { name }).click();
}

test("USR-01 USR-02 USR-03 USR-04 USR-28: list, search, filters, more filters as chips, columns, CSV export", async ({
  page,
}, info) => {
  const problems = watch(page);
  const tag = uniq(info, "ulist");
  const planId = await plan(`${tag}-plan`);
  await user(`${tag}-a@e2e.test`, { plan: { plan_id: planId, period: "month" } });
  await user(`${tag}-b@e2e.test`);
  await openConsole(page, "/users");
  await page.getByLabel("搜索邮箱或 ID").fill(tag);
  await expect(row(page, `${tag}-a@e2e.test`)).toBeVisible();
  await expect(row(page, `${tag}-b@e2e.test`)).toBeVisible();
  await expect(row(page, `${tag}-a@e2e.test`)).toContainText("正常");
  await expect(row(page, `${tag}-b@e2e.test`)).toContainText("无套餐");
  // Plan filter (in 更多筛选) → only a, shown as a chip.
  await page.getByRole("button", { name: "更多筛选" }).click();
  await page.getByLabel("套餐", { exact: true }).selectOption({ label: `${tag}-plan` });
  await page.keyboard.press("Escape");
  await expect(row(page, `${tag}-b@e2e.test`)).toHaveCount(0);
  await expect(row(page, `${tag}-a@e2e.test`)).toBeVisible();
  await expect(page.getByRole("button", { name: /清除筛选：套餐/ })).toBeVisible();
  await page.getByRole("button", { name: /清除筛选：套餐/ }).click();
  // Status segments (none expired).
  const status = page.getByRole("group", { name: "状态", exact: true });
  await status.getByRole("button", { name: "已到期" }).click();
  await expect(page.getByText("没有匹配的记录")).toBeVisible();
  await expect(page).toHaveURL(/status=expired/);
  await status.getByRole("button", { name: "全部" }).click();
  // D10: never used (a segment) + signed up / last sign-in before tomorrow (更多筛选, chips).
  await status.getByRole("button", { name: "从未使用" }).click();
  await expect(status.getByRole("button", { name: "从未使用" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "更多筛选" }).click();
  const tomorrow = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  await page.getByLabel("注册早于（站点时区的日）").fill(tomorrow);
  await page.getByLabel("最后登录早于").fill(tomorrow);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /清除筛选：注册早于/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /清除筛选：最后登录早于/ })).toBeVisible();
  await expect(row(page, `${tag}-b@e2e.test`)).toBeVisible();
  await expect(row(page, `${tag}-a@e2e.test`)).toHaveCount(0);
  await expect(page).toHaveURL(/never_used=1/);
  // The CSV export sends exactly the list's filters (never used, both days).
  const exportLink = page.getByRole("link", { name: "导出 CSV" });
  await expect(exportLink).toHaveAttribute("href", /never_used=true/);
  await expect(exportLink).toHaveAttribute("href", new RegExp(`registered_before=${tomorrow}`));
  await expect(exportLink).toHaveAttribute("href", new RegExp(`last_login_before=${tomorrow}`));
  await expect(exportLink).toHaveAttribute("href", new RegExp(`q=${tag}`));
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(row(page, `${tag}-a@e2e.test`)).toBeVisible();
  await expect(status.getByRole("button", { name: "全部" })).toHaveAttribute("aria-pressed", "true");
  // Column chooser (remembered).
  await page.getByRole("button", { name: "显示的列" }).click();
  await page.getByRole("checkbox", { name: "余额" }).click();
  await page.keyboard.press("Escape");
  if (!isMobile(info)) await expect(page.getByRole("columnheader", { name: "余额" })).toBeVisible();
  await page.reload();
  if (!isMobile(info)) await expect(page.getByRole("columnheader", { name: "余额" })).toBeVisible();
  // CSV of the current filter.
  const dl = page.waitForEvent("download");
  await page.getByRole("link", { name: "导出 CSV" }).click();
  expect((await dl).suggestedFilename()).toMatch(/\.csv$/);
  expect(problems).toEqual([]);
});

test("USR-05 USR-06 USR-07 USR-08 USR-09 USR-10 USR-11: new user with a plan, the subscription card and every plan action", async ({
  page,
}, info) => {
  const tag = uniq(info, "uplan");
  await plan(`${tag}-p1`);
  await plan(`${tag}-p2`);
  const email = `${tag}@e2e.test`;
  await openConsole(page, "/users");
  await page.getByRole("button", { name: "新建用户" }).click();
  const d = dialog(page, "新建用户");
  await d.getByLabel("邮箱").fill(email);
  await d.getByLabel("初始密码（至少 8 位）").fill("new-user-pass-1");
  await d.getByLabel("套餐").selectOption({ label: `${tag}-p1` });
  await d.getByLabel("时长").selectOption("month");
  await d.getByRole("button", { name: "创建" }).click();
  await expect(dialog(page, "用户已创建")).toBeVisible();
  await dialog(page, "用户已创建").getByRole("button", { name: "完成" }).click();
  const u = await openUser(page, email);
  await expect(u.getByText("当前订阅").first()).toBeVisible();
  await expect(u.getByText(`${tag}-p1`).first()).toBeVisible();
  await expect(u.getByText("月付").first()).toBeVisible();
  await expect(u.getByText("每月重置").first()).toBeVisible();
  // Renew one term, then extend 7 days.
  await u.getByRole("button", { name: "续期", exact: true }).click();
  let r = dialog(page, "续期 / 延长");
  await r.getByRole("button", { name: "确认" }).click();
  await toast(page, "已续期");
  await u.getByRole("button", { name: "续期", exact: true }).click();
  r = dialog(page, "续期 / 延长");
  await r.getByRole("button", { name: "延长 N 天" }).click();
  await r.getByLabel("延长天数").fill("7");
  await r.getByRole("button", { name: "确认" }).click();
  await toast(page, "已续期");
  // Reset the plan traffic (confirmation).
  await u.getByRole("button", { name: "重置流量" }).click();
  await expect(dialog(page, "重置套餐流量？")).toContainText("自动恢复");
  await confirmDialog(page);
  await toast(page, "流量已重置");
  // Change plan.
  await u.getByRole("button", { name: "更换套餐" }).click();
  const c = dialog(page, "更换套餐");
  await c.getByLabel("套餐").selectOption({ label: `${tag}-p2` });
  await c.getByLabel("时长").selectOption("days");
  await c.getByLabel("天数", { exact: true }).fill("15");
  await c.getByRole("button", { name: "确认分配" }).click();
  await toast(page, "套餐已分配");
  await expect(u.getByText(`${tag}-p2`).first()).toBeVisible();
  await expect(u.getByText("15 天").first()).toBeVisible();
  // The list shows the new plan without a reload.
  await closeUser(page, email);
  await expect(row(page, email)).toContainText(`${tag}-p2`);
  await openUser(page, email);
  // History lists the replaced subscription.
  await expect(u.getByText("套餐历史").first()).toBeVisible();
  await expect(u.getByText(`${tag}-p1`).first()).toBeVisible();
  // Cancel.
  // Cancel: the impact is stated and the address must be typed.
  await u.getByRole("button", { name: "取消套餐" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("失去全部入口");
  await expect(page.getByRole("alertdialog").getByRole("button", { name: "取消套餐" })).toBeDisabled();
  await confirmDialog(page, email, "取消套餐");
  await toast(page, "套餐已取消");
  await expect(u.getByText("没有生效的套餐。").first()).toBeVisible();
  await u.getByRole("button", { name: "分配套餐" }).click();
  await expect(dialog(page, "分配套餐")).toBeVisible();
  await dialog(page, "分配套餐").getByRole("button", { name: "取消" }).click();
  await closeUser(page, email);
  await expect(row(page, email)).toContainText("无套餐");
});

test("USR-12 USR-13 USR-14 USR-15 USR-16 USR-17 USR-18 USR-19: ban, role, password, sessions, subscription link, verification, sign-in methods", async ({
  page,
}, info) => {
  const tag = uniq(info, "uacct");
  const email = `${tag}@e2e.test`;
  const id = await user(email);
  sql(`UPDATE users SET email_verified_at = NULL, password_login_disabled_at = now() WHERE id = '${id}'`);
  await openConsole(page, "/users");
  const u = await openUser(page, email);
  // Ban with a reason (shown to the user), then lift it.
  await u.getByRole("button", { name: "封禁", exact: true }).click();
  const b = dialog(page, `封禁 ${email}`);
  // "Other" without a note cannot be submitted, and says why.
  await b.getByLabel("原因").selectOption("other");
  await expect(b.getByRole("button", { name: "封禁", exact: true })).toBeDisabled();
  await expect(b).toContainText("必须填写说明");
  await b.getByLabel("补充说明（会显示给用户）").fill("e2e abuse");
  await b.getByRole("button", { name: "封禁", exact: true }).click();
  await toast(page, "已封禁");
  await expect(u.getByText("e2e abuse").first()).toBeVisible();
  await expect(u.getByText(ADMIN).first()).toBeVisible();
  // The list's badge follows without a reload.
  await closeUser(page, email);
  await expect(row(page, email)).toContainText("已封禁");
  await openUser(page, email);
  await u.getByRole("button", { name: "解除封禁" }).click();
  await confirmDialog(page);
  await toast(page, "已解除封禁");
  await closeUser(page, email);
  await expect(row(page, email)).not.toContainText("已封禁");
  await openUser(page, email);
  await tab(page, email, "账户与安全");
  // Subscription link (read is audited) with a QR code; reset it.
  await u.getByRole("button", { name: "订阅链接" }).click();
  const s = dialog(page, "订阅链接");
  await expect(s.getByRole("img", { name: "订阅链接二维码" })).toBeVisible();
  const link = await s.locator("code").innerText();
  expect(link).toMatch(/^http.+\/[0-9a-f]{16}\/[A-Za-z0-9_-]{43}$/);
  await s.getByRole("button", { name: "关闭" }).last().click();
  await u.getByRole("button", { name: "重置订阅" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("已导入的客户端立即失效");
  await confirmDialog(page, email, "重置订阅");
  await toast(page, "订阅已重置");
  // The more-actions menu: password, sessions, verify, role.
  const menu = async (item: string) => {
    await u.getByRole("button", { name: "更多操作" }).click();
    await page.getByRole("menuitem", { name: item }).click();
  };
  await menu("设置新密码");
  await dialog(page, "设置新密码").getByLabel("新密码（至少 8 位）").fill("brand-new-pass-2");
  await dialog(page, "设置新密码").getByRole("button", { name: "保存" }).click();
  await toast(page, "密码已修改");
  await menu("踢下线（结束全部会话）");
  await confirmDialog(page);
  await toast(page, "已踢下线");
  await menu("标记邮箱已验证");
  await confirmDialog(page);
  await toast(page, "已标记为已验证");
  await expect(u.getByText("（未验证）")).toHaveCount(0);
  await menu("设为管理员");
  await confirmDialog(page);
  await toast(page, "角色已修改");
  await expect(u.getByText("管理员").first()).toBeVisible();
  await menu("降级为普通用户");
  await confirmDialog(page);
  await toast(page, "角色已修改");
  // Sign-in methods: passkey only → reset.
  await expect(u.getByText(/账户已选择只用通行密钥登录/).first()).toBeVisible();
  await u.getByRole("button", { name: "重置登录方式" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("没有通行密钥会被删除");
  await confirmDialog(page);
  await toast(page, "登录方式已重置");
  await expect(u.getByText(/账户已选择只用通行密钥登录/)).toHaveCount(0);
  // The new password works (the verified address signs in on the portal).
  await apiAs(email, "brand-new-pass-2", true);
});

test("USR-20 USR-21 USR-22 USR-23: owner transfer and back, delete with impact, balance, traffic history", async ({
  page,
}, info) => {
  const tag = uniq(info, "uown");
  const admin3 = `${tag}-admin@e2e.test`;
  await user(admin3, { role: "admin" });
  const me = await apiJson<{ id: string }>("GET", "/me");
  await openConsole(page, "/users");
  let u = await openUser(page, admin3);
  await u.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "转让所有者" }).click();
  await confirmDialog(page, admin3);
  await toast(page, "所有者已转让");
  // Back from the new owner (API).
  const a3 = await apiAs(admin3, "user-password-1");
  const back = await a3.post(
    `${new URL(page.url()).origin}/${new URL(page.url()).pathname.split("/")[1]}/api/v1/users/${me.id}/owner`,
    { data: { confirm: true } },
  );
  expect(back.status()).toBe(204);
  resetAdmin();
  await page.keyboard.press("Escape");
  // Delete with the impact shown and the address typed.
  const victim = `${tag}-del@e2e.test`;
  const vid = await user(victim);
  await apiJson("POST", `/users/${vid}/balance`, { amount_cents: 1234, reason: "e2e" });
  await openConsole(page, "/users");
  u = await openUser(page, victim);
  await expect(u.getByText("¥12.34").first()).toBeVisible();
  // Balance: adjust (the resulting balance is previewed) and see the ledger.
  await tab(page, victim, "订单");
  await expect(u.getByText("该用户还没有订单。")).toBeVisible();
  await u.getByRole("button", { name: "调整余额" }).click();
  const bd = dialog(page, "调整余额");
  await bd.getByRole("button", { name: "扣减" }).click();
  await bd.getByLabel("金额（元）").fill("2.34");
  await expect(bd).toContainText("¥12.34 → ¥10.00");
  await bd.getByLabel("原因（必填，写入审计）").fill("e2e debit");
  await bd.getByRole("button", { name: "确认调整" }).click();
  await toast(page, "余额已调整");
  await expect(u.getByText("e2e debit").first()).toBeVisible();
  await expect(u.getByText("人工调整").first()).toBeVisible();
  await u.getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: "删除账户" }).click();
  await expect(dialog(page)).toContainText("余额 ¥10.00");
  await expect(dialog(page)).toContainText("匿名化保留");
  await confirmDialog(page, victim, "永久删除");
  await toast(page, "账户已删除");
  await expect(page.getByRole("dialog", { name: victim })).toHaveCount(0);
  await expect(row(page, victim)).toHaveCount(0);
  // Traffic history (seeded by e2e.sh for the e2e user: a deleted node).
  await page.getByLabel("搜索邮箱或 ID").fill("e2e-user@");
  await openRow(page, "e2e-user@e2e.test");
  const t = dialog(page, "e2e-user@e2e.test");
  await tab(page, "e2e-user@e2e.test", "流量");
  await expect(t.getByText("流量明细")).toBeVisible();
  await expect(t.getByRole("img", { name: /每日流量/ })).toBeVisible();
  await expect(t.getByText("已删除的节点").first()).toBeVisible();
  // Per entrance (never summed per node): node · entrance, raw and billed.
  await expect(t.getByRole("list", { name: "按入口" })).toContainText("已删除的入口");
  await expect(t.getByRole("list", { name: "按入口" })).toContainText("原始");
  await t.getByRole("button", { name: "7 天" }).click();
  await expect(t.getByText("已删除的节点").first()).toBeVisible();
  expect(page.url()).toContain(CONSOLE);
});

test("USR-24 USR-25 USR-26 USR-27: selection, bulk action jobs, bulk delete with typed confirmation", async ({
  page,
}, info) => {
  const tag = uniq(info, "ubulk");
  for (const n of ["a", "b", "c"]) await user(`${tag}-${n}@e2e.test`);
  await openConsole(page, "/users");
  await page.getByLabel("搜索邮箱或 ID").fill(tag);
  await expect(row(page, `${tag}-c@e2e.test`)).toBeVisible();
  for (const n of ["a", "b"]) await row(page, `${tag}-${n}@e2e.test`).getByRole("checkbox", { name: "选择" }).click();
  await expect(page.getByTestId("bulk-bar")).toContainText("已选 2 项");
  await expect(page.getByTestId("bulk-bar").getByRole("button", { name: "选择全部匹配的 3 个" })).toBeVisible();
  // Bulk: credit 1 yuan each.
  await page.getByTestId("bulk-bar").getByRole("button", { name: "批量操作" }).click();
  const bd = dialog(page, "批量操作");
  await bd.getByLabel("操作").selectOption("add_balance");
  await bd.getByLabel("每人金额（元）").fill("1");
  await bd.getByLabel("原因（写入每条明细）").fill("e2e bulk");
  await bd.getByRole("button", { name: "预览并确认" }).click();
  await expect(dialog(page)).toContainText("影响 2 个账户");
  await confirmDialog(page, undefined, "开始执行");
  await toast(page, "批量任务已创建");
  await expect(page.getByRole("heading", { name: "批量任务" })).toBeVisible();
  await page
    .getByRole("button", { name: /调整余额/ })
    .first()
    .click();
  await expect(dialog(page, "调整余额")).toContainText(/共 2，完成 2/);
  await expect(dialog(page, "调整余额")).toContainText("已完成");
  await page.keyboard.press("Escape");
  // The finished job refreshed the list (balance column) without a reload.
  await page.getByRole("button", { name: "显示的列" }).click();
  await page.getByRole("checkbox", { name: "余额" }).click();
  await page.keyboard.press("Escape");
  await expect(row(page, `${tag}-a@e2e.test`)).toContainText("¥1.00");
  await expect(row(page, `${tag}-c@e2e.test`)).toContainText("¥0.00");
  // On all filter matches: tick one, then widen to every match.
  await row(page, `${tag}-c@e2e.test`).getByRole("checkbox", { name: "选择" }).click();
  await page.getByTestId("bulk-bar").getByRole("button", { name: "选择全部匹配的 3 个" }).click();
  await expect(page.getByTestId("bulk-bar")).toContainText("将作用于全部匹配的 3 个");
  await page.getByTestId("bulk-bar").getByRole("button", { name: "批量操作" }).click();
  const b2 = dialog(page, "批量操作");
  await expect(b2).toContainText("当前筛选的全部 3 个账户");
  await b2.getByLabel("操作").selectOption("send_email");
  await b2.getByLabel("邮件标题").fill("e2e notice");
  await b2.getByLabel("正文（纯文本，空行分段）").fill("hello");
  await b2.getByRole("button", { name: "预览并确认" }).click();
  await expect(dialog(page)).toContainText("影响 3 个账户");
  await page.getByRole("button", { name: "取消" }).last().click();
  await dialog(page, "批量操作").getByRole("button", { name: "取消" }).click();
  // The selection belongs to the view: changing the sort drops it.
  await expect(page.getByTestId("bulk-bar")).toBeVisible();
  await page.getByRole("button", { name: "更多筛选" }).click();
  await page.getByLabel("排序", { exact: true }).selectOption("email");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("bulk-bar")).toHaveCount(0);
  // Bulk delete of the selection (their balance makes them anonymized).
  for (const n of ["a", "b"]) await row(page, `${tag}-${n}@e2e.test`).getByRole("checkbox", { name: "选择" }).click();
  await page.getByTestId("bulk-bar").getByRole("button", { name: "删除" }).click();
  const del = page.getByRole("alertdialog");
  await expect(del).toContainText("永久删除 2 个账户？");
  await expect(del).toContainText("匿名化保留");
  await expect(del.getByRole("button", { name: "永久删除" })).toBeDisabled();
  await confirmDialog(page, "删除 2 个账户", "永久删除");
  await toast(page, /匿名化 2/);
  await expect(row(page, `${tag}-a@e2e.test`)).toHaveCount(0);
  await expect(row(page, `${tag}-c@e2e.test`)).toBeVisible();
});
