// INVENTORY §2 (dashboard) and §3 (system status, with the mail queue SET-17).
import { expect, test } from "@playwright/test";

import { CONSOLE, apiJson, dialog, openConsole, sql, toast, uniq, watch } from "./helpers";

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
  // KPI cards; the period control (default 7 天, in the URL) switches the revenue window.
  for (const t of ["7 天净营收", "有效订阅", "当前在线用户", "服务器在线"])
    await expect(page.getByText(t, { exact: true })).toBeVisible();
  await page.getByRole("group", { name: "时间范围" }).getByRole("button", { name: "今日" }).click();
  await expect(page).toHaveURL(/[?&]range=today/);
  await expect(page.getByText("今日净营收", { exact: true })).toBeVisible();
  await expect(page.getByText(/¥42\.00/).first()).toBeVisible();
  // Net revenue: collected, refunded (channel money, by refund day), net.
  await expect(page.locator('[data-revenue-window="today"]')).toContainText(/实收¥[\d.]+退款¥[\d.]+净额-?¥[\d.]+/);
  await expect(page.locator("[data-revenue-split]")).toContainText(/余额、抵扣、优惠券部分不算营收/);
  await expect(page.getByRole("heading", { name: "全网流量" })).toBeVisible();
  await expect(page.getByText("流量最多的节点")).toBeVisible();
  // Other specs leave history of deleted nodes behind: more than one row is fine.
  await expect(page.getByText("已删除的节点").first()).toBeVisible();
  // Latest orders → the order dialog.
  await page.getByRole("link", { name: new RegExp(order.out_trade_no) }).click();
  await expect(page).toHaveURL(new RegExp(`/orders\\?open=${id}`));
  await expect(dialog(page, order.out_trade_no)).toBeVisible();
  await page.keyboard.press("Escape");
  // Needs attention → the filtered view.
  await page.goto(CONSOLE);
  await page.getByRole("link", { name: /待审核提现/ }).click();
  await expect(page).toHaveURL(/\/finance\?status=pending/);
  await page.goBack();
  await page.getByRole("link", { name: /已付款未开通的订单/ }).click();
  await expect(page).toHaveURL(/\/orders\?unfulfilled=1/);
  await page.goBack();
  await page.getByRole("link", { name: /发送失败的邮件/ }).click();
  await expect(page).toHaveURL(/\/status\?mail=dead/);
  await page.goBack();
  // Refresh (and the 30 s poll) re-reads.
  const reread = page.waitForResponse((r) => r.url().endsWith("/api/v1/dashboard"));
  await page.getByRole("button", { name: "刷新" }).click();
  await reread;
  expect(problems).toEqual([]);
});

test("ST-01 ST-02 ST-03: panel instances, PostgreSQL, Valkey, proxy, background jobs, refresh", async ({ page }) => {
  await openConsole(page, "/status");
  await expect(page.getByRole("heading", { level: 1, name: "系统状态" })).toBeVisible();
  await expect(page.getByText("当前实例")).toBeVisible();
  await expect(page.getByRole("img", { name: /^CPU/ }).or(page.getByText("未知").first())).toBeVisible();
  await expect(page.getByText("面板进程内存")).toBeVisible();
  await expect(page.getByText("PostgreSQL")).toBeVisible();
  await expect(page.getByText("Valkey")).toBeVisible();
  await expect(page.getByText("反向代理（Caddy）")).toBeVisible();
  for (const j of ["流量结算", "支付对账", "邮件发件箱", "告警评估"]) await expect(page.getByText(j)).toBeVisible();
  // Refresh re-reads (its own spinner); the mail queue is on this page.
  const reread = page.waitForResponse((r) => r.url().endsWith("/api/v1/system/status"));
  await page.getByRole("button", { name: "刷新" }).click();
  await reread;
  await expect(page.getByRole("heading", { name: "邮件队列" })).toBeVisible();
});

test("ST-04 SET-17: dead letters — the notice runs the test mail; the mail queue (?mail=dead), retry", async ({
  page,
}, info) => {
  const subject = uniq(info, "dead letter");
  sql(
    `INSERT INTO mail_outbox (kind, to_addr, subject, body_text, body_html, status, attempts, last_error, settled_at) ` +
      `VALUES ('test', 'nobody@e2e.test', '${subject}', 'body', '<p>body</p>', 'dead', 8, '550 mailbox unavailable', now())`,
  );
  await openConsole(page, "/status?mail=dead");
  // ST-04: the notice, and its 测试发信 runs the step-by-step diagnosis here.
  await expect(page.getByText(/封邮件发送失败/)).toBeVisible();
  await page.getByRole("button", { name: "测试发信" }).first().click();
  const d = dialog(page, "测试发信");
  await expect(d.getByLabel("收件地址")).not.toHaveValue("");
  await d.getByRole("button", { name: "诊断并发送" }).click();
  await expect(d.getByRole("list", { name: "诊断结果" })).toBeVisible({ timeout: 30_000 });
  await expect(d.locator("[data-step=config]")).toBeVisible();
  await d.getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(d).toHaveCount(0);
  // SET-17: the failed mail (pre-filtered by ?mail=dead), the server's answer, the kind in words; retry.
  await expect(page.getByRole("group", { name: "邮件队列" }).getByRole("button", { name: /发送失败/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const dead = page.locator("[data-row]:visible", { hasText: subject });
  await expect(dead).toContainText("550 mailbox unavailable");
  await expect(dead).toContainText("测试邮件");
  await dead.getByRole("button", { name: "重试", exact: true }).click();
  await toast(page, "已重新排队");
  // Requeued: it leaves the failed list without a reload (it may fail again only after new attempts).
  await expect(dead).toHaveCount(0);
  // The other states are one click away (and in the URL).
  await page
    .getByRole("group", { name: "邮件队列" })
    .getByRole("button", { name: /待发送/ })
    .click();
  await expect(page).toHaveURL(/mail=pending/);
});

test("ST-05: exited instances are folded away; hidden /proc is explained", async ({ page }) => {
  // The live answer, plus an exited instance and this instance's /proc hidden
  // (the pre-v0.4.1 unit's ProcSubset=pid).
  await page.route(/\/api\/v1\/system\/status$/, async (route) => {
    const res = await route.fetch();
    const j = await res.json();
    const me = j.instances.find((i: { this: boolean }) => i.this);
    me.host = {
      ...me.host,
      cpu_percent: null,
      load: null,
      mem_total_bytes: null,
      mem_used_bytes: null,
      proc_hidden: true,
    };
    j.instances.push({
      ...me,
      id: "00000000-0000-4000-8000-000000000001",
      this: false,
      alive: false,
      version: "0.4.1-rc.1",
      host: { ...me.host, hostname: "old-panel" },
      beat_at: new Date(Date.now() - 300_000).toISOString(),
      agent_sessions: 42,
    });
    await route.fulfill({ response: res, json: j });
  });
  await openConsole(page, "/status");
  await expect(page.getByText("1 个已退出的实例")).toBeVisible();
  await expect(page.getByText(/old-panel · v0\.4\.1-rc\.1/)).toBeVisible();
  await expect(page.getByText("失联")).toHaveCount(0);
  await expect(page.getByText(/ProcSubset=pid/)).toBeVisible();
  // Only the live instance gets a card (its agent sessions, not the exited one's 42).
  await expect(page.getByText("agent 会话")).toHaveCount(1);
});
