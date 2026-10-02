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
  email: null,
  email_verified: false,
  locale: "en",
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
const consoleRoutes = { "GET /users": [], "GET /plans": [], "GET /node-groups": [], "GET /nodes": [] };

describe("viewOf / loginTarget", () => {
  it("maps console paths to views", () => {
    expect(viewOf("/admin")).toBe("users");
    expect(viewOf("/admin/audit")).toBe("audit");
    expect(viewOf("/admin/plans/extra")).toBe("plans");
    expect(viewOf("/admin/nope")).toBe("users");
    expect(viewOf("/app/audit")).toBe("users");
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
    expect(await screen.findByRole("heading", { name: "用户" })).toBeTruthy();
    expect(screen.queryByText(/建议开启两步验证/)).toBeNull();
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
