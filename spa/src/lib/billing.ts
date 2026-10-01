// R18-3 billing API shapes (mirror of src/billing/api.rs views). Amounts
// are integer CNY cents everywhere; the client never sends an amount.

export interface ShopPlan {
  plan_id: string;
  name: string;
  price_cents: number;
  period_days: number;
  traffic_quota_bytes: number | null;
  period: string;
  speed_limit_mbps: number | null;
  // What buying it does for the caller.
  action: "new" | "renew" | "replace" | "unavailable";
}

export interface Shop {
  enabled: boolean;
  current: { plan_id: string; name: string; expires_at: string | null } | null;
  plans: ShopPlan[];
}

export type OrderStatus = "pending" | "paid" | "expired" | "cancelled";

export interface MyOrder {
  id: string;
  out_trade_no: string;
  plan_id: string | null;
  plan_name: string;
  amount_cents: number;
  period_days: number;
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
  period_days: number;
  status: OrderStatus;
  trade_no: string | null;
  paid_via: "notify" | "query" | "manual" | null;
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
  price_cents: number | null;
  period_days: number | null;
  purchasable: boolean;
  updated_at: string | null;
}

export interface Prices {
  payments_enabled: boolean;
  prices: PriceRow[];
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
