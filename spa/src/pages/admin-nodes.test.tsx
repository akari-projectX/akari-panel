import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstallView, NodeView } from "../lib/api";
import { nodeRoutes } from "../test/nodes";
import { fakeApi, pickMenu, renderWithClient } from "../test/harness";
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
    inbound: { protocol: "vless", port: 443 },
    entrances: [
      {
        id: "e1",
        kind: "direct",
        name: "直连",
        connect_host: "203.0.113.1",
        connect_port: null,
        rate_permille: 1000,
        rate: 1,
        enabled: true,
        sort: 0,
        group_ids: [],
      },
    ],
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
  warnings: ["没有 linux/arm64 的 agent 程序"],
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
    expect(toSpecs([{ ...base, template: "trojan_tls", port: "443" }])).toMatch(/证书域名/);
    expect(toSpecs([{ ...base, template: "vmess_ws", port: "80", tls: true, domain: "a.example.com" }])).toEqual([
      { template: "vmess_ws", port: 80, tls_domain: "a.example.com" },
    ]);
  });
  it("converts the W8 protocol templates", () => {
    const base = {
      key: 1,
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
        node({ id: "a", name: "alpha", inbound: { protocol: "vless", port: 1 } }),
        node({ id: "b", name: "beta", inbound: { protocol: "vmess", port: 2 } }),
      ]),
      "GET /inbound-templates": catalog,
      "PUT /nodes/b/inbound": { config_version: 2 },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithClient(<AdminNodes />);
    await pickMenu("alpha", "配置");
    await screen.findByText("配置「alpha」");
    fireEvent.click(screen.getByRole("button", { name: "高级：编辑 JSON" }));
    // Switch to beta: its own state, not alpha's.
    await pickMenu("alpha", "收起配置");
    await pickMenu("beta", "配置");
    await screen.findByText("配置「beta」");
    expect(screen.queryByLabelText("Xray 入站 JSON（对象）")).toBeNull();
    expect(screen.getByText("vmess · tcp")).toBeTruthy();
    expect(screen.queryByText("vless · tcp")).toBeNull();
    // Removing the inbound and saving pushes beta's only.
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    fireEvent.click(screen.getByRole("button", { name: "保存并下发入站" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe("/nodes/b/inbound");
    expect(put?.body).toEqual({ inbound: null });
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
    fireEvent.change(screen.getByLabelText("连接地址（IP 或域名）"), {
      target: { value: "198.51.100.7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并生成安装命令" }));
    await screen.findByText(install.command);
    const create = calls.find((c) => c.method === "POST" && c.path === "/nodes");
    expect(create?.body).toEqual({
      name: "osaka",
      direct: { connect_host: "198.51.100.7" },
      template: { template: "vless_reality", port: 443, fingerprint: "chrome" },
      install: { origin: location.origin },
    });
    expect(screen.getByText(install.command_wget as string)).toBeTruthy();
    expect(screen.getByText("没有 linux/arm64 的 agent 程序")).toBeTruthy();
  });

  // W26: the free transport row is generated from the manifest: its
  // protocols, transports (with format notes), TLS rule and fields.
  it("builds a transport template row from the manifest form", async () => {
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
    fireEvent.change(screen.getByLabelText("协议"), { target: { value: "transport" } });
    const proto = screen.getByLabelText("代理协议") as HTMLSelectElement;
    expect([...proto.options].map((o) => o.text)).toEqual(["VLESS", "VMess", "Trojan（需 TLS）"]);
    fireEvent.change(proto, { target: { value: "vmess" } });
    const net = screen.getByLabelText("传输方式") as HTMLSelectElement;
    expect([...net.options].map((o) => o.text)).toEqual([
      "WebSocket",
      "HTTPUpgrade",
      "XHTTP（Clash (mihomo) 不支持；sing-box 不支持）",
      "gRPC（需 TLS）",
    ]);
    fireEvent.change(net, { target: { value: "xhttp" } });
    expect(screen.getByLabelText("启用 TLS")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("XHTTP 路径（可选）"), { target: { value: "/xh" } });
    fireEvent.change(screen.getByLabelText("XHTTP Host（可选）"), { target: { value: "cdn.example.com" } });
    fireEvent.change(screen.getByLabelText("XHTTP 模式"), { target: { value: "stream-up" } });
    fireEvent.click(screen.getByRole("button", { name: "创建并生成安装命令" }));
    await screen.findByText(install.command);
    const create = calls.find((c) => c.method === "POST" && c.path === "/nodes");
    expect((create?.body as { template: unknown }).template).toEqual({
      template: "transport",
      port: 443,
      protocol: "vmess",
      network: "xhttp",
      path: "/xh",
      host: "cdn.example.com",
      mode: "stream-up",
    });
  });

  it("asks for TLS where the manifest requires it (gRPC)", async () => {
    fakeApi({ "GET /nodes": [], "GET /inbound-templates": catalog });
    renderWithClient(<AdminNodes />);
    fireEvent.click(await screen.findByRole("button", { name: "新建节点" }));
    fireEvent.change(screen.getByLabelText("协议"), { target: { value: "transport" } });
    fireEvent.change(screen.getByLabelText("传输方式"), { target: { value: "grpc" } });
    expect(screen.queryByLabelText("启用 TLS")).toBeNull();
    expect(screen.getByLabelText("证书域名")).toBeTruthy();
    expect(screen.getByLabelText("gRPC serviceName（可选）")).toBeTruthy();
    expect(screen.queryByLabelText("gRPC 路径（可选）")).toBeNull();
  });

  it("shows enable/disable failures and asks before disabling (F3)", async () => {
    fakeApi({
      ...nodeRoutes([node({})]),
      "PATCH /nodes/n1": () => ({ status: 409, body: { error: "node is being deleted" } }),
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithClient(<AdminNodes />);
    await pickMenu("tokyo", "停用");
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    confirm.mockReturnValue(true);
    await pickMenu("tokyo", "停用");
    expect((await screen.findByRole("alert")).textContent).toContain("node is being deleted");
  });

  it("re-issues an install command for an enrolled node after confirmation", async () => {
    const calls = fakeApi({
      ...nodeRoutes([node({})]),
      "POST /nodes/n1/install": { ...install, pin: "sha256//PIN=", command_wget: null },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithClient(<AdminNodes />);
    await pickMenu("tokyo", "重装命令");
    await screen.findByText(install.command);
    expect(calls.find((c) => c.path === "/nodes/n1/install")?.body).toEqual({
      origin: location.origin,
    });
    expect(screen.queryByText("或 wget")).toBeNull();
    expect(screen.getByText(/sha256\/\/PIN=/)).toBeTruthy();
  });
});
