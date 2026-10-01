// R18-3 user purchase flow: shop → order → Alipay QR → status polling.
// The server polls Alipay on each status request (and reconciles in the
// background), so payment is detected even without the async notify.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { get, post } from "../lib/api";
import { yuan, type MyOrder, type Shop, type ShopPlan } from "../lib/billing";
import { humanBytes } from "../lib/utils";
import { PayQr } from "../components/pay-qr";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { useBillingT } from "./billing-i18n";
import { MyOrders } from "./orders";

const POLL_MS = 3000;

type T = ReturnType<typeof useBillingT>["t"];

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

function periodText(t: T, p: string): string {
  if (p === "monthly") return t("resetMonthly");
  if (p.startsWith("days-")) return t("resetDays", { days: p.slice(5) });
  return t("resetNone");
}

export function Purchase({
  orderId,
  onOrder,
}: {
  orderId: string | null;
  onOrder: (id: string | null) => void;
}) {
  const { t, locale } = useBillingT();
  const queryClient = useQueryClient();
  const shop = useQuery({ queryKey: ["shop"], queryFn: () => get<Shop>("/me/shop") });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buy(p: ShopPlan) {
    const current = shop.data?.current;
    if (p.action === "replace" && current) {
      if (!window.confirm(t("confirmReplace", { name: p.name, current: current.name }))) return;
    }
    setError(null);
    setBusy(true);
    try {
      const o = await post<MyOrder>("/me/orders", { plan_id: p.plan_id });
      queryClient.setQueryData(["order", o.id], o);
      await queryClient.invalidateQueries({ queryKey: ["my-orders"] });
      onOrder(o.id);
    } catch (err) {
      setError(t("error", { msg: err instanceof Error ? err.message : "?" }));
    } finally {
      setBusy(false);
    }
  }

  const data = shop.data;
  const current = data?.current;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {current && (
          <p className="text-sm text-muted-foreground">
            {current.expires_at
              ? t("currentExpires", {
                  name: current.name,
                  date: new Date(current.expires_at).toLocaleDateString(locale === "zh" ? "zh-CN" : "en"),
                })
              : t("currentNoExpiry", { name: current.name })}
          </p>
        )}
        {data && !data.enabled && <p className="text-sm text-muted-foreground">{t("unavailable")}</p>}
        {data?.enabled && data.plans.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("noPlans")}</p>
        )}
        {data?.enabled && data.plans.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.plans.map((p) => (
              <div key={p.plan_id} className="flex flex-col gap-2 rounded-lg border border-border p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">{p.name}</span>
                  <span className="text-sm font-semibold">
                    {t("perPeriod", { price: yuan(p.price_cents), days: p.period_days })}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {p.traffic_quota_bytes != null
                    ? t("quota", { quota: humanBytes(p.traffic_quota_bytes) })
                    : t("unlimited")}
                  {" · "}
                  {periodText(t, p.period)}
                  {p.speed_limit_mbps != null && ` · ${t("speed", { mbps: p.speed_limit_mbps })}`}
                </p>
                <Button
                  size="sm"
                  disabled={busy || p.action === "unavailable" || orderId != null}
                  onClick={() => buy(p)}
                >
                  {p.action === "renew"
                    ? t("renew")
                    : p.action === "replace"
                      ? t("replace")
                      : p.action === "unavailable"
                        ? t("unavailableAction")
                        : t("buy")}
                </Button>
              </div>
            ))}
          </div>
        )}
        {busy && <p className="text-sm text-muted-foreground">{t("creating")}</p>}
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
  const { t } = useBillingT();
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
      setError(t("error", { msg: err instanceof Error ? err.message : "?" }));
    }
  }

  if (!o) return null;
  const left = Math.max(0, Math.floor((new Date(o.expires_at).getTime() - now) / 1000));
  return (
    <div className="space-y-3 rounded-lg border border-border p-4" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{o.plan_name}</span>
        <Badge variant="secondary">{t(`status_${o.status}`)}</Badge>
      </div>
      <p className="text-sm">{t("amount", { price: yuan(o.amount_cents) })}</p>
      {pending && o.qr_code && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm font-medium">{t("scanTitle")}</p>
          <PayQr value={o.qr_code} label={t("qrLabel")} />
          <a className="text-sm underline" href={o.qr_code} target="_blank" rel="noreferrer noopener">
            {t("openAlipay")}
          </a>
          <p className="text-xs text-muted-foreground">
            {t("waiting")} {t("expiresIn", { min: Math.floor(left / 60), sec: left % 60 })}
          </p>
        </div>
      )}
      {o.status === "paid" && <p className="text-sm">{o.fulfilled ? t("paid") : t("paidPending")}</p>}
      {o.status === "expired" && <p className="text-sm text-muted-foreground">{t("expired")}</p>}
      {o.status === "cancelled" && <p className="text-sm text-muted-foreground">{t("cancelled")}</p>}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        {pending && (
          <Button variant="outline" size="sm" onClick={cancel}>
            {t("cancel")}
          </Button>
        )}
        {!pending && (
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("close")}
          </Button>
        )}
      </div>
    </div>
  );
}
