import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdminApp, loginTarget, viewOf } from "./admin-app";
import type { Me, TotpStatus } from "./lib/api";
import { loadPage } from "./lib/router";
import { fakeApi, renderWithClient } from "./test/harness";

vi.mock("./lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/router")>()),
  loadPage: vi.fn(),
}));

beforeEach(() => {
  window.history.pushState(null, "", "/admin");
  vi.mocked(loadPage).mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const me = (role: string): Me => ({
  id: `${role}-id`,
  login: role === "admin" ? "root" : "alice",
  role,
  traffic_used_bytes: 0,
  traffic_limit_bytes: null,
  expires_at: null,
  expired: false,
  quota_exhausted: false,
  banned: false,
  ban_reason: null,
  banned_at: null,
  email: null,
  email_verified: false,
  locale: "en",
  sub_token: null,
  sub_url: null,
  sub_legacy: false,
  probe_interval_secs: 18000,
});
const totp = (over: Partial<TotpStatus>): TotpStatus => ({
  id: "admin-id",
  login: "root",
  role: "admin",
  stage: "full",
  enabled: false,
  pending: false,
  recovery_codes_left: 0,
  admin_2fa_required: false,
  ...over,
});
const unauthorized = () => ({ status: 401, body: { error: "unauthorized" } });
const dashboard = {
  at: "2026-10-02T06:00:00Z",
  today_start: "2026-10-01T16:00:00Z",
  today: { revenue_cents: 1990, orders: 2, refunds_cents: 0, signups: 3 },
  d7: { revenue_cents: 9900, orders: 10, refunds_cents: 100, signups: 12 },
  d30: { revenue_cents: 39900, orders: 40, refunds_cents: 100, signups: 50 },
  users_total: 120,
  subscribers: 80,
  online_users: 33,
  nodes: { total: 4, online: 3, offline: 1, disabled: 0, pending: 0, alerting: 1 },
  pending: { tickets_open: 2, withdrawals: 0, mail_failed: 1, orders_unfulfilled: 0, alerts_firing: 1 },
  traffic_days: [{ day: "2026-10-01", up_bytes: 1024, down_bytes: 4096, billed_bytes: 5120, users: 3 }],
  traffic_top_nodes: [{ node_id: "n1", name: "香港 01", up_bytes: 1024, down_bytes: 4096, billed_bytes: 5120 }],
  latest_orders: [
    {
      id: "o1",
      out_trade_no: "AK1",
      user_login: "alice",
      plan_name: "basic",
      amount_cents: 990,
      status: "paid",
      created_at: "2026-10-02T05:00:00Z",
      paid_at: "2026-10-02T05:01:00Z",
    },
  ],
};
const consoleRoutes = {
  "GET /users": { users: [], total: 0 },
  "GET /plans": [],
  "GET /node-groups": [],
  "GET /nodes": [],
  "GET /dashboard": dashboard,
  "GET /auth/options": { register: false, invite_required: false, email_domains: [], reset: false, site_name: "星云" },
};

describe("viewOf / loginTarget", () => {
  it("maps console paths to views", () => {
    expect(viewOf("/admin")).toBe("dashboard");
    expect(viewOf("/admin/audit")).toBe("audit");
    expect(viewOf("/admin/plans/extra")).toBe("plans");
    expect(viewOf("/admin/nope")).toBe("dashboard");
    expect(viewOf("/app/audit")).toBe("dashboard");
    expect(viewOf("/admin/users")).toBe("users");
    for (const v of ["nodes", "orders", "updates", "settings", "account"]) expect(viewOf(`/admin/${v}`)).toBe(v);
  });
  it("sends an ended session to the login page, keeping the view", () => {
    expect(loginTarget("/admin")).toBe("/app");
    expect(loginTarget("/admin/nodes")).toBe("/app/nodes");
  });
});

describe("AdminApp", () => {
  it("is Chinese; deep links, nav and back button follow the URL", async () => {
    window.history.pushState(null, "", "/admin/audit");
    fakeApi({
      "GET /me": me("admin"),
      "GET /me/totp": totp({ enabled: true }),
      "GET /audit": { entries: [], next_before: null },
      ...consoleRoutes,
    });
    renderWithClient(<AdminApp />);
    expect(await screen.findByRole("heading", { name: "审计日志" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(screen.getByRole("link", { name: "审计" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "套餐" }).getAttribute("href")).toBe("/admin/plans");
    fireEvent.click(screen.getByRole("link", { name: "套餐" }));
    expect(window.location.pathname).toBe("/admin/plans");
    expect(await screen.findByRole("heading", { name: "套餐" })).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/admin/audit"));
    expect(await screen.findByRole("heading", { name: "审计日志" })).toBeTruthy();
    expect(screen.queryByText(/建议开启两步验证/)).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("recommends 2FA to an admin without it; the banner can be dismissed for good", async () => {
    fakeApi({ "GET /me": me("admin"), "GET /me/totp": totp({}), ...consoleRoutes });
    const view = renderWithClient(<AdminApp />);
    expect(await screen.findByText(/建议开启两步验证/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "去设置" }).getAttribute("href")).toBe("/admin/account");
    fireEvent.click(screen.getByRole("button", { name: "不再提示两步验证建议" }));
    expect(screen.queryByText(/建议开启两步验证/)).toBeNull();
    view.unmount();
    renderWithClient(<AdminApp />);
    expect(await screen.findByRole("heading", { name: "仪表盘" })).toBeTruthy();
    expect(screen.queryByText(/建议开启两步验证/)).toBeNull();
  });

  it("lands on the dashboard: figures, pending work, latest orders and the title", async () => {
    fakeApi({ "GET /me": me("admin"), "GET /me/totp": totp({ enabled: true }), ...consoleRoutes });
    renderWithClient(<AdminApp />);
    expect(await screen.findByRole("heading", { name: "仪表盘" })).toBeTruthy();
    expect(await screen.findByText("¥19.90")).toBeTruthy();
    expect(screen.getByText("3 / 4")).toBeTruthy();
    expect(screen.getByRole("link", { name: "香港 01" }).getAttribute("href")).toBe("/admin/nodes/n1");
    expect(screen.getByRole("link", { name: /待回复工单\s*2/ }).getAttribute("href")).toBe("/admin/tickets");
    expect(screen.getByRole("link", { name: /发送失败的邮件\s*1/ }).getAttribute("href")).toBe(
      "/admin/settings/failed-mail",
    );
    expect(screen.getByText("2026-10-02 13:00")).toBeTruthy(); // Beijing time
    await waitFor(() => expect(document.title).toBe("仪表盘 · 星云 管理后台"));
    expect(screen.getByText("星云 管理后台")).toBeTruthy();
  });

  it("shows the enrollment page for an enrollment session (require_admin_2fa)", async () => {
    fakeApi({ "GET /me": unauthorized, "GET /me/totp": totp({ stage: "enroll", admin_2fa_required: true }) });
    renderWithClient(<AdminApp />);
    expect(await screen.findByRole("heading", { name: "需要开启两步验证" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("an ended session goes back to the login page with the view kept", async () => {
    window.history.pushState(null, "", "/admin/nodes");
    fakeApi({ "GET /me": unauthorized, "GET /me/totp": unauthorized });
    renderWithClient(<AdminApp />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/app/nodes"));
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("a non-admin session never sees the console", async () => {
    fakeApi({ "GET /me": me("user"), ...consoleRoutes });
    renderWithClient(<AdminApp />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/app"));
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("logs out into the portal's login page", async () => {
    const calls = fakeApi({
      "GET /me": me("admin"),
      "GET /me/totp": totp({ enabled: true }),
      "POST /auth/logout": () => ({ status: 204 }),
      ...consoleRoutes,
    });
    renderWithClient(<AdminApp />);
    fireEvent.click(await screen.findByRole("button", { name: "退出登录" }));
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/app"));
    expect(calls.some((c) => c.method === "POST" && c.path === "/auth/logout")).toBe(true);
  });
});
