// The SPA is served under the panel's secret route prefix. Everything is
// derived from the current location: no prefix knowledge is baked in.
const APP_MARK = "/app";

export const appBase: string = (() => {
  const i = location.pathname.indexOf(APP_MARK);
  const base = i >= 0 ? location.pathname.slice(0, i) : "";
  return `${base}${APP_MARK}`;
})();

export const apiBase: string = `${appBase.replace(/\/app$/, "")}/api/v1`;

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
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

export const get = <T,>(path: string) => api<T>(path);
export const post = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const put = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const del = (path: string) => api<void>(path, { method: "DELETE" });

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
  last_seen_at: string | null;
  created_at: string;
}

export interface GeneratedAccount {
  inbound_tag: string;
  protocol: string;
  account: Record<string, unknown>;
}
