import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, type PlanView, type UserView } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fakeApi, renderAdmin } from "../test/harness";
import {
  BatchJobsCard,
  CouponBatchesCard,
  EMPTY_BATCH,
  EMPTY_COUPON_BATCH,
  ManualOrderDialog,
  batchAction,
  batchSummary,
  couponBatchBody,
  exportHref,
  manualOrderBody,
  type BatchJob,
} from "./admin-ops";
import { AdminUsers } from "./admin-users";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const user = (over: Partial<UserView>): UserView => ({
  id: "u1",
  login: "alice",
  role: "user",
  enabled: true,
  traffic_limit_bytes: null,
  traffic_used_bytes: 0,
  expires_at: null,
  created_at: "2026-10-01T00:00:00Z",
  totp_enabled: false,
  disabled_reason: null,
  plan_id: null,
  plan_name: null,
  next_reset_at: null,
  email: null,
  email_verified: false,
  ...over,
});

const plan = { id: "p1", name: "basic", enabled: true } as PlanView;

const job = (over: Partial<BatchJob>): BatchJob => ({
  id: "j1",
  actor_login: "root",
  action: "add_balance",
  params: { amount_cents: 100, reason: "r" },
  selection: "ids",
  status: "running",
  total: 10,
  done: 4,
  failed: 1,
  skipped: 0,
  last_error: null,
  created_at: "2026-10-03T00:00:00Z",
  finished_at: null,
  ...over,
});

describe("pure helpers", () => {
  it("builds batch actions (fen, Beijing day, no amount for other kinds)", () => {
    expect(batchAction({ ...EMPTY_BATCH, kind: "extend_expiry", days: "0" })).toBe("天数须为 1–3650 的整数");
    expect(batchAction({ ...EMPTY_BATCH, kind: "extend_expiry", days: "30" })).toEqual({
      kind: "extend_expiry",
      days: 30,
    });
    expect(batchAction({ ...EMPTY_BATCH, kind: "add_balance", amount: "1.5", reason: " 补偿 " })).toEqual({
      kind: "add_balance",
      amount_cents: 150,
      reason: "补偿",
    });
    expect(batchAction({ ...EMPTY_BATCH, kind: "add_balance", amount: "2", credit: false, reason: "x" })).toEqual({
      kind: "add_balance",
      amount_cents: -200,
      reason: "x",
    });
    expect(batchAction({ ...EMPTY_BATCH, kind: "add_balance", amount: "1.234", reason: "x" })).toBe(
      "金额无效（元，最多两位小数）",
    );
    expect(batchAction({ ...EMPTY_BATCH, kind: "set_plan", planId: "p1" })).toEqual({
      kind: "set_plan",
      plan_id: "p1",
      period: "month",
    });
    expect(batchAction({ ...EMPTY_BATCH, kind: "set_plan", planId: "p1", term: "days", termDays: "" })).toBe(
      "天数须为 1–3650 的整数",
    );
    expect(batchAction({ ...EMPTY_BATCH, kind: "set_plan", planId: "p1", term: "days", termDays: "45" })).toEqual({
      kind: "set_plan",
      plan_id: "p1",
      period: "days",
      days: 45,
    });
    expect(batchAction({ ...EMPTY_BATCH, kind: "send_email", subject: "s" })).toBe("请填写邮件正文");
    expect(batchAction({ ...EMPTY_BATCH, kind: "unban" })).toEqual({ kind: "unban" });
    expect(batchAction({ ...EMPTY_BATCH, kind: "ban", reason: " " })).toBe("请填写封禁原因（会显示给用户）");
    expect(batchAction({ ...EMPTY_BATCH, kind: "ban", reason: " 滥用 " })).toEqual({ kind: "ban", reason: "滥用" });
    expect(batchSummary({ kind: "add_balance", amount_cents: -200 }, [])).toContain("扣减余额 ¥2.00");
    expect(batchSummary({ kind: "set_plan", plan_id: "p1", period: "year" }, [plan])).toContain("「basic」，时长 年付");
  });

  it("never puts an amount in a manual order", () => {
    expect(manualOrderBody({ userId: "", planId: "p", period: "month", gift: false, reason: "r" })).toBe(
      "请先找到用户",
    );
    const b = manualOrderBody({ userId: "u", planId: "p", period: "month", gift: true, reason: " 赠送 " });
    expect(b).toEqual({ user_id: "u", plan_id: "p", period: "month", gift: true, reason: "赠送" });
    expect(Object.keys(b as object)).not.toContain("amount_cents");
  });

  it("builds coupon batch bodies", () => {
    expect(couponBatchBody({ ...EMPTY_COUPON_BATCH, value: "20" })).toMatchObject({
      count: 100,
      length: 10,
      kind: "percent",
      value: 20,
      max_uses: 1,
      plan_ids: null,
      periods: null,
    });
    expect(couponBatchBody({ ...EMPTY_COUPON_BATCH, kind: "fixed", value: "5.5", maxUses: "" })).toMatchObject({
      value: 550,
      max_uses: null,
    });
    expect(couponBatchBody({ ...EMPTY_COUPON_BATCH, value: "20", count: "6000" })).toBe("数量须为 1–5000");
    expect(couponBatchBody({ ...EMPTY_COUPON_BATCH, value: "20", prefix: "a b" })).toContain("前缀");
    expect(couponBatchBody({ ...EMPTY_COUPON_BATCH, value: "101" })).toBe("折扣百分比须为 1–100 的整数");
  });

  it("export links carry only set parameters", () => {
    expect(exportHref("/orders/export.csv", { from: "2026-10-01", to: "", status: undefined })).toBe(
      "/api/v1/orders/export.csv?from=2026-10-01",
    );
    expect(exportHref("/users/export.csv")).toBe("/api/v1/users/export.csv");
  });

  it("maps the new error codes to Chinese", () => {
    expect(adminErrorText(new ApiError(409, "x", { code: "batch.finished", params: { status: "done" } }))).toBe(
      "该任务已经结束，不能取消",
    );
    expect(
      adminErrorText(
        new ApiError(409, "x", { code: "order_admin.manual_not_fulfilled", params: { error: "plan is sold out" } }),
      ),
    ).toContain("人工订单未创建");
  });
});

describe("users: batch selection", () => {
  it("previews, confirms and creates a batch for the selected users; exports the filter", async () => {
    const calls = fakeApi({
      "GET /users": { users: [user({ id: "u1", login: "alice" }), user({ id: "u2", login: "bob" })], total: 2 },
      "GET /plans": [plan],
      "GET /users/batch": [],
      "POST /users/batch/preview": { total: 2, admins: 0, sample: ["alice", "bob"] },
      "POST /users/batch": (body: unknown) => ({ status: 202, body: job({ ...(body as object) }) }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminUsers />);
    await screen.findByRole("cell", { name: /^bob/ });
    const bulk = screen.getByRole("button", { name: /批量操作（已选 0）/ }) as HTMLButtonElement;
    expect(bulk.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("选择本页全部用户"));
    fireEvent.click(screen.getByLabelText("选择 bob"));
    fireEvent.click(screen.getByRole("button", { name: /批量操作（已选 1）/ }));
    const dialog = await screen.findByRole("dialog", { name: "批量操作" });
    expect(await within(dialog).findByText(/将作用于 2 个账户/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("操作"), { target: { value: "add_balance" } });
    fireEvent.change(within(dialog).getByLabelText("每人金额（元）"), { target: { value: "3" } });
    fireEvent.change(within(dialog).getByLabelText("原因（写入每条明细）"), { target: { value: "补偿" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "预览并执行" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/users/batch")).toBe(true));
    expect(confirm.mock.calls[0][0]).toContain("对 2 个用户执行「调整余额」");
    const preview = calls.find((c) => c.path === "/users/batch/preview");
    expect(preview?.body).toEqual({ selection: { ids: ["u1"] } });
    const create = calls.find((c) => c.method === "POST" && c.path === "/users/batch");
    expect(create?.body).toEqual({
      selection: { ids: ["u1"] },
      action: { kind: "add_balance", amount_cents: 300, reason: "补偿" },
    });
    // The export link follows the list filter.
    fireEvent.click(screen.getByRole("button", { name: "已到期" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "导出 CSV" }).getAttribute("href")).toBe(
        "/api/v1/users/export.csv?status=expired",
      ),
    );
  });

  it("targets the whole filter, and nothing happens without confirmation", async () => {
    const calls = fakeApi({
      "GET /users": { users: [user({})], total: 120 },
      "GET /plans": [plan],
      "GET /users/batch": [],
      "POST /users/batch/preview": { total: 120, admins: 1, sample: ["alice"] },
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAdmin(<AdminUsers />);
    fireEvent.click(await screen.findByRole("button", { name: "对全部用户批量操作（120）" }));
    const dialog = await screen.findByRole("dialog", { name: "批量操作" });
    expect(await within(dialog).findByText(/其中 1 个管理员会被跳过/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("操作"), { target: { value: "unban" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "预览并执行" }));
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(calls.find((c) => c.path === "/users/batch/preview")?.body).toEqual({ selection: { filter: {} } });
    expect(calls.some((c) => c.method === "POST" && c.path === "/users/batch")).toBe(false);
  });
});

describe("batch jobs", () => {
  it("shows progress, items and cancels a running job", async () => {
    const calls = fakeApi({
      "GET /users/batch": [job({}), job({ id: "j2", status: "done", done: 10, failed: 0 })],
      "GET /users/batch/j1": {
        job: job({}),
        items: [{ user_id: "u9", user_login: "zed", status: "failed", detail: "balance.insufficient" }],
      },
      "POST /users/batch/j1/cancel": job({ status: "cancelled" }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<BatchJobsCard />);
    expect(await screen.findByText("5/10：成功 4，失败 1，跳过 0")).toBeTruthy();
    const bars = screen.getAllByRole("progressbar");
    expect(bars[0].getAttribute("aria-valuenow")).toBe("5");
    fireEvent.click(screen.getAllByRole("button", { name: "明细" })[0]);
    expect(await screen.findByText(/zed/)).toBeTruthy();
    expect(screen.getByText(/余额不足/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/users/batch/j1/cancel")).toBe(true));
  });
});

describe("manual orders", () => {
  it("finds the user, offers priced periods and posts no amount", async () => {
    const calls = fakeApi({
      "GET /plan-prices": {
        payments_enabled: true,
        plans: [
          {
            plan_id: "p1",
            plan_name: "basic",
            plan_enabled: true,
            on_sale: true,
            prices: [{ period: "month", days: null, price_cents: 3000 }],
          },
        ],
      },
      "GET /users": { users: [user({ id: "u7", login: "carol" })], total: 1 },
      "POST /orders/manual": () => ({ status: 201, body: { id: "o1" } }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const created = vi.fn();
    renderAdmin(<ManualOrderDialog onClose={() => {}} onCreated={created} />);
    fireEvent.change(await screen.findByLabelText("用户（账号或邮箱）"), { target: { value: "Carol" } });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));
    expect(await screen.findByText("用户：carol")).toBeTruthy();
    await screen.findByRole("option", { name: "basic" });
    fireEvent.change(screen.getByLabelText("套餐"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("周期"), { target: { value: "month" } });
    fireEvent.click(screen.getByLabelText("赠送（金额 ¥0，不计入营收）"));
    expect(screen.getByText(/原价 ¥30.00 赠送/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("原因（必填，写入订单与审计）"), { target: { value: "活动奖品" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并开通" }));
    await waitFor(() => expect(created).toHaveBeenCalledWith("o1"));
    expect(confirm.mock.calls[0][0]).toContain("赠送「basic」给 carol");
    expect(calls.find((c) => c.path === "/orders/manual")?.body).toEqual({
      user_id: "u7",
      plan_id: "p1",
      period: "month",
      gift: true,
      reason: "活动奖品",
    });
  });

  it("shows the coded refusal", async () => {
    fakeApi({
      "GET /plan-prices": {
        payments_enabled: true,
        plans: [
          {
            plan_id: "p1",
            plan_name: "basic",
            plan_enabled: true,
            on_sale: true,
            prices: [{ period: "month", days: null, price_cents: 100 }],
          },
        ],
      },
      "GET /users": { users: [user({ id: "u7", login: "carol" })], total: 1 },
      "POST /orders/manual": () => ({
        status: 409,
        body: { error: "x", code: "order_admin.user_has_pending", params: {} },
      }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<ManualOrderDialog onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(await screen.findByLabelText("用户（账号或邮箱）"), { target: { value: "carol" } });
    fireEvent.click(screen.getByRole("button", { name: "查找" }));
    await screen.findByText("用户：carol");
    await screen.findByRole("option", { name: "basic" });
    fireEvent.change(screen.getByLabelText("套餐"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("周期"), { target: { value: "month" } });
    fireEvent.change(screen.getByLabelText("原因（必填，写入订单与审计）"), { target: { value: "转账" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并开通" }));
    expect(await screen.findByText("该用户有待付款订单，请先取消或等待其结束")).toBeTruthy();
  });
});

describe("coupon batches", () => {
  it("generates, lists with export links and revokes", async () => {
    const calls = fakeApi({
      "GET /coupon-batches": [
        {
          id: "b1",
          name: "双十一",
          prefix: "SALE-",
          count: 100,
          template: { kind: "percent", value: 20, max_uses: 1, ends_at: null },
          actor_login: "root",
          created_at: "2026-10-03T00:00:00Z",
          revoked_at: null,
          codes: 100,
          used: 3,
          redeemed: 2,
        },
      ],
      "GET /plans": [plan],
      "POST /coupon-batches": () => ({ status: 201, body: { id: "b2", count: 50 } }),
      "POST /coupon-batches/b1/revoke": { disabled: 100 },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<CouponBatchesCard />);
    expect(await screen.findByText("双十一")).toBeTruthy();
    expect(screen.getByRole("link", { name: "导出 CSV" }).getAttribute("href")).toBe(
      "/api/v1/coupon-batches/b1/export.csv",
    );
    fireEvent.click(screen.getByRole("button", { name: "批量生成优惠码" }));
    const dialog = await screen.findByRole("dialog", { name: "批量生成优惠码" });
    fireEvent.change(within(dialog).getByLabelText("数量（1–5000）"), { target: { value: "50" } });
    fireEvent.change(within(dialog).getByLabelText("前缀（可选）"), { target: { value: "VIP" } });
    fireEvent.change(within(dialog).getByLabelText("减免百分比"), { target: { value: "15" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "生成" }));
    expect(await screen.findByText("已生成 50 个优惠码，可在下表导出 CSV。")).toBeTruthy();
    expect(calls.find((c) => c.path === "/coupon-batches" && c.method === "POST")?.body).toMatchObject({
      prefix: "VIP",
      count: 50,
      kind: "percent",
      value: 15,
      max_uses: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "作废" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/coupon-batches/b1/revoke")).toBe(true));
  });
});
