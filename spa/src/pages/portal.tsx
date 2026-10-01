import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useLocale, useT } from "../i18n";
import { describePeriod, get, post, subscriptionUrl, type Me, type MyPlan } from "../lib/api";
import { errorText } from "../lib/errors";
import { copyText, humanBytes } from "../lib/utils";
import { TwoFactorCard } from "./two-factor";

// Dates in the visible locale (the admin console pins zh).
function useDate() {
  const locale = useLocale();
  const tag = locale === "zh" ? "zh-CN" : "en";
  return (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(tag) : "—");
}

export function Portal({ me }: { me: Me }) {
  const t = useT();
  const date = useDate();
  const limit = me.traffic_limit_bytes;
  const used = me.traffic_used_bytes;
  const pct = limit != null && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{t("portal.title")}</h1>
          </CardTitle>
          <CardDescription>{t("portal.usage")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {me.expired && (
            <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {t("portal.expiredBanner")}
            </p>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">{t("portal.trafficUsed")}</p>
              <p className="text-lg font-semibold">{humanBytes(used)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">{t("portal.trafficLimit")}</p>
              <p className="text-lg font-semibold">{limit != null ? humanBytes(limit) : t("common.unlimited")}</p>
            </div>
          </div>
          {limit != null && limit > 0 && (
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={t("portal.trafficUsed")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
            >
              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {me.expires_at ? t("portal.expires", { date: date(me.expires_at) }) : t("portal.noExpiry")}
          </p>
        </CardContent>
      </Card>
      <PlanCard />
      {/* Expired (R21): renewal scope only; these endpoints refuse it. */}
      {!me.expired && <SubscriptionCard />}
      <PasswordCard />
      {!me.expired && <TwoFactorCard />}
    </div>
  );
}

// The server keeps only a hash of the subscription token, so the link can
// only be shown when a new one is made (which also retires the old link).
function SubscriptionCard() {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function regenerate() {
    if (!window.confirm(t("portal.subConfirm"))) return;
    setError(null);
    setCopied(false);
    setBusy(true);
    try {
      const res = await post<{ sub_token: string }>("/me/sub-token", {});
      setUrl(subscriptionUrl(res.sub_token));
    } catch (err) {
      setError(errorText(err, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("portal.subTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("portal.subDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {url && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{t("portal.subShownOnce")}</p>
            <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{url}</pre>
            <Button variant="outline" size="sm" onClick={async () => setCopied(await copyText(url))}>
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          </div>
        )}
        <Button variant="outline" onClick={regenerate} disabled={busy}>
          {t("portal.subNew")}
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// The active plan, its period, and the nodes it gives access to (names and
// regions only).
export function PlanCard() {
  const t = useT();
  const date = useDate();
  const q = useQuery({ queryKey: ["my-plan"], queryFn: () => get<MyPlan>("/me/plan") });
  if (q.isPending) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
        </CardContent>
      </Card>
    );
  }
  if (q.isError) {
    return (
      <Card>
        <CardContent className="pt-6">
          <p role="alert" className="text-sm text-destructive">
            {t("portal.planLoadFailed", { message: errorText(q.error, t) })}
          </p>
        </CardContent>
      </Card>
    );
  }
  const { plan, nodes } = q.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("portal.planTitle")}</h2>
        </CardTitle>
        <CardDescription>{plan ? plan.name : t("portal.noPlan")}</CardDescription>
      </CardHeader>
      {plan && (
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">{t("portal.quota")}</dt>
              <dd className="font-medium">
                {plan.traffic_quota_bytes != null ? humanBytes(plan.traffic_quota_bytes) : t("common.unlimited")}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("portal.reset")}</dt>
              <dd className="font-medium">{describePeriod(plan.period, t)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("portal.nextReset")}</dt>
              <dd className="font-medium">{date(plan.next_reset_at)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t("portal.planExpires")}</dt>
              <dd className="font-medium">{plan.expires_at ? date(plan.expires_at) : t("common.never")}</dd>
            </div>
            {plan.speed_limit_mbps != null && (
              <div>
                <dt className="text-muted-foreground">{t("portal.speed")}</dt>
                <dd className="font-medium">{t("portal.speedValue", { mbps: plan.speed_limit_mbps })}</dd>
              </div>
            )}
          </dl>
          <div>
            <p className="mb-2 text-sm text-muted-foreground">{t("portal.nodes")}</p>
            {nodes.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("portal.noNodes")}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {nodes.map((n) => (
                  <li key={n.name}>
                    <Badge variant="secondary">
                      {n.name}
                      {n.region ? ` · ${n.region}` : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

// Change your own password (the current one is required). Other sessions
// end; this one continues.
export function PasswordCard() {
  const t = useT();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) return setMsg({ ok: false, text: t("portal.passwordMismatch") });
    if (next.length < 8) return setMsg({ ok: false, text: t("portal.passwordTooShort") });
    setBusy(true);
    try {
      await post("/me/password", { current_password: current, new_password: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      setMsg({ ok: true, text: t("portal.passwordChanged") });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err, t) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("portal.passwordTitle")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit} aria-label={t("portal.changePassword")}>
          <div className="space-y-1.5">
            <Label htmlFor="pw-current">{t("portal.currentPassword")}</Label>
            <Input
              id="pw-current"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-new">{t("portal.newPassword")}</Label>
            <Input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pw-confirm">{t("portal.repeatPassword")}</Label>
            <Input
              id="pw-confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={busy}>
            {t("portal.changePassword")}
          </Button>
        </form>
        {msg && (
          <p
            role={msg.ok ? "status" : "alert"}
            className={`mt-3 text-sm ${msg.ok ? "text-emerald-600" : "text-destructive"}`}
          >
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
