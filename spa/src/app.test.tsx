import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminTarget, App } from "./app";
import { setLocale } from "./i18n";
import type { Me, TotpStatus } from "./lib/api";
import { loadPage } from "./lib/router";
import { fakeApi, renderWithClient } from "./test/harness";

vi.mock("./lib/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/router")>()),
  loadPage: vi.fn(),
}));

beforeEach(() => {
  window.history.pushState(null, "", "/app");
  vi.mocked(loadPage).mockClear();
});
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

describe("adminTarget", () => {
  it("keeps the sub-path of the portal URL an admin opened", () => {
    expect(adminTarget("/app")).toBe("/admin");
    expect(adminTarget("/app/")).toBe("/admin");
    expect(adminTarget("/app/nodes")).toBe("/admin/nodes");
    expect(adminTarget("/app/plans/extra")).toBe("/admin/plans/extra");
  });
});

describe("App session routing", () => {
  it("shows the login page when there is no session", async () => {
    fakeApi({ "GET /me": unauthorized, "GET /me/totp": unauthorized });
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("sends an enrollment session (require_admin_2fa) to the console, which owns the enrollment page", async () => {
    window.history.pushState(null, "", "/app/account");
    fakeApi({ "GET /me": unauthorized, "GET /me/totp": totp({ stage: "enroll", admin_2fa_required: true }) });
    renderWithClient(<App />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/admin/account"));
    expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
  });

  it("sends admin sessions to the console (a separate bundle) and renders no console itself", async () => {
    window.history.pushState(null, "", "/app/audit");
    fakeApi({ "GET /me": me("admin"), "GET /me/totp": totp({ enabled: true }) });
    renderWithClient(<App />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/admin/audit"));
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
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
});
