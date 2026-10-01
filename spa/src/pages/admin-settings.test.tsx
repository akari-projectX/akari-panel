import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeApi, renderWithClient } from "../test/harness";
import { AdminSettings, hostOf, hostStillAllowed, type SettingsView } from "./admin-settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  version: 3,
  updated_at: null,
  main: { value: null, display: null, effective: null, source: "browser", config: null },
  sub: { value: null, display: null, effective: null, source: "browser", config: null },
  node: {
    value: null,
    display: null,
    panel_addr: "127.0.0.1:8443",
    server_name: "localhost",
    source: "config",
    config_addr: "127.0.0.1:8443",
    config_server_name: "localhost",
  },
  trust_cloudflare: { value: null, effective: false, source: "config", config: false },
  server_names: [
    {
      name: "localhost",
      display: "localhost",
      source: "config",
      first_used_at: "",
      current: true,
      locked: "配置文件",
      nodes: [],
    },
    {
      name: "old.example.com",
      display: "old.example.com",
      source: "settings",
      first_used_at: "",
      current: false,
      locked: null,
      nodes: [{ id: "n1", name: "tokyo", reason: "enrolled" }],
    },
  ],
  legacy_nodes: [],
  certificate_names: ["localhost", "old.example.com"],
  hot_reload: true,
  host_gate: false,
  ask_enabled: true,
  cloudflare_ranges: 22,
  warnings: [],
  ...over,
});

describe("host helpers", () => {
  it("strips ports and brackets", () => {
    expect(hostOf("Panel.Example.com:8443")).toBe("panel.example.com");
    expect(hostOf("[2001:db8::1]:443")).toBe("2001:db8::1");
  });
  it("matches the backend host gate", () => {
    expect(hostStillAllowed("old.example.com", "", "")).toBe(true);
    expect(hostStillAllowed("203.0.113.5", "panel.example.com", "")).toBe(true);
    expect(hostStillAllowed("panel.example.com", "panel.example.com:8443", "")).toBe(true);
    expect(hostStillAllowed("sub.example.com", "panel.example.com", "sub.example.com")).toBe(true);
    expect(hostStillAllowed("old.example.com", "panel.example.com", "sub.example.com")).toBe(false);
  });
});

describe("AdminSettings", () => {
  it("saves all four values and shows warnings", async () => {
    const calls = fakeApi({
      "GET /settings": view(),
      "PUT /settings": () => ({
        status: 200,
        body: view({ version: 4, warnings: ["订阅域名看起来没有经过 Cloudflare"] }),
      }),
    });
    renderWithClient(<AdminSettings />);
    // jsdom runs on "localhost": setting a main domain would need the
    // host-change confirmation (covered below), so only the others here.
    fireEvent.change(await screen.findByLabelText("订阅域名"), { target: { value: "sub.example.com" } });
    fireEvent.change(screen.getByLabelText("信任 Cloudflare"), { target: { value: "on" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText("订阅域名看起来没有经过 Cloudflare");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({
      version: 3,
      main_domain: null,
      sub_domain: "sub.example.com",
      node_domain: null,
      trust_cloudflare: true,
      force_node_cloudflare: false,
      confirm_host_change: false,
    });
  });

  it("blocks an orange-clouded node domain until forced, and confirms the change", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = fakeApi({
      "GET /settings": view(),
      "POST /settings/dns-check": {
        domain: "node.example.com",
        addresses: [{ ip: "104.16.0.1", cloudflare: true }],
        level: "block",
        message: "解析到 Cloudflare 的地址，说明开启了橙色云朵",
      },
      "PUT /settings": () => ({ status: 200, body: view({ version: 4 }) }),
    });
    renderWithClient(<AdminSettings />);
    fireEvent.change(await screen.findByLabelText("节点通信域名"), { target: { value: "node.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByText(/请改为灰色云朵/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("已经注册的节点继续使用"));
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { force_node_cloudflare: boolean }).force_node_cloudflare).toBe(true);
  });

  it("requires confirming a main domain that refuses the current address", async () => {
    fakeApi({ "GET /settings": view() });
    renderWithClient(<AdminSettings />);
    fireEvent.change(await screen.findByLabelText("主域名"), { target: { value: "panel.example.com" } });
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("removes a server name after a confirmation listing its nodes", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const calls = fakeApi({
      "GET /settings": view(),
      "POST /settings/server-names/remove": { removed: "old.example.com", affected_nodes: [] },
    });
    renderWithClient(<AdminSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "移除" }));
    await waitFor(() => expect(calls.some((c) => c.path === "/settings/server-names/remove")).toBe(true));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("tokyo"));
    expect(calls.find((c) => c.path === "/settings/server-names/remove")?.body).toEqual({
      name: "old.example.com",
      confirm: true,
    });
  });
});
