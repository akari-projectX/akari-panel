import type { TFunction } from "../i18n";
import { ApiError } from "./api";

// Server messages with a translation; anything else is shown as-is inside
// "errors.generic" (the panel's messages are short English sentences).
const KNOWN: Record<string, Parameters<TFunction>[0]> = {
  "invalid code": "errors.invalidCode",
  "invalid password": "errors.invalidPassword",
  "login already exists": "errors.loginExists",
  "cannot remove the last enabled admin": "errors.lastAdmin",
};

/** A user-presentable, localized message for a failed request. */
export function errorText(err: unknown, t: TFunction): string {
  if (!(err instanceof ApiError)) {
    // fetch() rejects with a TypeError when the server is unreachable.
    return err instanceof TypeError ? t("errors.network") : t("errors.generic", { message: String(err) });
  }
  const known = KNOWN[err.message];
  if (known) return t(known);
  if (err.status === 401) return t("errors.unauthorized");
  if (err.status === 403) return t("errors.forbidden");
  if (err.status === 429) return t("errors.tooMany");
  if (err.status >= 500) return t("errors.server");
  return t("errors.generic", { message: err.message });
}
