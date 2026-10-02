import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GroupView, MyPlan, NodeView, PlanView } from "../lib/api";
import { fakeApi, renderAdmin, renderWithClient } from "../test/harness";
import { AdminPlans, optionalInt, periodValue, pricesBody, quotaBytes } from "./admin-plans";
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
  node_ids: [],
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

const node = (id: string, name: string) => ({ id, name }) as unknown as NodeView;

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
  it("lists plans and groups, and creates a plan with the right body", async () => {
    const calls = fakeApi({
      "GET /node-groups": [group({ node_ids: ["n1"], plan_ids: ["p1"] }), group({ id: "g2", name: "eu" })],
      "GET /plans": [plan({})],
      "GET /nodes": [node("n1", "jp-1"), node("n2", "de-1")],
      "POST /plans": () => ({ status: 201, body: plan({ id: "p2", name: "pro" }) }),
    });
    renderAdmin(<AdminPlans />);
    expect(await screen.findByText("basic")).toBeTruthy();
    expect(screen.getByText("100.0 GiB")).toBeTruthy();
    expect(screen.getByText("jp-1")).toBeTruthy();

    const form = screen.getByRole("form", { name: "新建套餐" });
    fireEvent.change(within(form).getByLabelText("名称"), { target: { value: "pro" } });
    fireEvent.change(within(form).getByLabelText(/流量额度/), { target: { value: "50" } });
    fireEvent.change(within(form).getByLabelText("流量重置"), { target: { value: "days" } });
    fireEvent.change(within(form).getByLabelText("天数"), { target: { value: "30" } });
    fireEvent.change(within(form).getByLabelText(/限速/), { target: { value: "100" } });
    fireEvent.change(within(form).getByLabelText(/库存/), { target: { value: "50" } });
    fireEvent.change(within(form).getByLabelText(/说明/), { target: { value: "Fast\n- 100 Mbps" } });
    fireEvent.click(within(form).getByLabelText("仅限现有用户续费"));
    fireEvent.click(within(form).getByLabelText("eu"));
    fireEvent.click(within(form).getByRole("button", { name: "创建套餐" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
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
    });
  });

  it("sets per-period prices and the sale flag with PUT /prices", async () => {
    const calls = fakeApi({
      "GET /node-groups": [],
      "GET /plans": [plan({ prices: [{ period: "month", days: null, price_cents: 990 }], on_sale: true, capacity: 2 })],
      "GET /nodes": [],
      "PUT /plans/p1/prices": { status: 204 },
    });
    renderAdmin(<AdminPlans />);
    expect(await screen.findByText("月付 ¥9.90")).toBeTruthy();
    expect(screen.getByText("满员")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "定价" }));
    const form = screen.getByRole("form", { name: "定价 basic" });
    fireEvent.click(within(form).getByLabelText("年付"));
    fireEvent.change(within(form).getByLabelText("basic 年付 价格"), { target: { value: "99.00" } });
    fireEvent.click(within(form).getByLabelText("流量重置包"));
    fireEvent.change(within(form).getByLabelText("basic 流量重置包 价格"), { target: { value: "5" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存定价" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      on_sale: true,
      prices: [
        { period: "month", days: null, price_cents: 990 },
        { period: "year", days: null, price_cents: 9900 },
        { period: "reset", days: null, price_cents: 500 },
      ],
    });
  });

  it("marks device seats as not yet enforced", async () => {
    fakeApi({ "GET /node-groups": [], "GET /plans": [], "GET /nodes": [] });
    renderAdmin(<AdminPlans />);
    expect(await screen.findByLabelText("设备数（客户端上线后生效）")).toBeTruthy();
  });

  it("replaces a group's membership with PATCH node_ids", async () => {
    const calls = fakeApi({
      "GET /node-groups": [group({ node_ids: ["n1"] })],
      "GET /plans": [],
      "GET /nodes": [node("n1", "jp-1"), node("n2", "de-1")],
      "PATCH /node-groups/g1": group({ node_ids: ["n1", "n2"] }),
    });
    renderAdmin(<AdminPlans />);
    fireEvent.click(await screen.findByRole("button", { name: "成员" }));
    fireEvent.click(screen.getByLabelText("de-1"));
    fireEvent.click(screen.getByRole("button", { name: "保存成员" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ node_ids: ["n1", "n2"] });
  });

  it("shows the server's refusal", async () => {
    fakeApi({
      "GET /node-groups": [],
      "GET /plans": [plan({})],
      "GET /nodes": [],
      "DELETE /plans/p1": () => ({ status: 409, body: { error: "2 user(s) hold this plan" } }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminPlans />);
    fireEvent.click(await screen.findByRole("button", { name: "删除" }));
    expect((await screen.findByRole("alert")).textContent).toContain("hold this plan");
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
      "POST /me/password": () => (status === 204 ? { status: 204 } : { status, body: { error: "invalid password" } }),
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
