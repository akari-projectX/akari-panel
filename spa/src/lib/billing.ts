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
  // What would be charged now (price - credit); null when refused.
  amount_cents: number | null;
  credit_cents: number;
  // Credit beyond the price (lost when switching to a cheaper plan).
  forfeited_cents: number;
  action: OfferAction | null;
  refusal: OfferRefusal | null;
}

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
  status: OrderStatus;
  trade_no: string | null;
  paid_via: "notify" | "query" | "manual" | "credit" | null;
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
      return `${days ?? "?"} 天`;
    case "onetime":
      return days != null ? `一次性（${days} 天）` : "一次性（永久）";
    case "reset":
      return "流量重置包";
  }
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
