import { translate, type MessageKey, type TFunction, type Vars } from "../i18n";
import { ApiError, type ErrorParams } from "./api";

// Server errors (W21, M6): every API error body carries a stable `code` and
// its `params` ({"error": "...", "code": "plan.speed_limit_range",
// "params": {"max_speed_mbps": 100000}}). The portal maps the codes the
// user can meet to dictionary keys (zh + en, `errors` namespace); the
// console maps its own in lib/admin-errors.ts (Chinese, admin bundle only).
// `spa/scripts/check-error-codes.mjs` (make check, CI) fails when a code in
// src/error_codes.txt has no mapping here or there.

/**
 * Portal-reachable codes (namespaces auth, account, signup, shop, order,
 * coupon, balance, withdrawal, invite, ticket, request) -> dictionary key.
 * Placeholders in the messages are the error's params, plus `<p>_yuan` for
 * every `<p>_cents`.
 */
export const CODE_KEYS: Record<string, MessageKey> = {
  "account.banned": "errors.accountBanned",
  "account.delete_confirm_required": "errors.deleteConfirmRequired",
  "account.delete_pending_orders": "errors.deletePendingOrders",
  "account.delete_pending_withdrawals": "errors.deletePendingWithdrawals",
  "account.password_required": "errors.passwordRequired",
  "account.invalid_password": "errors.invalidPassword",
  "account.locale_invalid": "errors.localeInvalid",
  "account.passkey_exists": "errors.passkeyExists",
  "account.passkey_failed": "errors.passkeyFailed",
  "account.passkey_limit": "errors.passkeyLimit",
  "account.passkey_name_invalid": "errors.passkeyNameInvalid",
  "account.passkey_required": "errors.passkeyNeeded",
  "account.passkey_unavailable": "errors.passkeyUnavailable",
  "account.mail_off": "errors.mailOff",
  "account.password_too_long": "errors.passwordTooLong",
  "account.password_too_short": "errors.passwordTooShort",
  "auth.captcha_failed": "errors.captchaFailed",
  "auth.captcha_unavailable": "errors.captchaUnavailable",
  "auth.credentials_required": "errors.credentialsRequired",
  "auth.passkey_required": "errors.passkeyLogin",
  "auth.forbidden": "errors.forbidden",
  "auth.unauthorized": "errors.unauthorized",
  "balance.admin_none": "errors.adminNoBalance",
  "balance.insufficient": "errors.insufficientBalance",
  "coupon.below_minimum": "errors.couponMinimum",
  "coupon.expired": "errors.couponExpired",
  "coupon.invalid": "errors.couponInvalid",
  "coupon.new_users_only": "errors.couponNewOnly",
  "coupon.not_started": "errors.couponNotStarted",
  "coupon.period": "errors.couponPeriod",
  "coupon.plan": "errors.couponPlan",
  "coupon.used_up": "errors.couponUsedUp",
  "coupon.user_limit": "errors.couponUserLimit",
  "invite.invalid_inviter": "errors.invalidInviter",
  "kb.query_long": "errors.kbQueryLong",
  "invite.limit": "errors.inviteLimit",
  "invite.registration_closed": "errors.registrationClosed",
  "order.gateway_unavailable": "errors.paymentGateway",
  "order.in_progress": "errors.orderInProgress",
  "order.method_required": "errors.methodRequired",
  "order.method_unavailable": "errors.methodUnavailable",
  "order.not_pending": "errors.orderNotPending",
  "order.payments_off": "errors.paymentsOff",
  "request.body_too_large": "errors.bodyTooLarge",
  "request.field_not_null": "errors.fieldNotNull",
  "request.field_required": "errors.fieldRequired",
  "request.field_too_long": "errors.fieldTooLong",
  "request.internal": "errors.server",
  "request.invalid_body": "errors.invalidBody",
  "request.no_fields": "errors.noChanges",
  "request.not_found": "errors.notFound",
  "request.port_range": "errors.portRange",
  "request.rate_limited": "errors.tooMany",
  "request.reason_length": "errors.reasonLength",
  "request.status_invalid": "errors.statusInvalid",
  "request.traffic_query_invalid": "errors.trafficQueryInvalid",
  "shop.admin_cannot_buy": "errors.adminCannotBuy",
  "shop.no_switch": "errors.noSwitch",
  "shop.not_for_sale": "errors.notForSale",
  "shop.nothing_to_renew": "errors.nothingToRenew",
  "shop.renewal_only": "errors.renewalOnly",
  "shop.reset_needs_plan": "errors.resetNeedsPlan",
  "shop.sold_out": "errors.soldOut",
  "signup.challenge_invalid": "errors.challengeInvalid",
  "signup.domain_not_allowed": "errors.domainNotAllowed",
  "signup.invalid_code": "errors.invalidOrExpiredCode",
  "signup.invalid_email": "errors.invalidEmail",
  "signup.invalid_invite": "errors.invalidInvite",
  "signup.invalid_link": "errors.invalidLink",
  "signup.invite_required": "errors.inviteRequired",
  "signup.unavailable": "errors.signupUnavailable",
  "ticket.choice_invalid": "errors.ticketChoice",
  "ticket.closed": "errors.ticketClosed",
  "ticket.full": "errors.ticketFull",
  "ticket.message_long": "errors.ticketMessageLong",
  "ticket.message_required": "errors.ticketMessageRequired",
  "ticket.open_limit": "errors.ticketOpenLimit",
  "ticket.subject_long": "errors.ticketSubjectLong",
  "ticket.subject_multiline": "errors.ticketSubjectMultiline",
  "ticket.subject_required": "errors.ticketSubjectRequired",
  "ticket.unknown_node": "errors.ticketUnknownNode",
  "ticket.unknown_order": "errors.ticketUnknownOrder",
  "withdrawal.address_invalid": "errors.withdrawAddressInvalid",
  "withdrawal.amount_range": "errors.withdrawAmountRange",
  "withdrawal.below_minimum": "errors.withdrawBelowMinimum",
  "withdrawal.chain_invalid": "errors.withdrawChainInvalid",
  "withdrawal.exceeds": "errors.withdrawExceeds",
  "withdrawal.memo_invalid": "errors.withdrawMemoInvalid",
  "withdrawal.memo_unexpected": "errors.withdrawMemoUnexpected",
  "withdrawal.not_pending": "errors.withdrawalNotPending",
  "withdrawal.open": "errors.withdrawOpen",
  "withdrawal.txid_invalid": "errors.withdrawTxidInvalid",
  "withdrawal.usdt_amount_invalid": "errors.withdrawUsdtAmountInvalid",
};

/** Message variables of an error: its params as text, plus `<p>_yuan` for each `<p>_cents`. */
export function errorVars(params: ErrorParams, message: string): Vars {
  const vars: Vars = { message };
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    vars[k] = typeof v === "number" ? v : String(v);
    if (k.endsWith("_cents") && typeof v === "number") {
      vars[`${k.slice(0, -"_cents".length)}_yuan`] = (v / 100).toFixed(2);
      vars[`${k}_yuan`] = (v / 100).toFixed(2);
    }
  }
  return vars;
}

/** A user-presentable, localized message for a failed request. */
export function errorText(err: unknown, t: TFunction): string {
  if (!(err instanceof ApiError)) {
    // fetch() rejects with a TypeError when the server is unreachable.
    return err instanceof TypeError ? t("errors.network") : t("errors.generic", { message: String(err) });
  }
  const key = CODE_KEYS[err.code];
  if (key) return t(key, errorVars(err.params, err.message));
  if (err.status === 401) return t("errors.unauthorized");
  if (err.status === 403) return t("errors.forbidden");
  if (err.status === 429) return t("errors.tooMany");
  if (err.status >= 500) return t("errors.server");
  return t("errors.generic", { message: err.message });
}

/** errorText pinned to Chinese (the console's shared fallback). */
export const zh: TFunction = (key, vars) => translate("zh", key, vars);
