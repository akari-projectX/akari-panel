// INVENTORY §2 (dashboard) and §3 (system status, with the mail queue SET-17).
import { expect, test } from "@playwright/test";

import { CONSOLE, apiJson, dialog, openConsole, sql, toast, uniq, watch } from "./helpers";

test.describe.configure({ mode: "serial" });

test("DSH-01 DSH-02 DSH-03 DSH-04 DSH-05 DSH-07: needs-you queue, KPI tabs + chart, latest orders, servers", async ({
  page,
}, info) => {
  const problems = watch(page);
  const email = `${uniq(info, "dash")}@e2e.test`;
  const u = await apiJson<{ id: string }>("POST", "/users", { email, password: "dash-pass-1" });
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
  // A dead letter, so the queue has its mail row.
  sql(
    `INSERT INTO mail_outbox (kind, to_addr, subject, body_text, body_html, status, attempts, last_error, settled_at) ` +
      `VALUES ('test', 'nobody@e2e.test', '${uniq(info, "dash dead")}', 'b', '<p>b</p>', 'dead', 8, '550 no such user', now())`,
  );
  await openConsole(page, "");
  await expect(page.getByRole("heading", { level: 1, name: "仪表盘" })).toBeVisible();
  // ① The queue: the row opens the filtered list; its detail is in words.
  const mailRow = page.getByRole("link", { name: /封邮件发送失败/ });
  await expect(mailRow).toContainText(/最近一封：/);
  await mailRow.click();
  await expect(page).toHaveURL(/\/status\?tab=mail&mail=dead/);
  await page.goBack();
  // ② KPI tabs are one chart's tabs; the period (default 7 天) and the metric are in the URL.
  for (const t of ["近 7 天净营收", "近 7 天订单", "近 7 天注册", "近 7 天全网流量"])
    await expect(page.getByRole("tab", { name: new RegExp(t) })).toBeVisible();
  await expect(page.locator("[data-revenue-split]")).toContainText(/余额、抵扣、优惠券部分不算营收/);
  await page.getByRole("group", { name: "时间范围" }).getByRole("button", { name: "今日" }).click();
  await expect(page).toHaveURL(/[?&]range=today/);
  await expect(page.getByRole("tab", { name: /今日净营收/ })).toContainText(/实收 ¥[\d,.]+ · 退款 ¥[\d,.]+/);
  await page.getByRole("tab", { name: /今日订单/ }).click();
  await expect(page).toHaveURL(/[?&]metric=orders/);
  await expect(page.getByRole("tab", { name: /今日订单/ })).toHaveAttribute("aria-selected", "true");
  // ③ Servers.
  await expect(page.getByRole("heading", { name: "服务器" })).toBeVisible();
  await expect(page.getByText("本周期流量最多")).toBeVisible();
  // Latest orders → the order dialog.
  await expect(page.getByText(/¥42\.00/).first()).toBeVisible();
  await page
    .getByRole("link", { name: new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
    .first()
    .click();
  await expect(page).toHaveURL(new RegExp(`/orders\\?open=${id}`));
  await expect(dialog(page, order.out_trade_no)).toBeVisible();
  await page.keyboard.press("Escape");
  // Refresh (and the 30 s poll) re-reads.
  await page.goto(CONSOLE);
  const reread = page.waitForResponse((r) => r.url().endsWith("/api/v1/dashboard"));
  await page.getByRole("button", { name: "立即刷新" }).click();
  await reread;
  expect(problems).toEqual([]);
});

test("ST-01 ST-02 ST-03: verdict, panel instances, PostgreSQL, Valkey, proxy, background jobs, refresh", async ({
  page,
}) => {
  await openConsole(page, "/status");
  await expect(page.getByRole("heading", { level: 1, name: "系统状态" })).toBeVisible();
  // The verdict comes first: all fine, or the issues listed.
  await expect(page.locator("[data-verdict]")).toContainText(/全部正常|个问题需要关注/);
  await expect(page.getByText("当前实例")).toBeVisible();
  await expect(page.getByRole("img", { name: /^CPU/ }).or(page.getByText(/ProcSubset=pid/))).toBeVisible();
  await expect(page.getByText("面板进程内存")).toBeVisible();
  await expect(page.getByText("PostgreSQL", { exact: true })).toBeVisible();
  await expect(page.getByText("Valkey", { exact: true })).toBeVisible();
  await expect(page.getByText("反向代理（Caddy）")).toBeVisible();
  // Jobs: problems first; the fine ones may be folded.
  const more = page.getByRole("button", { name: /个任务运行正常/ });
  if (await more.isVisible()) await more.click();
  for (const j of ["流量结算", "支付对账", "邮件发件箱", "告警评估"])
    await expect(page.locator(`[data-job]`, { hasText: j })).toBeVisible();
  // Refresh re-reads (its own spinner); the mail queue is the second segment.
  const reread = page.waitForResponse((r) => r.url().endsWith("/api/v1/system/status"));
  await page.getByRole("button", { name: "立即刷新" }).click();
  await reread;
  await page
    .getByRole("group", { name: "系统状态视图" })
    .getByRole("button", { name: /邮件队列/ })
    .click();
  await expect(page).toHaveURL(/[?&]tab=mail/);
  await expect(page.getByRole("group", { name: "邮件队列" })).toBeVisible();
});

test("ST-04 SET-17: dead letters — the notice runs the test mail; the mail queue (?mail=dead), retry", async ({
  page,
}, info) => {
  const subject = uniq(info, "dead letter");
  sql(
    `INSERT INTO mail_outbox (kind, to_addr, subject, body_text, body_html, status, attempts, last_error, settled_at) ` +
      `VALUES ('test', 'nobody@e2e.test', '${subject}', 'body', '<p>body</p>', 'dead', 8, '550 mailbox unavailable', now())`,
  );
  await openConsole(page, "/status?tab=mail&mail=dead");
  // ST-04: the notice, and its 测试发信 runs the step-by-step diagnosis here.
  // The status answer is cached for 5 s per instance (sysstatus CACHE_FOR): the
  // previous test's visit may still be served, so refresh until the new dead letter counts.
  await expect(async () => {
    await page.getByRole("button", { name: "立即刷新" }).click();
    await expect(page.getByText(/封邮件已放弃发送/)).toBeVisible({ timeout: 1_500 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("button", { name: "测试发信" }).first().click();
  await expect(page).toHaveURL(/[?&]diagnose=1/);
  const d = dialog(page, "测试发信");
  await expect(d.getByLabel("收件地址")).not.toHaveValue("");
  await d.getByRole("button", { name: "诊断并发送" }).click();
  await expect(d.getByRole("group", { name: "诊断结果" })).toBeVisible({ timeout: 30_000 });
  await expect(d.locator("[data-step=config]")).toBeVisible();
  await expect(d.getByRole("button", { name: "重新测试" })).toBeVisible({ timeout: 30_000 });
  await d.getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(d).toHaveCount(0);
  // SET-17: the failed mail (pre-filtered by ?mail=dead), the failure in words + the server's text, the kind in words; retry.
  await expect(page.getByRole("group", { name: "邮件队列" }).getByRole("button", { name: /失败/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const dead = page.locator("[data-row]:visible", { hasText: subject });
  await expect(dead).toContainText("收件服务器拒收（550）");
  await dead.getByRole("button", { name: "原始错误" }).click();
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
  await page.getByRole("group", { name: "邮件队列" }).getByRole("button", { name: "全部" }).click();
  await expect(page).not.toHaveURL(/mail=/);
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
