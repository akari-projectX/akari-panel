import { apiBase, authBase } from './base';

/**
 * 与面板之间的请求层。
 *
 *   · 会话是面板发的 httpOnly + SameSite=Strict cookie，前端看不到也不存任何令牌，
 *     每个请求都带 credentials: 'same-origin'；登录状态以 GET /me 是否 401 为准；
 *   · 错误体是 {error, code, params}：页面按 code 映射文案（lib/errors），不显示 error 原文；
 *   · 统一的拒绝（404 空 body）不带任何信息，前端不从中区分原因。
 *
 * 会话失效（401）与账户被封（403 account.banned）是全站的事，不是哪一页的事：
 * 这里只负责把它们广播出去，由 AuthProvider 收尾（退回登录页 / 换成封禁视图）。
 */

export type ErrorParams = Record<string, string | number | boolean | null>;

export class ApiError extends Error {
  readonly status: number;
  /** 面板的稳定错误码（"order.in_progress"）；没有时为空串 */
  readonly code: string;
  readonly params: ErrorParams;

  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = typeof body.code === 'string' ? body.code : '';
    this.params = typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params)
      ? (body.params as ErrorParams)
      : {};
  }
}

type Listener = (err: ApiError) => void;
const listeners = new Set<Listener>();

/** 订阅「会话失效 / 账户被封」这类全站事件；返回取消订阅 */
export function onSessionEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/* 这几个请求的 401 是「没登录」的正常答复，不是「会话中途失效」，不广播 */
const QUIET_401 = new Set([`${apiBase}/me`, `${authBase}/login`, `${authBase}/passkey/login`]);

export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: init.body !== undefined ? { 'content-type': 'application/json', ...init.headers } : init.headers,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = new ApiError(res.status, typeof body.error === 'string' ? body.error : res.statusText, body);
    if ((res.status === 401 && !QUIET_401.has(url.split('?')[0])) || err.code === 'account.banned') {
      listeners.forEach((f) => f(err));
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body ?? {}) });

/** /api/v1 下的接口；path 以 / 开头 */
export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(`${apiBase}${path}`, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(`${apiBase}${path}`, json('POST', body)),
  put: <T>(path: string, body: unknown) => request<T>(`${apiBase}${path}`, json('PUT', body)),
  patch: <T>(path: string, body: unknown) => request<T>(`${apiBase}${path}`, json('PATCH', body)),
  del: <T = void>(path: string) => request<T>(`${apiBase}${path}`, { method: 'DELETE' }),
};

/** /auth 下的接口（不在 /api/v1 下面，见面板 src/web.rs） */
export const auth = {
  get: <T>(path: string) => request<T>(`${authBase}${path}`),
  post: <T>(path: string, body?: unknown) => request<T>(`${authBase}${path}`, json('POST', body)),
};

/** 查询串：跳过 undefined / 空串 / false */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
