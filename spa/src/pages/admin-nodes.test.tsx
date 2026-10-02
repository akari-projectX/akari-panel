import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstallView, NodeView } from "../lib/api";
import { nodeRoutes } from "../test/nodes";
import { fakeApi, renderWithClient } from "../test/harness";
import { AdminNodes, formatLease, toSpecs } from "./admin-nodes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const node = (over: Partial<NodeView>): NodeView =>
  ({
    id: "n1",
    name: "tokyo",
    enabled: true,
    status: "online",
    agent_version: "v1.0.0",
    core_version: null,
    agent_os: "linux",
    agent_arch: "amd64",
    update_status: null,
    config_version: 1,
    user_version: 1,
    xray_inbounds: [{ tag: "in-a", protocol: "vless", port: 443 }],
    server_addr: "203.0.113.1",
    region: "东京",
    last_error: null,
    last_error_at: null,
    agent_protocol: 3,
    lease_expires_at: null,
    lease_remaining_seconds: 7200,
    failed_config_version: null,
    failed_user_version: null,
    traffic_max_rate_bytes_per_sec: null,
    deleting_at: null,
    last_seen_at: null,
    created_at: "2026-10-02T00:00:00Z",
    enrolled: true,
    cert_not_after: null,
    enroll_token_expires_at: null,
    heartbeat: null,
    warnings: [],
    display_name: null,
    sort: 0,
    visible: true,
    tags: [],
    traffic_rate_permille: 1000,
    traffic_rate: 1,
    connect_overrides: {},
    group_ids: [],
    traffic_raw_bytes: 0,
    traffic_billed_bytes: 0,
    online: false,
    latency: [],
    probe_requested_at: null,
    ...over,
  }) as NodeView;

const install: InstallView = {
  url: "https://p.example.com/pfx/install/TOKEN",
  command: "curl -fsSL 'https://p.example.com/pfx/install/TOKEN' | sudo sh",
  command_wget: "wget -qO- 'https://p.example.com/pfx/install/TOKEN' | sudo sh",
  uninstall_command: "sudo akari-agent-uninstall",
  expires_at: new Date(Date.now() + 3600_000).toISOString(),
  pin: null,
  releases: {},
  fallback_binary_url: null,
  warnings: ["no agent binary for linux/arm64"],
};

const catalog = {
  reality_dests: ["www.apple.com", "dl.google.com"],
  fingerprints: ["chrome", "firefox"],
  tls_cert_dir: "/etc/akari-agent/tls",
};

describe("toSpecs", () => {
  it("converts rows and rejects bad ports and missing domains", () => {
    const base = {
      key: 1,
      tag: "",
      dest: "",
      customDest: "",
      serverName: "",
      fingerprint: "chrome",
      domain: "",
      path: "",
      tls: false,
    };
    expect(toSpecs([{ ...base, template: "vless_reality", port: "443" }])).toEqual([
      { template: "vless_reality", port: 443, fingerprint: "chrome" },
    ]);
    expect(toSpecs([{ ...base, template: "vless_reality", port: "0" }])).toMatch(/端口/);
    expect(
      toSpecs([
        { ...base, template: "vmess_ws", port: "80" },
        { ...base, key: 2, template: "vmess_ws", port: "80" },
      ]),
    ).toMatch(/重复/);
    expect(toSpecs([{ ...base, template: "trojan_tls", port: "443" }])).toMatch(/证书域名/);
    expect(toSpecs([{ ...base, template: "vmess_ws", port: "80", tls: true, domain: "a.example.com" }])).toEqual([
      { template: "vmess_ws", port: 80, tls_domain: "a.example.com" },
    ]);
  });
  it("converts the W8 protocol templates", () => {
    const base = {
      key: 1,
      tag: "",
      dest: "",
      customDest: "",
      serverName: "",
      fingerprint: "chrome",
      domain: "",
      path: "",
      tls: false,
    };
    expect(toSpecs([{ ...base, template: "vless_reality", port: "443", vision: false }])).toEqual([
      { template: "vless_reality", port: 443, fingerprint: "chrome", vision: false },
    ]);
    expect(
      toSpecs([{ ...base, template: "vless_reality_xhttp", port: "443", path: "/x", mode: "stream-one" }]),
    ).toEqual([{ template: "vless_reality_xhttp", port: 443, fingerprint: "chrome", path: "/x", mode: "stream-one" }]);
    // Hysteria 2 (UDP) may share the TCP port of another inbound; SS (TCP+UDP) may not.
    expect(
      toSpecs([
        { ...base, template: "vless_reality", port: "443" },
        { ...base, key: 2, template: "hysteria2", port: "443", domain: "n.example.com" },
      ]),
    ).toHaveLength(2);
    expect(
      toSpecs([
        { ...base, template: "shadowsocks_2022", port: "8388" },
        { ...base, key: 2, template: "hysteria2", port: "8388", domain: "n.example.com" },
      ]),
    ).toMatch(/重复/);
    expect(toSpecs([{ ...base, template: "hysteria2", port: "443" }])).toMatch(/证书域名/);
    expect(toSpecs([{ ...base, template: "transport", port: "443", protocol: "trojan", network: "ws" }])).toMatch(
      /TLS/,
    );
    expect(
      toSpecs([
        {
          ...base,
          template: "transport",
          port: "443",
          protocol: "vless",
          network: "grpc",
          domain: "n.example.com",
          serviceName: "svc",
        },
      ]),
    ).toEqual([
      {
        template: "transport",
        port: 443,
        protocol: "vless",
        network: "grpc",
        service_name: "svc",
        tls_domain: "n.example.com",
      },
    ]);
    expect(
      toSpecs([
        {
          ...base,
          template: "transport",
          port: "80",
          protocol: "vmess",
          network: "httpupgrade",
          host: "cdn.example.com",
        },
      ]),
    ).toEqual([
      { template: "transport", port: 80, protocol: "vmess", network: "httpupgrade", host: "cdn.example.com" },
    ]);
    expect(
      toSpecs([{ ...base, template: "shadowsocks_2022", port: "8388", method: "2022-blake3-aes-256-gcm" }]),
    ).toEqual([{ template: "shadowsocks_2022", port: 8388, method: "2022-blake3-aes-256-gcm" }]);
  });
  it("formats the lease", () => {
    expect(formatLease(null)).toBe("—");
    expect(formatLease(0)).toBe("已到期");
    expect(formatLease(90000)).toBe("1 天 1 小时");
    expect(formatLease(3700)).toBe("1 小时 1 分");
  });
});

describe("AdminNodes", () => {
  it("keeps each node's editor separate (F1)", async () => {
    const calls = fakeApi({
      ...nodeRoutes([
        node({ id: "a", name: "alpha", xray_inbounds: [{ tag: "in-a", protocol: "vless", port: 1 }] }),
        node({ id: "b", name: "beta", xray_inbounds: [{ tag: "in-b", protocol: "vmess", port: 2 }] }),
      ]),
      "GET /inbound-templates": catalog,
      "PUT /nodes/b/inbounds": { config_version: 2 },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithClient(<AdminNodes />);
    const configure = await screen.findAllByRole("button", { name: "配置" });
    fireEvent.click(configure[0]);
    await screen.findByText("配置「alpha」");
    fireEvent.click(screen.getByRole("button", { name: "高级：编辑 JSON" }));
    // Switch to beta: its own state, not alpha's.
    fireEvent.click(screen.getByRole("button", { name: "收起" }));
    fireEvent.click((await screen.findAllByRole("button", { name: "配置" }))[1]);
    await screen.findByText("配置「beta」");
    expect(screen.queryByLabelText("Xray 入站 JSON（数组）")).toBeNull();
    expect(screen.getAllByText("in-b").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("in-a")).toHaveLength(0);
    // Removing an inbound and saving pushes beta's list only.
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并下发入站" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/nodes/b/inbounds");
    expect(put?.body).toEqual({ inbounds: [] });
  });

  it("creates a node from templates and shows the install command", async () => {
    const calls = fakeApi({
      "GET /nodes": [],
      "GET /inbound-templates": catalog,
      "POST /nodes": () => ({
        status: 201,
        body: {
          id: "n9",
          name: "osaka",
          enrollment_token: "TOKEN",
          expires_at: install.expires_at,
          bootstrap: 'panel_addr = "x"',
          install,
        },
      }),
    });
    renderWithClient(<AdminNodes />);
    fireEvent.click(await screen.findByRole("button", { name: "新建节点" }));
    fireEvent.change(screen.getByLabelText("名称（内部，唯一）"), { target: { value: "osaka" } });
    fireEvent.change(screen.getByLabelText("公网地址（IP 或域名）"), {
      target: { value: "198.51.100.7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并生成安装命令" }));
    await screen.findByText(install.command);
    const create = calls.find((c) => c.method === "POST" && c.path === "/nodes");
    expect(create?.body).toEqual({
      name: "osaka",
      server_addr: "198.51.100.7",
      templates: [{ template: "vless_reality", port: 443, fingerprint: "chrome" }],
      install: { origin: location.origin },
    });
    expect(screen.getByText(install.command_wget as string)).toBeTruthy();
    expect(screen.getByText("no agent binary for linux/arm64")).toBeTruthy();
  });

  it("shows enable/disable failures and asks before disabling (F3)", async () => {
    fakeApi({
      ...nodeRoutes([node({})]),
      "PATCH /nodes/n1": () => ({ status: 409, body: { error: "node is being deleted" } }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithClient(<AdminNodes />);
    fireEvent.click(await screen.findByRole("button", { name: "停用" }));
    expect(confirm).toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "停用" }));
    expect((await screen.findByRole("alert")).textContent).toContain("node is being deleted");
  });

  it("re-issues an install command for an enrolled node after confirmation", async () => {
    const calls = fakeApi({
      ...nodeRoutes([node({})]),
      "POST /nodes/n1/install": { ...install, pin: "sha256//PIN=", command_wget: null },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithClient(<AdminNodes />);
    fireEvent.click(await screen.findByRole("button", { name: "重装命令" }));
    await screen.findByText(install.command);
    expect(calls.find((c) => c.path === "/nodes/n1/install")?.body).toEqual({
      origin: location.origin,
    });
    expect(screen.queryByText("或 wget")).toBeNull();
    expect(screen.getByText(/sha256\/\/PIN=/)).toBeTruthy();
  });
});
