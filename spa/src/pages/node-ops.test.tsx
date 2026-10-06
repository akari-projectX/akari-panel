// W11: node form fields, live status, node detail, latency badges, portal
// node list.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LatencyBadge, latencyLevel } from "../components/latency-badge";
import { niceMax, pathOf } from "../components/line-chart";
import { FixedLocale, setLocale } from "../i18n";
import type { MyNodeStatus, NodeStatus, NodeView } from "../lib/api";
import { nodeRoutes } from "../test/nodes";
import { fakeApi, pickMenu, renderAdmin, renderWithClient } from "../test/harness";
import { connectToBody, createBody, emptyOps, opsToBody, parseTags } from "./admin-node-form";
import { agentLatency, humanRate } from "./admin-node-status";
import { AdminNodes } from "./admin-nodes";
import { NodesCard } from "./portal-nodes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState(null, "", "/");
});

const node = (over: Partial<NodeView> = {}): NodeView =>
  ({
    id: "n1",
    server_id: "s1",
    server_name: "hk-1",
    name: "hk-1",
    enabled: true,
    status: "online",
    agent_version: "v0.3.0",
    core_version: "v26.3.27",
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
        rate_permille: 500,
        rate: 0.5,
        enabled: true,
        sort: 0,
        wire_no: 0,
        listen_port: null,
        source_cidrs: [],
        health_ok: null,
        health_at: null,
        health_failures: 0,
        health_error: null,
        hidden_since: null,
        group_ids: [],
      },
    ],
    region: "香港",
    last_error: null,
    last_error_at: null,
    agent_protocol: 5,
    lease_expires_at: null,
    lease_remaining_seconds: 7200,
    failed_config_version: null,
    failed_user_version: null,
    traffic_max_rate_bytes_per_sec: null,
    deleting_at: null,
    last_seen_at: "2026-10-02T00:00:00Z",
    created_at: "2026-10-02T00:00:00Z",
    enrolled: true,
    cert_not_after: null,
    enroll_token_expires_at: null,
    heartbeat: {
      cpu_percent: 37.4,
      mem_used_bytes: 512 * 2 ** 20,
      mem_total_bytes: 2 ** 31,
      connections: 12,
      uptime_seconds: 7200,
      lease_remaining_seconds: 7000,
      ts: "2026-10-02T00:00:00Z",
      metrics: {
        load1: 0.5,
        load5: 0.4,
        load15: 0.3,
        cpu_count: 2,
        swap_used_bytes: 0,
        swap_total_bytes: 0,
        disk_used_bytes: 2 ** 33,
        disk_total_bytes: 2 ** 35,
        net_interface: "eth0",
        net_rx_bytes_per_sec: 1_250_000,
        net_tx_bytes_per_sec: 125_000,
        net_rx_bytes_total: 2 ** 40,
        net_tx_bytes_total: 2 ** 39,
        tcp_sockets: 120,
        udp_sockets: 8,
        online_users: 7,
        process_rss_bytes: 60 * 2 ** 20,
        xray_version: "26.3.27",
      },
    },
    warnings: [],
    display_name: "香港 01",
    sort: 0,
    visible: true,
    tags: ["IPLC"],
    traffic_raw_bytes: 2 ** 30,
    traffic_billed_bytes: 2 ** 29,
    online: true,
    latency: [
      { source: "agent", target: "https://a/", delay_ms: null, error: "timeout", measured_at: "2026-10-02T00:00:00Z" },
      { source: "agent", target: "https://b/", delay_ms: 320, error: null, measured_at: "2026-10-02T00:00:00Z" },
      { source: "panel", target: "in-a", delay_ms: 45, error: null, measured_at: "2026-10-02T00:00:00Z" },
    ],
    probe_requested_at: null,
    ...over,
  }) as NodeView;

describe("helpers", () => {
  it("latency levels follow Clash Verge thresholds", () => {
    expect(latencyLevel(80, false)).toBe("good");
    expect(latencyLevel(199, false)).toBe("good");
    expect(latencyLevel(200, false)).toBe("fair");
    expect(latencyLevel(499, false)).toBe("fair");
    expect(latencyLevel(500, false)).toBe("bad");
    expect(latencyLevel(null, true)).toBe("timeout");
    expect(latencyLevel(undefined, false)).toBe("unknown");
  });

  it("badge text is localized", () => {
    setLocale("en");
    render(<LatencyBadge ms={null} failed />);
    expect(screen.getByText("Timeout").getAttribute("data-level")).toBe("timeout");
    cleanup();
    render(
      <FixedLocale locale="zh">
        <LatencyBadge ms={null} failed />
        <LatencyBadge ms={null} na />
        <LatencyBadge ms={150} />
      </FixedLocale>,
    );
    expect(screen.getByText("超时")).toBeTruthy();
    expect(screen.getByText("不适用")).toBeTruthy();
    expect(screen.getByText("150 ms").getAttribute("data-level")).toBe("good");
  });

  it("chart scale and paths", () => {
    expect(niceMax([0.3])).toBe(1);
    expect(niceMax([37], 1)).toBe(50);
    expect(niceMax([1_200_000])).toBe(2_000_000);
    expect(pathOf([], 10)).toBe("");
    const d = pathOf([0, null, 10, 5], 10);
    expect(d.match(/M/g)?.length).toBe(2); // the gap starts a new segment
    expect(d).toContain("L");
  });

  it("rates and agent latency choice", () => {
    expect(humanRate(125_000)).toBe("1.0 Mbps");
    expect(humanRate(0)).toBe("0 bps");
    expect(agentLatency(node().latency)?.target).toBe("https://b/");
    expect(agentLatency([])).toBeNull();
  });

  it("validates form fields", () => {
    expect(parseTags("香港，IPLC、 0.5x ,")).toEqual(["香港", "IPLC", "0.5x"]);
    expect(opsToBody({ ...emptyOps(), rate: "0.0005" })).toBe("倍率最多 3 位小数");
    expect(opsToBody({ ...emptyOps(), rate: "101" })).toMatch(/0–100/);
    expect(opsToBody({ ...emptyOps(), sort: "1.5" })).toMatch(/整数/);
    expect(opsToBody({ ...emptyOps(), tags: "a|b" })).toMatch(/\|/);
    const defaults = opsToBody(emptyOps());
    expect(typeof defaults).not.toBe("string");
    if (typeof defaults !== "string") {
      expect(createBody(defaults, "")).toEqual({});
      expect(createBody(defaults, " relay.example.com ")).toEqual({ direct: { connect_host: "relay.example.com" } });
    }
    expect(connectToBody(" relay.example.com ", "30443")).toEqual({
      connect_host: "relay.example.com",
      connect_port: 30443,
    });
    expect(connectToBody("", "")).toEqual({ connect_host: null, connect_port: null });
    expect(connectToBody("", "70000")).toMatch(/1–65535/);
  });
});

describe("admin node list and form", () => {
  it("shows live columns: CPU/mem, rates, online users, latency, multiplier and tags", async () => {
    fakeApi({ ...nodeRoutes([node()]) });
    renderAdmin(<AdminNodes />);
    const row = (await screen.findByText("香港 01")).closest("tr") as HTMLElement;
    expect(within(row).getByText("hk-1")).toBeTruthy();
    expect(within(row).getByText("0.5x")).toBeTruthy();
    expect(within(row).getByText("IPLC")).toBeTruthy();
    expect(row.textContent).toContain("37%");
    expect(row.textContent).toContain("25%"); // 512 MiB of 2 GiB
    expect(row.textContent).toContain("↓ 10.0 Mbps");
    expect(row.textContent).toContain("↑ 1.0 Mbps");
    expect(within(row).getByText("7")).toBeTruthy();
    expect(within(row).getByText("320 ms").getAttribute("data-level")).toBe("fair");
  });

  it("an offline node shows no stale metrics", async () => {
    fakeApi({ ...nodeRoutes([node({ online: false, status: "offline", latency: [] })]) });
    renderAdmin(<AdminNodes />);
    const row = (await screen.findByText("香港 01")).closest("tr") as HTMLElement;
    expect(row.textContent).not.toContain("37%");
    expect(within(row).getByText("未测")).toBeTruthy();
  });

  it("creates a node with display name, tags, multiplier and groups", async () => {
    const calls = fakeApi({
      "GET /nodes": [],
      "GET /node-groups": [{ id: "g1", name: "亚洲", description: "", entrance_ids: [], plan_ids: [] }],
      "GET /inbound-templates": { reality_dests: ["www.apple.com:443"], fingerprints: ["chrome"] },
      "POST /nodes": () => ({
        status: 201,
        body: { id: "n9", name: "jp", enrollment_token: "T", expires_at: "2099-01-01T00:00:00Z", bootstrap: "x" },
      }),
    });
    renderAdmin(<AdminNodes />);
    fireEvent.click(await screen.findByRole("button", { name: "新建节点" }));
    fireEvent.change(screen.getByLabelText("名称（内部，唯一）"), { target: { value: "jp" } });
    fireEvent.change(screen.getByLabelText("显示名称（用户可见）"), { target: { value: "东京 01" } });
    fireEvent.change(screen.getByLabelText("标签（逗号分隔）"), { target: { value: "日本, 0.5x" } });
    fireEvent.change(screen.getByLabelText("倍率"), { target: { value: "0.5" } });
    fireEvent.click(await screen.findByLabelText("亚洲"));
    fireEvent.click(screen.getByRole("button", { name: "创建并生成安装命令" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === "/nodes")).toBe(true));
    const body = calls.find((c) => c.method === "POST" && c.path === "/nodes")?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "jp",
      display_name: "东京 01",
      tags: ["日本", "0.5x"],
      direct: { rate: 0.5, group_ids: ["g1"] },
    });
    expect(body.sort).toBeUndefined(); // unchanged defaults are not sent
    expect(body.visible).toBeUndefined();
  });

  it("saves display fields on the node and billing/address on its direct entrance", async () => {
    const calls = fakeApi({
      ...nodeRoutes([node()]),
      "GET /node-groups": [],
      "GET /inbound-templates": { reality_dests: [], fingerprints: [] },
      "PATCH /nodes/n1": node(),
      "PATCH /entrances/e1": node().entrances[0],
    });
    renderAdmin(<AdminNodes />);
    await pickMenu("hk-1", "配置");
    const card = (await screen.findByText(/展示与计费/)).closest("div.rounded-lg") as HTMLElement;
    fireEvent.change(within(card).getByLabelText("倍率"), { target: { value: "2" } });
    fireEvent.click(within(card).getByLabelText("对用户显示"));
    fireEvent.change(within(card).getByLabelText("连接端口"), { target: { value: "30443" } });
    fireEvent.click(within(card).getByRole("button", { name: "保存" }));
    await within(card).findByText("已保存");
    expect(calls.find((c) => c.method === "PATCH" && c.path === "/nodes/n1")?.body).toEqual({
      display_name: "香港 01",
      sort: 0,
      visible: false,
      tags: ["IPLC"],
    });
    expect(calls.find((c) => c.method === "PATCH" && c.path === "/entrances/e1")?.body).toEqual({
      rate: 2,
      group_ids: [],
      connect_host: "203.0.113.1",
      connect_port: 30443,
    });
  });
});

describe("node detail", () => {
  const status: NodeStatus = {
    id: "n1",
    status: "online",
    online: true,
    last_seen_at: "2026-10-02T00:00:00Z",
    heartbeat: node().heartbeat,
    latency: node().latency.concat([
      { source: "panel", target: "hy", delay_ms: null, error: "udp", measured_at: "2026-10-02T00:00:00Z" },
    ]),
    traffic_raw_bytes: 2 ** 30,
    traffic_billed_bytes: 2 ** 29,
    probe_requested_at: null,
  };
  const metrics = {
    range: "24h",
    step_secs: 300,
    points: [0, 1, 2].map((i) => ({
      t: new Date(Date.UTC(2026, 9, 2, 0, i * 5)).toISOString(),
      samples: 20,
      cpu: 10 + i,
      cpu_max: 20 + i,
      load1: 0.5,
      mem_used: 2 ** 29,
      mem_total: 2 ** 31,
      swap_used: 0,
      swap_total: 0,
      disk_used: 0,
      disk_total: 0,
      rx_bps: 1000,
      tx_bps: 500,
      rx_bps_max: 2000,
      tx_bps_max: 1000,
      tcp: 10,
      udp: 2,
      conns: 5,
      conns_max: 9,
      users: 3,
      users_max: 4,
    })),
  };

  it("opens from the list (deep link), shows status, charts and latency; 立即测速 with cooldown", async () => {
    let probes = 0;
    const calls = fakeApi({
      ...nodeRoutes([node()]),
      "GET /servers/s1/status": status,
      "GET /servers/s1/metrics": metrics,
      "GET /nodes/n1/traffic": {
        from: "2026-09-03",
        to: "2026-10-02",
        timezone: "UTC",
        daily_since: null,
        total: { up_bytes: 0, down_bytes: 0, billed_bytes: 0 },
        days: [],
        top_users: [],
      },
      "GET /servers/s1/alert-rules": {
        muted: false,
        disabled: [],
        offline_secs: null,
        cpu_percent: null,
        cpu_minutes: null,
        mem_percent: null,
        mem_minutes: null,
        disk_percent: null,
        cert_days: null,
      },
      "POST /servers/s1/probe": () =>
        ++probes === 1
          ? { status: 202, body: { requested_at: "2026-10-02T00:00:00Z" } }
          : { status: 429, body: { error: "a latency test was requested moments ago" } },
    });
    window.history.pushState(null, "", "/admin/nodes");
    renderAdmin(<AdminNodes />);
    fireEvent.click(await screen.findByRole("button", { name: /详情/ }));
    expect(location.pathname).toBe("/admin/nodes/n1");
    await screen.findByText(/节点详情「香港 01」/);
    expect(await screen.findByText("1.0 GiB / 512.0 MiB")).toBeTruthy(); // raw / billed
    expect(screen.getByText("https://b/")).toBeTruthy();
    expect(screen.getByText(/UDP 协议/)).toBeTruthy();
    expect(screen.getAllByRole("img").length).toBe(5); // four machine charts + W22 daily traffic
    expect(calls.some((c) => c.path === "/servers/s1/metrics" && c.search === "?range=24h")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "7 天" }));
    await waitFor(() => expect(calls.some((c) => c.search === "?range=7d")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "立即测速" }));
    expect((await screen.findByRole("status")).textContent).toContain("已发起测速");
    fireEvent.click(screen.getByRole("button", { name: "立即测速" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("刚刚测过"));
    fireEvent.click(screen.getByRole("button", { name: "返回列表" }));
    expect(location.pathname).toBe("/admin/nodes");
  });

  it("W23: values the agent could not read show as 未知, never 0", async () => {
    const hb = node().heartbeat!;
    const unknownHb = {
      ...hb,
      cpu_percent: null,
      mem_used_bytes: null,
      mem_total_bytes: null,
      metrics: {
        ...hb.metrics!,
        load1: null,
        load5: null,
        load15: null,
        cpu_count: null,
        net_rx_bytes_per_sec: null,
        net_tx_bytes_per_sec: null,
        tcp_sockets: null,
        udp_sockets: 3,
      },
    };
    const n = node({ heartbeat: unknownHb });
    fakeApi({
      ...nodeRoutes([n]),
      "GET /servers/s1/status": { ...status, heartbeat: unknownHb },
      "GET /servers/s1/metrics": {
        ...metrics,
        points: metrics.points.map((p) => ({ ...p, cpu: null, cpu_max: null, mem_used: null, mem_total: null })),
      },
      "GET /nodes/n1/traffic": {
        from: "2026-09-03",
        to: "2026-10-02",
        timezone: "UTC",
        daily_since: null,
        total: { up_bytes: 0, down_bytes: 0, billed_bytes: 0 },
        days: [],
        top_users: [],
      },
      "GET /servers/s1/alert-rules": {
        muted: false,
        disabled: [],
        offline_secs: null,
        cpu_percent: null,
        cpu_minutes: null,
        mem_percent: null,
        mem_minutes: null,
        disk_percent: null,
        cert_days: null,
      },
    });
    window.history.pushState(null, "", "/admin/nodes");
    renderAdmin(<AdminNodes />);
    // The list row: CPU / memory and the rates.
    expect((await screen.findAllByText(/未知/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^0%/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /详情/ }));
    await screen.findByText(/节点详情「香港 01」/);
    expect(await screen.findByText("负载 未知 / 未知 / 未知 · 未知")).toBeTruthy();
    expect(screen.getByText("未知 / 3")).toBeTruthy(); // TCP unknown, UDP read
    expect(screen.getByText(/agent 读不到该值（不是 0）/)).toBeTruthy();
  });

  it("W23: an update status from before the last reinstall is shown as history", async () => {
    fakeApi(
      nodeRoutes([
        node({
          update_status: {
            rollout_id: "r1",
            version: "v0.4.0",
            rollout_status: "aborted",
            status: "failed",
            detail: "failed (v0.4.0): switch to v0.4.0: permission denied",
            superseded: true,
          },
        }),
      ]),
    );
    window.history.pushState(null, "", "/admin/nodes");
    renderAdmin(<AdminNodes />);
    const badge = await screen.findByText("v0.4.0: failed（重装前）");
    expect(badge.className).not.toContain("text-destructive");
    expect(badge.getAttribute("title")).toContain("节点已于此后重装");
  });
});

describe("portal node list", () => {
  const mine: MyNodeStatus[] = [
    {
      name: "香港 01",
      entrance: "直连",
      region: "香港",
      tags: ["IPLC"],
      rate: 0.5,
      online: true,
      latency_ms: 88,
      latency_status: "ok",
      latency_measured_at: "2026-10-02T00:00:00Z",
    },
    {
      name: "Tokyo",
      entrance: "直连",
      region: null,
      tags: [],
      rate: 1,
      online: false,
      latency_ms: null,
      latency_status: "timeout",
      latency_measured_at: null,
    },
  ];

  it("lists nodes with status, rate and latency in English", async () => {
    setLocale("en");
    fakeApi({ "GET /me/nodes": mine });
    renderWithClient(<NodesCard me={{ probe_interval_secs: 600 }} />);
    expect(await screen.findByText("香港 01")).toBeTruthy();
    // The effective probe interval (audit Minor 1), not a fixed "5 hours".
    expect(screen.getByText(/updated about every 10 min\)/)).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText("0.5x")).toBeTruthy();
    expect(screen.getByText("88 ms").getAttribute("data-level")).toBe("good");
    expect(screen.getByText("Timeout")).toBeTruthy();
  });

  it("Chinese labels and the empty state", async () => {
    setLocale("zh");
    fakeApi({ "GET /me/nodes": [] });
    renderWithClient(<NodesCard me={{ probe_interval_secs: 18000 }} />);
    expect(await screen.findByText("暂无可用节点。")).toBeTruthy();
    expect(screen.getByText(/约每 5 小时更新一次/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "节点状态" })).toBeTruthy();
  });
});
