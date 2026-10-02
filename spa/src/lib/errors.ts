import { translate, type TFunction } from "../i18n";
import { ApiError } from "./api";

// Server messages with a translation; anything else is shown as-is inside
// "errors.generic" (the panel's messages are short English sentences).
const KNOWN: Record<string, Parameters<TFunction>[0]> = {
  "invalid code": "errors.invalidCode",
  "invalid password": "errors.invalidPassword",
  "payments are not enabled": "errors.paymentsOff",
  "payment gateway unavailable, try again": "errors.paymentGateway",
  "plan is not for sale": "errors.notForSale",
  "your current plan does not expire; nothing to renew": "errors.nothingToRenew",
  "another order is being created": "errors.orderInProgress",
  "order is not pending": "errors.orderNotPending",
  "plan is sold out": "errors.soldOut",
  "plan is only available to its current subscribers": "errors.renewalOnly",
  "switching to this plan from another plan is not allowed": "errors.noSwitch",
  "a traffic reset pack needs an active subscription of its plan": "errors.resetNeedsPlan",
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

const zh: TFunction = (key, vars) => translate("zh", key, vars);

// Messages only admin endpoints return. Chinese text here, not in the shared
// dictionaries: the console is Chinese only (R18), and the user bundle must
// carry no admin strings (R23; unused here, this map is tree-shaken out of it).
const ADMIN_KNOWN: Record<string, string> = {
  "login already exists": "该账号已存在",
  "cannot remove the last enabled admin": "不能移除最后一个启用的管理员",
};

// Like zh, but an unknown server message stays bare (no "操作失败：" wrapper),
// for callers that put their own context in front.
const zhBare: TFunction = (key, vars) => (key === "errors.generic" ? String(vars?.message ?? "") : zh(key, vars));

/**
 * errorText for the admin console (Chinese only, R18), usable outside
 * components. With `context` the text is "<context>：<detail>" (one prefix,
 * not "<context>：操作失败：<detail>").
 */
export function adminErrorText(err: unknown, context?: string): string {
  const known = err instanceof ApiError ? ADMIN_KNOWN[err.message] : undefined;
  const text = known ?? errorText(err, context ? zhBare : zh);
  return context ? `${context}：${text}` : text;
}
