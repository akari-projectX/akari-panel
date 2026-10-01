import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GroupView, MyPlan, NodeView, PlanView, UserView } from "../lib/api";
import { fakeApi, renderWithClient } from "../test/harness";
import { AdminPlans, periodValue, quotaBytes } from "./admin-plans";
import { AdminUsers } from "./admin-users";
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
  group_ids: ["g1"],
  active_users: 2,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

const node = (id: string, name: string) => ({ id, name }) as unknown as NodeView;

const user = (over: Partial<UserView>): UserView => ({
  id: "u1",
  login: "alice",
  role: "user",
  enabled: true,
  traffic_limit_bytes: 100 * GIB,
  traffic_used_bytes: 5 * GIB,
  expires_at: null,
  created_at: "2026-10-01T00:00:00Z",
  totp_enabled: false,
  disabled_reason: null,
  plan_id: null,
  plan_name: null,
  next_reset_at: null,
  ...over,
});

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
    renderWithClient(<AdminPlans />);
    expect(await screen.findByText("basic")).toBeTruthy();
    expect(screen.getByText("100.0 GB")).toBeTruthy();
    expect(screen.getByText("jp-1")).toBeTruthy();

    const form = screen.getByRole("form", { name: "New plan" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "pro" } });
    fireEvent.change(within(form).getByLabelText(/Quota/), { target: { value: "50" } });
    fireEvent.change(within(form).getByLabelText("Reset"), { target: { value: "days" } });
    fireEvent.change(within(form).getByLabelText("Days"), { target: { value: "30" } });
    fireEvent.change(within(form).getByLabelText(/Speed/), { target: { value: "100" } });
    fireEvent.click(within(form).getByLabelText("eu"));
    fireEvent.click(within(form).getByRole("button", { name: "Create plan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const created = calls.find((c) => c.method === "POST");
    expect(created?.path).toBe("/plans");
    expect(created?.body).toEqual({
      name: "pro",
      period: "days-30",
      traffic_quota_bytes: 50 * GIB,
      group_ids: ["g2"],
      speed_limit_mbps: 100,
    });
  });

  it("replaces a group's membership with PATCH node_ids", async () => {
    const calls = fakeApi({
      "GET /node-groups": [group({ node_ids: ["n1"] })],
      "GET /plans": [],
      "GET /nodes": [node("n1", "jp-1"), node("n2", "de-1")],
      "PATCH /node-groups/g1": group({ node_ids: ["n1", "n2"] }),
    });
    renderWithClient(<AdminPlans />);
    fireEvent.click(await screen.findByRole("button", { name: "Nodes" }));
    fireEvent.click(screen.getByLabelText("de-1"));
    fireEvent.click(screen.getByRole("button", { name: "Save nodes" }));
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
    renderWithClient(<AdminPlans />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect((await screen.findByRole("alert")).textContent).toContain("hold this plan");
  });
});

describe("AdminUsers plan column", () => {
  it("shows plan, reset date, disable reason, and assigns a plan", async () => {
    const calls = fakeApi({
      "GET /users": [
        user({ plan_id: "p1", plan_name: "basic", next_reset_at: "2026-11-01T00:00:00Z" }),
        user({ id: "u2", login: "bob", enabled: false, disabled_reason: "quota" }),
      ],
      "GET /plans": [plan({}), plan({ id: "p2", name: "retired", enabled: false })],
      "PUT /users/u2/plan": { active: null, history: [] },
    });
    renderWithClient(<AdminUsers />);
    expect(await screen.findByText("disabled (quota)")).toBeTruthy();
    expect(screen.getAllByText("basic").length).toBeGreaterThan(0);
    const bob = screen.getByText("bob").closest("tr") as HTMLElement;
    fireEvent.click(within(bob).getByRole("button", { name: "Plan" }));
    const form = await screen.findByRole("form", { name: "Plan of bob" });
    // Retired plans are not offered.
    const options = within(form).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["basic"]);
    fireEvent.click(within(form).getByLabelText("Reset usage"));
    fireEvent.click(within(form).getByRole("button", { name: "Assign plan" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      plan_id: "p1",
      reset_traffic: true,
    });
  });

  it("cancels a plan", async () => {
    const calls = fakeApi({
      "GET /users": [user({ plan_id: "p1", plan_name: "basic" })],
      "GET /plans": [plan({})],
      "DELETE /users/u1/plan": () => ({ status: 204 }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithClient(<AdminUsers />);
    fireEvent.click(await screen.findByRole("button", { name: "Plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel plan" }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/users/u1/plan")).toBe(true),
    );
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
        status === 204 ? { status: 204 } : { status, body: { error: "invalid password" } },
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
    expect((await screen.findByRole("alert")).textContent).toContain("invalid password");
    status = 204;
    fill("old-password", "new-password-1", "new-password-1");
    expect((await screen.findByRole("status")).textContent).toContain("Password changed");
    expect(calls.at(-1)?.body).toEqual({
      current_password: "old-password",
      new_password: "new-password-1",
    });
  });
});
