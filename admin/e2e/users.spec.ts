// INVENTORY §4 (users), v2 console: view rail, chips, floating selection
// bar, batch wizard and jobs popover; the detail dialog with its fact strip,
// tabs 概览 / 流量 / 账单 / 账户与安全 and the ⋯ 更多 footer menu.
import { expect, test, type Page, type TestInfo } from "@playwright/test";

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

async function search(page: Page, text: string) {
  await page.getByLabel("搜索邮箱或 ID").fill(text);
  // The box reaches the URL (and the list) after a debounce; a selection made
  // before that would belong to the old view and be dropped.
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe(text);
}

async function openUser(page: Page, email: string) {
  await search(page, email);
  await openRow(page, email);
  await expect(dialog(page, email)).toBeVisible();
  return dialog(page, email);
}

/** Close the user's detail dialog (it is not a form: no discard question). */
async function closeUser(page: Page, email: string) {
  await dialog(page, email).getByRole("button", { name: "关闭" }).first().click();
  await expect(page.getByRole("dialog", { name: email })).toHaveCount(0);
}

/** A detail tab (概览 / 流量 / 账单 / 账户与安全). */
async function tab(page: Page, email: string, name: string) {
  await dialog(page, email).getByRole("tab", { name }).click();
}

/** The detail's ⋯ 更多 menu (footer). */
async function more(page: Page, email: string, item: string | RegExp) {
  await dialog(page, email).getByRole("button", { name: "更多操作" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

/** A view in the rail (desktop) or the pills (phone). */
async function view(page: Page, name: RegExp) {
  await page.getByRole("navigation", { name: "用户视图" }).getByRole("button", { name }).click();
}

/** Tick a row (a phone enters 选择 mode first). */
async function tick(page: Page, info: TestInfo, email: string) {
  const mode = page.getByRole("button", { name: "选择", exact: true });
  if (isMobile(info) && (await mode.isVisible())) await mode.click();
  await row(page, email).getByRole("checkbox").click();
}

const bar = (page: Page) => page.getByRole("region", { name: "批量操作" });

test("USR-01 USR-02 USR-03 USR-04 USR-28: list, search, views, more filters as chips, columns, CSV export", async ({
  page,
}, info) => {
  const problems = watch(page);
  const tag = uniq(info, "ulist");
  const planId = await plan(`${tag}-plan`);
  await user(`${tag}-a@e2e.test`, { plan: { plan_id: planId, period: "month" } });
  await user(`${tag}-b@e2e.test`);
  await openConsole(page, "/users");
  // The view rail carries live counts.
  await expect(
    page.getByRole("navigation", { name: "用户视图" }).getByRole("button", { name: /^全部\s*[\d,]+/ }),
  ).toBeVisible();
  await search(page, tag);
  await expect(row(page, `${tag}-a@e2e.test`)).toBeVisible();
  await expect(row(page, `${tag}-b@e2e.test`)).toBeVisible();
  await expect(row(page, `${tag}-a@e2e.test`)).toContainText("正常");
  await expect(row(page, `${tag}-b@e2e.test`)).toContainText("无套餐");
  await expect(page.getByText("匹配 2 个")).toBeVisible();
  // Plan filter (in 更多筛选) → only a, shown as a chip.
  await page.getByRole("button", { name: "更多筛选" }).click();
  // The label wraps the select: its name also carries the chosen option.
  await page.getByRole("combobox", { name: /^套餐/ }).selectOption(planId);
  await page.getByRole("button", { name: "应用" }).click();
  await expect(row(page, `${tag}-b@e2e.test`)).toHaveCount(0);
  await expect(row(page, `${tag}-a@e2e.test`)).toBeVisible();
  await page.getByRole("button", { name: "清除筛选：套餐" }).click();
  await expect(row(page, `${tag}-b@e2e.test`)).toBeVisible();
  // Views: none of them lapsed.
  await view(page, /^已到期 · 用尽/);
  await expect(page.getByText("没有匹配的用户")).toBeVisible();
  await expect(page).toHaveURL(/view=lapsed/);
  await view(page, /^全部/);
  // D10: never used (a view) + signed up / last sign-in before (更多筛选, chips).
  await view(page, /^从未使用/);
  await expect(page).toHaveURL(/view=never/);
  await page.getByRole("button", { name: "更多筛选" }).click();
  const tomorrow = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  await page.getByLabel("注册早于", { exact: true }).fill(tomorrow);
  await page.getByLabel("最后登录早于", { exact: true }).fill(tomorrow);
  await page.getByRole("button", { name: "应用" }).click();
  await expect(page.getByRole("button", { name: "清除筛选：注册早于" })).toBeVisible();
  await expect(page.getByRole("button", { name: "清除筛选：最后登录早于" })).toBeVisible();
  await expect(row(page, `${tag}-b@e2e.test`)).toBeVisible();
  await expect(row(page, `${tag}-a@e2e.test`)).toHaveCount(0);
  // The CSV export sends exactly the list's filters (never used, both days, search).
  const exportLink = page.getByRole("link", { name: "导出 CSV", includeHidden: true });
  await expect(exportLink).toHaveAttribute("href", /never_used=true/);
  await expect(exportLink).toHaveAttribute("href", new RegExp(`registered_before=${tomorrow}`));
  await expect(exportLink).toHaveAttribute("href", new RegExp(`last_login_before=${tomorrow}`));
  await expect(exportLink).toHaveAttribute("href", new RegExp(`q=${tag}`));
  await page.getByRole("button", { name: "清除全部" }).click();
  await search(page, tag);
  await expect(row(page, `${tag}-a@e2e.test`)).toBeVisible();
  await expect(page).not.toHaveURL(/view=/);
  if (!isMobile(info)) {
    // Column chooser (remembered).
    await page.getByRole("button", { name: "显示的列" }).click();
    await page.getByRole("checkbox", { name: "余额" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("columnheader", { name: "余额" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("columnheader", { name: "余额" })).toBeVisible();
    // CSV of the current filter.
    const dl = page.waitForEvent("download");
    await page.getByRole("link", { name: "导出 CSV" }).click();
    expect((await dl).suggestedFilename()).toMatch(/\.csv$/);
  }
  expect(problems).toEqual([]);
});

test("USR-05 USR-06 USR-07 USR-08 USR-09 USR-10 USR-11: new user with a plan, the subscription card and every plan action", async ({
  page,
}, info) => {
  const tag = uniq(info, "uplan");
  const p1 = await plan(`${tag}-p1`);
  await plan(`${tag}-p2`);
  const email = `${tag}@e2e.test`;
  await openConsole(page, "/users");
  await page.getByRole("button", { name: "新建用户" }).click();
  const d = dialog(page, "新建用户");
  await d.getByRole("textbox", { name: /^邮箱/ }).fill(email);
  // Field labels wrap the control with its hint (and a select's options): match the start.
  await d.getByLabel(/^密码/).fill("new-user-pass-1");
  await d.getByRole("combobox", { name: /^套餐/ }).selectOption(p1);
  await d.getByRole("combobox", { name: /^周期/ }).selectOption("month");
  await expect(d).toContainText("到期");
  await d.getByRole("button", { name: "创建用户" }).click();
  await expect(dialog(page, "用户已创建")).toBeVisible();
  await dialog(page, "用户已创建").getByRole("button", { name: "完成" }).click();
  const u = await openUser(page, email);
  // The fact strip (every tab) and the subscription card.
  await expect(u.getByRole("group", { name: "概要" })).toContainText(`${tag}-p1`);
  await expect(u.getByText("当前订阅").first()).toBeVisible();
  await expect(u.getByText("月付").first()).toBeVisible();
  await expect(u.getByText("每月重置").first()).toBeVisible();
  // Renew one term (footer), then extend 7 days (card popover).
  await u.getByRole("button", { name: "续期", exact: true }).click();
  await confirmDialog(page, undefined, "续期");
  await toast(page, "已续期一个周期");
  await u.getByRole("button", { name: "延长 N 天" }).click();
  await page.getByLabel("延长天数").fill("7");
  await page.getByRole("button", { name: "延长", exact: true }).click();
  await toast(page, "已延长 7 天");
  // Reset the plan traffic (impact list).
  await u.getByRole("button", { name: "重置流量" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("立即恢复");
  await confirmDialog(page, undefined, "重置流量");
  await toast(page, "流量已重置");
  // Change plan: plan cards, custom days, the before / after comparison.
  await u.getByRole("button", { name: "更换套餐" }).click();
  const c = dialog(page, "更换套餐");
  await c.getByRole("radio", { name: new RegExp(`${tag}-p2`) }).click();
  await c.getByRole("button", { name: "自定义天数" }).click();
  await c.getByLabel("天数", { exact: true }).fill("15");
  await expect(c).toContainText("确认后");
  await c.getByRole("button", { name: "确认更换" }).click();
  await toast(page, "套餐已更换");
  await expect(u.getByText(`${tag}-p2`).first()).toBeVisible();
  await expect(u.getByText("15 天").first()).toBeVisible();
  // The list shows the new plan without a reload.
  await closeUser(page, email);
  await expect(row(page, email)).toContainText(`${tag}-p2`);
  await openUser(page, email);
  // History lists the replaced subscription.
  await expect(u.getByText("套餐历史").first()).toBeVisible();
  await expect(u.getByText(new RegExp(`${tag}-p1 · 已更换`)).first()).toBeVisible();
  // Cancel: the impact is stated and the address must be typed.
  await u.getByRole("button", { name: "取消套餐" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("立即失去");
  await expect(page.getByRole("alertdialog").getByRole("button", { name: "取消套餐" })).toBeDisabled();
  await confirmDialog(page, email, "取消套餐");
  await toast(page, "套餐已取消");
  await expect(u.getByText("没有套餐").first()).toBeVisible();
  await u.getByRole("button", { name: "分配套餐" }).first().click();
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
  await b.getByRole("radio", { name: /^其他/ }).click();
  await expect(b.getByRole("button", { name: "封禁并踢下线" })).toBeDisabled();
  await expect(b).toContainText("请先写说明");
  await b.getByLabel("说明（必填）").fill("e2e abuse");
  await b.getByRole("button", { name: "封禁并踢下线" }).click();
  await toast(page, "已封禁");
  await expect(u.getByText("e2e abuse").first()).toBeVisible();
  await expect(u.getByText(ADMIN).first()).toBeVisible();
  // The list's badge follows without a reload.
  await closeUser(page, email);
  await expect(row(page, email)).toContainText("已封禁");
  await openUser(page, email);
  await u.getByRole("button", { name: "解除封禁" }).first().click();
  await expect(page.getByRole("alertdialog")).toContainText("e2e abuse");
  await confirmDialog(page, undefined, "解除封禁");
  await toast(page, "已解除封禁");
  await closeUser(page, email);
  await expect(row(page, email)).not.toContainText("已封禁");
  await openUser(page, email);
  // Subscription link: masked until 显示 (the read is audited), with a QR code.
  await u.getByRole("button", { name: "显示", exact: true }).click();
  await expect(u.getByRole("img", { name: "订阅链接二维码" })).toBeVisible();
  await expect(u).toContainText(/http\S+\/[0-9a-f]{16}\/[A-Za-z0-9_-]{43}/);
  // Reset it (⋯ 更多).
  await more(page, email, "重置订阅链接…");
  await expect(page.getByRole("alertdialog")).toContainText("需要重新导入");
  await confirmDialog(page, email, "重置订阅");
  await toast(page, "订阅已重置");
  // 账户与安全: password, sessions, verification, role, sign-in methods.
  await tab(page, email, "账户与安全");
  await u.getByRole("button", { name: "设置新密码" }).click();
  await dialog(page, "设置新密码")
    .getByLabel(/^新密码/)
    .fill("brand-new-pass-2");
  await dialog(page, "设置新密码").getByRole("button", { name: "设置并踢下线" }).click();
  await toast(page, "密码已修改");
  await u.getByRole("button", { name: "踢下线", exact: true }).click();
  await confirmDialog(page, undefined, "踢下线");
  await toast(page, "已踢下线");
  await u.getByRole("button", { name: "标记已验证" }).click();
  await confirmDialog(page, undefined, "标记已验证");
  await toast(page, "已标记为已验证");
  await expect(u.getByRole("button", { name: "标记已验证" })).toHaveCount(0);
  const role = u.getByRole("group", { name: "账户角色" });
  await role.getByRole("button", { name: "管理员" }).click();
  await confirmDialog(page, undefined, "设为管理员");
  await toast(page, "已设为管理员");
  await expect(role.getByRole("button", { name: "管理员" })).toHaveAttribute("aria-pressed", "true");
  await role.getByRole("button", { name: "普通用户" }).click();
  await confirmDialog(page, undefined, "降为普通用户");
  await toast(page, "已降为普通用户");
  // Sign-in methods: passkey only → reset (no passkey deleted, the password comes back).
  await expect(u.getByText(/账户已选择只用通行密钥登录/).first()).toBeVisible();
  await u.getByRole("button", { name: "重置", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("删除的通行密钥");
  await confirmDialog(page, undefined, "恢复密码登录");
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
  await more(page, admin3, /转让所有者/);
  await expect(page.getByRole("alertdialog")).toContainText("变为管理员");
  await confirmDialog(page, admin3, "转让所有者");
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
  await expect(u.getByRole("group", { name: "概要" })).toContainText("¥12.34");
  // 账单: orders + the ledger; adjust (the resulting balance is previewed).
  await tab(page, victim, "账单");
  await expect(u.getByText("该用户还没有订单。")).toBeVisible();
  await u.getByRole("button", { name: "人工调整余额" }).click();
  const bd = dialog(page, "人工调整余额");
  await bd.getByRole("button", { name: "扣减" }).click();
  await bd.getByLabel("金额（元）").fill("2.34");
  await expect(bd).toContainText("¥12.34 → ¥10.00");
  await bd.getByLabel("原因（必填，写入审计）").fill("e2e debit");
  await bd.getByRole("button", { name: "确认调整" }).click();
  await toast(page, "余额已调整");
  await expect(u.getByText("e2e debit").first()).toBeVisible();
  await expect(u.getByText("人工调整").first()).toBeVisible();
  await expect(u.getByRole("group", { name: "概要" })).toContainText("¥10.00");
  await more(page, victim, /删除账户/);
  await expect(page.getByRole("alertdialog")).toContainText("余额 ¥10.00");
  await expect(page.getByRole("alertdialog")).toContainText("匿名化保留");
  await confirmDialog(page, victim, "永久删除");
  await toast(page, "账户已删除");
  await expect(page.getByRole("dialog", { name: victim })).toHaveCount(0);
  await expect(row(page, victim)).toHaveCount(0);
  // Traffic history (seeded by e2e.sh for the e2e user: a deleted node).
  await search(page, "e2e-user@");
  await openRow(page, "e2e-user@e2e.test");
  const t = dialog(page, "e2e-user@e2e.test");
  await tab(page, "e2e-user@e2e.test", "流量");
  await expect(t.getByText("流量明细")).toBeVisible();
  await expect(t.getByRole("img", { name: /每日流量/ })).toBeVisible();
  await expect(t.getByText(/已删除的节点/).first()).toBeVisible();
  // Per entrance (never summed per node): node · entrance, raw and billed.
  await expect(t.getByRole("list", { name: "按入口" })).toContainText("已删除的入口");
  await expect(t.getByRole("list", { name: "按入口" })).toContainText("原始");
  await t.getByRole("button", { name: "7 天" }).click();
  await expect(t.getByText(/已删除的节点/).first()).toBeVisible();
  expect(page.url()).toContain(CONSOLE);
});

test("USR-24 USR-25 USR-26 USR-27: selection, bulk action jobs, bulk delete with typed confirmation", async ({
  page,
}, info) => {
  const tag = uniq(info, "ubulk");
  for (const n of ["a", "b", "c"]) await user(`${tag}-${n}@e2e.test`);
  await openConsole(page, "/users");
  await search(page, tag);
  await expect(row(page, `${tag}-c@e2e.test`)).toBeVisible();
  for (const n of ["a", "b"]) await tick(page, info, `${tag}-${n}@e2e.test`);
  await expect(bar(page)).toContainText("已选 2 个");
  await expect(bar(page).getByRole("button", { name: "选择全部匹配的 3 个" })).toBeVisible();
  // Bulk: credit 1 yuan each (wizard: parameters → server preview → start).
  await bar(page).getByRole("button", { name: "更多批量操作" }).click();
  await page.getByRole("menuitem", { name: "调整余额" }).click();
  const bd = dialog(page, /调整余额 · 2 个用户/);
  await bd.getByLabel("每人金额（元）").fill("1");
  await bd.getByLabel("原因（显示在用户的余额明细里）").fill("e2e bulk");
  await bd.getByRole("button", { name: "预览", exact: true }).click();
  await expect(bd).toContainText("将处理");
  await bd.getByRole("button", { name: "开始执行（2 人）" }).click();
  await toast(page, "批量任务已创建");
  // The new job's detail opens; it finishes and refreshes the list.
  const jd = dialog(page, /调整余额/);
  await expect(jd).toContainText("已完成", { timeout: 20_000 });
  await expect(jd).toContainText(/成功\s*2/);
  await jd.getByRole("button", { name: "完成" }).click();
  // The jobs popover lists it.
  await page.getByRole("button", { name: "批量任务" }).click();
  await expect(
    page.getByRole("dialog", { name: "批量任务" }).or(page.locator("[data-slot=popover-content]")),
  ).toContainText("调整余额");
  await page.keyboard.press("Escape");
  // The finished job refreshed the list (balance column) without a reload.
  if (!isMobile(info)) {
    await page.getByRole("button", { name: "显示的列" }).click();
    const bal = page.getByRole("checkbox", { name: "余额" });
    if (!(await bal.isChecked())) await bal.click();
    await page.keyboard.press("Escape");
    await expect(row(page, `${tag}-a@e2e.test`)).toContainText("¥1.00");
  } else {
    const r = await apiJson<{ users: { balance_cents: number }[] }>("GET", `/users?q=${tag}-a`);
    expect(r.users[0].balance_cents).toBe(100);
  }
  // On all filter matches: tick one, then widen to every match.
  await tick(page, info, `${tag}-c@e2e.test`);
  await bar(page).getByRole("button", { name: "选择全部匹配的 3 个" }).click();
  await expect(bar(page)).toContainText("全部匹配的 3 个");
  await bar(page).getByRole("button", { name: "更多批量操作" }).click();
  await page.getByRole("menuitem", { name: "发送邮件" }).click();
  const b2 = dialog(page, /发送邮件 · 3 个用户/);
  await expect(b2).toContainText("当前筛选的全部 3 个账户");
  await b2.getByLabel("邮件标题").fill("e2e notice");
  await b2.getByLabel("正文（纯文本，空行分段）").fill("hello");
  await b2.getByRole("button", { name: "预览", exact: true }).click();
  await expect(b2.getByRole("button", { name: "开始执行（3 人）" })).toBeVisible();
  await b2.getByRole("button", { name: "取消" }).click();
  // The selection belongs to the view: changing the sort drops it.
  await expect(bar(page)).toBeVisible();
  await page.getByRole("button", { name: "排序" }).click();
  await page.getByRole("menuitem", { name: "邮箱（A → Z）" }).click();
  await expect(bar(page)).toHaveCount(0);
  // Bulk delete of the selection (their balance makes them anonymized).
  for (const n of ["a", "b"]) await tick(page, info, `${tag}-${n}@e2e.test`);
  await bar(page).getByRole("button", { name: "删除" }).click();
  const del = page.getByRole("alertdialog");
  await expect(del).toContainText("永久删除 2 个账户？");
  await expect(del).toContainText("匿名化保留");
  await expect(del.getByRole("button", { name: "永久删除" })).toBeDisabled();
  await confirmDialog(page, "删除 2 个账户", "永久删除");
  await toast(page, /匿名化 2/);
  await expect(row(page, `${tag}-a@e2e.test`)).toHaveCount(0);
  await expect(row(page, `${tag}-c@e2e.test`)).toBeVisible();
});
