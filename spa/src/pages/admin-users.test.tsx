import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PlanView, UserDetail, UserView } from "../lib/api";
import { fakeApi, renderAdmin } from "../test/harness";
import { AdminUsers, PAGE_SIZE, createUserBody, userPatch, userStatus, usersQuery } from "./admin-users";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GIB = 1024 ** 3;

const user = (over: Partial<UserView>): UserView => ({
  id: "u1",
  role: "user",
  enabled: true,
  traffic_limit_bytes: 100 * GIB,
  traffic_used_bytes: 5 * GIB,
  expires_at: null,
  created_at: "2026-10-01T00:00:00Z",
  disabled_reason: null,
  plan_id: null,
  plan_name: null,
  next_reset_at: null,
  email: "alice@example.com",
  email_verified: true,
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
  renew_off_sale: true,
  prices: [],
  group_ids: [],
  active_users: 0,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

async function manage(login: string) {
  const row = (await screen.findByRole("cell", { name: new RegExp(`^${login}`) })).closest("tr") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: /管理/ }));
}

const page = (users: UserView[], total = users.length) => ({ users, total });

const detail = (u: UserView, over: Partial<UserDetail> = {}): UserDetail => ({
  ...u,
  subscription: null,
  ban: null,
  ...over,
});

describe("userPatch", () => {
  it("sends only the role, and only when it changed (D12: no limit or expiry)", () => {
    const u = user({});
    expect(userPatch(u, { role: "user" })).toBeNull();
    expect(userPatch(u, { role: "admin" })).toEqual({ role: "admin" });
  });
});

describe("AdminUsers", () => {
  it("pages with the total and sends filters, search and sort", async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => user({ id: `u${i}`, email: `user-${i}@x.test` }));
    const calls = fakeApi({
      "GET /users": () => {
        const offset = Number(new URLSearchParams(calls.at(-1)?.search).get("offset"));
        return {
          status: 200,
          body: page(offset === 0 ? full : [user({ id: "last", email: "last-user@x.test" })], PAGE_SIZE + 1),
        };
      },
      "GET /plans": [plan({})],
    });
    renderAdmin(<AdminUsers />);
    expect(await screen.findByRole("cell", { name: /^user-0@x.test$/ })).toBeTruthy();
    const lists = () => calls.filter((c) => c.path === "/users");
    expect(lists()[0].search).toBe(`?limit=${PAGE_SIZE}&offset=0`);
    expect(screen.getByText(`共 ${PAGE_SIZE + 1} 个用户`)).toBeTruthy();
    const prev = screen.getByRole("button", { name: "上一页" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByRole("cell", { name: /^last-user@x.test$/ })).toBeTruthy();
    expect(lists().some((c) => c.search === `?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}`)).toBe(true);
    expect((screen.getByRole("button", { name: "下一页" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/第 2 \/ 2 页/)).toBeTruthy();
    // A filter chip starts at page 1 again.
    fireEvent.click(screen.getByRole("button", { name: "已到期" }));
    await waitFor(() => expect(lists().at(-1)?.search).toBe(`?limit=${PAGE_SIZE}&offset=0&status=expired`));
    expect(screen.getByRole("button", { name: "已到期" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.change(screen.getByLabelText("套餐"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "-traffic" } });
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "ali" } });
    await waitFor(() =>
      expect(lists().at(-1)?.search).toBe(`?limit=${PAGE_SIZE}&offset=0&q=ali&status=expired&plan_id=p1&sort=-traffic`),
    );
    expect(await screen.findByText(`找到 ${PAGE_SIZE + 1} 个用户`)).toBeTruthy();
  });

  it("shows an empty state", async () => {
    fakeApi({ "GET /users": page([]), "GET /plans": [] });
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText("还没有用户，点「新建用户」创建第一个。")).toBeTruthy();
  });

  it("creates a user in a dialog (email, plan + term) and shows the token once", async () => {
    const calls = fakeApi({
      "GET /users": page([]),
      "GET /plans": [plan({})],
      "POST /users": { ...user({ email: "bob@example.com" }), sub_token: "tok-1", sub_url: null },
    });
    renderAdmin(<AdminUsers />);
    fireEvent.click(await screen.findByRole("button", { name: "新建用户" }));
    const dialog = await screen.findByRole("dialog", { name: "新建用户" });
    fireEvent.change(within(dialog).getByLabelText("邮箱"), { target: { value: "bob@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("密码"), { target: { value: "password-1" } });
    fireEvent.change(within(dialog).getByLabelText("套餐"), { target: { value: "p1" } });
    fireEvent.change(within(dialog).getByLabelText("时长"), { target: { value: "days" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("天数须为 1–3650 的整数");
    fireEvent.change(within(dialog).getByLabelText("天数"), { target: { value: "30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(await screen.findByText("tok-1")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      email: "bob@example.com",
      password: "password-1",
      plan: { plan_id: "p1", period: "days", days: 30 },
    });
  });

  it("edits only the role; no limit, expiry or enable inputs (D12)", async () => {
    const calls = fakeApi({
      "GET /users": page([user({ enabled: false, disabled_reason: "quota" })]),
      "GET /plans": [],
      "GET /users/u1": detail(user({})),
      "PATCH /users/u1": user({}),
    });
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText("超出流量")).toBeTruthy();
    await manage("alice");
    const form = await screen.findByRole("form", { name: "编辑 alice@example.com" });
    expect(within(form).queryByLabelText(/流量上限/)).toBeNull();
    expect(within(form).queryByLabelText(/到期日/)).toBeNull();
    expect(within(form).queryByLabelText("启用")).toBeNull();
    fireEvent.change(within(form).getByLabelText("角色"), { target: { value: "admin" } });
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ role: "admin" });
    expect((await within(form).findByRole("status")).textContent).toBe("已保存。");
  });

  it("shows the current subscription and renews, extends, resets and cancels", async () => {
    const calls = fakeApi({
      "GET /users": page([user({ plan_id: "p1", plan_name: "basic" })]),
      "GET /plans": [plan({})],
      "GET /users/u1": detail(user({ plan_id: "p1", plan_name: "basic" }), {
        subscription: {
          user_plan_id: "up1",
          plan_id: "p1",
          plan_name: "basic",
          period: "month",
          period_days: null,
          starts_at: "2026-10-01T00:00:00Z",
          expires_at: "2026-11-01T00:00:00Z",
          traffic_used_bytes: 5 * GIB,
          traffic_total_bytes: 100 * GIB,
          reset_period: "monthly",
          last_reset_at: null,
          next_reset_at: "2026-11-01T00:00:00Z",
          speed_limit_mbps: null,
          status: "active",
        },
      }),
      "PATCH /users/u1/plan": { active: null, history: [] },
      "POST /users/u1/plan/reset-traffic": { subscription: null },
      "DELETE /users/u1/plan": () => ({ status: 204 }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminUsers />);
    await manage("alice");
    const form = await screen.findByRole("form", { name: "alice@example.com 的套餐" });
    expect(await within(form).findByText("月付")).toBeTruthy();
    expect(within(form).getByText("5.0 GiB / 100.0 GiB")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "续期一个时长" }));
    fireEvent.change(within(form).getByLabelText("延长天数"), { target: { value: "7" } });
    fireEvent.click(within(form).getByRole("button", { name: "延长" }));
    fireEvent.click(within(form).getByRole("button", { name: "重置流量" }));
    fireEvent.click(within(form).getByRole("button", { name: "取消套餐" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    const sent = calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]);
    expect(sent).toEqual([
      ["PATCH", "/users/u1/plan", { period: "month" }],
      ["PATCH", "/users/u1/plan", { extend_days: 7 }],
      ["POST", "/users/u1/plan/reset-traffic", { confirm: true }],
      ["DELETE", "/users/u1/plan", undefined],
    ]);
  });

  it("bans with a reason and unbans (W28-c)", async () => {
    const calls = fakeApi({
      "GET /users": page([
        user({}),
        user({ id: "u2", email: "bob@example.com", enabled: false, disabled_reason: "admin" }),
      ]),
      "GET /plans": [],
      "GET /users/u1": detail(user({})),
      "GET /users/u2": detail(user({ id: "u2", email: "bob@example.com", enabled: false, disabled_reason: "admin" }), {
        ban: { reason: "共享账号", banned_at: "2026-10-01T00:00:00Z", banned_by_id: "a1", banned_by_email: "ops@x" },
      }),
      "POST /users/u1/ban": detail(user({})),
      "POST /users/u2/unban": detail(user({ id: "u2" })),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderAdmin(<AdminUsers />);
    expect(await screen.findByText("已封禁")).toBeTruthy();
    await manage("alice");
    const ban = await screen.findByRole("form", { name: "封禁 alice@example.com" });
    fireEvent.click(within(ban).getByRole("button", { name: "封禁用户" }));
    expect((await within(ban).findByRole("alert")).textContent).toBe("请填写封禁原因（会显示给用户）。");
    fireEvent.change(within(ban).getByLabelText(/原因/), { target: { value: " 滥用 " } });
    fireEvent.click(within(ban).getByRole("button", { name: "封禁用户" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/users/u1/ban")).toBe(true));
    expect(calls.find((c) => c.path === "/users/u1/ban")?.body).toEqual({ reason: "滥用" });
    await manage("bob");
    const unban = await screen.findByRole("form", { name: "封禁 bob@example.com" });
    expect(await within(unban).findByText(/共享账号/)).toBeTruthy();
    fireEvent.click(within(unban).getByRole("button", { name: "解除封禁" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/users/u2/unban")).toBe(true));
  });

  it("asks before deleting, revoking sessions and regenerating the token", async () => {
    const calls = fakeApi({
      "GET /users": page([user({})]),
      "GET /plans": [],
      "GET /users/u1": detail(user({})),
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

  it("assigns a plan for a term (retired plans not offered)", async () => {
    const calls = fakeApi({
      "GET /users": page([user({})]),
      "GET /plans": [plan({}), plan({ id: "p2", name: "retired", enabled: false })],
      "GET /users/u1": detail(user({})),
      "PUT /users/u1/plan": { active: null, history: [] },
    });
    renderAdmin(<AdminUsers />);
    await manage("alice");
    const form = await screen.findByRole("form", { name: "alice@example.com 的套餐" });
    expect(await within(form).findByText("没有生效的套餐。")).toBeTruthy();
    expect(
      within(within(form).getByLabelText("套餐"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["basic"]);
    fireEvent.change(within(form).getByLabelText("时长"), { target: { value: "onetime" } });
    fireEvent.click(within(form).getByRole("button", { name: "分配套餐" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ plan_id: "p1", period: "onetime" });
  });
});

describe("userStatus / usersQuery / createUserBody", () => {
  const now = Date.parse("2026-10-02T00:00:00Z");
  it("derives the badge with the server's precedence", () => {
    expect(userStatus(user({}), now).label).toBe("正常");
    expect(userStatus(user({ expires_at: "2026-10-01T00:00:00Z" }), now).label).toBe("已到期");
    expect(userStatus(user({ role: "admin", expires_at: "2026-10-01T00:00:00Z" }), now).label).toBe("正常");
    expect(userStatus(user({ enabled: false, disabled_reason: "quota" }), now).label).toBe("超出流量");
    expect(
      userStatus(user({ enabled: false, disabled_reason: "admin", expires_at: "2026-10-01T00:00:00Z" }), now).label,
    ).toBe("已封禁");
  });
  it("leaves defaults out of the query", () => {
    expect(usersQuery({ q: " a ", status: "", plan: "", sort: "created", page: 2 })).toBe(
      `?limit=${PAGE_SIZE}&offset=${2 * PAGE_SIZE}&q=a`,
    );
  });
  it("validates the dialog", () => {
    const f = { password: "p", email: "x@y.test", role: "user", planId: "", term: "month" as const, days: "" };
    expect(createUserBody(f)).toEqual({ email: "x@y.test", password: "p" });
    expect(createUserBody({ ...f, planId: "p1" })).toEqual({
      email: "x@y.test",
      password: "p",
      plan: { plan_id: "p1", period: "month" },
    });
    expect(createUserBody({ ...f, planId: "p1", term: "onetime", days: "0" })).toBe("天数须为 1–3650 的整数");
    expect(createUserBody({ ...f, planId: "p1", term: "onetime", days: "7" })).toEqual({
      email: "x@y.test",
      password: "p",
      plan: { plan_id: "p1", period: "onetime", days: 7 },
    });
    // An admin gets no plan.
    expect(createUserBody({ ...f, role: "admin", planId: "p1" })).toEqual({
      email: "x@y.test",
      password: "p",
      role: "admin",
    });
  });
});
