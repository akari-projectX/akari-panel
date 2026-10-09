// API shapes shared by several console views (mirrors of the panel's
// views: servers.rs, entrances.rs, plans.rs, catalog.rs).

export type RateRuleView = { weekdays: number[]; start: number; end: number; rate: number };

export type EntranceView = {
  id: string;
  node_id?: string;
  kind: "direct" | "relay";
  name: string;
  connect_host: string | null;
  connect_port: number | null;
  rate_permille: number;
  rate: number;
  rate_now: number;
  rate_rules: RateRuleView[];
  enabled: boolean;
  sort: number;
  wire_no: number;
  /** Optimistic concurrency: sent back with PATCH, 409 when the entrance changed since. */
  version: number;
  listen_port: number | null;
  source_cidrs: string[];
  health_ok: boolean | null;
  health_at: string | null;
  health_failures: number;
  health_error: string | null;
  hidden_since: string | null;
  group_ids: string[];
};

export type ServerNode = {
  id: string;
  name: string;
  display_name: string | null;
  enabled: boolean;
  visible: boolean;
  sort: number;
  region: string | null;
  tags: string[];
  protocol: string | null;
  port: number | null;
  block_rules_enabled: boolean;
  entrances: EntranceView[];
};

export type TrafficQuota = {
  bytes: number | null;
  mode: "both" | "up" | "down";
  reset_day: number | null;
  next_reset_at: string | null;
  period_start: string | null;
  rx_bytes: number;
  tx_bytes: number;
  used_bytes: number;
  exceeded_at: string | null;
};

export type HeartbeatMetrics = {
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpu_count: number | null;
  disk_used_bytes: number | null;
  disk_total_bytes: number | null;
  net_interface: string;
  net_rx_bytes_per_sec: number | null;
  net_tx_bytes_per_sec: number | null;
  online_users: number;
  process_rss_bytes: number | null;
  xray_version: string;
};

export type CertStatus = {
  state: string;
  domain?: string | null;
  not_after?: string | null;
  error_kind?: string | null;
  error?: string | null;
};

export type Heartbeat = {
  cpu_percent: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
  connections: number;
  uptime_seconds?: number | null;
  ts: string;
  cert?: CertStatus | null;
  metrics?: HeartbeatMetrics;
  block?: unknown;
  source_filter?: { state?: string; error?: string | null } | null;
};

export type UpdateStatus = {
  rollout_id: string;
  version: string;
  rollout_status: string;
  status: string;
  detail: string | null;
  superseded?: boolean;
};

export type ServerView = {
  id: string;
  name: string;
  created_at: string;
  status: string;
  online: boolean;
  agent_version: string | null;
  core_version: string | null;
  agent_os: string | null;
  agent_arch: string | null;
  agent_protocol: number | null;
  agent_capabilities?: string[] | null;
  update_status: UpdateStatus | null;
  config_version: number;
  user_version: number;
  tls_domain: string | null;
  agent_addr: string | null;
  last_error: string | null;
  last_error_at: string | null;
  lease_expires_at: string | null;
  lease_remaining_seconds: number | null;
  traffic_max_rate_bytes_per_sec: number | null;
  deleting_at: string | null;
  last_seen_at: string | null;
  enrolled: boolean;
  cert_not_after: string | null;
  enroll_token_expires_at: string | null;
  latency: unknown;
  probe_requested_at: string | null;
  alerts_firing: number;
  traffic_quota: TrafficQuota;
  heartbeat: Heartbeat | null;
  warnings: string[];
  nodes: ServerNode[];
};

export type NodeGroup = {
  id: string;
  name: string;
  description: string;
  entrance_ids: string[];
  plan_ids: string[];
};

export type PlanPrice = { period: string; days: number | null; price_cents: number };

export type PlanView = {
  id: string;
  name: string;
  /** Traffic reset: "monthly" | "none" | "days-N" (plans.rs). */
  period: string;
  traffic_quota_bytes: number | null;
  speed_limit_mbps: number | null;
  device_seats: number | null;
  sort: number;
  enabled: boolean;
  group_ids: string[];
  description: string;
  capacity: number | null;
  renewal_only: boolean;
  renew_off_sale: boolean;
  allow_switch_in: boolean;
  on_sale: boolean;
  prices: PlanPrice[];
  active_users: number;
};

/** Install / enrollment answer (servers.rs `create_with_enrollment`, nodeinstall). */
export type InstallView = {
  command?: string;
  command_wget?: string;
  expires_at?: string;
  warnings?: string[];
  bootstrap?: string;
  enroll_token?: string;
  token_expires_at?: string;
  [k: string]: unknown;
};
