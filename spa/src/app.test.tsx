import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App, viewOf } from "./app";
import { setLocale } from "./i18n";
import type { Me, TotpStatus } from "./lib/api";
import { fakeApi, renderWithClient } from "./test/harness";

beforeEach(() => window.history.pushState(null, "", "/app/"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  act(() => setLocale("en"));
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

describe("viewOf", () => {
  it("maps paths to admin views", () => {
    expect(viewOf("/app/")).toBe("users");
    expect(viewOf("/app/audit")).toBe("audit");
    expect(viewOf("/app/plans/extra")).toBe("plans");
    expect(viewOf("/app/nope")).toBe("users");
    for (const v of ["nodes", "orders", "updates", "account"]) expect(viewOf(`/app/${v}`)).toBe(v);
  });
});

describe("App session routing", () => {
  it("shows the login page when there is no session", async () => {
    fakeApi({ "GET /me": unauthorized, "GET /me/totp": unauthorized });
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("shows the enrollment page only for an enrollment session (require_admin_2fa)", async () => {
    fakeApi({ "GET /me": unauthorized, "GET /me/totp": totp({ stage: "enroll", admin_2fa_required: true }) });
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { name: "需要开启两步验证" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("users get the portal in their language", async () => {
    fakeApi({
      "GET /me": me("user"),
      "GET /me/plan": { plan: null, nodes: [] },
      "GET /me/totp": totp({ role: "user" }),
    });
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { name: "My account" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "中文" }));
    expect(await screen.findByRole("heading", { name: "我的账户" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("expired users (R21) see the renewal notice, not the subscription or 2FA cards", async () => {
    const calls = fakeApi({
      "GET /me": { ...me("user"), expires_at: "2026-01-01T00:00:00Z", expired: true },
      "GET /me/plan": { plan: null, nodes: [] },
    });
    renderWithClient(<App />);
    expect(await screen.findByText(/Your account has expired/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Password" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Subscription link" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Two-factor authentication" })).toBeNull();
    expect(calls.some((c) => c.path === "/me/totp")).toBe(false);
  });

  it("quota-disabled users (R21) get the same renewal scope", async () => {
    fakeApi({
      "GET /me": { ...me("user"), quota_exhausted: true },
      "GET /me/plan": { plan: null, nodes: [] },
    });
    renderWithClient(<App />);
    expect(await screen.findByText(/used up your traffic/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Subscription link" })).toBeNull();
  });

  it("admins get the Chinese console; deep links, nav and back button follow the URL", async () => {
    window.history.pushState(null, "", "/app/audit");
    fakeApi({
      "GET /me": me("admin"),
      "GET /me/totp": totp({ enabled: true }),
      "GET /audit": { entries: [], next_before: null },
      ...consoleRoutes,
    });
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { name: "审计日志" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "审计" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("link", { name: "套餐" }));
    expect(window.location.pathname).toBe("/app/plans");
    expect(await screen.findByRole("heading", { name: "套餐" })).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(window.location.pathname).toBe("/app/audit"));
    expect(await screen.findByRole("heading", { name: "审计日志" })).toBeTruthy();
    expect(screen.queryByText(/建议开启两步验证/)).toBeNull();
  });

  it("recommends 2FA to an admin without it; the banner can be dismissed for good", async () => {
    fakeApi({ "GET /me": me("admin"), "GET /me/totp": totp({}), ...consoleRoutes });
    const view = renderWithClient(<App />);
    expect(await screen.findByText(/建议开启两步验证/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "不再提示两步验证建议" }));
    expect(screen.queryByText(/建议开启两步验证/)).toBeNull();
    view.unmount();
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { name: "用户" })).toBeTruthy();
    expect(screen.queryByText(/建议开启两步验证/)).toBeNull();
  });
});
