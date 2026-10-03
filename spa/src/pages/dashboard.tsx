// W20 (M1): the portal's dashboard view — plan, days and traffic left, the
// renewal call to action for the R21 renewal scope, the subscription link,
// and the announcements (Ops).
import { useQuery } from "@tanstack/react-query";

import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { useLocale, useT } from "../i18n";
import { appBase, get, type Me, type MyPlan } from "../lib/api";
import { navigate } from "../lib/router";
import { humanBytes } from "../lib/utils";
import { AnnouncementsCard } from "./announcements";
import { PlanCard } from "./portal";
import { SubscriptionCard } from "./subscription";

const DAY_MS = 86_400_000;

/** Whole days until `iso` (rounded up; 0 once past). */
export function daysLeft(iso: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - now) / DAY_MS));
}

/** The renewal banner with its call to action (shared by dashboard and shop). */
export function RenewalBanner({ me, cta = true }: { me: Me; cta?: boolean }) {
  const t = useT();
  if (!me.expired && !me.quota_exhausted) return null;
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between"
    >
      <p>{me.expired ? t("portal.expiredBanner") : t("portal.quotaBanner")}</p>
      {cta && (
        <Button className="shrink-0" onClick={() => navigate(`${appBase}/shop`)}>
          {me.expired ? t("dash.renewCta") : t("dash.resetCta")}
        </Button>
      )}
    </div>
  );
}

export function Dashboard({ me }: { me: Me }) {
  const t = useT();
  const locale = useLocale();
  const plan = useQuery({ queryKey: ["my-plan"], queryFn: () => get<MyPlan>("/me/plan") });
  const restricted = me.expired || me.quota_exhausted;
  const limit = me.traffic_limit_bytes;
  const used = me.traffic_used_bytes;
  const pct = limit != null && limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const date = (s: string) => new Date(s).toLocaleDateString(locale === "zh" ? "zh-CN" : "en");
  const planName = plan.data?.plan?.name;

  return (
    <div className="space-y-6">
      <RenewalBanner me={me} />
      <Card>
        <CardContent className="grid gap-6 pt-6 sm:grid-cols-3">
          <div>
            <p className="text-sm text-muted-foreground">{t("dash.plan")}</p>
            <p className="mt-1 text-lg font-semibold">{planName ?? t("dash.noPlan")}</p>
            {!planName && plan.isSuccess && (
              <Button className="mt-2" size="sm" variant="outline" onClick={() => navigate(`${appBase}/shop`)}>
                {t("dash.buyCta")}
              </Button>
            )}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("dash.daysLeft")}</p>
            <p className="mt-1 text-lg font-semibold">
              {me.expires_at
                ? me.expired
                  ? t("dash.expired")
                  : t("dash.days", { days: daysLeft(me.expires_at) })
                : t("dash.noExpiry")}
            </p>
            {me.expires_at && (
              <p className="text-xs text-muted-foreground">{t("dash.expiresOn", { date: date(me.expires_at) })}</p>
            )}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("dash.trafficLeft")}</p>
            <p className="mt-1 text-lg font-semibold">
              {limit != null ? humanBytes(Math.max(0, limit - used)) : t("common.unlimited")}
            </p>
            <p className="text-xs text-muted-foreground">
              {limit != null
                ? t("dash.trafficOf", { used: humanBytes(used), total: humanBytes(limit) })
                : t("dash.trafficUsedOnly", { used: humanBytes(used) })}
            </p>
            {limit != null && limit > 0 && (
              <div
                className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={t("portal.trafficUsed")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(pct)}
              >
                <div className={`h-full ${pct >= 90 ? "bg-destructive" : "bg-primary"}`} style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {/* Renewal scope (R21): the subscription refuses these accounts. */}
      {!restricted && <SubscriptionCard me={me} />}
      <PlanCard />
      <AnnouncementsCard />
    </div>
  );
}
