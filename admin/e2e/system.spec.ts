// INVENTORY §12 (alerts), §13 (agent updates), §14 (audit). The alert
// thresholds/channels and the release source are settings now (settings.spec.ts).
import { join } from "node:path";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  ADMIN,
  CONSOLE,
  PAY_DIR,
  RELEASE_SOURCE,
  apiJson,
  confirmDialog,
  dialog,
  isMobile,
  openConsole,
  row,
  sql,
  toast,
  uniq,
} from "./helpers";

test.describe.configure({ mode: "serial" });

/** Open a row by clicking a text inside it (a link elsewhere in the row would navigate away). */
async function openBy(page: Page, info: TestInfo, r: ReturnType<typeof row>, text: string | RegExp) {
  await expect(r).toBeVisible();
  if (isMobile(info)) await r.locator('[role="button"]').first().click();
  else await r.getByText(text).first().click();
}

test("ALR-01 ALR-02 ALR-05: alert center, acknowledge (row and bulk), alert detail, notification log with filters and retry", async ({
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
    `INSERT INTO server_alerts (server_id, kind, status, value, detail) VALUES ('${id}', 'cpu', 'firing', '97%', 'CPU 97% for 5 min') RETURNING id`,
  ).split("\n")[0];
  sql(
    `INSERT INTO server_alerts (server_id, kind, status, value, detail) VALUES ('${id}', 'memory', 'firing', '95%', 'memory 95% for 5 min')`,
  );
  sql(
    `INSERT INTO alert_notifications (alert_id, channel, event, payload, status, attempts, last_error) ` +
      `VALUES (${alert}, 'webhook', 'firing', '{"title":"${name} CPU"}', 'dead', 8, 'connection refused')`,
  );
  await openConsole(page, "/alerts");
  // The thresholds and channels are a settings section now.
  await expect(page.getByRole("link", { name: "告警通道与阈值" })).toHaveAttribute(
    "href",
    /\/settings\/alert-channels$/,
  );
  // ALR-01: firing list, counts by kind, filters (in the URL).
  await expect(page.getByText(/CPU 过高 · \d/)).toBeVisible();
  await page.getByLabel("服务器", { exact: true }).selectOption({ label: name });
  await expect(page).toHaveURL(/server=/);
  const cpu = page.locator("[data-row]:visible", { hasText: "CPU 97% for 5 min" }).first();
  const mem = page.locator("[data-row]:visible", { hasText: "memory 95% for 5 min" }).first();
  await expect(cpu).toContainText("正在告警");
  await expect(mem).toContainText("正在告警");
  // ALR-02: acknowledge one row (the list updates without a reload).
  await cpu.getByRole("button", { name: "确认", exact: true }).click();
  await toast(page, "已确认");
  await expect(cpu).toContainText(/u-[0-9a-f]{8}|e2e-admin|@/);
  await expect(cpu.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  // … and in bulk.
  await mem.getByRole("checkbox", { name: "选择" }).click();
  await page.getByRole("button", { name: /确认所选（1）/ }).click();
  await toast(page, "已确认 1 条告警");
  await expect(mem.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);
  // The alert's own detail, with a link to its server.
  await openBy(page, info, cpu, "CPU 97% for 5 min");
  const a = dialog(page, new RegExp(`CPU 过高 · ${name}`));
  await expect(a.getByText("97%", { exact: true })).toBeVisible();
  await expect(a.getByRole("link", { name: "查看服务器" })).toHaveAttribute("href", new RegExp(`server:${id}`));
  await a.getByRole("button", { name: "关闭", exact: true }).first().click();
  await expect(a).toHaveCount(0);
  // A filter without matches: the "no match" empty state.
  await page.getByLabel("状态", { exact: true }).selectOption("resolved");
  await page.getByLabel("类型", { exact: true }).selectOption("cpu");
  await expect(page.getByText("没有匹配的记录")).toBeVisible();
  // ALR-05: the notification log (channel / status in words, filters); retry a dead one.
  await page.getByRole("tab", { name: "通知记录" }).click();
  await page.getByLabel("通道", { exact: true }).selectOption("webhook");
  await page.getByLabel("投递状态", { exact: true }).selectOption("dead");
  const n = row(page, `${name} CPU`);
  await expect(n).toContainText("connection refused");
  await expect(n).toContainText("发送失败");
  await expect(n).toContainText("Webhook");
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
  // The order of the work: check, releases, rollouts.
  const titles = await page.locator("h3").allTextContents();
  const at = (t: string) => titles.findIndex((x) => x.includes(t));
  expect(at("检查更新")).toBeLessThan(at("Agent 发布"));
  expect(at("Agent 发布")).toBeLessThan(at("灰度更新"));
  await expect(page.getByRole("link", { name: "更新源与验签" })).toHaveAttribute("href", /\/settings\/updates$/);
  // UPD-01: check.
  await page.getByRole("button", { name: "检查更新" }).click();
  await expect(page.getByText(/上次检查：.*(已保存 v0\.9\.0|已是最新)/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/最新发布 v0\.9\.0/)).toBeVisible();
  // DSH-06: the dashboard and the nodes page say a newer agent exists.
  await page.goto(CONSOLE);
  await expect(page.getByText("有新版本 v0.9.0")).toBeVisible();
  await page.goto(`${CONSOLE}/nodes`);
  await expect(page.getByText("有新版本 v0.9.0")).toBeVisible();
  await page.goto(`${CONSOLE}/updates`);
  // UPD-02: delete the amd64 release (typing the version), upload it again by hand.
  await expect(page.getByRole("button", { name: "删除 v0.9.0 arm64" })).toBeVisible();
  await page.getByRole("button", { name: "删除 v0.9.0 amd64" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("没有未结束的灰度使用这个版本");
  await confirmDialog(page, "v0.9.0");
  await toast(page, "已删除");
  await expect(page.getByRole("button", { name: "删除 v0.9.0 amd64" })).toHaveCount(0);
  const dl = join(PAY_DIR, "release/www/dl");
  await page.getByLabel("清单（manifest）").setInputFiles(join(dl, "akari-agent-linux-amd64.manifest.json"));
  await page.getByLabel("签名", { exact: true }).setInputFiles(join(dl, "akari-agent-linux-amd64.manifest.sig"));
  await page.getByLabel("二进制").setInputFiles(join(dl, "akari-agent-linux-amd64"));
  await page.getByRole("button", { name: "上传" }).click();
  await toast(page, "已上传 v0.9.0");
  await expect(page.getByRole("button", { name: "删除 v0.9.0 amd64" })).toBeVisible();
  // The file inputs are cleared after an upload.
  await expect(page.getByLabel("二进制")).toHaveValue("");
  await expect(page.getByRole("button", { name: "上传" })).toBeDisabled();
  // UPD-03: a rollout to this server; the form checks its numbers; "将影响 N 台" before it starts.
  await page.getByRole("button", { name: "新建灰度" }).click();
  const d = dialog(page, "新建灰度");
  await d.getByLabel("版本").selectOption("v0.9.0");
  await d.getByLabel(/分批/).fill("50,10");
  await d.getByLabel("健康超时（秒）").click();
  await expect(d.getByText("必须在 1–100 之间且逐个增大")).toBeVisible();
  await d.getByLabel(/分批/).fill("100");
  await d.getByLabel("覆盖比例（%）").fill("100");
  await d.getByLabel("健康超时（秒）").fill("600");
  await d.getByRole("checkbox", { name: name }).click();
  const made = page.waitForResponse((r) => r.url().endsWith("/rollouts") && r.request().method() === "POST");
  await d.getByRole("button", { name: "开始" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("将影响 1 台服务器");
  await confirmDialog(page, undefined, "开始");
  const res = await made;
  expect(res.status(), await res.text()).toBeLessThan(300);
  await toast(page, "灰度已开始");
  const ro = page.locator("[data-rollout]:visible", { hasText: "v0.9.0" }).first();
  await openBy(page, info, ro, "v0.9.0");
  const r = dialog(page, /灰度 v0\.9\.0/);
  await expect(r.getByText(name)).toBeVisible();
  await r.getByRole("button", { name: "暂停" }).click();
  await expect(r.getByText("已暂停")).toBeVisible();
  await r.getByRole("button", { name: "继续" }).click();
  await expect(r.getByText("进行中")).toBeVisible();
  await r.getByRole("button", { name: "中止" }).click();
  await confirmDialog(page, undefined, "中止");
  await expect(r.getByText("已中止")).toBeVisible();
  await expect(r.getByRole("button", { name: "继续" })).toHaveCount(0);
});

test("AUD-01 AUD-02: the audit log — actor (by email) and action filters in the URL, object link, change detail, load older", async ({
  page,
}, info) => {
  const email = `${uniq(info, "audited")}@e2e.test`;
  const u = await apiJson<{ id: string }>("POST", "/users", { email, password: "audited-pass-1" });
  await apiJson("POST", `/users/${u.id}/ban`, { reason: "audit trail" });
  await openConsole(page, "/audit");
  // The actor by email (resolved to the account's label).
  await page.getByLabel("操作者").fill(ADMIN);
  await page.getByLabel("操作", { exact: true }).fill("user.ban");
  await expect(page).toHaveURL(/action=user\.ban/);
  const r = row(page, u.id.slice(0, 8));
  await expect(r).toContainText(ADMIN);
  await expect(r).toContainText("封禁用户");
  // The object links to the user.
  await expect(r.getByRole("link", { name: /用户/ })).toHaveAttribute("href", new RegExp(`/users\\?open=${u.id}`));
  // AUD-02: the changed fields, before → after, in the entry's dialog.
  await openBy(page, info, r, "封禁用户");
  const d = dialog(page, "封禁用户");
  await expect(d.getByText("enabled", { exact: true })).toBeVisible();
  await expect(d.locator(".line-through").first()).toBeVisible();
  await d.getByRole("button", { name: "关闭", exact: true }).first().click();
  // The filters survive a reload (they are in the URL).
  await page.reload();
  await expect(page.getByLabel("操作", { exact: true })).toHaveValue("user.ban");
  await expect(row(page, u.id.slice(0, 8))).toContainText("封禁用户");
  // Load older pages of everything (the audit log is append-only: enough real entries for a second page).
  for (let i = 0; i < 26; i++) {
    await apiJson("POST", `/users/${u.id}/unban`);
    await apiJson("POST", `/users/${u.id}/ban`, { reason: `round ${i}` });
  }
  await page.getByLabel("操作者").fill("");
  await page.getByLabel("操作", { exact: true }).fill("");
  await expect(page).not.toHaveURL(/action=/);
  await expect(page.getByRole("button", { name: "加载更早" })).toBeVisible();
  await page.getByRole("button", { name: "加载更早" }).click();
  await expect(page.locator("[data-row]:visible")).not.toHaveCount(50);
});
