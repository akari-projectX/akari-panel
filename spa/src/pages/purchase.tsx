// R18-3 user purchase flow: shop → order → Alipay QR → status polling.
// W7: plans are sold per period (month … three years, custom days,
// one-time, traffic reset pack); the shop shows each period as the server
// prices it for the caller (switch credit, amount, or why not), with the
// plan's Markdown-lite description and stock.
// The server polls Alipay on each status request (and reconciles in the
// background), so payment is detected even without the async notify.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useLocale, useT, type MessageKey, type TFunction } from "../i18n";
import { get, post, type Me } from "../lib/api";
import { errorText } from "../lib/errors";
import {
  money,
  STATUS_KEY,
  yuan,
  type CouponRefusal,
  type MyOrder,
  type Offer,
  type OfferAction,
  type OfferRefusal,
  periodLabel,
  type PayMethod,
  type PeriodKind,
  type Shop,
  type ShopPlan,
} from "../lib/billing";
import { humanBytes } from "../lib/utils";
import { Dialog } from "../components/dialog";
import { PayQr } from "../components/pay-qr";
import { PlanDescription } from "../components/plan-description";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { MyOrders } from "./orders";

const POLL_MS = 3000;

/** W20 (M1): the 购买套餐 view (/app/shop). */
export function ShopView({ me }: { me: Me }) {
  return <Purchase me={me} />;
}

/** W20 (M1): the 订单 view (/app/orders); "continue paying" opens the payment sheet. */
export function OrdersView() {
  const t = useT();
  const [orderId, setOrderId] = useState<string | null>(null);
  return (
    <>
      <MyOrders onContinue={setOrderId} />
      <Dialog open={orderId != null} onClose={() => setOrderId(null)} title={t("checkout.paymentTitle")}>
        {orderId && <PaymentPanel id={orderId} onClose={() => setOrderId(null)} />}
      </Dialog>
    </>
  );
}

/**
 * W20 (M2): the offer selected when the shop opens. A quota-exhausted
 * holder of the plan gets the reset pack, an expired one the renewal; else
 * the first offer that can actually be bought (period before reset pack).
 * A refused offer is never preselected (undefined = nothing buyable).
 */
export function preselect(p: ShopPlan, me: Pick<Me, "expired" | "quota_exhausted">): Offer | undefined {
  const buyable = p.offers.filter((o) => o.action != null);
  if (p.current && me.quota_exhausted) {
    const reset = buyable.find((o) => o.action === "reset");
    if (reset) return reset;
  }
  if (p.current && me.expired) {
    const renew = buyable.find((o) => o.action === "renew");
    if (renew) return renew;
  }
  return buyable.find((o) => o.action !== "reset") ?? buyable[0];
}

function periodText(t: TFunction, p: string): string {
  if (p === "monthly") return t("billing.resetMonthly");
  if (p.startsWith("days-")) return t("billing.resetDays", { days: p.slice(5) });
  return t("billing.resetNone");
}

const REFUSAL_KEY = {
  not_for_sale: "billing.refusalNotForSale",
  sold_out: "billing.refusalSoldOut",
  renewal_only: "billing.refusalRenewalOnly",
  no_switch: "billing.refusalNoSwitch",
  reset_needs_subscription: "billing.refusalResetNeedsPlan",
  no_expiry: "billing.refusalNoExpiry",
} as const satisfies Record<OfferRefusal, MessageKey>;

// W16: why a coupon does not apply (same wording as the order's error).
export const COUPON_KEY = {
  invalid: "errors.couponInvalid",
  not_started: "errors.couponNotStarted",
  expired: "errors.couponExpired",
  used_up: "errors.couponUsedUp",
  user_limit: "errors.couponUserLimit",
  new_users_only: "errors.couponNewOnly",
  plan: "errors.couponPlan",
  period: "errors.couponPeriod",
  below_minimum: "errors.couponMinimum",
} as const satisfies Record<CouponRefusal, MessageKey>;

const ACTION_KEY = {
  new: "billing.buy",
  renew: "billing.renew",
  switch: "billing.switch",
  reset: "billing.resetAction",
} as const satisfies Record<OfferAction, MessageKey>;

export function Purchase({ me }: { me: Me }) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  // W16: the coupon entered (applied with the button) and whether to pay
  // with the balance; the server prices every offer with both.
  const [couponInput, setCouponInput] = useState("");
  const [coupon, setCoupon] = useState("");
  const [useBalance, setUseBalance] = useState(false);
  const shop = useQuery({
    queryKey: ["shop", coupon, useBalance],
    queryFn: () => {
      const q = new URLSearchParams();
      if (coupon) q.set("coupon", coupon);
      if (useBalance) q.set("use_balance", "true");
      const qs = q.toString();
      return get<Shop>(qs ? `/me/shop?${qs}` : "/me/shop");
    },
    placeholderData: (prev) => prev,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // W20 (Minor 4/5): the in-page checkout summary, then the payment sheet.
  const [checkout, setCheckout] = useState<{ plan: ShopPlan; offer: Offer } | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);

  // R40: the chosen payment method (only asked when more than one).
  const [methodId, setMethodId] = useState<string | null>(null);

  async function buy(p: ShopPlan, o: Offer) {
    setError(null);
    setBusy(true);
    try {
      // The server prices the order; the client never sends an amount.
      const order = await post<MyOrder>("/me/orders", {
        plan_id: p.plan_id,
        period: o.period,
        coupon: coupon || undefined,
        use_balance: useBalance || undefined,
        method_id: methodId ?? undefined,
      });
      queryClient.setQueryData(["order", order.id], order);
      await queryClient.invalidateQueries({ queryKey: ["my-orders"] });
      await queryClient.invalidateQueries({ queryKey: ["my-balance"] });
      setOrderId(order.id);
    } catch (err) {
      setCheckout(null);
      setError(errorText(err, t));
      await queryClient.invalidateQueries({ queryKey: ["shop"] });
    } finally {
      setBusy(false);
    }
  }

  const data = shop.data;
  const current = data?.current;
  // Renewal scope: the plan the user holds comes first.
  const restricted = me.expired || me.quota_exhausted;
  const plans = data ? [...data.plans].sort((a, b) => (restricted ? Number(b.current) - Number(a.current) : 0)) : [];
  function closeSheet() {
    setCheckout(null);
    setOrderId(null);
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("billing.title")}</h2>
        </CardTitle>
        <CardDescription>{t("billing.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {current && (
          <p className="text-sm text-muted-foreground">
            {current.expires_at
              ? t("billing.currentExpires", {
                  name: current.name,
                  date: new Date(current.expires_at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en"),
                })
              : t("billing.currentNoExpiry", { name: current.name })}
          </p>
        )}
        {data && !data.enabled && <p className="text-sm text-muted-foreground">{t("billing.unavailable")}</p>}
        {data?.enabled && (
          <div className="flex flex-wrap items-end gap-3">
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setCoupon(couponInput.trim());
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="coupon-code">{t("billing.couponLabel")}</Label>
                <Input
                  id="coupon-code"
                  className="w-40"
                  value={couponInput}
                  maxLength={32}
                  autoComplete="off"
                  onChange={(e) => setCouponInput(e.target.value)}
                />
              </div>
              <Button type="submit" size="sm" variant="outline" disabled={!couponInput.trim()}>
                {t("billing.couponApply")}
              </Button>
              {coupon && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setCoupon("");
                    setCouponInput("");
                  }}
                >
                  {t("billing.couponClear")}
                </Button>
              )}
            </form>
            {data.balance_cents > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={useBalance} onChange={(e) => setUseBalance(e.target.checked)} />
                {t("billing.useBalance", { balance: yuan(data.balance_cents) })}
              </label>
            )}
          </div>
        )}
        {data?.coupon &&
          (data.coupon.refusal ? (
            <p role="alert" className="text-sm text-destructive">
              {t(COUPON_KEY[data.coupon.refusal])}
            </p>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t("billing.couponApplied", { code: data.coupon.code })}
            </p>
          ))}
        {data?.enabled && data.plans.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("billing.noPlans")}</p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {data?.enabled && plans.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {plans.map((p) => (
              <PlanOffer
                key={p.plan_id}
                plan={p}
                me={me}
                disabled={busy || checkout != null}
                onBuy={(plan, offer) => {
                  setError(null);
                  setCheckout({ plan, offer });
                }}
              />
            ))}
          </div>
        )}
      </CardContent>
      <Dialog
        open={checkout != null}
        onClose={closeSheet}
        title={orderId ? t("checkout.paymentTitle") : t("checkout.title")}
      >
        {orderId ? (
          <PaymentPanel id={orderId} onClose={closeSheet} />
        ) : (
          checkout && (
            <CheckoutSummary
              plan={checkout.plan}
              offer={checkout.offer}
              current={current?.name ?? null}
              methods={data?.methods ?? []}
              methodId={methodId}
              onMethod={setMethodId}
              busy={busy}
              onConfirm={() => void buy(checkout.plan, checkout.offer)}
              onCancel={closeSheet}
            />
          )
        )}
      </Dialog>
    </Card>
  );
}

/** W20 (Minor 4): what the order will cost, line by line; only non-zero parts are shown. */
function CheckoutSummary({
  plan: p,
  offer: o,
  current,
  methods,
  methodId,
  onMethod,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: ShopPlan;
  offer: Offer;
  current: string | null;
  methods: PayMethod[];
  methodId: string | null;
  onMethod: (id: string) => void;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const amount = o.amount_cents ?? o.price_cents;
  const row = (label: string, value: string, tone = "") => (
    <div className="flex justify-between gap-4 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-right tabular-nums ${tone}`}>{value}</dd>
    </div>
  );
  return (
    <div className="space-y-4">
      <dl className="divide-y divide-border text-sm">
        {row(t("checkout.plan"), p.name)}
        {row(t("checkout.period"), periodLabel(t, o.period, o.days))}
        {row(t("checkout.listPrice"), money(o.price_cents))}
        {o.discount_cents > 0 && row(t("checkout.discount"), money(-o.discount_cents), "text-emerald-700")}
        {o.credit_cents > 0 && row(t("checkout.credit"), money(-o.credit_cents), "text-emerald-700")}
        {o.balance_cents > 0 && row(t("checkout.balance"), money(-o.balance_cents), "text-emerald-700")}
        <div className="flex justify-between gap-4 py-2 text-base font-semibold">
          <dt>{t("checkout.total")}</dt>
          <dd className="tabular-nums">{money(amount)}</dd>
        </div>
      </dl>
      {o.forfeited_cents > 0 && (
        <p className="text-sm text-destructive">{t("checkout.forfeit", { amount: money(o.forfeited_cents) })}</p>
      )}
      {o.action === "switch" && current && (
        <p className="text-sm text-amber-900">{t("checkout.switchNote", { current })}</p>
      )}
      {o.action === "reset" && <p className="text-sm text-muted-foreground">{t("checkout.resetNote")}</p>}
      {amount > 0 && methods.length > 1 && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("checkout.method")}</legend>
          {methods.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="pay-method"
                value={m.id}
                checked={methodId === m.id}
                onChange={() => onMethod(m.id)}
              />
              {m.display_name}
            </label>
          ))}
        </fieldset>
      )}
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("billing.creating")}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          onClick={onConfirm}
          disabled={busy || (amount > 0 && methods.length > 1 && !methods.some((m) => m.id === methodId))}
          data-autofocus
        >
          {amount > 0 ? t("checkout.pay", { amount: money(amount) }) : t("checkout.confirmFree")}
        </Button>
      </div>
    </div>
  );
}

// One plan: description, the periods it is sold in (with the server's
// price, credit and amount for the caller) and the buy button.
function PlanOffer({
  plan: p,
  me,
  disabled,
  onBuy,
}: {
  plan: ShopPlan;
  me: Me;
  disabled: boolean;
  onBuy: (p: ShopPlan, o: Offer) => void;
}) {
  const t = useT();
  const first = preselect(p, me);
  const [period, setPeriod] = useState<PeriodKind | undefined>(first?.period);
  // Only a buyable offer can be selected (refused radios are disabled).
  const sel = p.offers.find((o) => o.period === period && o.action != null) ?? first;
  const group = `periods-${p.plan_id}`;
  // Nothing buyable: say why once (the first offer's refusal).
  const refusal = sel ? null : (p.offers.find((o) => o.refusal)?.refusal ?? "not_for_sale");
  const picked =
    p.current && first && sel === first
      ? first.action === "reset" && me.quota_exhausted
        ? t("billing.pickedReset")
        : first.action === "renew" && me.expired
          ? t("billing.pickedRenew")
          : null
      : null;
  return (
    <div
      id={`plan-${p.plan_id}`}
      className={`flex flex-col gap-2 rounded-lg border p-4 ${p.current ? "border-primary" : "border-border"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{p.name}</span>
        <span className="flex gap-1">
          {p.current && <Badge>{t("billing.yourPlan")}</Badge>}
          {p.sold_out && <Badge variant="destructive">{t("billing.soldOut")}</Badge>}
          {!p.sold_out && !p.current && p.remaining != null && (
            <Badge variant="secondary">{t("billing.remaining", { count: p.remaining })}</Badge>
          )}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {p.traffic_quota_bytes != null
          ? t("billing.quota", { quota: humanBytes(p.traffic_quota_bytes) })
          : t("billing.unlimited")}
        {" · "}
        {periodText(t, p.period)}
        {p.speed_limit_mbps != null && ` · ${t("billing.speed", { mbps: p.speed_limit_mbps })}`}
      </p>
      <PlanDescription text={p.description} />
      <fieldset className="space-y-1">
        <legend className="sr-only">{t("billing.pickPeriod", { name: p.name })}</legend>
        {p.offers.map((o) => (
          <label
            key={o.period}
            className={`flex items-center justify-between gap-2 text-sm ${o.action ? "" : "text-muted-foreground"}`}
          >
            <span className="flex items-center gap-2">
              <input
                type="radio"
                name={group}
                value={o.period}
                checked={sel?.period === o.period}
                disabled={o.action == null}
                onChange={() => setPeriod(o.period)}
              />
              {periodLabel(t, o.period, o.days)}
            </span>
            <span className="font-medium tabular-nums">{money(o.price_cents)}</span>
          </label>
        ))}
      </fieldset>
      {sel && sel.action && sel.amount_cents != null && (
        <div className="space-y-0.5 text-sm">
          {sel.discount_cents > 0 && (
            <p className="text-muted-foreground">{t("billing.discount", { amount: yuan(sel.discount_cents) })}</p>
          )}
          {sel.coupon_refusal && <p className="text-muted-foreground">{t(COUPON_KEY[sel.coupon_refusal])}</p>}
          {sel.credit_cents > 0 && (
            <p className="text-muted-foreground">
              {t("billing.credit", { credit: yuan(sel.credit_cents), price: yuan(sel.price_cents) })}
            </p>
          )}
          {sel.balance_cents > 0 && (
            <p className="text-muted-foreground">{t("billing.balancePart", { amount: yuan(sel.balance_cents) })}</p>
          )}
          {sel.forfeited_cents > 0 && (
            <p className="text-destructive">{t("billing.forfeit", { amount: yuan(sel.forfeited_cents) })}</p>
          )}
          <p className="font-semibold">{t("billing.toPay", { amount: yuan(sel.amount_cents) })}</p>
        </div>
      )}
      {picked && (
        <p role="status" className="text-sm font-medium text-amber-900">
          {picked}
        </p>
      )}
      {refusal && <p className="text-sm text-muted-foreground">{t(REFUSAL_KEY[refusal])}</p>}
      <Button disabled={disabled || !sel?.action} onClick={() => sel && onBuy(p, sel)}>
        {sel?.action ? t(ACTION_KEY[sel.action]) : t("billing.noOffer")}
      </Button>
    </div>
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, [active]);
  return now;
}

// One order: QR while pending (polled), then the outcome.
export function PaymentPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const order = useQuery({
    queryKey: ["order", id],
    queryFn: () => get<MyOrder>(`/me/orders/${id}`),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? POLL_MS : false),
  });
  const o = order.data;
  const pending = o?.status === "pending";
  const now = useNow(pending);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (o?.status === "paid") {
      // The plan, limits and expiry changed.
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["my-plan"] });
      void queryClient.invalidateQueries({ queryKey: ["shop"] });
      void queryClient.invalidateQueries({ queryKey: ["my-orders"] });
      void queryClient.invalidateQueries({ queryKey: ["my-balance"] });
    }
    // An order that ended unpaid gave its balance part back.
    if (o?.status === "cancelled" || o?.status === "expired") {
      void queryClient.invalidateQueries({ queryKey: ["my-balance"] });
    }
  }, [o?.status, queryClient]);

  async function cancel() {
    setError(null);
    try {
      const r = await post<MyOrder>(`/me/orders/${id}/cancel`, {});
      queryClient.setQueryData(["order", id], r);
      await queryClient.invalidateQueries({ queryKey: ["my-orders"] });
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  if (!o) return null;
  const left = Math.max(0, Math.floor((new Date(o.expires_at).getTime() - now) / 1000));
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{o.plan_name}</span>
        <Badge variant="secondary">{t(STATUS_KEY[o.status])}</Badge>
      </div>
      <p className="text-sm">
        {periodLabel(t, o.period, o.period_days)} · {t("billing.amount", { price: yuan(o.amount_cents) })}
      </p>
      {o.discount_cents > 0 && (
        <p className="text-xs text-muted-foreground">
          {o.coupon_code} · {t("billing.discount", { amount: yuan(o.discount_cents) })}
        </p>
      )}
      {o.credit_cents > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("billing.credit", { credit: yuan(o.credit_cents), price: yuan(o.list_price_cents) })}
        </p>
      )}
      {o.balance_cents > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("billing.paidWithBalance", { amount: yuan(o.balance_cents) })}
        </p>
      )}
      {pending && o.qr_code && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm font-medium">{t("billing.scanTitle")}</p>
          <PayQr value={o.qr_code} label={t("billing.qrLabel")} />
          <a className="text-sm underline" href={o.qr_code} target="_blank" rel="noreferrer noopener">
            {t("billing.openAlipay")}
          </a>
          <p className="text-xs text-muted-foreground">
            {t("billing.waiting")} {t("billing.expiresIn", { min: Math.floor(left / 60), sec: left % 60 })}
          </p>
        </div>
      )}
      {pending && !o.qr_code && o.pay_url && (
        <div className="flex flex-col items-center gap-3">
          <a className="text-sm font-medium underline" href={o.pay_url} target="_blank" rel="noreferrer noopener">
            {t("billing.openPayment")}
          </a>
          <p className="text-xs text-muted-foreground">
            {t("billing.waiting")} {t("billing.expiresIn", { min: Math.floor(left / 60), sec: left % 60 })}
          </p>
        </div>
      )}
      {o.payment_method_name && (
        <p className="text-xs text-muted-foreground">{t("billing.paidWith", { method: o.payment_method_name })}</p>
      )}
      {o.status === "paid" && <p className="text-sm">{o.fulfilled ? t("billing.paid") : t("billing.paidPending")}</p>}
      {o.status === "expired" && <p className="text-sm text-muted-foreground">{t("billing.expired")}</p>}
      {o.status === "cancelled" && <p className="text-sm text-muted-foreground">{t("billing.cancelled")}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        {pending && (
          <Button variant="outline" size="sm" onClick={cancel}>
            {t("billing.cancel")}
          </Button>
        )}
        {!pending && (
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("billing.close")}
          </Button>
        )}
      </div>
    </div>
  );
}
