// Server errors → text (W21 codes, zh + en). The table is ERRORS
// (errors.gen.ts); scripts/check-error-codes.mjs keeps it equal to
// src/error_codes.txt.
import { ApiError } from "./api";
import { ERRORS } from "./errors.gen";
import type { Lang } from "./i18n";

/** Template variables from the error params: strings as-is, numbers, and `<p>_yuan` for each `<p>_cents`. */
export function errorVars(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (k.endsWith("_cents") && typeof v === "number") out[`${k.slice(0, -6)}_yuan`] = (v / 100).toFixed(2);
  }
  return out;
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? vars[name] : m));
}

const FALLBACK = {
  network: ["无法连接面板，请检查网络后重试", "Cannot reach the panel; check the network and retry"],
  unauthorized: ["登录已失效，请重新登录", "The session ended; sign in again"],
  forbidden: ["没有权限执行此操作", "Not allowed"],
  tooMany: ["操作太频繁，请稍后再试", "Too many attempts; try again later"],
  server: ["面板内部错误，请稍后重试", "Internal panel error; try again later"],
  notFound: ["对象不存在或已被删除", "Not found (deleted meanwhile?)"],
} as const;

export type ErrorTable = Record<string, readonly [zh: string, en: string]>;

/** The text of any thrown error, in `lang`, from `table` (codes) or by status. */
export function errorTextWith(table: ErrorTable, err: unknown, lang: Lang): string {
  const pick = (pair: readonly [string, string]) => (lang === "en" ? pair[1] : pair[0]);
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  const own = table[err.code];
  if (own) return fill(pick(own), errorVars(err.params));
  if (err.status === 0) return pick(FALLBACK.network);
  if (err.status === 401) return pick(FALLBACK.unauthorized);
  if (err.status === 403) return pick(FALLBACK.forbidden);
  if (err.status === 404) return pick(FALLBACK.notFound);
  if (err.status === 429) return pick(FALLBACK.tooMany);
  if (err.status >= 500) return pick(FALLBACK.server);
  return err.message;
}

/** The text of any thrown error, in `lang` (every server code). */
export function errorText(err: unknown, lang: Lang): string {
  return errorTextWith(ERRORS, err, lang);
}

/** The code shown next to an error ("plan.in_use"), or the HTTP status. */
export function errorCode(err: unknown): string {
  if (err instanceof ApiError) return err.code || (err.status ? `HTTP ${err.status}` : "network");
  return "";
}
