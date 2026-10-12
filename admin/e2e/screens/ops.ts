// Dashboard, system status, alerts, updates, audit (v2 shots/ops.json).
// Not taken (states the real app cannot show on demand): dashboard-allclear
// (the e2e data always has pending work), status-allok (depends on the CI
// host), status-mail-empty (the queue is never empty there),
// status-diagnose-running (a single request, no stable frame), *-loading,
// *-error, *-stale, alerts-calm (other specs leave alerts firing),
// alerts-outbox-empty (never empty there), updates-checking / -nokey /
// -check-error / -no-releases / -error / -paused / -delete-inuse /
// -upload-progress / -upload-error (transient or need a state the CI data
// does not have). status-diagnose-ok / -failed: only the one matching the
// CI mail setup is taken.
import { expect, type Page } from "@playwright/test";

import { apiJson, sql, uniq } from "../helpers";
import { go, goDialog, goto, need, type Ctx, type Shot } from "./shared";

/**
 * Alerts of our own: an enrolled server (the evaluator leaves the live kinds
 * of a never-online one as they are) with a firing CPU alert, a resolved
 * disk alert and a failed webhook notice.
 */
export async function setup(c: Ctx): Promise<void> {
  const name = uniq(c.info, "screens-alerts");
  const { id } = await apiJson<{ id: string }>("POST", "/servers", { name });
  sql(`UPDATE servers SET cert_serial = md5('${name}'), enrolled_at = now() WHERE id = '${id}'`);
  c.extra.alertServer = id;
  c.extra.alertFiring = sql(
    `INSERT INTO server_alerts (server_id, kind, status, value, detail, fired_at) VALUES ('${id}', 'cpu', 'firing', '94%', 'CPU 高于 90% 已持续 10 分钟', now() - interval '25 minutes') RETURNING id`,
  ).split("\n")[0];
  c.extra.alertResolved = sql(
    `INSERT INTO server_alerts (server_id, kind, status, value, detail, fired_at, resolved_at, acked_at, acked_by) VALUES ('${id}', 'disk', 'resolved', '91%', '磁盘已用 91%', now() - interval '3 hours', now() - interval '2 hours', now() - interval '170 minutes', 'admin') RETURNING id`,
  ).split("\n")[0];
  sql(
    `INSERT INTO alert_notifications (alert_id, channel, event, payload, status, attempts, last_error) ` +
      `VALUES (${c.extra.alertFiring}, 'webhook', 'firing', '{"title":"${name} CPU 过高"}', 'dead', 3, '502 Bad Gateway'), ` +
      `(${c.extra.alertFiring}, 'email', 'firing', '{"title":"${name} CPU 过高"}', 'sent', 1, NULL)`,
  );
}

/** Run the test mail in the open dialog; resolve only when the outcome is `want`. */
const diagnose = (want: "ok" | "failed") => async (page: Page) => {
  await goto(page, "/status?tab=mail&mail=dead&diagnose=1");
  const d = page.getByRole("dialog");
  await d.getByRole("button", { name: "诊断并发送" }).click();
  await expect(d.getByRole("button", { name: "重新测试" })).toBeVisible({ timeout: 30_000 });
  const failed = await d.getByText(/步失败/).isVisible();
  if (failed !== (want === "failed")) throw new Error(`the test mail ${failed ? "failed" : "passed"} here`);
};

export const shots: Shot[] = [
  { name: "dashboard-default", open: go(""), full: true },
  { name: "dashboard-orders-30d", open: go("/?metric=orders&range=30d") },
  { name: "dashboard-traffic-today", open: go("/?metric=traffic&range=today") },
  { name: "status-overview", open: go("/status"), full: true },
  {
    name: "status-overview-jobs-open",
    open: async (page) => {
      await goto(page, "/status");
      const more = page.getByRole("button", { name: /个任务运行正常/ });
      if (await more.isVisible()) await more.click();
      await page.locator("[data-job]").first().scrollIntoViewIfNeeded();
    },
  },
  { name: "status-mail-dead", open: go("/status?tab=mail&mail=dead"), full: true },
  { name: "status-mail-all", open: go("/status?tab=mail"), full: true },
  { name: "status-diagnose-failed", open: diagnose("failed") },
  { name: "status-diagnose-ok", open: diagnose("ok") },
  { name: "alerts-board", open: go("/alerts"), full: true },
  {
    name: "alerts-selected",
    open: async (page) => {
      await goto(page, "/alerts");
      await page.locator("[data-alert]").getByRole("checkbox", { name: "选择" }).first().click();
      await expect(page.getByRole("region", { name: "批量操作" })).toBeVisible();
    },
  },
  { name: "alerts-filter-kind", open: go("/alerts?kind=cpu"), full: true },
  {
    name: "alerts-nomatch",
    open: async (page, c) => goto(page, `/alerts?kind=cert&server=${need(c.extra.alertServer, "alert server")}`),
  },
  { name: "alerts-detail-firing", open: goDialog((c) => `/alerts?open=${need(c.extra.alertFiring, "firing alert")}`) },
  {
    name: "alerts-detail-resolved",
    open: goDialog((c) => `/alerts?open=${need(c.extra.alertResolved, "resolved alert")}`),
  },
  { name: "alerts-outbox", open: go("/alerts/outbox"), full: true },
  { name: "alerts-outbox-failed", open: go("/alerts/outbox?status=failed") },
  { name: "alerts-outbox-nomatch", open: go("/alerts/outbox?channel=telegram&status=failed") },
  { name: "updates-pipeline", open: go("/updates"), full: true },
  {
    name: "updates-no-rollout",
    open: async (page) => {
      await goto(page, "/updates");
      const empty = page.getByText("没有进行中的灰度");
      if (!(await empty.isVisible())) throw new Error("a rollout is open");
      await empty.scrollIntoViewIfNeeded();
    },
  },
  { name: "updates-upload-empty", open: goDialog(() => "/updates?upload=1") },
  {
    name: "updates-delete",
    open: async (page) => {
      await goto(page, "/updates");
      const v = await page.locator("[data-release]").first().getAttribute("data-release");
      if (!v) throw new Error("no release");
      await goto(page, `/updates?delete=${encodeURIComponent(v)}`);
      await expect(page.getByRole("alertdialog")).toBeVisible();
    },
  },
  { name: "updates-rollout-form", open: goDialog(() => "/updates?new=rollout") },
  {
    name: "updates-rollout-invalid",
    open: async (page) => {
      await goDialog(() => "/updates?new=rollout")(page, {} as Ctx);
      const d = page.getByRole("dialog");
      await d.getByLabel("批次").fill("0");
      await d.getByLabel("健康超时（分钟）").fill("abc");
      await d.getByLabel(/最大失败比例/).fill("");
      await d.getByRole("button", { name: "下一步" }).click();
      await expect(d.getByText(/处需要修正/)).toBeVisible();
    },
  },
  {
    name: "updates-rollout-subset",
    open: async (page) => {
      await goDialog(() => "/updates?new=rollout")(page, {} as Ctx);
      await page
        .getByRole("dialog")
        .getByRole("radio", { name: /指定服务器/ })
        .click();
    },
  },
  {
    name: "updates-rollout-confirm",
    open: async (page) => {
      await goDialog(() => "/updates?new=rollout")(page, {} as Ctx);
      const d = page.getByRole("dialog");
      await d.getByRole("button", { name: "下一步" }).click();
      await expect(d.getByRole("button", { name: /开始升级/ })).toBeVisible();
    },
  },
];
