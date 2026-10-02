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
import { get, post } from "../lib/api";
import { errorText } from "../lib/errors";
import {
  STATUS_KEY,
  yuan,
  type MyOrder,
  type Offer,
  type OfferAction,
  type OfferRefusal,
  periodLabel,
  type PeriodKind,
  type Shop,
  type ShopPlan,
} from "../lib/billing";
import { humanBytes } from "../lib/utils";
import { PayQr } from "../components/pay-qr";
import { PlanDescription } from "../components/plan-description";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { MyOrders } from "./orders";

const POLL_MS = 3000;

// Shop + the open order's payment panel + order history.
export function Billing() {
  const [orderId, setOrderId] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <Purchase orderId={orderId} onOrder={setOrderId} />
      <MyOrders onContinue={setOrderId} />
    </div>
  );
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

const ACTION_KEY = {
  new: "billing.buy",
  renew: "billing.renew",
  switch: "billing.switch",
  reset: "billing.resetAction",
} as const satisfies Record<OfferAction, MessageKey>;

export function Purchase({ orderId, onOrder }: { orderId: string | null; onOrder: (id: string | null) => void }) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const shop = useQuery({ queryKey: ["shop"], queryFn: () => get<Shop>("/me/shop") });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy(p: ShopPlan, o: Offer) {
    const current = shop.data?.current;
    if (o.action === "switch" && current) {
      const ok = window.confirm(
        t("billing.confirmSwitch", {
          name: p.name,
          current: current.name,
          amount: yuan(o.amount_cents ?? o.price_cents),
          credit: yuan(o.credit_cents),
        }),
      );
      if (!ok) return;
    }
    if (o.action === "reset" && !window.confirm(t("billing.confirmReset"))) return;
    setError(null);
    setBusy(true);
    try {
      // The server prices the order; the client never sends an amount.
      const order = await post<MyOrder>("/me/orders", { plan_id: p.plan_id, period: o.period });
      queryClient.setQueryData(["order", order.id], order);
      await queryClient.invalidateQueries({ queryKey: ["my-orders"] });
      onOrder(order.id);
    } catch (err) {
      setError(errorText(err, t));
      await queryClient.invalidateQueries({ queryKey: ["shop"] });
    } finally {
      setBusy(false);
    }
  }

  const data = shop.data;
  const current = data?.current;
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
        {data?.enabled && data.plans.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("billing.noPlans")}</p>
        )}
        {data?.enabled && data.plans.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.plans.map((p) => (
              <PlanOffer key={p.plan_id} plan={p} disabled={busy || orderId != null} onBuy={buy} />
            ))}
          </div>
        )}
        {busy && <p className="text-sm text-muted-foreground">{t("billing.creating")}</p>}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {orderId && <PaymentPanel id={orderId} onClose={() => onOrder(null)} />}
      </CardContent>
    </Card>
  );
}

// One plan: description, the periods it is sold in (with the server's
// price, credit and amount for the caller) and the buy button.
function PlanOffer({
  plan: p,
  disabled,
  onBuy,
}: {
  plan: ShopPlan;
  disabled: boolean;
  onBuy: (p: ShopPlan, o: Offer) => void;
}) {
  const t = useT();
  const first = p.offers.find((o) => o.action != null && o.period !== "reset") ?? p.offers[0];
  const [period, setPeriod] = useState<PeriodKind | undefined>(first?.period);
  const sel = p.offers.find((o) => o.period === period) ?? first;
  const group = `periods-${p.plan_id}`;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
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
            <span className="font-medium">{t("billing.price", { price: yuan(o.price_cents) })}</span>
          </label>
        ))}
      </fieldset>
      {sel && sel.action && sel.amount_cents != null && (
        <div className="space-y-0.5 text-sm">
          {sel.credit_cents > 0 && (
            <p className="text-muted-foreground">
              {t("billing.credit", { credit: yuan(sel.credit_cents), price: yuan(sel.price_cents) })}
            </p>
          )}
          {sel.forfeited_cents > 0 && (
            <p className="text-destructive">{t("billing.forfeit", { amount: yuan(sel.forfeited_cents) })}</p>
          )}
          <p className="font-semibold">{t("billing.toPay", { amount: yuan(sel.amount_cents) })}</p>
        </div>
      )}
      {sel && sel.refusal && <p className="text-sm text-muted-foreground">{t(REFUSAL_KEY[sel.refusal])}</p>}
      <Button size="sm" disabled={disabled || !sel?.action} onClick={() => sel && onBuy(p, sel)}>
        {sel?.action ? t(ACTION_KEY[sel.action]) : t(REFUSAL_KEY[sel?.refusal ?? "not_for_sale"])}
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
      {o.credit_cents > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("billing.credit", { credit: yuan(o.credit_cents), price: yuan(o.list_price_cents) })}
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
