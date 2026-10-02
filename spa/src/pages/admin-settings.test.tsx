import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeApi, renderWithClient } from "../test/harness";
import { AdminSettings, hostOf, hostStillAllowed, humanInterval, probeBody, type SettingsView } from "./admin-settings";

const tab = (t: string) => window.history.pushState(null, "", `/admin/settings/${t}`);

afterEach(() => {
  window.history.pushState(null, "", "/");
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  version: 3,
  updated_at: null,
  site_name: null,
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
  probe: {
    interval_secs: { value: null, effective: 18000, config: 18000, source: "config" },
    urls: {
      value: null,
      effective: ["https://www.gstatic.com/generate_204", "https://cp.cloudflare.com/generate_204"],
      config: ["https://www.gstatic.com/generate_204", "https://cp.cloudflare.com/generate_204"],
      source: "config",
    },
    panel_tcp: { value: null, effective: true, config: true, source: "config" },
    timeout_ms: 5000,
    attempts: 3,
    manual_cooldown_secs: 30,
  },
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
    tab("node");
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
    tab("node");
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

describe("tabs and the site name (W21)", () => {
  it("switches tabs by URL and saves the site name", async () => {
    const calls = fakeApi({
      "GET /settings": view(),
      "PUT /settings/site": () => ({ status: 200, body: view({ version: 4, site_name: "星云" }) }),
      "GET /settings/mail": { version: 1, dead_letters: 0 },
      "GET /mail/outbox": [],
    });
    renderWithClient(<AdminSettings />);
    expect(screen.getByRole("tab", { name: "站点" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.change(await screen.findByLabelText("站点名称"), { target: { value: " 星云 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存站点名称" }));
    await screen.findByText("已保存。");
    expect(calls.find((c) => c.path === "/settings/site")?.body).toEqual({ version: 3, site_name: "星云" });
    // The node domain is on its own tab; arrow keys move between tabs.
    expect(screen.queryByLabelText("节点通信域名")).toBeNull();
    fireEvent.keyDown(screen.getByRole("tab", { name: "站点" }), { key: "ArrowRight" });
    expect(window.location.pathname).toBe("/admin/settings/node");
    expect(await screen.findByLabelText("节点通信域名")).toBeTruthy();
    expect(screen.queryByLabelText("主域名")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "失败邮件" }));
    expect(await screen.findByRole("heading", { name: /失败邮件/ })).toBeTruthy();
  });
});

describe("latency test settings (W12)", () => {
  it("formats intervals", () => {
    expect(humanInterval(18000)).toBe("5 小时");
    expect(humanInterval(600)).toBe("10 分钟");
    expect(humanInterval(90000)).toBe("1 天 1 小时");
  });

  it("validates the form like the backend", () => {
    expect(probeBody(1, "", "", "config")).toEqual({
      body: { version: 1, interval_secs: null, urls: null, panel_tcp: null },
    });
    expect(probeBody(1, "15", " http://a.example/204 \n\nhttps://b.example/x ", "off")).toEqual({
      body: { version: 1, interval_secs: 900, urls: ["http://a.example/204", "https://b.example/x"], panel_tcp: false },
    });
    expect(probeBody(1, "5", "", "config")).toHaveProperty("error");
    expect(probeBody(1, "20000", "", "config")).toHaveProperty("error");
    expect(probeBody(1, "", "ftp://a.example/", "config")).toHaveProperty("error");
    expect(probeBody(1, "", "https://user@a.example/", "config")).toHaveProperty("error");
    expect(probeBody(1, "", "http://a/1\nhttp://a/1", "config")).toHaveProperty("error");
    expect(probeBody(1, "", "http://a/1\nhttp://a/2\nhttp://a/3\nhttp://a/4\nhttp://a/5", "config")).toHaveProperty(
      "error",
    );
  });

  it("saves interval, URLs and the panel TCP switch", async () => {
    const calls = fakeApi({
      "GET /settings": view(),
      "PUT /settings/probe": () => ({ status: 200, body: view({ version: 4 }) }),
    });
    tab("probe");
    renderWithClient(<AdminSettings />);
    fireEvent.change(await screen.findByLabelText("测速间隔（分钟）"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("测速地址"), { target: { value: "http://probe.example/generate_204" } });
    fireEvent.change(screen.getByLabelText("面板 TCP 测速"), { target: { value: "off" } });
    fireEvent.click(screen.getByRole("button", { name: "保存测速设置" }));
    await screen.findByText("已保存，已通知所有在线节点。");
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      version: 3,
      interval_secs: 1800,
      urls: ["http://probe.example/generate_204"],
      panel_tcp: false,
    });
  });

  it("refuses an out-of-range interval without calling the API", async () => {
    const calls = fakeApi({ "GET /settings": view() });
    tab("probe");
    renderWithClient(<AdminSettings />);
    fireEvent.change(await screen.findByLabelText("测速间隔（分钟）"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存测速设置" }));
    await screen.findByText(/测速间隔须在 10 分钟到 7 天/);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});
