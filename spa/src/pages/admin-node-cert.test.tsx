import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import type { CertStatus, NodeView } from "../lib/api";
import { fakeApi, renderAdmin } from "../test/harness";
import { NodeCertStatus, TlsDomainField, certErrorText, describeCheck } from "./admin-node-cert";
import { toSpecs } from "./admin-nodes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CERT_FILE = "/run/credentials/akari-agent.service/tls_fullchain.pem";
const tlsInbound = {
  protocol: "vless",
  port: 443,
  streamSettings: { security: "tls", tlsSettings: { certificates: [{ certificateFile: CERT_FILE }] } },
};

const node = (over: Partial<NodeView>): NodeView =>
  ({
    id: "n1",
    name: "hk",
    enabled: true,
    status: "online",
    agent_protocol: 6,
    inbound: tlsInbound,
    tls_domain: "hk1.example.com",
    agent_addr: "198.51.100.7",
    heartbeat: null,
    warnings: [],
    ...over,
  }) as NodeView;

const cert = (over: Partial<CertStatus>): CertStatus => ({
  domain: "hk1.example.com",
  state: "valid",
  not_after: "2026-12-31T00:00:00Z",
  next_attempt: "2026-12-01T00:00:00Z",
  last_error: null,
  error_kind: null,
  last_error_at: null,
  challenge: "http-01",
  failures: 0,
  ...over,
});

const hb = (c: CertStatus) => ({
  cpu_percent: 1,
  mem_used_bytes: 1,
  mem_total_bytes: 2,
  connections: 0,
  lease_remaining_seconds: null,
  ts: "2026-10-02T00:00:00Z",
  cert: c,
});

describe("NodeCertStatus", () => {
  it("is absent without a node TLS domain", () => {
    fakeApi({});
    renderAdmin(<NodeCertStatus node={node({ tls_domain: null })} />);
    expect(screen.queryByTestId("node-cert-status")).toBeNull();
  });

  it("shows a valid certificate with its expiry", () => {
    fakeApi({});
    renderAdmin(<NodeCertStatus node={node({ heartbeat: hb(cert({})) })} />);
    expect(screen.getByRole("status").textContent).toMatch(/证书有效，到期/);
  });

  it("explains a wrong DNS record with the node's IP and what the domain resolves to", async () => {
    const calls = fakeApi({
      "POST /inbound-templates/check-domain": {
        domain: "hk1.example.com",
        addresses: ["203.0.113.50"],
        expected: ["198.51.100.7"],
        matches: false,
        cloudflare: false,
        error: null,
      },
    });
    renderAdmin(
      <NodeCertStatus
        node={node({
          heartbeat: hb(
            cert({
              state: "failed",
              not_after: null,
              error_kind: "connection",
              last_error: "HTTP 400 urn:ietf:params:acme:error:connection - Timeout during connect",
              failures: 2,
            }),
          ),
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/80 端口不可达/);
    expect(screen.getByRole("alert").textContent).toMatch(/198\.51\.100\.7/);
    await waitFor(() => expect(screen.getByText(/域名未解析到本机 IP 198\.51\.100\.7（当前解析到 203\.0\.113\.50）/)));
    expect(calls.find((c) => c.path === "/inbound-templates/check-domain")?.body).toMatchObject({
      domain: "hk1.example.com",
      node_id: "n1",
    });
    expect(screen.getByText(/连续失败 2 次/)).toBeTruthy();
  });

  it("flags agents too old to obtain the certificate", () => {
    fakeApi({});
    renderAdmin(<NodeCertStatus node={node({ agent_protocol: 5 })} />);
    expect(screen.getByRole("status").textContent).toMatch(/agent 版本过旧/);
  });

  it("says nothing is ordered for nodes without a TLS inbound", () => {
    fakeApi({});
    renderAdmin(<NodeCertStatus node={node({ inbound: { protocol: "vless", port: 443 } })} />);
    expect(screen.getByRole("status").textContent).toMatch(/不会申请证书/);
  });
});

describe("certErrorText", () => {
  it("has an actionable sentence for every kind", () => {
    for (const [kind, re] of [
      ["dns", /无法解析.*A\/AAAA/],
      ["port_busy", /80 端口被占用/],
      ["rate_limited", /频率限制/],
      ["caa", /CAA/],
      ["rejected", /更换节点域名/],
      ["ca_unreachable", /出站网络/],
      ["other", /证书申请失败/],
    ] as const) {
      expect(certErrorText(cert({ state: "failed", error_kind: kind }), "198.51.100.7")).toMatch(re);
    }
  });
});

describe("describeCheck", () => {
  const base = {
    domain: "a.example.com",
    addresses: ["192.0.2.1"],
    expected: [],
    matches: null,
    cloudflare: false,
    error: null,
  };
  it("warns only, with the reason", () => {
    expect(describeCheck({ ...base, matches: true, expected: ["192.0.2.1"] }).ok).toBe(true);
    expect(describeCheck(base)).toEqual({ ok: true, text: expect.stringMatching(/节点地址未知/) });
    expect(describeCheck({ ...base, error: "no record" }).ok).toBe(false);
    expect(describeCheck({ ...base, cloudflare: true }).text).toMatch(/灰色云朵/);
  });
});

describe("TlsDomainField", () => {
  it("checks the domain against the address typed in the wizard", async () => {
    const calls = fakeApi({
      "POST /inbound-templates/check-domain": {
        domain: "n.example.com",
        addresses: ["192.0.2.1"],
        expected: ["192.0.2.1"],
        matches: true,
        cloudflare: false,
        error: null,
      },
    });
    function Host() {
      const [v, setV] = useState("");
      return <TlsDomainField id="t" value={v} onChange={setV} connectHost="192.0.2.1" />;
    }
    renderAdmin(<Host />);
    fireEvent.change(screen.getByLabelText(/节点域名/), { target: { value: "n.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "检查解析" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/解析正确/));
    expect(calls[0].body).toEqual({ domain: "n.example.com", connect_host: "192.0.2.1" });
  });
});

describe("toSpecs with a node TLS domain", () => {
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
  it("lets TLS rows default to the node domain", () => {
    expect(toSpecs([{ ...base, template: "trojan_tls", port: "443" }])).toMatch(/节点域名/);
    expect(toSpecs([{ ...base, template: "trojan_tls", port: "443" }], "n.example.com")).toEqual([
      { template: "trojan_tls", port: 443 },
    ]);
    expect(toSpecs([{ ...base, template: "vmess_ws", port: "80", tls: true }], "n.example.com")).toEqual([
      { template: "vmess_ws", port: 80, tls: true },
    ]);
    expect(
      toSpecs([{ ...base, template: "transport", port: "443", protocol: "trojan", network: "grpc" }], "n.example.com"),
    ).toEqual([{ template: "transport", port: 443, protocol: "trojan", network: "grpc", tls: true }]);
  });
});
