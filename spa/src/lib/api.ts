import type { TFunction } from "../i18n";
import type { PlanPrice } from "./billing";

// W27 (D4/D11): the user portal lives at `/` of the main domain; the admin
// console and the shared login for admins live under the secret admin
// prefix (`/{prefix}/admin`, `/{prefix}/app`). Everything is derived from
// the current location: no prefix knowledge is baked in, and the portal at
// `/` never learns the admin prefix.
export const prefixBase: string = (() => {
  const segs = location.pathname.split("/"); // ["", "<prefix>", "app"|"admin", ...]
  return segs.length >= 3 && segs[1] && (segs[2] === "app" || segs[2] === "admin") ? `/${segs[1]}` : "";
})();
// The user portal (and the shared login page): `/` on its own, `/{prefix}/app`
// under the admin prefix.
export const appBase: string = prefixBase ? `${prefixBase}/app` : "";
// Where "home" links go (the portal's root).
export const appHome: string = appBase || "/";
// The admin console. The user bundle knows it only as a redirect target for
// admin sessions under the admin prefix; the server answers it to admin
// sessions alone.
export const adminBase: string = `${prefixBase}/admin`;
export const apiBase: string = `${prefixBase}/api/v1`;
export const authBase: string = `${prefixBase}/auth`;

/** Parameters of a coded server error (W21): numbers and strings. */
export type ErrorParams = Record<string, string | number | boolean | null>;

export class ApiError extends Error {
  status: number;
  /** The parsed JSON error body. */
  body: Record<string, unknown>;
  /** Stable machine code of the server error ("plan.speed_limit_range"); "" if none (W21). */
  code: string;
  params: ErrorParams;
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.code = typeof body.code === "string" ? body.code : "";
    this.params =
      typeof body.params === "object" && body.params !== null && !Array.isArray(body.params)
        ? (body.params as ErrorParams)
        : {};
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    throw new ApiError(res.status, body.error ?? res.statusText, body);
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
// D1: the email address is the login name; every failure is the same 401.
export const login = async (body: { email: string; password: string }) =>
  request<LoginResult>(`${authBase}/login`, {
    method: "POST",
    body: JSON.stringify({ ...body, guard: await formGuard() }),
  });
export const logout = () => request<void>(`${authBase}/logout`, { method: "POST" });

// W15 self-service (public, /{prefix}/auth/*). While registration or reset
// is disabled the panel answers those endpoints with its canonical 404;
// the login page only offers them when `authOptions()` says so.
export interface AuthOptions {
  register: boolean;
  invite_required: boolean;
  // Empty = any domain.
  email_domains: string[];
  reset: boolean;
  // W24: false = register with email + password (no code; a proof of
  // work instead). Absent (older panels) = true.
  email_verify?: boolean;
  // W21: 系统设置 → 站点名称 (default "Akari"), for page titles.
  site_name?: string;
  // Ops: 系统设置 → 站点 branding (null when unavailable; absent on older panels).
  branding?: Branding | null;
  // W27: bot protection of the public forms (null = settings unreadable:
  // the forms refuse; absent on older panels).
  guard?: FormGuardOptions | null;
  // W27: "sign in with a passkey" works here (an https main domain).
  passkey?: boolean;
}

export interface FormGuardOptions {
  // Signed issue time; a form may be posted form_min_secs after it (null
  // when the minimum submit time is off).
  form_token: string | null;
  form_min_secs: number;
  honeypot: boolean;
  // Cloudflare Turnstile: the site key and the forms that need a token.
  turnstile: { site_key: string; login: boolean; register: boolean; reset: boolean } | null;
}

// --- Ops: branding, announcements, knowledge base ---

export const PLATFORMS = ["windows", "macos", "linux", "android", "ios", "harmony", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface FooterLink {
  label: string;
  url: string;
}
export interface ClientDownload {
  platform: Platform;
  label: string | null;
  url: string;
}
export interface Branding {
  version: number;
  /** Prefix-relative ("brand/logo?v=…"); resolve with `brandUrl`. */
  logo_url: string | null;
  favicon_url: string | null;
  footer_text: string | null;
  footer_links: FooterLink[];
  tos_url: string | null;
  privacy_url: string | null;
  client_downloads: ClientDownload[];
  updated_at: string;
}
/** A branding image URL under the secret prefix. */
export const brandUrl = (rel: string): string => `${prefixBase}/${rel}`;

export interface MyAnnouncement {
  id: string;
  title_zh: string;
  title_en: string | null;
  /** Sanitized HTML rendered by the panel (src/markdown.rs). */
  html_zh: string;
  html_en: string | null;
  pinned: boolean;
  created_at: string;
  read: boolean;
}
export interface MyAnnouncements {
  announcements: MyAnnouncement[];
  unread: number;
}

export interface HelpItem {
  id: string;
  category_id: string | null;
  title_zh: string;
  title_en: string | null;
  updated_at: string;
}
export interface HelpList {
  categories: { id: string; name_zh: string; name_en: string | null; articles: HelpItem[] }[];
  uncategorized: HelpItem[];
  total: number;
}
export interface HelpArticle {
  id: string;
  category_id: string | null;
  category_zh: string | null;
  category_en: string | null;
  title_zh: string;
  title_en: string | null;
  html_zh: string;
  html_en: string | null;
  updated_at: string;
}

/** The variant for the UI language: English when present, else Chinese. */
export function pick<T>(locale: "zh" | "en", zh: T, en: T | null | undefined): T {
  return locale === "en" && en != null && en !== "" ? en : zh;
}
// W27: the newest form token seen (every /auth/options answer carries a
// fresh one) and when it arrived.
let guardSeen: { token: string | null; min: number; at: number } | null = null;
// Tokens live 24 h on the server; refresh well before.
const GUARD_REFRESH_MS = 6 * 3600_000;

export const authOptions = async () => {
  const o = await request<AuthOptions>(`${authBase}/options`);
  if (o.guard) guardSeen = { token: o.guard.form_token, min: o.guard.form_min_secs, at: Date.now() };
  return o;
};

/** The `guard` part of a public form: the form token, posted no sooner than
 * the minimum submit time after it was issued (waits if needed), and the
 * honeypot left empty. */
export async function formGuard(): Promise<{ form_token?: string; website: string } | undefined> {
  if (!guardSeen || Date.now() - guardSeen.at > GUARD_REFRESH_MS) {
    try {
      await authOptions();
    } catch {
      return undefined;
    }
  }
  const g = guardSeen;
  if (!g) return undefined;
  const wait = g.at + g.min * 1000 + 250 - Date.now();
  if (g.min > 0 && wait > 0) await new Promise((r) => setTimeout(r, wait));
  return { ...(g.token ? { form_token: g.token } : {}), website: "" };
}

const authPost = <T>(path: string, body: unknown) =>
  request<T>(`${authBase}${path}`, { method: "POST", body: JSON.stringify(body) });
/** A public form post with its `guard` (W27). */
const guardedPost = async <T>(path: string, body: object) => authPost<T>(path, { ...body, guard: await formGuard() });
export const registerCode = (body: { email: string; invite_code?: string; locale?: string }) =>
  guardedPost<{ ok: true }>("/register/code", body);
export const register = (body: {
  email: string;
  code?: string;
  pow?: { challenge: string; nonce: string };
  password: string;
  invite_code?: string;
  locale?: string;
}) => guardedPost<LoginResult & { trial: boolean; email_verified?: boolean }>("/register", body);
/** W24: a proof-of-work challenge (registration without email verification). */
export const registerChallenge = () => request<{ challenge: string; bits: number }>(`${authBase}/register/challenge`);
export const requestReset = (body: { email: string }) => guardedPost<{ ok: true }>("/password-reset/request", body);
export const resetPassword = (body: { token: string; password: string }) =>
  authPost<{ ok: true }>("/password-reset", body);

// --- API shapes (mirror of panel/src/api.rs views) ---

export interface Me {
  id: string;
  role: string;
  traffic_used_bytes: number;
  traffic_limit_bytes: number | null;
  expires_at: string | null;
  // R21: past expiry (role=user): renewal scope only (account, plan,
  // password, shop/orders); the subscription is unavailable.
  expired: boolean;
  // R21: disabled for exceeding the traffic limit: same renewal scope.
  quota_exhausted: boolean;
  // W28-c: banned by an admin: only this account view (with the reason,
  // written for the user) and tickets; everything else is 403
  // `account.banned`.
  banned: boolean;
  ban_reason: string | null;
  banned_at: string | null;
  // D1: the account's email address (its login name) and whether it is
  // verified (only a verified one gets mail and resets the password);
  // language of the mails.
  email: string;
  email_verified: boolean;
  locale: "zh" | "en";
  // W20 (B1): the subscription link, always retrievable (stored encrypted).
  // D11: `sub_url` is absolute when a subscription/main domain is set, else
  // root-relative on this origin (`/<sub path>/<token>`: absoluteUrl); both
  // null for admins and the renewal scope.
  sub_token: string | null;
  sub_url: string | null;
  // A pre-W20 link: still works, cannot be shown until it is reset.
  sub_legacy: boolean;
  /** PR ② section 5: the formats that are on, the import buttons to show (absent = all). */
  sub_formats?: string[];
  sub_import_clients?: string[];
  // Effective latency-test interval (seconds), for the node list text.
  probe_interval_secs: number;
}

/** The subscription URL of `me`, or null (none to show). */
export function mySubUrl(me: Pick<Me, "sub_token" | "sub_url">): string | null {
  return me.sub_url ? absoluteUrl(me.sub_url) : null;
}

export interface LoginResult {
  id: string;
  email: string;
  role: string;
  expired: boolean;
  quota_exhausted: boolean;
  // W27: offer binding a passkey (policy on, the account has none).
  passkey_prompt?: boolean;
}

export interface AuditEntry {
  id: number;
  at: string;
  actor_id: string | null;
  // Q4: non-personal label ("u-1a2b3c4d", "cli", "system", …); the actor's
  // current address when it is an account (null once deleted).
  actor_label: string;
  actor_email: string | null;
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

// A link from the API: absolute, or root-relative on this origin (D11: a
// subscription link when no domain is configured).
export const absoluteUrl = (u: string): string => (u.startsWith("/") ? `${location.origin}${u}` : u);

export interface UserView {
  id: string;
  role: string;
  enabled: boolean;
  traffic_limit_bytes: number | null;
  traffic_used_bytes: number;
  expires_at: string | null;
  created_at: string;
  // Why the account is disabled (null while enabled): "admin" = banned
  // (W28-c). Only "quota" is ever re-enabled automatically (period reset,
  // plan change, traffic reset).
  disabled_reason: "admin" | "quota" | null;
  // M3: the active plan (null = none) and its next traffic reset.
  plan_id: string | null;
  plan_name: string | null;
  next_reset_at: string | null;
  // D1: the login name.
  email: string;
  email_verified: boolean;
}

/** W21: GET /users — one page and the number of users matching the filters. */
export interface UserPage {
  users: UserView[];
  total: number;
}

// --- M3: node groups, plans, user plans (mirror of src/plans.rs) ---

export interface GroupView {
  id: string;
  name: string;
  description: string;
  // W28-a: groups hold entrances (plans -> node groups -> entrances).
  entrance_ids: string[];
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
  /** 中-6: off sale, its subscribers can still renew / buy the reset pack. */
  renew_off_sale: boolean;
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
/** D12: a user's current subscription (GET /users/{id}). */
export interface SubscriptionView {
  user_plan_id: string;
  plan_id: string;
  plan_name: string;
  /** The term it was assigned/bought or last renewed with (period kind) and its days. */
  period: "month" | "quarter" | "half_year" | "year" | "two_year" | "three_year" | "days" | "onetime";
  period_days: number | null;
  starts_at: string;
  expires_at: string | null;
  traffic_used_bytes: number;
  traffic_total_bytes: number | null;
  /** The plan's traffic reset period: "monthly", "days-N" or "none". */
  reset_period: string;
  last_reset_at: string | null;
  next_reset_at: string | null;
  speed_limit_mbps: number | null;
  status: "banned" | "over_quota" | "expired" | "active";
}

/** W28-c: the ban of a banned account. */
export interface BanView {
  reason: string | null;
  banned_at: string | null;
  banned_by_id: string | null;
  banned_by_email: string | null;
}

/** GET /users/{id}: the list row, the current subscription and the ban. */
export interface UserDetail extends UserView {
  subscription: SubscriptionView | null;
  ban: BanView | null;
}

// An xray inbound object (W28-a/D2: a node has one; the panel names it,
// so the stored object has no tag).
export interface Inbound {
  tag?: string;
  [k: string]: unknown;
}

// W28-a: how clients reach a node (mirror of entrances.rs EntranceView).
// Every node has its built-in "direct" entrance; "relay" = an external
// relay forwarding to the node's derived inbound on listen_port.
export interface EntranceView {
  id: string;
  kind: "direct" | "relay";
  name: string;
  // What clients dial: null host = the node's TLS domain, null port = the
  // inbound's port.
  connect_host: string | null;
  connect_port: number | null;
  rate_permille: number;
  rate: number;
  enabled: boolean;
  sort: number;
  wire_no: number;
  listen_port: number | null;
  source_cidrs: string[];
  // Relay health (panel TCP test): null = not tested; hidden_since set =
  // left out of subscriptions until it answers again.
  health_ok: boolean | null;
  health_at: string | null;
  health_failures: number;
  health_error: string | null;
  hidden_since: string | null;
  group_ids: string[];
}

/** The node's built-in direct entrance. */
export function directEntrance(n: { entrances: EntranceView[] }): EntranceView | undefined {
  return n.entrances.find((e) => e.kind === "direct");
}

export interface NodeView {
  id: string;
  // Q1: the server (machine, agent) the node runs on; the machine fields
  // below (status, agent, certificate, lease, TLS domain…) are its.
  server_id: string;
  server_name: string;
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
  // W28-a (D2): the node's one inbound; null = not configured yet.
  inbound: Inbound | null;
  entrances: EntranceView[];
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
  // to users, tags (multiplier, address and groups: the entrances).
  display_name: string | null;
  sort: number;
  visible: boolean;
  tags: string[];
  // W11: bytes accepted on the node (before the multiplier) and billed.
  traffic_raw_bytes: number;
  traffic_billed_bytes: number;
  // W11: online by the reaper's rule; latest latency results.
  online: boolean;
  latency: LatencyResult[];
  probe_requested_at: string | null;
}

// W17: one row of GET /nodes?view=summary (the node list): only the list's
// columns, a slim heartbeat, the best agent latency result. The node page
// fetches GET /nodes/{id} (NodeView). Mirror of api.rs NodeSummary.
export interface NodeSummary {
  id: string;
  // Q1: the node's server (machine fields below are the server's).
  server_id: string;
  server_name: string;
  name: string;
  display_name: string | null;
  enabled: boolean;
  status: string;
  online: boolean;
  deleting_at: string | null;
  region: string | null;
  agent_version: string | null;
  agent_os: string | null;
  agent_arch: string | null;
  agent_protocol: number | null;
  update_status: NodeUpdateStatus | null;
  lease_expires_at: string | null;
  enrolled: boolean;
  cert_not_after: string | null;
  enroll_token_expires_at: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  sort: number;
  visible: boolean;
  tags: string[];
  entrances: EntranceView[];
  latency: LatencyResult | null;
  alerts_firing: number;
  warnings: string[];
  needs_certificate: boolean;
  heartbeat: HeartbeatSummary | null;
}

// W23: null = the agent could not read the value (shown as 未知, never 0).
export interface HeartbeatSummary {
  cpu_percent: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
  connections: number;
  uptime_seconds?: number | null;
  ts: string;
  metrics?: { net_rx_bytes_per_sec: number | null; net_tx_bytes_per_sec: number | null; online_users: number };
}

// W17: support tickets (customer side; mirror of tickets.rs).
export type TicketCategory = "general" | "billing" | "technical" | "account" | "other";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketStatus = "open" | "answered" | "closed";
export const TICKET_CATEGORIES: TicketCategory[] = ["general", "billing", "technical", "account", "other"];
export const TICKET_PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];
export const TICKET_MAX_SUBJECT = 120;
export const TICKET_MAX_BODY = 5000;

export interface MyTicketRow {
  id: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  messages: number;
  created_at: string;
  updated_at: string;
  unread: boolean;
}

export interface TicketMessage {
  id: number;
  staff: boolean;
  // Staff view only (customers never learn who on the staff wrote): the
  // snapshot label and the author's current address.
  author_label?: string;
  author_email?: string | null;
  body: string;
  created_at: string;
}

export interface MyTicketView {
  id: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  order_id: string | null;
  order_no: string | null;
  node_id: string | null;
  node_name: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: "user" | "staff" | null;
  messages: TicketMessage[];
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
  probe_requested_at: string | null;
}

// W11: GET /nodes/{id}/metrics?range=… (averages per point; *_max maxima).
// W23: null = unknown in that interval (a gap in the chart).
export interface MetricsPoint {
  t: string;
  samples: number;
  cpu: number | null;
  cpu_max: number | null;
  load1: number | null;
  mem_used: number | null;
  mem_total: number | null;
  swap_used: number | null;
  swap_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
  rx_bps_max: number | null;
  tx_bps_max: number | null;
  tcp: number | null;
  udp: number | null;
  conns: number | null;
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
  // W28-a: the entrance's name (one row per usable entrance).
  entrance: string;
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
  // W23: the rollout is over and the node was reinstalled (enrolled again)
  // after its last step there: history, not the node's current state.
  superseded?: boolean;
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

/** One-click update check (mirror of src/updatecheck.rs StatusView). */
export interface AgentUpdateStatus {
  version: number;
  /** The stored source (null = default_source_url). */
  source_url: string | null;
  default_source_url: string;
  auto_check: boolean;
  next_auto_check_at: string | null;
  checking: boolean;
  keys_configured: boolean;
  last_check: {
    at: string;
    ok: boolean;
    result: "stored" | "up_to_date" | "failed";
    version: string | null;
    code: string | null;
    params: Record<string, unknown> | null;
    message: string | null;
    stored: string[];
  } | null;
  /** The newest complete (non-rollback) stored release. */
  latest: { version: string; platforms: string[] } | null;
  outdated_servers: number;
  /** latest.version when nodes run something older ("有新版本" badge). */
  update_available: string | null;
}

export type RolloutStatus = "running" | "paused" | "halted" | "aborted" | "completed";
export type RolloutNodeStatus = "pending" | "offered" | "updating" | "healthy" | "failed" | "skipped";

export interface RolloutView {
  id: string;
  version: string;
  status: RolloutStatus;
  waves: number[];
  percentage: number;
  explicit_servers: boolean;
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
  server_id: string;
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
  servers: RolloutNodeView[];
}

export interface CreateRollout {
  version: string;
  percentage?: number;
  server_ids?: string[];
  waves?: number[];
  health_timeout_secs?: number;
  max_failure_ratio?: number;
}

// W23: a null value = the agent could not read it (shown as 未知, never 0).
export interface Heartbeat {
  cpu_percent: number | null;
  mem_used_bytes: number | null;
  mem_total_bytes: number | null;
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
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpu_count: number | null;
  swap_used_bytes: number | null;
  swap_total_bytes: number | null;
  disk_used_bytes: number | null;
  disk_total_bytes: number | null;
  net_interface: string;
  net_rx_bytes_per_sec: number | null;
  net_tx_bytes_per_sec: number | null;
  net_rx_bytes_total: number | null;
  net_tx_bytes_total: number | null;
  tcp_sockets: number | null;
  udp_sockets: number | null;
  online_users: number;
  process_rss_bytes: number | null;
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

// One-time enrollment material (POST /nodes without server_id: a new
// server for the node; POST /servers/{id}/enroll-token): shown once, only
// the token's hash is stored. `id` is the node's (POST /nodes) or the
// server's (enroll-token).
export interface NodeEnrollment {
  id: string;
  server_id?: string;
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
  | ({ template: "vless_reality"; port: number; vision?: boolean } & RealityOpts)
  | ({ template: "vless_reality_xhttp"; port: number; path?: string; mode?: string } & RealityOpts)
  // W10: domain/tls_domain default to the node's TLS domain (tls: true).
  | { template: "vless_tls_vision"; port: number; domain?: string }
  | { template: "vless_ws_tls"; port: number; domain?: string; path?: string }
  | { template: "vmess_ws"; port: number; path?: string; tls_domain?: string; tls?: boolean }
  | { template: "vmess_tcp"; port: number }
  | { template: "trojan_tls"; port: number; domain?: string }
  | {
      template: "transport";
      port: number;
      protocol: "vless" | "vmess" | "trojan";
      network: "ws" | "httpupgrade" | "xhttp" | "grpc";
      path?: string;
      host?: string;
      mode?: string;
      service_name?: string;
      tls_domain?: string;
      tls?: boolean;
    }
  | { template: "shadowsocks_2022"; port: number; method?: string }
  | { template: "hysteria2"; port: number; domain?: string };

export interface TemplateCatalog {
  reality_dests: string[];
  fingerprints: string[];
  tls_cert_dir: string;
  ss_methods?: string[];
  xhttp_modes?: string[];
}

export interface RenderedInbound {
  inbound: Inbound;
  needs_certificate: boolean;
}

export interface CheckDestView {
  ok: boolean;
  tls13: boolean;
  h2: boolean;
  trusted: boolean;
  error: string | null;
}
