// R18-3 billing API shapes (mirror of src/billing/api.rs views). Amounts
// are integer CNY cents everywhere; the client never sends an amount.

import type { MessageKey, TFunction } from "../i18n";

// W7 period kinds (src/billing/catalog.rs PeriodKind), in display order.
export const PERIOD_KINDS = [
  "month",
  "quarter",
  "half_year",
  "year",
  "two_year",
  "three_year",
  "days",
  "onetime",
  "reset",
] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

/** Prices in catalogue order (month … three years, days, one-time, reset; then by days). */
export function sortPrices<T extends { period: PeriodKind; days: number | null }>(prices: readonly T[]): T[] {
  const rank = (p: T) => PERIOD_KINDS.indexOf(p.period);
  return [...prices].sort((a, b) => rank(a) - rank(b) || (a.days ?? 0) - (b.days ?? 0));
}

/** One price of a plan (days: "days" required, "onetime" optional, else null). */
export interface PlanPrice {
  period: PeriodKind;
  days: number | null;
  price_cents: number;
}

export type OfferAction = "new" | "renew" | "switch" | "reset";
export type OfferRefusal =
  "not_for_sale" | "sold_out" | "renewal_only" | "no_switch" | "reset_needs_subscription" | "no_expiry";

/** A priced period as the caller would buy it now (server-computed). */
export interface Offer {
  period: PeriodKind;
  days: number | null;
  price_cents: number;
  // What Alipay would be asked for now (price - discount - credit -
  // balance); null when refused.
  amount_cents: number | null;
  // W16: the entered coupon's discount (on the list price).
  discount_cents: number;
  credit_cents: number;
  // Credit beyond what is left (lost when switching to a cheaper plan).
  forfeited_cents: number;
  // W16: the balance part (when paying with the balance).
  balance_cents: number;
  // W16: why the entered coupon does not apply to this period.
  coupon_refusal: CouponRefusal | null;
  action: OfferAction | null;
  refusal: OfferRefusal | null;
}

// W16 coupon refusals (src/billing/coupons.rs Refusal).
export type CouponRefusal =
  | "invalid"
  | "not_started"
  | "expired"
  | "used_up"
  | "user_limit"
  | "new_users_only"
  | "plan"
  | "period"
  | "below_minimum";

export interface ShopPlan {
  plan_id: string;
  name: string;
  // Markdown-lite text (rendered as text, see components/plan-description).
  description: string;
  traffic_quota_bytes: number | null;
  // Traffic reset period: "monthly" | "days-N" | "none".
  period: string;
  speed_limit_mbps: number | null;
  device_seats: number | null;
  // The caller holds this plan.
  current: boolean;
  // Slots left (null = unlimited).
  remaining: number | null;
  sold_out: boolean;
  offers: Offer[];
}

export interface Shop {
  enabled: boolean;
  current: { plan_id: string; name: string; expires_at: string | null } | null;
  // What the caller's subscription is worth when switching plans.
  credit_cents: number;
  // W16: the caller's balance (fen).
  balance_cents: number;
  // W16: the coupon entered (?coupon=), with a refusal that concerns the
  // whole code; null without one.
  coupon: { code: string; refusal: CouponRefusal | null } | null;
  plans: ShopPlan[];
}

export type OrderStatus = "pending" | "paid" | "expired" | "cancelled";

/** The user-facing label of each order status (i18n key). */
export const STATUS_KEY = {
  pending: "billing.statusPending",
  paid: "billing.statusPaid",
  expired: "billing.statusExpired",
  cancelled: "billing.statusCancelled",
} as const satisfies Record<OrderStatus, MessageKey>;

export interface MyOrder {
  id: string;
  out_trade_no: string;
  plan_id: string | null;
  plan_name: string;
  amount_cents: number;
  period: PeriodKind;
  period_days: number | null;
  list_price_cents: number;
  credit_cents: number;
  discount_cents: number;
  coupon_code: string | null;
  balance_cents: number;
  refunded_at: string | null;
  status: OrderStatus;
  // Only while pending: the Alipay QR payload (https://qr.alipay.com/...).
  qr_code: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  fulfilled: boolean;
}

export interface AdminOrder {
  id: string;
  out_trade_no: string;
  user_id: string | null;
  user_login: string;
  plan_id: string | null;
  plan_name: string;
  amount_cents: number;
  period: PeriodKind;
  period_days: number | null;
  list_price_cents: number;
  credit_cents: number;
  credit_order_id: string | null;
  discount_cents: number;
  coupon_id: string | null;
  coupon_code: string | null;
  balance_cents: number;
  balance_state: "none" | "held" | "refunded";
  refunded_at: string | null;
  refund_cents: number | null;
  refund_reason: string | null;
  status: OrderStatus;
  trade_no: string | null;
  paid_via: "notify" | "query" | "manual" | "credit" | "balance" | "coupon" | null;
  paid_amount_cents: number | null;
  manual_reason: string | null;
  fulfilled_at: string | null;
  fulfil_result: Record<string, unknown> | null;
  fulfil_error: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  ended_at: string | null;
  close_state: string | null;
}

export interface PaymentEvent {
  id: number;
  source: string;
  verified: boolean;
  outcome: string;
  trade_status: string | null;
  params: Record<string, string> | null;
  ip: string | null;
  created_at: string;
}

export interface OrderDetail {
  order: AdminOrder;
  events: PaymentEvent[];
}

export interface PriceRow {
  plan_id: string;
  plan_name: string;
  plan_enabled: boolean;
  on_sale: boolean;
  prices: PlanPrice[];
}

export interface Prices {
  payments_enabled: boolean;
  plans: PriceRow[];
}

/** The user-facing name of a billing period (W7 period kinds). */
export function periodLabel(t: TFunction, kind: PeriodKind, days: number | null): string {
  switch (kind) {
    case "month":
      return t("billing.periodMonth");
    case "quarter":
      return t("billing.periodQuarter");
    case "half_year":
      return t("billing.periodHalfYear");
    case "year":
      return t("billing.periodYear");
    case "two_year":
      return t("billing.periodTwoYear");
    case "three_year":
      return t("billing.periodThreeYear");
    case "days":
      return t("billing.periodDays", { days: days ?? "?" });
    case "onetime":
      return days != null ? t("billing.periodOnetimeDays", { days }) : t("billing.periodOnetime");
    case "reset":
      return t("billing.periodReset");
  }
}

/** Chinese period labels (admin console). */
export function periodZh(kind: PeriodKind, days: number | null): string {
  switch (kind) {
    case "month":
      return "月付";
    case "quarter":
      return "季付";
    case "half_year":
      return "半年付";
    case "year":
      return "年付";
    case "two_year":
      return "两年付";
    case "three_year":
      return "三年付";
    case "days":
      return days != null ? `${days} 天` : "自定义天数";
    case "onetime":
      return days != null ? `一次性（${days} 天）` : "一次性（永久）";
    case "reset":
      return "流量重置包";
  }
}

/** The name of a period kind, without days (coupon scopes, filters). */
export function periodKindZh(kind: PeriodKind): string {
  return kind === "days" ? "自定义天数" : kind === "onetime" ? "一次性" : periodZh(kind, null);
}

// 990 -> "9.90" (integer arithmetic, no float rounding).
export function yuan(cents: number): string {
  const c = Math.trunc(cents);
  return `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, "0")}`;
}

// "9.9" / "9.90" / "10" -> 990; null when not a valid amount (> 0, <= 2
// decimals). Parsed as text so 0.1 + 0.2 never happens.
export function parseYuan(s: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

// ---------------------------------------------------------------------------
// W16: balance (src/billing/ledger.rs), invite commission + withdrawals
// (commission.rs), coupons (coupons.rs).
// ---------------------------------------------------------------------------

export type LedgerKind =
  "commission" | "admin_adjust" | "order_payment" | "refund_to_balance" | "withdrawal" | "withdrawal_reversal";

export interface LedgerEntry {
  id: number;
  kind: LedgerKind;
  // Signed fen.
  amount_cents: number;
  balance_after_cents: number;
  order_id: string | null;
  out_trade_no: string | null;
  commission_id: string | null;
  withdrawal_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface AdminLedgerEntry extends LedgerEntry {
  user_id: string | null;
  user_login: string;
  actor_login: string;
}

export interface MyBalance {
  balance_cents: number;
  withdrawable_cents: number;
  entries: LedgerEntry[];
}

export interface UserBalance {
  user_id: string;
  login: string;
  balance_cents: number;
  withdrawable_cents: number;
  entries: AdminLedgerEntry[];
}

export interface BalanceRow {
  user_id: string;
  login: string;
  balance_cents: number;
  updated_at: string;
}

export type CommissionStatus = "pending" | "credited" | "reversed";

export interface MyCommission {
  id: string;
  invitee_login: string;
  base_cents: number;
  rate_percent: number;
  amount_cents: number;
  status: CommissionStatus;
  available_at: string;
  credited_at: string | null;
  reversed_at: string | null;
  created_at: string;
}

export interface MyInvite {
  enabled: boolean;
  rate_percent: number;
  first_order_only: boolean;
  hold_days: number;
  min_withdrawal_cents: number;
  // W15: the account's invite codes (managed via /me/invite-codes).
  invite_codes: string[] | null;
  invited_count: number;
  pending_cents: number;
  credited_cents: number;
  reversed_cents: number;
  balance_cents: number;
  withdrawable_cents: number;
  commissions: MyCommission[];
}

export interface Commission {
  id: string;
  order_id: string;
  out_trade_no: string;
  inviter_id: string | null;
  inviter_login: string;
  invitee_id: string | null;
  invitee_login: string;
  base_cents: number;
  rate_percent: number;
  amount_cents: number;
  status: CommissionStatus;
  available_at: string;
  credited_at: string | null;
  reversed_at: string | null;
  reverse_reason: string | null;
  created_at: string;
}

export interface CommissionSettings {
  enabled: boolean;
  rate_percent: number;
  first_order_only: boolean;
  hold_days: number;
  min_withdrawal_cents: number;
}

export type WithdrawMethod = "alipay" | "wechat" | "bank" | "other";
export type WithdrawalStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface Withdrawal {
  id: string;
  user_id: string | null;
  user_login: string;
  amount_cents: number;
  method: WithdrawMethod;
  account: string;
  status: WithdrawalStatus;
  payout_reference: string | null;
  note: string | null;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
}

export interface Coupon {
  id: string;
  code: string;
  name: string;
  kind: "percent" | "fixed";
  // percent: 1-100; fixed: fen.
  value: number;
  plan_ids: string[] | null;
  periods: PeriodKind[] | null;
  min_amount_cents: number;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  per_user_limit: number | null;
  new_users_only: boolean;
  enabled: boolean;
  used: number;
  redeemed: number;
  created_at: string;
  updated_at: string;
}

export interface CouponRedemption {
  order_id: string;
  out_trade_no: string;
  user_id: string | null;
  user_login: string;
  status: "reserved" | "redeemed" | "released";
  over_limit: boolean;
  discount_cents: number;
  order_status: OrderStatus;
  created_at: string;
}

export interface CouponDetail {
  coupon: Coupon;
  redemptions: CouponRedemption[];
}

/** A signed fen amount: "+9.90" / "-9.90". */
/** "¥50.00" (audit Minor 3: the currency sign before the amount). */
export function money(cents: number): string {
  return `${cents < 0 ? "\u2212" : ""}¥${yuan(Math.abs(cents))}`;
}

/** "+¥50.00" / "−¥10.00" (U+2212) for ledger changes; colour with `moneyTone`. */
export function signedMoney(cents: number): string {
  return `${cents < 0 ? "\u2212" : "+"}¥${yuan(Math.abs(cents))}`;
}

/** Text colour of a signed amount (AA contrast on white). */
export function moneyTone(cents: number): string {
  return cents < 0 ? "text-destructive" : cents > 0 ? "text-emerald-700" : "";
}

export function signedYuan(cents: number): string {
  return `${cents < 0 ? "-" : "+"}${yuan(Math.abs(cents))}`;
}
