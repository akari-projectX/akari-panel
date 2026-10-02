import type { TFunction } from "../i18n";
import type { PlanPrice } from "./billing";

// Two bundles are served under the panel's secret route prefix (R23): the
// user portal at /{prefix}/app and the admin console at /{prefix}/admin.
// Everything is derived from the current location (the prefix is the first
// path segment): no prefix knowledge is baked in.
export const prefixBase: string = (() => {
  const segs = location.pathname.split("/"); // ["", "<prefix>", "app", ...]
  return segs.length >= 3 && segs[1] ? `/${segs[1]}` : "";
})();
// The user portal (and the shared login page).
export const appBase: string = `${prefixBase}/app`;
// The admin console. The user bundle knows it only as a redirect target for
// admin sessions; the server answers it to admin sessions alone.
export const adminBase: string = `${prefixBase}/admin`;
export const apiBase: string = `${prefixBase}/api/v1`;
export const authBase: string = `${prefixBase}/auth`;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// REST helpers: `path` is relative to apiBase (/{prefix}/api/v1).
const api = <T>(path: string, init?: RequestInit) => request<T>(`${apiBase}${path}`, init);

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = <T = void>(path: string) => api<T>(path, { method: "DELETE" });
// Raw body (agent release binaries, M6).
export const putBinary = <T>(path: string, body: Blob) =>
  request<T>(`${apiBase}${path}`, {
    method: "PUT",
    body,
    headers: { "content-type": "application/octet-stream" },
  });

// Auth endpoints live at /{prefix}/auth/*, NOT under /api/v1 (see src/web.rs).
// Do not route them through get/post: that yields /api/v1/auth/* -> 404.
// `code`: TOTP code or recovery code (required by accounts with 2FA; every
// failure is the same 401, so the form always offers the field).
export const login = (body: { login: string; password: string; code?: string }) =>
  request<LoginResult>(`${authBase}/login`, { method: "POST", body: JSON.stringify(body) });
export const logout = () => request<void>(`${authBase}/logout`, { method: "POST" });

// --- API shapes (mirror of panel/src/api.rs views) ---

export interface Me {
  id: string;
  login: string;
  role: string;
  traffic_used_bytes: number;
  traffic_limit_bytes: number | null;
  expires_at: string | null;
  // R21: past expiry (role=user): renewal scope only (account, plan,
  // password, shop/orders); subscription and 2FA are unavailable.
  expired: boolean;
  // R21: disabled for exceeding the traffic limit: same renewal scope.
  quota_exhausted: boolean;
}

// "enroll": only with auth.require_admin_2fa, an admin without 2FA; only the
// /me/totp endpoints accept it.
export type Stage = "full" | "enroll";

export interface LoginResult {
  id: string;
  login: string;
  role: string;
  stage: Stage;
}

export interface TotpStatus {
  id: string;
  login: string;
  role: string;
  stage: Stage;
  enabled: boolean;
  pending: boolean;
  recovery_codes_left: number;
  // auth.require_admin_2fa: admins without 2FA only get an enrollment
  // session. Off by default (2FA is optional, recommended to admins).
  admin_2fa_required: boolean;
}

export interface TotpEnrollment {
  secret: string;
  otpauth_uri: string;
  digits: number;
  period: number;
  algorithm: string;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_id: string | null;
  actor_login: string;
  ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before: unknown;
  after: unknown;
}

export interface AuditPage {
  entries: AuditEntry[];
  next_before: number | null;
}

// Subscription URL for a token (same origin, current secret prefix).
export const subscriptionUrl = (token: string): string => `${location.origin}${prefixBase}/sub/${token}`;

export interface UserView {
  id: string;
  login: string;
  role: string;
  enabled: boolean;
  traffic_limit_bytes: number | null;
  traffic_used_bytes: number;
  expires_at: string | null;
  created_at: string;
  totp_enabled: boolean;
  // Why the account is disabled (null while enabled). Only "quota" is ever
  // re-enabled automatically (period reset, plan change).
  disabled_reason: "admin" | "quota" | "expiry" | null;
  // M3: the active plan (null = none) and its next traffic reset.
  plan_id: string | null;
  plan_name: string | null;
  next_reset_at: string | null;
}

// --- M3: node groups, plans, user plans (mirror of src/plans.rs) ---

export interface GroupView {
  id: string;
  name: string;
  description: string;
  node_ids: string[];
  plan_ids: string[];
  created_at: string;
  updated_at: string;
}

// "monthly" | "none" | "days-N"
export type Period = string;

export interface PlanView {
  id: string;
  name: string;
  traffic_quota_bytes: number | null;
  period: Period;
  // Per user, both directions, enforced by the agent (protocol 4, W7).
  speed_limit_mbps: number | null;
  // Reserved for seat binding (R25): not enforced until the client ships.
  device_seats: number | null;
  sort: number;
  enabled: boolean;
  // W7 catalogue: Markdown-lite description, shop flag, stock and rules.
  description: string;
  on_sale: boolean;
  capacity: number | null;
  renewal_only: boolean;
  allow_switch_in: boolean;
  prices: PlanPrice[];
  group_ids: string[];
  active_users: number;
  created_at: string;
  updated_at: string;
}

export interface UserPlanView {
  id: string;
  plan_id: string;
  plan_name: string;
  status: "active" | "replaced" | "cancelled" | "expired";
  starts_at: string;
  expires_at: string | null;
  period_anchor: string;
  last_reset_at: string | null;
  next_reset_at: string | null;
  ended_at: string | null;
}

export interface UserPlanState {
  active: UserPlanView | null;
  history: UserPlanView[];
}

export interface MyPlan {
  plan: {
    name: string;
    traffic_quota_bytes: number | null;
    period: Period;
    speed_limit_mbps: number | null;
    device_seats: number | null;
    starts_at: string;
    expires_at: string | null;
    period_anchor: string;
    last_reset_at: string | null;
    next_reset_at: string | null;
  } | null;
  traffic_used_bytes: number;
  traffic_limit_bytes: number | null;
  expires_at: string | null;
  nodes: { name: string; region: string | null }[];
}

export function describePeriod(p: Period, t: TFunction): string {
  if (p === "monthly") return t("portal.periodMonthly");
  if (p === "none") return t("portal.periodNone");
  const m = /^days-(\d+)$/.exec(p);
  return m ? t("portal.periodDays", { days: m[1] }) : p;
}

// GET /users/{id}/nodes: an account's node access (no credentials).
export interface UserNodeView {
  node_id: string;
  name: string;
  region: string | null;
  enabled: boolean;
  status: string;
  deleting: boolean;
  // true = admin assignment, false = granted by the plan.
  manual: boolean;
  inbounds: { tag: string; protocol: string }[];
}

export interface Inbound {
  tag: string;
  [k: string]: unknown;
}

export interface NodeView {
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  agent_version: string | null;
  core_version: string | null;
  // M6: platform of the connected agent and its latest rollout entry.
  agent_os: string | null;
  agent_arch: string | null;
  update_status: NodeUpdateStatus | null;
  config_version: number;
  user_version: number;
  xray_inbounds: Inbound[];
  server_addr: string | null;
  // M3: region shown to users in the portal.
  region: string | null;
  // W10: the node's TLS domain ("节点域名": the agent obtains the
  // certificate itself; null = certificate files installed by hand) and the
  // agent's source address as the panel saw it.
  tls_domain?: string | null;
  agent_addr?: string | null;
  // The agent's last failed apply; null once an update applies cleanly.
  last_error: string | null;
  last_error_at: string | null;
  agent_protocol: number | null;
  lease_expires_at: string | null;
  lease_remaining_seconds: number | null;
  failed_config_version: number | null;
  failed_user_version: number | null;
  // Per-node billing plausibility cap override (bytes/s); null = default.
  traffic_max_rate_bytes_per_sec: number | null;
  // Set while the node is being deleted; the row disappears when done.
  deleting_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  // Certificate enrollment (M1-8): whether the agent holds a certificate,
  // its expiry, and the expiry of a live (unused) enrollment token.
  enrolled: boolean;
  cert_not_after: string | null;
  enroll_token_expires_at: string | null;
  // Last heartbeat (null when none in the last 10 minutes).
  heartbeat: Heartbeat | null;
  // Problems the admin must fix (stored config, certificate expiry).
  warnings: string[];
  // W11 (xboard-style form): user-facing name (null = name), order, shown
  // to users, tags, multiplier (permille and as a number), per-inbound
  // client-facing host/port, node groups.
  display_name: string | null;
  sort: number;
  visible: boolean;
  tags: string[];
  traffic_rate_permille: number;
  traffic_rate: number;
  connect_overrides: Record<string, ConnectOverride>;
  group_ids: string[];
  // W11: bytes accepted on the node (before the multiplier) and billed.
  traffic_raw_bytes: number;
  traffic_billed_bytes: number;
  // W11: online by the reaper's rule; latest latency results.
  online: boolean;
  latency: LatencyResult[];
  probe_requested_at: string | null;
}

export interface ConnectOverride {
  host?: string;
  port?: number;
}

// W11: one latency result. source "agent" = the node's url-test (target =
// URL), "panel" = TCP connect from the panel (target = inbound tag);
// delay_ms null = failed (error: "timeout", "refused", "udp" = n/a, ...).
export interface LatencyResult {
  source: "agent" | "panel";
  target: string;
  delay_ms: number | null;
  error: string | null;
  measured_at: string;
}

// W11: GET /nodes/{id}/status.
export interface NodeStatus {
  id: string;
  status: string;
  online: boolean;
  last_seen_at: string | null;
  heartbeat: Heartbeat | null;
  latency: LatencyResult[];
  traffic_raw_bytes: number;
  traffic_billed_bytes: number;
  traffic_rate: number;
  probe_requested_at: string | null;
}

// W11: GET /nodes/{id}/metrics?range=… (averages per point; *_max maxima).
export interface MetricsPoint {
  t: string;
  samples: number;
  cpu: number;
  cpu_max: number;
  load1: number;
  mem_used: number;
  mem_total: number;
  swap_used: number;
  swap_total: number;
  disk_used: number;
  disk_total: number;
  rx_bps: number;
  tx_bps: number;
  rx_bps_max: number;
  tx_bps_max: number;
  tcp: number;
  udp: number;
  conns: number;
  conns_max: number;
  users: number;
  users_max: number;
}

export interface NodeMetricsView {
  range: string;
  step_secs: number;
  points: MetricsPoint[];
}

// W11: GET /me/nodes (portal): no ids, addresses or machine metrics.
export interface MyNodeStatus {
  name: string;
  region: string | null;
  tags: string[];
  rate: number;
  online: boolean;
  latency_ms: number | null;
  latency_status: "ok" | "timeout" | "unknown";
  latency_measured_at: string | null;
}

export interface NodeUpdateStatus {
  rollout_id: string;
  version: string;
  rollout_status: RolloutStatus;
  status: RolloutNodeStatus;
  detail: string | null;
}

// --- M6 agent self-update (mirror of src/updates.rs / src/rollout.rs) ---

export interface ReleaseView {
  id: string;
  version: string;
  os: string;
  arch: string;
  sha256: string;
  size: number;
  key_id: string;
  min_panel_protocol: number;
  rollback: boolean;
  complete: boolean;
  created_at: string;
  complete_at: string | null;
}

export type RolloutStatus = "running" | "paused" | "halted" | "aborted" | "completed";
export type RolloutNodeStatus = "pending" | "offered" | "updating" | "healthy" | "failed" | "skipped";

export interface RolloutView {
  id: string;
  version: string;
  status: RolloutStatus;
  waves: number[];
  percentage: number;
  explicit_nodes: boolean;
  current_wave: number;
  wave_started_at: string;
  health_timeout_secs: number;
  max_failure_ratio: number;
  halted_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  counts: Partial<Record<RolloutNodeStatus, number>>;
}

export interface RolloutNodeView {
  node_id: string;
  name: string;
  wave: number;
  position: number;
  status: RolloutNodeStatus;
  from_version: string | null;
  agent_version: string | null;
  offered_at: string | null;
  finished_at: string | null;
  detail: string | null;
}

export interface RolloutDetail extends RolloutView {
  nodes: RolloutNodeView[];
}

export interface CreateRollout {
  version: string;
  percentage?: number;
  node_ids?: string[];
  waves?: number[];
  health_timeout_secs?: number;
  max_failure_ratio?: number;
}

export interface Heartbeat {
  cpu_percent: number;
  mem_used_bytes: number;
  mem_total_bytes: number;
  connections: number;
  uptime_seconds?: number;
  lease_remaining_seconds: number | null;
  // W10 (agent protocol 6): the automatic certificate, while the node has a
  // TLS domain and an inbound that needs a certificate.
  cert?: CertStatus | null;
  ts: string;
  // W11: machine status from agents with capability "metrics".
  metrics?: HeartbeatMetrics;
}

export interface HeartbeatMetrics {
  load1: number;
  load5: number;
  load15: number;
  cpu_count: number;
  swap_used_bytes: number;
  swap_total_bytes: number;
  disk_used_bytes: number;
  disk_total_bytes: number;
  net_interface: string;
  net_rx_bytes_per_sec: number;
  net_tx_bytes_per_sec: number;
  net_rx_bytes_total: number;
  net_tx_bytes_total: number;
  tcp_sockets: number;
  udp_sockets: number;
  online_users: number;
  process_rss_bytes: number;
  xray_version: string;
}

export type CertErrorKind =
  "dns" | "connection" | "rate_limited" | "port_busy" | "caa" | "rejected" | "ca_unreachable" | "other";

// Mirror of grpc::cert_status_json.
export interface CertStatus {
  domain: string;
  state: "pending" | "valid" | "failed" | "unknown";
  not_after: string | null;
  next_attempt: string | null;
  last_error: string | null;
  error_kind: CertErrorKind | null;
  last_error_at: string | null;
  challenge: string | null;
  failures: number;
}

// POST /inbound-templates/check-domain (warn only).
export interface CheckDomainView {
  domain: string;
  addresses: string[];
  expected: string[];
  matches: boolean | null;
  cloudflare: boolean;
  error: string | null;
}

// One-time enrollment material (POST /nodes, POST /nodes/{id}/enroll-token):
// shown once, only the token's hash is stored.
export interface NodeEnrollment {
  id: string;
  name: string;
  enrollment_token: string;
  expires_at: string;
  bootstrap: string;
  // R18-2: present when the create request asked for an install link.
  install?: InstallView;
}

// R18-2 one-line installer (mirror of src/nodeinstall.rs InstallView).
export interface InstallView {
  url: string;
  command: string;
  // Absent when the panel certificate is pinned (wget cannot pin).
  command_wget: string | null;
  uninstall_command: string;
  expires_at: string;
  pin: string | null;
  releases: Record<string, { version: string; sha256: string }>;
  fallback_binary_url: string | null;
  warnings: string[];
}

// R18-2 / W8 inbound templates (mirror of src/nodetpl.rs InboundSpec).
interface RealityOpts {
  dest?: string;
  server_name?: string;
  fingerprint?: string;
}
export type InboundSpec =
  | ({ template: "vless_reality"; port: number; tag?: string; vision?: boolean } & RealityOpts)
  | ({ template: "vless_reality_xhttp"; port: number; tag?: string; path?: string; mode?: string } & RealityOpts)
  // W10: domain/tls_domain default to the node's TLS domain (tls: true).
  | { template: "vless_tls_vision"; port: number; tag?: string; domain?: string }
  | { template: "vless_ws_tls"; port: number; tag?: string; domain?: string; path?: string }
  | { template: "vmess_ws"; port: number; tag?: string; path?: string; tls_domain?: string; tls?: boolean }
  | { template: "vmess_tcp"; port: number; tag?: string }
  | { template: "trojan_tls"; port: number; tag?: string; domain?: string }
  | {
      template: "transport";
      port: number;
      tag?: string;
      protocol: "vless" | "vmess" | "trojan";
      network: "ws" | "httpupgrade" | "xhttp" | "grpc";
      path?: string;
      host?: string;
      mode?: string;
      service_name?: string;
      tls_domain?: string;
      tls?: boolean;
    }
  | { template: "shadowsocks_2022"; port: number; tag?: string; method?: string }
  | { template: "hysteria2"; port: number; tag?: string; domain?: string };

export interface TemplateCatalog {
  reality_dests: string[];
  fingerprints: string[];
  tls_cert_dir: string;
  ss_methods?: string[];
  xhttp_modes?: string[];
}

export interface RenderedInbounds {
  inbounds: Inbound[];
  needs_certificate: boolean;
}

export interface CheckDestView {
  ok: boolean;
  tls13: boolean;
  h2: boolean;
  trusted: boolean;
  error: string | null;
}

export interface GeneratedAccount {
  inbound_tag: string;
  protocol: string;
  account: Record<string, unknown>;
}
