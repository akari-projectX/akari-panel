// INVENTORY §12 (alerts), §13 (agent updates), §14 (audit).
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
  openRow,
  row,
  sql,
  toast,
  uniq,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test("ALR-01 ALR-02 ALR-03 ALR-04 ALR-05: alert center, acknowledge, settings, channel tests, notification log with retry", async ({
  page,
}, info) => {
  const name = uniq(info, "alert-host");
  const { id } = await apiJson<{ id: string }>("POST", "/servers", { name });
  // The evaluator (every 30 s) monitors enrolled servers only: an alert on a
  // never-enrolled one is resolved by the next round. Enrolled but never
  // online, the server's live kinds (cpu) are undecided and stay as they are.
  sql(`UPDATE servers SET cert_serial = md5('${name}'), enrolled_at = now() WHERE id = '${id}'`);
  // A firing CPU alert and a dead notification.
  const alert = sql(
    `INSERT INTO server_alerts (server_id, kind, status, value, detail) VALUES ('${id}', 'cpu', 'firing', '97%', 'CPU 97% for 5 min') RETURNING id`,
  ).split("\n")[0];
  sql(
    `INSERT INTO alert_notifications (alert_id, channel, event, payload, status, attempts, last_error) ` +
      `VALUES (${alert}, 'webhook', 'firing', '{"title":"${name} CPU"}', 'dead', 8, 'connection refused')`,
  );
  await openConsole(page, "/alerts");
  // ALR-01: firing list, counts by kind, filters.
  await expect(page.getByText(/CPU 过高 · \d/)).toBeVisible();
  await page.getByLabel("服务器", { exact: true }).selectOption({ label: name });
  await page.getByLabel("类型", { exact: true }).selectOption("cpu");
  await expect(row(page, name)).toContainText("正在告警");
  await expect(row(page, name)).toContainText("CPU 97% for 5 min");
  // ALR-02: acknowledge.
  await row(page, name).getByRole("button", { name: "确认", exact: true }).click();
  await toast(page, "已确认");
  await expect(row(page, name)).toContainText(/u-[0-9a-f]{8}|e2e-admin/);
  await page.getByLabel("状态", { exact: true }).selectOption("resolved");
  await expect(page.getByText("没有匹配的记录")).toBeVisible();
  // ALR-03: settings — thresholds, the webhook with a generated secret.
  await page.getByRole("tab", { name: "告警设置" }).click();
  await page.getByLabel("CPU 超过 %").fill("95");
  await page.getByLabel("冷却（分钟）").fill("30");
  await page.getByRole("switch", { name: "Webhook" }).click();
  await page.getByLabel("URL", { exact: true }).fill(`${new URL(RELEASE_SOURCE).origin}/hook`);
  await page.getByRole("button", { name: "随机生成" }).click();
  await page.getByLabel("收件人（最多 5 个，逗号分隔）").fill(ADMIN);
  await page.getByRole("button", { name: "保存告警设置" }).click();
  await toast(page, "告警设置已保存");
  await expect(page.getByText("已保存；留空 = 不修改")).toBeVisible();
  // ALR-04: a channel test (the stand-in answers 501: the failure is reported).
  await page.getByRole("button", { name: "发送测试" }).nth(1).click();
  await expect(page.locator("[data-toast]").filter({ hasNotText: "告警设置已保存" }).first()).toBeVisible();
  // Turn the webhook off again (the evaluator would deliver to it).
  await page.getByRole("switch", { name: "Webhook" }).click();
  await page.getByRole("button", { name: "保存告警设置" }).click();
  await toast(page, "告警设置已保存");
  // ALR-05: the notification log; retry a dead one.
  await page.getByRole("tab", { name: "通知记录" }).click();
  await expect(row(page, `${name} CPU`)).toContainText("connection refused");
  await row(page, `${name} CPU`).getByRole("button", { name: "重试", exact: true }).click();
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
  await openConsole(page, "/updates");
  // UPD-01: the source and auto-check, then check.
  await page.getByLabel("发布源（GitHub 最新发布 API，留空 = 官方）").fill(RELEASE_SOURCE);
  await page.getByRole("switch", { name: "自动检查（每 6 小时）" }).click();
  await page.getByRole("button", { name: "保存", exact: true }).first().click();
  await toast(page, "已保存");
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText(/上次检查：.*(已保存 v0\.9\.0|已是最新)/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/最新发布 v0\.9\.0/)).toBeVisible();
  // DSH-06: the dashboard and the nodes page say a newer agent exists.
  await page.goto(CONSOLE);
  await expect(page.getByText("有新版本 v0.9.0")).toBeVisible();
  await page.goto(`${CONSOLE}/nodes`);
  await expect(page.getByText("有新版本 v0.9.0")).toBeVisible();
  await page.goto(`${CONSOLE}/updates`);
  // UPD-02: delete the amd64 release, upload it again by hand.
  await expect(page.getByRole("button", { name: "删除 v0.9.0 arm64" })).toBeVisible();
  await page.getByRole("button", { name: "删除 v0.9.0 amd64" }).click();
  await confirmDialog(page);
  await toast(page, "已删除");
  await expect(page.getByRole("button", { name: "删除 v0.9.0 amd64" })).toHaveCount(0);
  const dl = join(PAY_DIR, "release/www/dl");
  await page.getByLabel("清单（manifest）").setInputFiles(join(dl, "akari-agent-linux-amd64.manifest.json"));
  await page.getByLabel("签名", { exact: true }).setInputFiles(join(dl, "akari-agent-linux-amd64.manifest.sig"));
  await page.getByLabel("二进制").setInputFiles(join(dl, "akari-agent-linux-amd64"));
  await page.getByRole("button", { name: "上传" }).click();
  await toast(page, "已上传 v0.9.0");
  await expect(page.getByRole("button", { name: "删除 v0.9.0 amd64" })).toBeVisible();
  // UPD-03: a rollout to this server; pause, resume, abort.
  await page.getByRole("button", { name: "新建灰度" }).click();
  const d = dialog(page, "新建灰度");
  await d.getByLabel("版本").selectOption("v0.9.0");
  await d.getByLabel("覆盖比例（%）").fill("100");
  await d.getByLabel("健康超时（秒）").fill("600");
  await d.getByRole("checkbox", { name: name }).click();
  const made = page.waitForResponse((r) => r.url().endsWith("/rollouts") && r.request().method() === "POST");
  await d.getByRole("button", { name: "开始" }).click();
  const res = await made;
  expect(res.status(), await res.text()).toBeLessThan(300);
  await toast(page, "灰度已开始");
  await openRow(page, "v0.9.0");
  const r = dialog(page, /灰度 v0\.9\.0/);
  await expect(r.getByText(name)).toBeVisible();
  await r.getByRole("button", { name: "暂停" }).click();
  await expect(r.getByText("已暂停")).toBeVisible();
  await r.getByRole("button", { name: "继续" }).click();
  await expect(r.getByText("进行中")).toBeVisible();
  await r.getByRole("button", { name: "中止" }).click();
  await confirmDialog(page);
  await expect(r.getByText("已中止")).toBeVisible();
  await expect(r.getByRole("button", { name: "继续" })).toHaveCount(0);
});

test("AUD-01 AUD-02: the audit log — actor and action filters, field-level changes, load older", async ({
  page,
}, info) => {
  const email = `${uniq(info, "audited")}@e2e.test`;
  const u = await apiJson<{ id: string }>("POST", "/users", { email, password: "audited-pass-1" });
  await apiJson("POST", `/users/${u.id}/ban`, { reason: "audit trail" });
  const label = `u-${sql(`SELECT replace(id::text, '-', '') FROM users WHERE email = '${ADMIN}'`).slice(0, 8)}`;
  await openConsole(page, "/audit");
  await page.getByLabel("操作者标签").fill(label);
  await page.getByLabel("操作", { exact: true }).fill("user.ban");
  const r = row(page, u.id.slice(0, 8));
  await expect(r).toContainText(ADMIN);
  await expect(r).toContainText("封禁用户");
  // AUD-02: the changed fields, before → after.
  await expect(r.getByText("enabled")).toBeVisible();
  await expect(r.locator(".line-through").first()).toBeVisible();
  // Load older pages of everything (the audit log is append-only: enough real entries for a second page).
  for (let i = 0; i < 26; i++) {
    await apiJson("POST", `/users/${u.id}/unban`);
    await apiJson("POST", `/users/${u.id}/ban`, { reason: `round ${i}` });
  }
  await page.reload();
  await page.getByLabel("操作者标签").fill("");
  await page.getByLabel("操作", { exact: true }).fill("");
  await expect(page.getByRole("button", { name: "加载更早" })).toBeVisible();
  await page.getByRole("button", { name: "加载更早" }).click();
  await expect(page.locator("[data-row]:visible")).not.toHaveCount(50);
});
