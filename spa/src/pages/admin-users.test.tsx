import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanView, UserNodeView, UserView } from "../lib/api";
import { fakeApi, renderAdmin } from "../test/harness";
import { AdminUsers, PAGE_SIZE, userPatch } from "./admin-users";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GIB = 1024 ** 3;

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

const plan = (over: Partial<PlanView>): PlanView => ({
  id: "p1",
  name: "basic",
  traffic_quota_bytes: 100 * GIB,
  period: "monthly",
  speed_limit_mbps: null,
  device_seats: null,
  sort: 0,
  enabled: true,
  group_ids: [],
  active_users: 0,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

async function manage(login: string) {
  const row = (await screen.findByRole("cell", { name: login })).closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /管理/ }));
}

describe("userPatch", () => {
  const u = user({ expires_at: "2026-12-31T00:00:00Z" });
  const same = { role: "user", enabled: true, limitGib: "100", expires: "2026-12-31" };

  it("sends only changed fields", () => {
    expect(userPatch(u, same)).toBeNull();
    expect(userPatch(u, { ...same, limitGib: "" })).toEqual({ traffic_limit_bytes: null });
    expect(userPatch(u, { ...same, limitGib: "1.5", expires: "" })).toEqual({
      traffic_limit_bytes: Math.round(1.5 * GIB),
      expires_at: null,
    });
    expect(userPatch(u, { ...same, role: "admin", enabled: false })).toEqual({ role: "admin", enabled: false });
    expect(userPatch(u, { ...same, limitGib: "-1" })).toBe("bad-limit");
  });

  it("never sends plan-managed limit or expiry", () => {
    const managed = user({ plan_id: "p1", plan_name: "basic" });
    expect(userPatch(managed, { role: "user", enabled: true, limitGib: "1", expires: "2030-01-01" })).toBeNull();
  });
});

describe("AdminUsers", () => {
  it("pages with limit/offset and stops at a short page", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => user({ id: `u${i}`, login: `user-${i}` }));
    const calls = fakeApi({
      "GET /users": () => {
        const offset = Number(new URLSearchParams(calls.at(-1)?.search).get("offset"));
        return { status: 200, body: offset === 0 ? full : [user({ id: "last", login: "last-user" })] };
      },
      "GET /plans": [],
    });
    renderAdmin(<AdminUsers />);
    expect(await screen.findByRole("cell", { name: "user-0" })).toBeTruthy();
    expect(calls[0].search).toBe(`?limit=${PAGE_SIZE}&offset=0`);
    const prev = screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("cell", { name: "last-user" })).toBeTruthy();
    expect(calls.some((c) => c.search === `?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}`)).toBe(true);
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/第 2 页/)).toBeTruthy();
  });

  it("shows an empty state", async () => {
    fakeApi({ "GET /users": [], "GET /plans": [] });
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText("还没有用户，在上方创建第一个。")).toBeTruthy();
  });

  it("edits limit, expiry and enabled with one PATCH of the changes", async () => {
    const calls = fakeApi({
      "GET /users": [user({ enabled: false, disabled_reason: "quota" })],
      "GET /plans": [],
      "GET /users/u1/nodes": [],
      "PATCH /users/u1": user({}),
    });
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText("停用（超出流量）")).toBeTruthy();
    await manage("alice");
    const form = await screen.findByRole("form", { name: "编辑 alice" });
    fireEvent.change(within(form).getByLabelText(/流量上限/), { target: { value: "200" } });
    fireEvent.change(within(form).getByLabelText(/到期日/), { target: { value: "2027-01-31" } });
    fireEvent.click(within(form).getByLabelText("启用"));
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      enabled: true,
      traffic_limit_bytes: 200 * GIB,
      expires_at: "2027-01-31T00:00:00.000Z",
    });
    expect((await within(form).findByRole("status")).textContent).toBe("已保存。");
  });

  it("locks plan-managed fields and explains the plan-cancel rule", async () => {
    fakeApi({
      "GET /users": [user({ plan_id: "p1", plan_name: "basic" })],
      "GET /plans": [plan({})],
      "GET /users/u1/nodes": [],
    });
    renderAdmin(<AdminUsers />);
    await manage("alice");
    const form = await screen.findByRole("form", { name: "编辑 alice" });
    expect((within(form).getByLabelText(/流量上限/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText(/沿用上一个套餐/).length).toBeGreaterThan(0);
  });

  it("shows the account's node access without credentials", async () => {
    const nodes: UserNodeView[] = [
      {
        node_id: "n1",
        name: "tokyo-1",
        region: "Tokyo",
        enabled: true,
        status: "online",
        deleting: false,
        manual: false,
        inbounds: [{ tag: "in-vless", protocol: "vless" }],
      },
    ];
    fakeApi({ "GET /users": [user({})], "GET /plans": [], "GET /users/u1/nodes": nodes });
    renderAdmin(<AdminUsers />);
    await manage("alice");
    const section = await screen.findByRole("region", { name: "alice 的节点权限" });
    expect(await within(section).findByText("tokyo-1")).toBeTruthy();
    expect(within(section).getByText("在线")).toBeTruthy();
    expect(within(section).getByText("in-vless（vless）")).toBeTruthy();
    expect(within(section).getByText("套餐")).toBeTruthy();
  });

  it("asks before deleting, revoking sessions and regenerating the token", async () => {
    const calls = fakeApi({
      "GET /users": [user({})],
      "GET /plans": [],
      "GET /users/u1/nodes": [],
      "DELETE /users/u1": () => ({ status: 204 }),
      "POST /users/u1/revoke-sessions": () => ({ status: 204 }),
      "POST /users/u1/sub-token": { sub_token: "tok-123" },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderAdmin(<AdminUsers />);
    await manage("alice");
    for (const name of ["删除用户", "吊销会话", "重新生成订阅令牌"]) {
      fireEvent.click(await screen.findByRole("button", { name }));
    }
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "吊销会话" }));
    expect((await screen.findByRole("status")).textContent).toBe("已吊销该用户的全部会话。");
    fireEvent.click(screen.getByRole("button", { name: "重新生成订阅令牌" }));
    expect(await screen.findByText("tok-123")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "删除用户" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.path === "/users/u1")).toBe(true));
  });

  it("resets 2FA of an account that has it, with a localized server error", async () => {
    fakeApi({
      "GET /users": [user({ role: "admin", totp_enabled: true })],
      "GET /plans": [],
      "DELETE /users/u1/totp": () => ({ status: 409, body: { error: "cannot remove the last enabled admin" } }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminUsers />);
    await manage("alice");
    // Admins have no plan and no node access.
    expect(screen.queryByRole("region", { name: "alice 的节点权限" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "重置两步验证" }));
    expect((await screen.findByRole("alert")).textContent).toBe("不能移除最后一个启用的管理员");
  });

  it("assigns a plan (retired plans not offered)", async () => {
    const calls = fakeApi({
      "GET /users": [user({})],
      "GET /plans": [plan({}), plan({ id: "p2", name: "retired", enabled: false })],
      "GET /users/u1/nodes": [],
      "PUT /users/u1/plan": { active: null, history: [] },
    });
    renderAdmin(<AdminUsers />);
    await manage("alice");
    const form = await screen.findByRole("form", { name: "alice 的套餐" });
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["basic"]);
    fireEvent.click(within(form).getByLabelText("清零已用流量"));
    fireEvent.click(within(form).getByRole("button", { name: "分配套餐" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ plan_id: "p1", reset_traffic: true });
  });
});
