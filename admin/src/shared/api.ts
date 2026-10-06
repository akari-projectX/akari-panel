import { apiBase, authBase } from "./base";

/** Parameters of a coded server error (W21). */
export type ErrorParams = Record<string, string | number | boolean | null | unknown>;

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  /** Stable machine code ("plan.name_exists"); "" if none. */
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

/** Called when a request answers 401 (the session ended). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(f: (() => void) | null): void {
  onUnauthorized = f;
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: "same-origin",
      headers: init?.body && !(init.body instanceof Blob) ? { "content-type": "application/json" } : undefined,
      ...init,
    });
  } catch {
    throw new ApiError(0, "network error", { code: "" });
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, body.error ?? res.statusText, body);
  }
  if (res.status === 204) return null as T; // never undefined: `useRun` reads undefined as "failed"
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const api = <T>(path: string, init?: RequestInit) => request<T>(`${apiBase}${path}`, init);
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const get = <T>(path: string) => api<T>(path);
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, json("POST", body));
export const put = <T>(path: string, body: unknown) => api<T>(path, json("PUT", body));
export const patch = <T>(path: string, body: unknown) => api<T>(path, json("PATCH", body));
export const del = <T = void>(path: string) => api<T>(path, { method: "DELETE" });
/** Raw body (agent release files, branding images). */
export const putBinary = <T>(path: string, body: Blob, type = "application/octet-stream") =>
  api<T>(path, { method: "PUT", body, headers: { "content-type": type } });

/** `?a=1&b=x` from the defined, non-empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

// Auth endpoints live at /{prefix}/auth/*, not under /api/v1.
export const authPost = <T>(path: string, body: unknown = {}) => request<T>(`${authBase}${path}`, json("POST", body));
export const authGet = <T>(path: string) => request<T>(`${authBase}${path}`);
export const logout = () => request<void>(`${authBase}/logout`, { method: "POST" });

/** The login answer (`POST /auth/login`, `/auth/passkey/login`). */
export type LoginAnswer = {
  id: string;
  email: string;
  role: string;
  passkey_prompt?: boolean;
};

export type Me = {
  id: string;
  email: string;
  role: string;
  email_verified: boolean;
  is_owner: boolean;
};
