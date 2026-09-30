// The SPA is served under the panel's secret route prefix. Everything is
// derived from the current location: no prefix knowledge is baked in.
const APP_MARK = "/app";

export const appBase: string = (() => {
  const i = location.pathname.indexOf(APP_MARK);
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
const api = <T,>(path: string, init?: RequestInit) => request<T>(`${apiBase}${path}`, init);

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api<void>(path, { method: "DELETE" });

// Auth endpoints live at /{prefix}/auth/*, NOT under /api/v1 (see src/web.rs).
// Do not route them through get/post: that yields /api/v1/auth/* -> 404.
export const login = (body: { login: string; password: string }) =>
  request<unknown>(`${authBase}/login`, { method: "POST", body: JSON.stringify(body) });
export const logout = () => request<void>(`${authBase}/logout`, { method: "POST" });

// --- API shapes (mirror of panel/src/api.rs views) ---

export interface Me {
  id: string;
  login: string;
  role: string;
  traffic_used_bytes: number;
  traffic_limit_bytes: number | null;
  expires_at: string | null;
}

export interface UserView {
  id: string;
  login: string;
  role: string;
  enabled: boolean;
  traffic_limit_bytes: number | null;
  traffic_used_bytes: number;
  expires_at: string | null;
  created_at: string;
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
  config_version: number;
  user_version: number;
  xray_inbounds: Inbound[];
  server_addr: string | null;
  // The agent's last failed apply; null once an update applies cleanly.
  last_error: string | null;
  last_error_at: string | null;
  agent_protocol: number | null;
  lease_expires_at: string | null;
  lease_remaining_seconds: number | null;
  failed_config_version: number | null;
  failed_user_version: number | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface GeneratedAccount {
  inbound_tag: string;
  protocol: string;
  account: Record<string, unknown>;
}
