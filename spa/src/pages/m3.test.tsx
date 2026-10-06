import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GroupView, MyPlan, NodeView, PlanView } from "../lib/api";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { AdminPlans, optionalInt, periodValue, planBody, planForm, pricesBody, quotaBytes } from "./admin-plans";
import { PasswordCard, PlanCard } from "./portal";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GIB = 1024 ** 3;

const group = (over: Partial<GroupView>): GroupView => ({
  id: "g1",
  name: "asia",
  description: "",
  entrance_ids: [],
  plan_ids: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

const plan = (over: Partial<PlanView>): PlanView => ({
  id: "p1",
  name: "basic",
  traffic_quota_bytes: 100 * GIB,
  period: "monthly",
  speed_limit_mbps: null,
  device_seats: null,
  sort: 0,
  enabled: true,
  description: "",
  on_sale: false,
  capacity: null,
  renewal_only: false,
  allow_switch_in: true,
  prices: [],
  group_ids: ["g1"],
  active_users: 2,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

// A node with its direct entrance "e-<id>".
const node = (id: string, name: string) =>
  ({ id, name, entrances: [{ id: `e-${id}`, kind: "direct", name: "直连" }] }) as unknown as NodeView;

describe("plan form helpers", () => {
  it("builds periods and quotas", () => {
    expect(periodValue("monthly", "")).toBe("monthly");
    expect(periodValue("none", "5")).toBe("none");
    expect(periodValue("days", "30")).toBe("days-30");
    expect(periodValue("days", "0")).toBeNull();
    expect(periodValue("days", "3651")).toBeNull();
    expect(periodValue("days", "1.5")).toBeNull();
    expect(quotaBytes("")).toBeNull();
    expect(quotaBytes("1.5")).toBe(Math.round(1.5 * GIB));
    expect(quotaBytes("-1")).toBeUndefined();
    expect(quotaBytes("abc")).toBeUndefined();
    expect(optionalInt("", 1, 10)).toBeNull();
    expect(optionalInt("5", 1, 10)).toBe(5);
    expect(optionalInt("0", 1, 10)).toBeUndefined();
    expect(optionalInt("2.5", 1, 10)).toBeUndefined();
  });

  it("builds the price list in integer cents, validating days", () => {
    const off = { enabled: false, price: "", days: "" };
    const drafts = {
      month: { enabled: true, price: "9.9", days: "" },
      quarter: off,
      half_year: off,
      year: { enabled: true, price: "99", days: "" },
      two_year: off,
      three_year: off,
      days: off,
      onetime: { enabled: true, price: "0.29", days: "" },
      reset: { enabled: true, price: "5", days: "" },
    };
    expect(pricesBody(drafts)).toEqual([
      { period: "month", days: null, price_cents: 990 },
      { period: "year", days: null, price_cents: 9900 },
      { period: "onetime", days: null, price_cents: 29 },
      { period: "reset", days: null, price_cents: 500 },
    ]);
    expect(pricesBody({ ...drafts, days: { enabled: true, price: "1", days: "" } })).toBe(
      "自定义天数：天数须为 1–3650",
    );
    expect(pricesBody({ ...drafts, onetime: { enabled: true, price: "1", days: "7" } })).toContainEqual({
      period: "onetime",
      days: 7,
      price_cents: 100,
    });
    expect(pricesBody({ ...drafts, month: { enabled: true, price: "0", days: "" } })).toBe("月付：价格无效");
  });
});

describe("AdminPlans", () => {
  it("lists plans and groups, and creates a plan with its prices in one request", async () => {
    const calls = fakeApi({
      "GET /node-groups": [group({ entrance_ids: ["e-n1"], plan_ids: ["p1"] }), group({ id: "g2", name: "eu" })],
      "GET /plans": [plan({})],
      "GET /nodes": [node("n1", "jp-1"), node("n2", "de-1")],
      "POST /plans": () => ({ status: 201, body: plan({ id: "p2", name: "pro" }) }),
    });
    renderAdmin(<AdminPlans />);
    expect(await screen.findByRole("cell", { name: "basic" })).toBeTruthy();
    expect(screen.getByText("100.0 GiB")).toBeTruthy();
    expect(screen.getByText("jp-1 · 直连")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "新建套餐" }));
    const form = await screen.findByRole("form", { name: "新建套餐" });
    // Device seats are reserved for the client (R25): not shown.
    expect(within(form).queryByLabelText(/设备数/)).toBeNull();
    fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "pro" } });
    fireEvent.change(within(form).getByLabelText(/流量额度/), { target: { value: "50" } });
    fireEvent.change(within(form).getByLabelText("流量重置"), { target: { value: "days" } });
    fireEvent.change(within(form).getByLabelText("天数"), { target: { value: "30" } });
    fireEvent.change(within(form).getByLabelText(/限速/), { target: { value: "100" } });
    fireEvent.change(within(form).getByLabelText(/库存/), { target: { value: "50" } });
    fireEvent.change(within(form).getByLabelText(/说明/), { target: { value: "Fast\n- 100 Mbps" } });
    fireEvent.click(within(form).getByLabelText("仅限现有用户续费"));
    fireEvent.click(within(form).getByLabelText("eu"));
    fireEvent.click(within(form).getByLabelText("月付"));
    fireEvent.change(within(form).getByLabelText("月付 价格"), { target: { value: "9.9" } });
    fireEvent.click(within(form).getByLabelText(/上架/));
    fireEvent.click(within(form).getByRole("button", { name: "创建套餐" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
    const created = calls.find((c) => c.method === "POST");
    expect(created?.path).toBe("/plans");
    expect(created?.body).toEqual({
      name: "pro",
      period: "days-30",
      traffic_quota_bytes: 50 * GIB,
      group_ids: ["g2"],
      speed_limit_mbps: 100,
      capacity: 50,
      description: "Fast\n- 100 Mbps",
      renewal_only: true,
      pricing: { on_sale: true, prices: [{ period: "month", days: null, price_cents: 990 }] },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits fields and prices with one PATCH; prices are listed in catalogue order", async () => {
    const calls = fakeApi({
      "GET /node-groups": [],
      "GET /plans": [
        plan({
          prices: [
            { period: "reset", days: null, price_cents: 500 },
            { period: "month", days: null, price_cents: 990 },
          ],
          on_sale: true,
          capacity: 2,
        }),
      ],
      "GET /nodes": [],
      "PATCH /plans/p1": plan({}),
    });
    renderAdmin(<AdminPlans />);
    const month = await screen.findByText("月付 ¥9.90");
    const reset = screen.getByText(/流量重置包 ¥5.00/);
    expect(month.compareDocumentPosition(reset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("满员")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑 basic" }));
    const form = await screen.findByRole("form", { name: "编辑 basic" });
    fireEvent.click(within(form).getByLabelText("年付"));
    fireEvent.change(within(form).getByLabelText("年付 价格"), { target: { value: "99.00" } });
    fireEvent.change(within(form).getByLabelText(/限速/), { target: { value: "50" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(1);
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      speed_limit_mbps: 50,
      pricing: {
        on_sale: true,
        prices: [
          { period: "month", days: null, price_cents: 990 },
          { period: "year", days: null, price_cents: 9900 },
          { period: "reset", days: null, price_cents: 500 },
        ],
      },
    });
  });

  it("applies an edit to existing subscribers only when asked, after the impact preview", async () => {
    const calls = fakeApi({
      "GET /node-groups": [],
      "GET /plans": [plan({})],
      "GET /nodes": [],
      "POST /plans/p1/impact": { subscribers: 2, over_quota: 1 },
      "PATCH /plans/p1": plan({}),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminPlans />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 basic" }));
    const form = await screen.findByRole("form", { name: "编辑 basic" });
    fireEvent.change(within(form).getByLabelText(/限速/), { target: { value: "50" } });
    fireEvent.click(within(form).getByRole("checkbox", { name: /同时应用到现有用户（2 个订阅）/ }));
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(confirm.mock.calls[0][0]).toContain("同时应用到 2 个现有订阅，其中 1 人已超出新额度");
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
      speed_limit_mbps: 50,
      apply_to_existing: true,
    });
  });

  it("validates the dialog before sending", () => {
    const f = planForm(null);
    expect(planBody({ ...f, name: "" }, null)).toBe("请填写名称");
    expect(planBody({ ...f, name: "x", onSale: true }, null)).toBe("上架前至少设置一个流量重置包以外的价格");
    expect(planBody({ ...f, name: "x", speed: "0" }, null)).toBe("限速须为 1–100000 的整数（Mbps）");
    // Unchanged edit: only the pricing (the server applies it alone).
    const p = plan({});
    expect(planBody(planForm(p), p)).toEqual({ pricing: { on_sale: false, prices: [] } });
  });

  it("asks before disabling a plan", async () => {
    const calls = fakeApi({
      "GET /node-groups": [],
      "GET /plans": [plan({})],
      "GET /nodes": [],
      "PATCH /plans/p1": plan({ enabled: false }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAdmin(<AdminPlans />);
    fireEvent.click(await screen.findByRole("button", { name: "basic 的更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "停用" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([]);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "basic 的更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "停用" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }));
  });

  it("replaces a group's membership with PATCH entrance_ids", async () => {
    const calls = fakeApi({
      "GET /node-groups": [group({ entrance_ids: ["e-n1"] })],
      "GET /plans": [],
      "GET /nodes": [node("n1", "jp-1"), node("n2", "de-1")],
      "PATCH /node-groups/g1": group({ entrance_ids: ["e-n1", "e-n2"] }),
    });
    renderAdmin(<AdminPlans />);
    fireEvent.click(await screen.findByRole("button", { name: "成员" }));
    fireEvent.click(screen.getByLabelText("de-1 · 直连"));
    fireEvent.click(screen.getByRole("button", { name: "保存成员" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ entrance_ids: ["e-n1", "e-n2"] });
  });

  it("shows the server's refusal", async () => {
    fakeApi({
      "GET /node-groups": [],
      "GET /plans": [plan({})],
      "GET /nodes": [],
      "DELETE /plans/p1": () => ({
        status: 409,
        body: { error: "2 user(s) hold this plan", code: "plan.in_use", params: { active: 2 } },
      }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminPlans />);
    fireEvent.click(await screen.findByRole("button", { name: "basic 的更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect((await screen.findByRole("alert")).textContent).toContain("有 2 个用户正在使用此套餐");
  });
});

describe("Portal", () => {
  const myPlan: MyPlan = {
    plan: {
      name: "basic",
      traffic_quota_bytes: 100 * GIB,
      period: "days-30",
      speed_limit_mbps: 200,
      device_seats: null,
      starts_at: "2026-10-01T00:00:00Z",
      expires_at: null,
      period_anchor: "2026-10-01T00:00:00Z",
      last_reset_at: null,
      next_reset_at: "2026-10-31T00:00:00Z",
    },
    traffic_used_bytes: 5 * GIB,
    traffic_limit_bytes: 100 * GIB,
    expires_at: null,
    nodes: [
      { name: "jp-1", region: "Tokyo" },
      { name: "de-1", region: null },
    ],
  };

  it("shows plan, period, next reset and node names/regions", async () => {
    fakeApi({ "GET /me/plan": myPlan });
    renderWithClient(<PlanCard />);
    expect(await screen.findByText("basic")).toBeTruthy();
    expect(screen.getByText("Every 30 days")).toBeTruthy();
    expect(screen.getByText(new Date("2026-10-31T00:00:00Z").toLocaleDateString())).toBeTruthy();
    expect(screen.getByText("jp-1 · Tokyo")).toBeTruthy();
    expect(screen.getByText("de-1")).toBeTruthy();
    expect(screen.getByText("Never")).toBeTruthy();
    expect(screen.getByText("up to 200 Mbps")).toBeTruthy();
  });

  it("says so when there is no plan", async () => {
    fakeApi({ "GET /me/plan": { ...myPlan, plan: null, nodes: [] } });
    renderWithClient(<PlanCard />);
    expect(await screen.findByText("You have no active plan.")).toBeTruthy();
  });

  it("changes the password, and reports mismatches and server errors", async () => {
    let status = 400;
    const calls = fakeApi({
      "POST /me/password": () =>
        status === 204
          ? { status: 204 }
          : { status, body: { error: "invalid password", code: "account.invalid_password" } },
    });
    renderWithClient(<PasswordCard />);
    const fill = (cur: string, next: string, rep: string) => {
      fireEvent.change(screen.getByLabelText("Current password"), { target: { value: cur } });
      fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
      fireEvent.change(screen.getByLabelText("Repeat new password"), { target: { value: rep } });
      fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    };
    fill("old-password", "new-password-1", "new-password-2");
    expect((await screen.findByRole("alert")).textContent).toContain("do not match");
    expect(calls).toHaveLength(0);
    fill("wrong", "new-password-1", "new-password-1");
    expect((await screen.findByRole("alert")).textContent).toBe("The current password is not correct.");
    status = 204;
    fill("old-password", "new-password-1", "new-password-1");
    expect((await screen.findByRole("status")).textContent).toContain("Password changed");
    expect(calls.at(-1)?.body).toEqual({
      current_password: "old-password",
      new_password: "new-password-1",
    });
  });
});

describe("Portal in Chinese", () => {
  it("renders the plan card in the chosen language", async () => {
    fakeApi({
      "GET /me/plan": {
        plan: {
          name: "basic",
          traffic_quota_bytes: null,
          period: "monthly",
          speed_limit_mbps: null,
          device_seats: null,
          starts_at: "2026-10-01T00:00:00Z",
          expires_at: null,
          period_anchor: "2026-10-01T00:00:00Z",
          last_reset_at: null,
          next_reset_at: null,
        },
        traffic_used_bytes: 0,
        traffic_limit_bytes: null,
        expires_at: null,
        nodes: [],
      },
    });
    renderAdmin(<PlanCard />);
    expect(await screen.findByText("每月")).toBeTruthy();
    expect(screen.getByText("不限")).toBeTruthy();
    expect(screen.getByText("暂无可用节点。")).toBeTruthy();
  });
});
