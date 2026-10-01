import type { TFunction } from "../i18n";

// The SPA is served under the panel's secret route prefix. Everything is
// derived from the current location: no prefix knowledge is baked in.
const APP_MARK = "/app";

export const appBase: string = (() => {
  // "/app" as a whole path segment (a prefix may itself start with "app").
  const i = location.pathname.search(/\/app(?:\/|$)/);
  const base = i >= 0 ? location.pathname.slice(0, i) : "";
  return `${base}${APP_MARK}`;
})();

// `/{prefix}`: the secret route prefix root. Not everything lives under
// /api/v1 — the auth endpoints are mounted at `/{prefix}/auth/*`.
export const prefixBase: string = appBase.replace(/\/app$/, "");
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
  // Hint only: not enforced.
  speed_limit_mbps: number | null;
  // Reserved for seat binding (M5): not enforced.
  device_seats: number | null;
  sort: number;
  enabled: boolean;
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
  ts: string;
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

// R18-2 inbound templates (mirror of src/nodetpl.rs InboundSpec).
export type InboundSpec =
  | {
      template: "vless_reality";
      port: number;
      tag?: string;
      dest?: string;
      server_name?: string;
      fingerprint?: string;
    }
  | { template: "vless_ws_tls"; port: number; tag?: string; domain: string; path?: string }
  | { template: "vmess_ws"; port: number; tag?: string; path?: string; tls_domain?: string }
  | { template: "trojan_tls"; port: number; tag?: string; domain: string };

export interface TemplateCatalog {
  reality_dests: string[];
  fingerprints: string[];
  tls_cert_dir: string;
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
