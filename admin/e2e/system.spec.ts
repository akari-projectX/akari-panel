// INVENTORY §12 (alerts), §13 (agent updates), §14 (audit). The alert
// thresholds/channels and the release source are settings now (settings.spec.ts).
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  ADMIN,
  CONSOLE,
  PAY_DIR,
  RELEASE_SOURCE,
  apiJson,
  confirmDialog,
  dialog,
  openConsole,
  sql,
  toast,
  uniq,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("ALR-01 ALR-02 ALR-05: firing board, acknowledge (card and bulk), detail timeline, history filters, notification log with filters and retry", async ({
  page,
}, info) => {
  const name = uniq(info, "alert-host");
  const { id } = await apiJson<{ id: string }>("POST", "/servers", { name });
  // The evaluator (every 30 s) monitors enrolled servers only: an alert on a
  // never-enrolled one is resolved by the next round. Enrolled but never
  // online, the server's live kinds (cpu, memory) are undecided and stay as they are.
  sql(`UPDATE servers SET cert_serial = md5('${name}'), enrolled_at = now() WHERE id = '${id}'`);
  // Two firing alerts and a dead notification.
  const alert = sql(
    `INSERT INTO server_alerts (server_id, kind, status, value, detail) VALUES ('${id}', 'cpu', 'firing', 'CPU 97%', '最近 5 分钟每分钟平均 CPU 都高于 90%') RETURNING id`,
  ).split("\n")[0];
  const memAlert = sql(
    `INSERT INTO server_alerts (server_id, kind, status, value, detail) VALUES ('${id}', 'memory', 'firing', '内存 95%', '最近 5 分钟每分钟平均内存占用都高于 90%') RETURNING id`,
  ).split("\n")[0];
  sql(
    `INSERT INTO alert_notifications (alert_id, channel, event, payload, status, attempts, last_error) ` +
      `VALUES (${alert}, 'webhook', 'firing', '{"title":"${name} CPU"}', 'dead', 8, 'connection refused')`,
  );
  await openConsole(page, "/alerts");
  // The thresholds and channels are a settings section now.
  await expect(page.getByRole("link", { name: /告警通道与阈值/ })).toHaveAttribute("href", /\/settings\/alerts$/);
  // ALR-01: the firing board; the server filter is in the URL.
  await page.getByLabel("服务器", { exact: true }).selectOption({ label: name });
  await expect(page).toHaveURL(/server=/);
  const cpu = page.locator(`[data-alert="${alert}"]`);
  const mem = page.locator(`[data-alert="${memAlert}"]`);
  await expect(cpu).toContainText("最近 5 分钟每分钟平均 CPU 都高于 90%");
  await expect(cpu).toContainText("已持续");
  await expect(mem).toContainText("最近 5 分钟每分钟平均内存占用都高于 90%");
  // ALR-02: acknowledge one card (the board updates without a reload).
  await cpu.getByRole("button", { name: "确认", exact: true }).click();
  await toast(page, "已确认");
  await expect(cpu).toContainText(/已确认 · 恢复前不再提醒/);
  await expect(cpu.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  // … and in bulk (tick → the floating bar).
  await mem.getByRole("checkbox", { name: "选择" }).click();
  await page
    .getByRole("region", { name: "批量操作" })
    .getByRole("button", { name: /确认 1 条/ })
    .click();
  await toast(page, "已确认 1 条告警");
  await expect(mem.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  // The alert's own detail: facts, the timeline (the failed webhook notice), a link to its server.
  await cpu.getByRole("button", { name }).click();
  await expect(page).toHaveURL(new RegExp(`open=${alert}`));
  const a = dialog(page, new RegExp(`CPU 过高 · ${name}`));
  await expect(a.getByText("CPU 97%", { exact: true })).toBeVisible();
  await expect(a).toContainText("Webhook 通知失败");
  await expect(a).toContainText("仍在触发");
  await expect(a.getByRole("link", { name: "查看服务器" }).first()).toHaveAttribute("href", new RegExp(`server:${id}`));
  await a.getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(a).toHaveCount(0);
  // A filter without matches: the calm card for the board, "no match" for the history.
  await page.goto(`${CONSOLE}/alerts?kind=cert&server=${id}`);
  await expect(page.getByText("这个筛选下没有正在触发的告警")).toBeVisible();
  await expect(page.getByText("没有匹配的记录")).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await expect(page).not.toHaveURL(/kind=/);
  // ALR-05: the notification log (merged per event, filters in the URL); retry a dead one.
  await page
    .getByRole("group", { name: "告警视图" })
    .getByRole("button", { name: /通知记录/ })
    .click();
  await expect(page).toHaveURL(/\/alerts\/outbox/);
  await page.getByRole("group", { name: "通道" }).getByRole("button", { name: "Webhook" }).click();
  await page.getByRole("group", { name: "投递状态" }).getByRole("button", { name: /失败/ }).click();
  await expect(page).toHaveURL(/channel=webhook/);
  await expect(page).toHaveURL(/status=failed/);
  const n = page.locator("[data-row]:visible", { hasText: `${name} CPU` });
  await expect(n).toContainText("连接被拒绝");
  await expect(n).toContainText("发送失败");
  await expect(n).toContainText("Webhook");
  await n.getByRole("button", { name: "原始错误" }).click();
  await expect(n).toContainText("connection refused");
  await n.getByRole("button", { name: "重试", exact: true }).click();
  await toast(page, "已重新排队");
});

test("UPD-01 UPD-02 UPD-03 DSH-06: check for updates from the source, releases (delete, upload), a rollout paused, resumed, aborted", async ({
  page,
}, info) => {
  const name = uniq(info, "upd-host");
  await apiJson("POST", "/servers", { name });
  // A server that ran an older agent (protocol ≥ 3, linux/amd64).
  sql(
    `UPDATE servers SET agent_version = 'v0.8.0', agent_protocol = 7, agent_os = 'linux', agent_arch = 'amd64', enrolled_at = now(), cert_serial = md5('${name}') WHERE name = '${name}'`,
  );
  // The source is a setting (系统设置 → 节点 → 更新源与验签, settings.spec.ts): set it through the API.
  const st = await apiJson<{ version: number }>("GET", "/agent-updates");
  await apiJson("PUT", "/agent-updates/settings", {
    version: st.version,
    source_url: RELEASE_SOURCE,
    auto_check: false,
  });
  await openConsole(page, "/updates");
  // The order of the work: check, releases, rollouts (a numbered pipeline).
  const titles = await page.locator("main h2").allTextContents();
  const at = (t: string) => titles.findIndex((x) => x.trim() === t);
  expect(at("检查更新")).toBeGreaterThan(-1);
  expect(at("检查更新")).toBeLessThan(at("发布"));
  expect(at("发布")).toBeLessThan(at("灰度"));
  await expect(page.getByRole("link", { name: /更新源与验签/ }).first()).toHaveAttribute(
    "href",
    /\/settings\/updates$/,
  );
  // UPD-01: check (its own progress), the result in words.
  await page.getByRole("button", { name: "立即检查" }).click();
  await expect(page.locator("[data-last-check]")).toContainText(/已保存 v0\.9\.0|已是最新/, { timeout: 30_000 });
  await expect(page.locator("[data-last-check]")).toContainText(/最新发布 v0\.9\.0/);
  // The fleet's versions on top.
  await expect(page.locator("[data-distribution]")).toContainText("v0.8.0");
  // DSH-06: the dashboard and the nodes page say a newer agent exists.
  await page.goto(CONSOLE);
  await expect(page.getByText("agent v0.9.0 可用")).toBeVisible();
  await page.goto(`${CONSOLE}/nodes`);
  await expect(page.getByText("有新版本 v0.9.0")).toBeVisible();
  await page.goto(`${CONSOLE}/updates`);
  // UPD-02: one row per version (both platforms); delete it (impact, typing the version), upload amd64 again.
  const rel = page.locator('[data-release="v0.9.0"]');
  await expect(rel).toContainText("linux/amd64");
  await expect(rel).toContainText("linux/arm64");
  await rel.getByRole("button", { name: "v0.9.0 的操作" }).click();
  await page.getByRole("menuitem", { name: /删除发布/ }).click();
  await expect(page).toHaveURL(/delete=v0\.9\.0/);
  await expect(page.getByRole("alertdialog")).toContainText("没有未结束的灰度使用这个版本");
  await confirmDialog(page, "v0.9.0", "删除发布");
  await toast(page, "已删除 v0.9.0");
  await expect(rel).toHaveCount(0);
  await page.getByRole("button", { name: "上传发布" }).first().click();
  const up = dialog(page, "上传 agent 发布");
  await expect(up.getByText("还差 3 个文件")).toBeVisible();
  const dl = join(PAY_DIR, "release/www/dl");
  await up.getByLabel("清单（manifest）").setInputFiles(join(dl, "akari-agent-linux-amd64.manifest.json"));
  await up.getByLabel("签名", { exact: true }).setInputFiles(join(dl, "akari-agent-linux-amd64.manifest.sig"));
  await up.getByLabel("二进制", { exact: true }).setInputFiles(join(dl, "akari-agent-linux-amd64"));
  await up.getByRole("button", { name: "上传并验签" }).click();
  await toast(page, "已上传 v0.9.0");
  await expect(up).toHaveCount(0);
  await expect(rel).toContainText("linux/amd64");
  // UPD-03: a rollout to this server; the form checks its numbers; "开始升级 N 台" on a second step.
  await page.getByRole("button", { name: "新建灰度" }).first().click();
  const d = dialog(page, "新建灰度");
  await d.getByLabel("版本").selectOption("v0.9.0");
  await d.getByLabel("批次").fill("0");
  await d.getByLabel("健康超时（分钟）").click();
  await expect(d.getByText("1–10 的整数")).toBeVisible();
  await d.getByLabel("批次").fill("1");
  await d.getByLabel("健康超时（分钟）").fill("10");
  await d.getByRole("radio", { name: /指定服务器/ }).click();
  await d.getByRole("checkbox", { name }).click();
  await d.getByRole("button", { name: "下一步" }).click();
  const c = dialog(page, /开始灰度 v0\.9\.0/);
  await expect(c).toContainText("将影响 1 台服务器");
  const made = page.waitForResponse((r) => r.url().endsWith("/rollouts") && r.request().method() === "POST");
  await c.getByRole("button", { name: "开始升级 1 台" }).click();
  const res = await made;
  expect(res.status(), await res.text()).toBeLessThan(300);
  await toast(page, "灰度已开始");
  // The open rollout is on the page: per server, pause / resume / abort (with impact).
  const ro = page.locator("[data-active-rollout]");
  await expect(ro).toContainText(name);
  await expect(page.getByRole("button", { name: "新建灰度" }).first()).toBeDisabled();
  await ro.getByRole("button", { name: "暂停" }).click();
  await expect(ro.getByText("已暂停").first()).toBeVisible();
  await ro.getByRole("button", { name: "继续" }).click();
  await expect(ro.getByText(/进行中/).first()).toBeVisible();
  await ro.getByRole("button", { name: "中止" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("不再升级");
  await confirmDialog(page, undefined, "中止灰度");
  await expect(ro).toHaveCount(0);
  const h = page.locator("[data-rollout]", { hasText: "v0.9.0" }).first();
  await expect(h).toContainText("已中止");
  await h.click();
  await expect(dialog(page, /灰度 v0\.9\.0/).getByText(name)).toBeVisible();
});

test("AUD-01 AUD-02: the audit timeline — actor (by email) and action pills in the URL, object link, change detail, load older", async ({
  page,
}, info) => {
  const email = `${uniq(info, "audited")}@e2e.test`;
  const u = await apiJson<{ id: string }>("POST", "/users", { email, password: "audited-pass-1" });
  await apiJson("POST", `/users/${u.id}/ban`, { reason: "audit trail" });
  await openConsole(page, "/audit");
  // The actor by email (resolved to the account's label), the action by code: pills, in the URL.
  await page.getByRole("button", { name: "操作者", exact: true }).click();
  await page.getByLabel("操作者邮箱或标签").fill(ADMIN);
  await page.getByLabel("操作者邮箱或标签").press("Enter");
  await expect(page).toHaveURL(/actor=/);
  await page.getByRole("button", { name: "动作", exact: true }).click();
  await page.getByLabel("动作代码或前缀").fill("user.ban");
  await page.getByLabel("动作代码或前缀").press("Enter");
  await expect(page).toHaveURL(/action=user\.ban/);
  const r = page.locator("[data-row]", { hasText: email }).first();
  await expect(r).toContainText(ADMIN);
  await expect(r).toContainText("封禁用户");
  // The object links to the user.
  await expect(r.getByRole("link", { name: email })).toHaveAttribute("href", new RegExp(`/users\\?open=${u.id}`));
  // AUD-02: the changed fields, before → after, in the entry's dialog (?open=).
  await r.getByText(/^\d{2}:\d{2}$/).click();
  await expect(page).toHaveURL(/[?&]open=\d+/);
  const d = dialog(page, "封禁用户");
  await expect(d.getByText("enabled", { exact: true })).toBeVisible();
  await expect(d.locator(".line-through").first()).toBeVisible();
  await d.getByRole("button", { name: "关闭", exact: true }).first().click();
  // The filters survive a reload (they are in the URL).
  await page.reload();
  await expect(page.getByRole("button", { name: /^动作：/ })).toContainText("封禁用户");
  await expect(page.locator("[data-row]", { hasText: email }).first()).toContainText("封禁用户");
  // Load older pages of everything (the audit log is append-only: enough real entries for a second page).
  for (let i = 0; i < 26; i++) {
    await apiJson("POST", `/users/${u.id}/unban`);
    await apiJson("POST", `/users/${u.id}/ban`, { reason: `round ${i}` });
  }
  await page.getByRole("button", { name: "清除全部" }).click();
  await expect(page).not.toHaveURL(/action=/);
  await expect(page.getByRole("button", { name: "加载更早的记录" })).toBeVisible();
  await page.getByRole("button", { name: "加载更早的记录" }).click();
  await expect(page.locator("[data-row]")).not.toHaveCount(50);
});
