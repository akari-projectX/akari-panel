// Dashboard, system status, alerts, updates, audit (v2 shots/ops.json).
// Not taken (states the real app cannot show on demand): dashboard-allclear
// (the e2e data always has pending work), status-allok (depends on the CI
// host), status-mail-empty (the queue is never empty there),
// status-diagnose-running (a single request, no stable frame), *-loading,
// *-error, *-stale. status-diagnose-ok / -failed: only the one matching the
// CI mail setup is taken.
import { expect, type Page } from "@playwright/test";

import { go, goto, type Shot } from "./shared";

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
];
