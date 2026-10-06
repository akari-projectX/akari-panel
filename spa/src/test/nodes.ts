// Test helper (W17): the node list reads GET /nodes?view=summary and the
// node page/editor GET /nodes/{id}. `nodeRoutes` answers both from full
// NodeView fixtures, deriving the summary the way the server does.
import type { NodeSummary, NodeView } from "../lib/api";

export function summaryOf(n: NodeView): NodeSummary {
  const agent = n.latency.filter((r) => r.source === "agent");
  const hb = n.heartbeat;
  return {
    id: n.id,
    server_id: n.server_id,
    server_name: n.server_name,
    name: n.name,
    display_name: n.display_name,
    enabled: n.enabled,
    status: n.status,
    online: n.online,
    deleting_at: n.deleting_at,
    region: n.region,
    agent_version: n.agent_version,
    agent_os: n.agent_os,
    agent_arch: n.agent_arch,
    agent_protocol: n.agent_protocol,
    update_status: n.update_status,
    lease_expires_at: n.lease_expires_at,
    enrolled: n.enrolled,
    cert_not_after: n.cert_not_after,
    enroll_token_expires_at: n.enroll_token_expires_at,
    last_seen_at: n.last_seen_at,
    last_error: n.last_error,
    sort: n.sort,
    visible: n.visible,
    tags: n.tags,
    entrances: n.entrances,
    latency: agent.find((r) => r.delay_ms != null) ?? agent[0] ?? null,
    alerts_firing: 0,
    warnings: n.warnings,
    needs_certificate: false,
    heartbeat: hb
      ? {
          cpu_percent: hb.cpu_percent,
          mem_used_bytes: hb.mem_used_bytes,
          mem_total_bytes: hb.mem_total_bytes,
          connections: hb.connections,
          uptime_seconds: hb.uptime_seconds,
          ts: hb.ts,
          metrics: hb.metrics && {
            net_rx_bytes_per_sec: hb.metrics.net_rx_bytes_per_sec,
            net_tx_bytes_per_sec: hb.metrics.net_tx_bytes_per_sec,
            online_users: hb.metrics.online_users,
          },
        }
      : null,
  };
}

/** "GET /nodes" (summaries) + "GET /nodes/<id>" (full) for each fixture. */
export function nodeRoutes(nodes: NodeView[]): Record<string, unknown> {
  return {
    "GET /nodes": nodes.map(summaryOf),
    ...Object.fromEntries(nodes.map((n) => [`GET /nodes/${n.id}`, n])),
  };
}
