import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { adminTarget, App } from "./app";
import { setLocale } from "./i18n";
import type { Me } from "./lib/api";
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
  role,
  traffic_used_bytes: 0,
  traffic_limit_bytes: null,
  expires_at: null,
  expired: false,
  quota_exhausted: false,
  email: role === "admin" ? "root@example.com" : "alice@example.com",
  email_verified: false,
  locale: "en",
  sub_token: null,
  sub_url: null,
  sub_legacy: false,
  probe_interval_secs: 18000,
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
    fakeApi({ "GET /me": unauthorized });
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("sends admin sessions to the console (a separate bundle) and renders no console itself", async () => {
    window.history.pushState(null, "", "/app/audit");
    fakeApi({ "GET /me": me("admin") });
    renderWithClient(<App />);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith("/admin/audit"));
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("users get the portal in their language", async () => {
    fakeApi({
      "GET /me": me("user"),
      "GET /me/plan": { plan: null, nodes: [] },
    });
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
    expect(document.title).toBe("Dashboard · Akari");
    fireEvent.click(screen.getAllByRole("button", { name: "中文" })[0]);
    expect(await screen.findByRole("heading", { level: 1, name: "仪表盘" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(document.title).toBe("仪表盘 · Akari");
  });

  it("expired users (R21) see the renewal notice with a call to action, not the subscription", async () => {
    fakeApi({
      "GET /me": { ...me("user"), expires_at: "2026-01-01T00:00:00Z", expired: true },
      "GET /me/plan": { plan: null, nodes: [] },
      "GET /me/shop": { enabled: false, current: null, credit_cents: 0, balance_cents: 0, coupon: null, plans: [] },
    });
    renderWithClient(<App />);
    expect(await screen.findByText(/Your account has expired/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Subscription link" })).toBeNull();
    // No node view for the renewal scope (the endpoint refuses it).
    expect(screen.queryByRole("link", { name: "Nodes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Renew now" }));
    expect(location.pathname).toBe("/app/shop");
    expect(await screen.findByRole("heading", { level: 1, name: "Buy a plan" })).toBeTruthy();
    // Account settings: the password can be changed.
    fireEvent.click(screen.getAllByRole("link", { name: "Account settings" })[0]);
    expect(await screen.findByRole("heading", { name: "Password" })).toBeTruthy();
  });

  it("quota-disabled users (R21) get the same renewal scope and a reset-pack call to action", async () => {
    fakeApi({
      "GET /me": { ...me("user"), quota_exhausted: true },
      "GET /me/plan": { plan: null, nodes: [] },
    });
    renderWithClient(<App />);
    expect(await screen.findByText(/used up your traffic/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Buy a traffic reset pack" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Subscription link" })).toBeNull();
  });
});

// W20 (M1): one URL per view; the nav and Back move between them.
describe("portal views", () => {
  const routes = {
    "GET /me": { ...me("user"), sub_token: "T".repeat(43), probe_interval_secs: 600 },
    "GET /me/plan": { plan: null, nodes: [] },
    "GET /me/nodes": [],
    "GET /me/orders": [],
    "GET /me/tickets": [],
    "GET /me/shop": { enabled: false, current: null, credit_cents: 0, balance_cents: 0, coupon: null, plans: [] },
  };

  it.each([
    ["/app/shop", "Buy a plan"],
    ["/app/nodes", "Nodes"],
    ["/app/orders", "Orders"],
    ["/app/tickets", "Tickets"],
    ["/app/nowhere", "Dashboard"],
  ])("deep link %s opens %s", async (path, heading) => {
    window.history.pushState(null, "", path);
    fakeApi(routes);
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
  });

  it("navigates with the nav (current page marked) and Back", async () => {
    fakeApi(routes);
    renderWithClient(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
    // The subscription link is on the dashboard, permanently.
    expect(((await screen.findByLabelText("Subscription link")) as HTMLInputElement).value).toBe(
      `${location.origin}/sub/${"T".repeat(43)}`,
    );
    const navs = screen.getAllByRole("navigation", { name: "Main navigation" });
    expect(navs).toHaveLength(2); // desktop top nav + phone tab bar
    const orders = screen.getAllByRole("link", { name: /Orders/ })[0];
    expect(orders.getAttribute("href")).toBe("/app/orders");
    fireEvent.click(orders);
    expect(location.pathname).toBe("/app/orders");
    expect(await screen.findByRole("heading", { level: 1, name: "Orders" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Orders/ })[0].getAttribute("aria-current")).toBe("page");
    expect(document.title).toBe("Orders · Akari");
    act(() => window.history.back());
    expect(await screen.findByRole("heading", { level: 1, name: "Dashboard" })).toBeTruthy();
  });
});
