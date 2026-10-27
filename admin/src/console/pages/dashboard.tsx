// 仪表盘 (DSH-*; v2 dashboard-*): the operator's first 30 seconds.
// ① 需要你处理 (the lead): one row per pending queue with its count, one
//    sentence of detail (GET /dashboard `pending_detail`) and the filtered
//    list; safe inline actions with their own spinners (acknowledge the
//    firing alerts, retry the oldest failed fulfilment, retry the dead
//    letters); "一切就绪" when every queue is empty.
// ② 业务: four KPIs that are the tabs of one chart (MetricChart over the
//    daily `series`), today / 7 d / 30 d in the URL (?range=, ?metric=),
//    compared with the previous period of the same length (today: with
//    yesterday up to the same time, `prev_today`), plus the latest orders.
// ③ 服务器: one health sentence, the agent update strip, compact server
//    blocks (state, CPU, agent, quota bar) and this period's top traffic.
// A failed poll keeps the data on screen and turns the freshness pill amber.
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
  LifeBuoy,
  MailWarning,
  PackageX,
  PartyPopper,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Suspense, lazy, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { get, post, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { ago, bytes, dateTime, daysBefore, pct, yuan } from "../../shared/format";
import { useLang, useTr, type Lang, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Segmented } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { Meter, usageTone } from "../../shared/ui/meter";
import { ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import type { Metric, MetricDay } from "../../shared/ui/charts";
import { errorText } from "../../shared/errors";
import { useAction } from "../data";
import { AsyncButton, Fresh, IconBadge } from "../components/kit";
import { alertKindName, mailReason, waitText } from "../components/ops-bits";
import { OrdStatus, orderState } from "../components/status";
import { useQS } from "../router";
import { useServers } from "../servers";
import type { ServerView } from "../types";
import { downloadFile } from "./download";
import { useUpdateStatus } from "./update-status";

// recharts is the biggest library on this page: the chart streams in after
// the cards (its own chunk), so the first screen does not wait for it.
const MetricChart = lazy(() => import("../../shared/ui/charts").then((m) => ({ default: m.MetricChart })));

type Window = {
  revenue_cents: number;
  gross_cents: number;
  manual_cents: number;
  gift_cents: number;
  orders: number;
  refunds_cents: number;
  signups: number;
};
type Day = Required<Omit<MetricDay, "traffic_bytes">>;

export type Dashboard = {
  at: string;
  timezone: string;
  today_date: string;
  today: Window;
  d7: Window;
  d30: Window;
  users_total: number;
  subscribers: number;
  subscribers_7d: number;
  online_users: number;
  servers: { total: number; online: number; offline: number; disabled: number; pending: number; alerting: number };
  pending: {
    tickets_open: number;
    withdrawals: number;
    mail_failed: number;
    orders_unfulfilled: number;
    alerts_firing: number;
  };
  pending_detail: {
    alert_oldest_at: string | null;
    alert_oldest_kind: string | null;
    alert_oldest_server: string | null;
    alerts_unacked: number;
    order_sample_id: string | null;
    order_sample_no: string | null;
    order_sample_error: string | null;
    withdrawals_cents: number;
    ticket_oldest_at: string | null;
    mail_last_error: string | null;
  };
  latest_orders: {
    id: string;
    out_trade_no: string;
    user_label: string;
    user_email: string | null;
    plan_name: string;
    amount_cents: number;
    status: string;
    paid_via: string | null;
    created_at: string;
    action: string;
    fulfilled_at: string | null;
    refunded_at: string | null;
    refund_cents: number | null;
  }[];
  series: Day[];
  prev_today: { revenue_cents: number; gross_cents: number; refunds_cents: number; orders: number; signups: number };
};

type Range = "today" | "7d" | "30d";
const DAYS: Record<Range, number> = { today: 1, "7d": 7, "30d": 30 };

/** "2026 年 10 月 12 日 星期一" / "Monday, October 12, 2026" for a site day (YYYY-MM-DD). */
function longDate(day: string, lang: Lang): string {
  const d = new Date(`${day}T12:00:00Z`);
  const wd = d.toLocaleDateString("zh-CN", { timeZone: "UTC", weekday: "long" });
  return lang === "en"
    ? d.toLocaleDateString("en-US", {
        timeZone: "UTC",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${wd}`;
}

const sumOf = (rows: Day[], f: (d: Day) => number) => rows.reduce((a, d) => a + f(d), 0);
const traffic = (d: Day) => d.direct_bytes + d.relay_bytes + d.other_bytes;
/** Change in percent, null when there is nothing to compare with. */
const change = (cur: number, prev: number) => (prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100);

export function DashboardPage() {
  const tr = useTr();
  const lang = useLang();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => get<Dashboard>("/dashboard"), refetchInterval: 30_000 });
  const d = q.data;
  const header = (
    <PageHeader
      title={tr("仪表盘", "Dashboard")}
      description={
        d ? (
          <>
            {longDate(d.today_date, lang)}
            <span className="max-sm:hidden">{tr(` · 站点时区 ${d.timezone}`, ` · site time zone ${d.timezone}`)}</span>
          </>
        ) : undefined
      }
      actions={
        d && <Fresh updatedAt={q.dataUpdatedAt} stale={q.isError && !!d} every={30} onRefresh={() => q.refetch()} />
      }
    />
  );
  if (q.isError && !d)
    return (
      <>
        {header}
        <Card>
          <ErrorState
            title={tr("仪表盘加载失败", "The dashboard did not load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        </Card>
      </>
    );
  return (
    <>
      {header}
      <div className="grid gap-4">
        {!d ? <QueueSkeleton /> : <Queue d={d} />}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <Business d={d} />
          <LatestOrders d={d} />
        </div>
        <Fleet d={d} />
      </div>
    </>
  );
}

/* ---------- ① 需要你处理 ---------- */

type Item = {
  key: string;
  icon: LucideIcon;
  tone: "danger" | "warning" | "info";
  count: number;
  what: string;
  detail: ReactNode;
  to: string;
  cta: string;
  action?: ReactNode;
};

function useQueueItems(d: Dashboard): Item[] {
  const tr = useTr();
  const lang = useLang();
  const toast = useToast();
  const [run] = useAction();
  const p = d.pending;
  const x = d.pending_detail;
  const ackAll = () =>
    run(
      async () => {
        const r = await get<{ alerts: { id: number; acked_at: string | null }[] }>(
          `/alerts${qs({ status: "firing", limit: 200 })}`,
        );
        const open = r.alerts.filter((a) => !a.acked_at);
        for (const a of open) await post(`/alerts/${a.id}/ack`);
        return open.length;
      },
      { errorPrefix: tr("确认告警失败", "Acknowledging failed") },
    ).then((n) => {
      if (n !== undefined)
        toast({
          tone: "success",
          title: tr(`已确认 ${n} 条告警，通知不再重复发送`, `${n} alerts acknowledged; no more repeats`),
        });
      return n;
    });
  const retryOrder = () =>
    run(
      () =>
        post<{ fulfilled: boolean }>(`/orders/${x.order_sample_id}/fulfil`, {
          reason: tr("仪表盘：重试开通", "Dashboard: retry fulfilment"),
        }),
      { errorPrefix: tr("重试开通失败", "Retry failed") },
    ).then((r) => {
      if (r)
        toast(
          r.fulfilled
            ? { tone: "success", title: tr(`订单 ${x.order_sample_no} 已开通`, `Order ${x.order_sample_no} fulfilled`) }
            : {
                tone: "error",
                title: tr(`订单 ${x.order_sample_no} 仍未开通`, `Order ${x.order_sample_no} still not fulfilled`),
              },
        );
      return r;
    });
  const retryMail = () =>
    run(
      async () => {
        const rows = await get<{ id: number; retryable: boolean }[]>(
          `/mail/outbox${qs({ status: "dead", limit: 200 })}`,
        );
        const ok = rows.filter((m) => m.retryable);
        for (const m of ok) await post(`/mail/outbox/${m.id}/retry`);
        return ok.length;
      },
      { errorPrefix: tr("重试失败", "Retry failed") },
    ).then((n) => {
      if (n !== undefined) toast({ tone: "success", title: tr(`${n} 封邮件已重新排队`, `${n} mails requeued`) });
      return n;
    });
  const orderReason = x.order_sample_error
    ? /insufficient balance/i.test(x.order_sample_error)
      ? tr("余额不足，未能开通", "Balance short, not granted")
      : tr("已付款，套餐未能开通", "Paid, the plan was not granted")
    : tr("已付款，套餐未能开通", "Paid, the plan was not granted");
  const items: Item[] = [
    {
      key: "alerts",
      icon: Bell,
      tone: "danger",
      count: p.alerts_firing,
      what: tr("条告警正在触发", "alerts firing"),
      detail: x.alert_oldest_at
        ? tr(
            `最久：${x.alert_oldest_server ?? ""} ${alertKindName(x.alert_oldest_kind ?? "", tr)} ${waitText(x.alert_oldest_at, lang)}`,
            `Longest: ${x.alert_oldest_server ?? ""} ${alertKindName(x.alert_oldest_kind ?? "", tr)}, ${waitText(x.alert_oldest_at, lang)}`,
          )
        : "",
      to: "/alerts",
      cta: tr("查看告警", "View alerts"),
      action:
        x.alerts_unacked > 0 ? (
          <AsyncButton size="sm" variant="outline" done={tr("已确认", "Done")} onClick={ackAll}>
            {tr("全部确认", "Acknowledge all")}
          </AsyncButton>
        ) : undefined,
    },
    {
      key: "orders",
      icon: PackageX,
      tone: "danger",
      count: p.orders_unfulfilled,
      what: tr("笔订单已付款但没开通", "paid orders not fulfilled"),
      detail: (
        <>
          {orderReason}
          {x.order_sample_no && (
            <>
              {" · "}
              <span className="font-mono">{x.order_sample_no}</span>
            </>
          )}
        </>
      ),
      to: "/orders?status=unfulfilled",
      cta: tr("去处理", "Handle"),
      action: x.order_sample_id ? (
        <AsyncButton size="sm" variant="outline" done={tr("已处理", "Done")} onClick={retryOrder}>
          {tr("重试开通", "Retry fulfilment")}
        </AsyncButton>
      ) : undefined,
    },
    {
      key: "withdrawals",
      icon: Wallet,
      tone: "warning",
      count: p.withdrawals,
      what: tr("笔提现等待审核", "withdrawals to review"),
      detail: tr(`合计 ${yuan(x.withdrawals_cents)}`, `${yuan(x.withdrawals_cents)} in total`),
      to: "/finance?status=pending",
      cta: tr("去审核", "Review"),
    },
    {
      key: "tickets",
      icon: LifeBuoy,
      tone: "warning",
      count: p.tickets_open,
      what: tr("个工单等待回复", "tickets awaiting a reply"),
      detail: x.ticket_oldest_at
        ? tr(`最久的已等 ${waitText(x.ticket_oldest_at, lang)}`, `Longest wait ${waitText(x.ticket_oldest_at, lang)}`)
        : "",
      to: "/tickets?status=open",
      cta: tr("去回复", "Reply"),
    },
    {
      key: "mails",
      icon: MailWarning,
      tone: "info",
      count: p.mail_failed,
      what: tr("封邮件发送失败", "mails failed"),
      detail: x.mail_last_error
        ? tr(`最近一封：${mailReason(x.mail_last_error, tr)}`, `Latest: ${mailReason(x.mail_last_error, tr)}`)
        : "",
      to: "/status?tab=mail&mail=dead",
      cta: tr("查看", "View"),
      action: (
        <AsyncButton size="sm" variant="outline" done={tr("已重新排队", "Requeued")} onClick={retryMail}>
          {tr("全部重试", "Retry all")}
        </AsyncButton>
      ),
    },
  ];
  return items.filter((i) => i.count > 0);
}

function Queue({ d }: { d: Dashboard }) {
  const tr = useTr();
  const nav = useNavigate();
  const items = useQueueItems(d);
  if (items.length === 0) return <AllClear />;
  const total = items.reduce((a, b) => a + b.count, 0);
  return (
    <Card className="overflow-hidden" data-queue>
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <h2 className="text-headline font-semibold tracking-[-0.01em]">{tr("需要你处理", "Needs you")}</h2>
        <Badge tone="danger" className="tnum">
          {tr(`${total} 项`, `${total}`)}
        </Badge>
        <span className="ml-auto text-footnote text-faint max-sm:hidden">
          {tr("按紧急程度排列 · 点一行进入已筛选好的列表", "Most urgent first · a row opens the filtered list")}
        </span>
      </div>
      <ul className="divide-y divide-separator border-t border-separator">
        {items.map((it) => (
          <li key={it.key}>
            <div
              role="link"
              tabIndex={0}
              aria-label={`${it.count} ${it.what}`}
              data-queue-row={it.key}
              onClick={() => nav(it.to)}
              onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && nav(it.to)}
              className="group flex cursor-default items-center gap-3 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <IconBadge icon={it.icon} tone={it.tone} size="sm" />
              <span
                className={cn(
                  "tnum w-8 shrink-0 text-right text-title2 font-semibold tracking-[-0.02em] max-sm:w-6",
                  it.tone === "danger" && "text-destructive",
                )}
              >
                {it.count}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-callout font-medium">{it.what}</span>
                {it.detail && <span className="block truncate text-footnote text-muted-foreground">{it.detail}</span>}
              </span>
              {it.action && <span className="max-sm:hidden">{it.action}</span>}
              <span className="inline-flex items-center gap-0.5 text-body font-medium whitespace-nowrap text-primary max-sm:hidden">
                {it.cta}
                <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
              <ChevronRight className="size-4 text-faint sm:hidden" aria-hidden="true" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AllClear() {
  const tr = useTr();
  return (
    <Card className="relative overflow-hidden" data-allclear>
      <div className="pointer-events-none absolute -top-16 -left-10 size-56 rounded-full bg-success-soft blur-2xl" />
      <div className="relative flex flex-wrap items-center gap-4 px-5 py-5">
        <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-success text-white shadow-raised">
          <CheckCircle2 className="size-6" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-title3 font-semibold tracking-[-0.015em]">
            {tr("一切就绪", "All clear")} <PartyPopper className="size-4 text-warning" aria-hidden="true" />
          </h2>
          <p className="mt-0.5 text-body text-muted-foreground">
            {tr(
              "没有告警、没有待回复工单、没有待审提现，订单和邮件都正常。",
              "No alerts, no tickets waiting, no withdrawals to review; orders and mail are fine.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-footnote text-muted-foreground">
          {[
            tr("告警 0", "Alerts 0"),
            tr("开通失败 0", "Unfulfilled 0"),
            tr("提现 0", "Withdrawals 0"),
            tr("工单 0", "Tickets 0"),
            tr("失败邮件 0", "Failed mail 0"),
          ].map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
              {s}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function QueueSkeleton() {
  return (
    <Card>
      <div className="h-11 border-b border-separator" />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-separator px-4 py-3 last:border-0">
          <Skeleton className="size-9 rounded-[10px]" />
          <Skeleton className="h-3 w-48" />
        </div>
      ))}
    </Card>
  );
}

/* ---------- ② 业务 ---------- */

function useRange(): [Range, Metric, (p: Record<string, string | null>) => void] {
  const [query, patch] = useQS();
  const r = query.get("range");
  const range: Range = r === "today" ? "today" : r === "30d" || r === "d30" ? "30d" : "7d";
  const m = query.get("metric");
  const metric: Metric = m === "orders" || m === "signups" || m === "traffic" ? m : "net";
  return [range, metric, (p) => patch(p, true)];
}

function Business({ d }: { d: Dashboard | undefined }) {
  const tr = useTr();
  const lang = useLang();
  const toast = useToast();
  const [range, metric, patch] = useRange();
  const [exporting, setExporting] = useState(false);
  const n = DAYS[range];
  const series = d?.series ?? [];
  const cur = series.slice(-n);
  const prev = range === "today" ? [] : series.slice(-2 * n, -n);
  const rangeName = { today: tr("今日", "Today's"), "7d": tr("近 7 天", "7-day"), "30d": tr("近 30 天", "30-day") }[
    range
  ];
  const pt = d?.prev_today;
  const net = sumOf(cur, (x) => x.revenue_cents);
  const orders = sumOf(cur, (x) => x.orders);
  const signups = sumOf(cur, (x) => x.signups);
  const tb = sumOf(cur, traffic);
  const cmp: Record<Metric, number | null> =
    range === "today"
      ? {
          net: pt ? change(net, pt.revenue_cents) : null,
          orders: pt ? change(orders, pt.orders) : null,
          signups: pt ? change(signups, pt.signups) : null,
          traffic: null,
        }
      : {
          net:
            prev.length === n
              ? change(
                  net,
                  sumOf(prev, (x) => x.revenue_cents),
                )
              : null,
          orders:
            prev.length === n
              ? change(
                  orders,
                  sumOf(prev, (x) => x.orders),
                )
              : null,
          signups:
            prev.length === n
              ? change(
                  signups,
                  sumOf(prev, (x) => x.signups),
                )
              : null,
          traffic: prev.length === n ? change(tb, sumOf(prev, traffic)) : null,
        };
  const unit = (v: ReactNode, u: string) => (
    <>
      {v}
      <span className="ml-0.5 text-callout font-medium text-muted-foreground">{u}</span>
    </>
  );
  const metrics: { id: Metric; label: string; value: ReactNode; foot: ReactNode }[] = [
    {
      id: "net",
      label: tr("净营收", " net revenue"),
      value: yuan(net),
      foot: tr(
        `实收 ${yuan(sumOf(cur, (x) => x.gross_cents))} · 退款 ${yuan(sumOf(cur, (x) => x.refunds_cents))}`,
        `collected ${yuan(sumOf(cur, (x) => x.gross_cents))} · refunded ${yuan(sumOf(cur, (x) => x.refunds_cents))}`,
      ),
    },
    {
      id: "orders",
      label: tr("订单", " orders"),
      value: unit(orders.toLocaleString(), tr("笔", "")),
      foot:
        range === "today"
          ? tr(`昨日同时段 ${pt?.orders ?? 0} 笔`, `${pt?.orders ?? 0} by this time yesterday`)
          : tr(`日均 ${(orders / n).toFixed(1)} 笔`, `${(orders / n).toFixed(1)} a day`),
    },
    {
      id: "signups",
      label: tr("注册", " sign-ups"),
      value: unit(signups.toLocaleString(), tr("人", "")),
      foot:
        range === "today"
          ? tr(`昨日同时段 ${pt?.signups ?? 0} 人`, `${pt?.signups ?? 0} by this time yesterday`)
          : tr(`日均 ${(signups / n).toFixed(1)} 人`, `${(signups / n).toFixed(1)} a day`),
    },
    {
      id: "traffic",
      label: tr("全网流量", " traffic"),
      value: bytes(tb),
      foot: tr(
        `直连 ${bytes(sumOf(cur, (x) => x.direct_bytes))} · 中转 ${bytes(sumOf(cur, (x) => x.relay_bytes))}`,
        `direct ${bytes(sumOf(cur, (x) => x.direct_bytes))} · relay ${bytes(sumOf(cur, (x) => x.relay_bytes))}`,
      ),
    },
  ];
  // No hourly data: "today" charts the last 14 site days.
  const chartDays = series.slice(-(range === "today" ? 14 : n));
  const exportCsv = async () => {
    if (!d || exporting) return;
    setExporting(true);
    const to = d.today_date;
    try {
      await downloadFile(`/orders/export.csv${qs({ from: daysBefore(to, n - 1), to })}`, `akari-orders-${to}.csv`);
      toast({ tone: "success", title: tr("已开始下载", "Download started") });
    } catch (e) {
      toast({ tone: "error", title: errorText(e, lang) });
    } finally {
      setExporting(false);
    }
  };
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3.5 pb-3">
        <h2 className="text-headline font-semibold tracking-[-0.01em]">{tr("业务", "Business")}</h2>
        <span className="text-footnote text-faint max-sm:hidden">
          {range === "today"
            ? tr("与昨日同时段相比", "vs yesterday by this time")
            : tr("与上一个同长周期相比", "vs the previous period")}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            icon={Download}
            className="max-sm:hidden"
            loading={exporting}
            disabled={!d}
            onClick={() => void exportCsv()}
            title={tr("导出所选时间范围的订单 CSV", "Export the period's orders (CSV)")}
          >
            {tr("导出", "Export")}
          </Button>
          <Segmented
            size="sm"
            label={tr("时间范围", "Period")}
            value={range}
            onChange={(v) => patch({ range: v === "7d" ? null : v })}
            options={[
              { value: "today", label: tr("今日", "Today") },
              { value: "7d", label: tr("7 天", "7 days") },
              { value: "30d", label: tr("30 天", "30 days") },
            ]}
          />
        </span>
      </div>
      <div
        role="tablist"
        aria-label={tr("指标", "Metric")}
        className="grid grid-cols-2 border-y border-separator sm:grid-cols-4"
      >
        {metrics.map((x, i) => {
          const on = x.id === metric;
          const c = cmp[x.id];
          return (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={on}
              data-kpi={x.id}
              onClick={() => patch({ metric: x.id === "net" ? null : x.id })}
              className={cn(
                "relative min-w-0 px-4 pt-3 pb-3.5 text-left transition-colors",
                i > 0 && "sm:border-l sm:border-separator",
                i % 2 === 1 && "max-sm:border-l max-sm:border-separator",
                i > 1 && "max-sm:border-t max-sm:border-separator",
                on ? "bg-primary-soft/40" : "hover:bg-accent",
              )}
            >
              {on && <span className="absolute inset-x-0 top-0 h-[2px] bg-primary" aria-hidden="true" />}
              <div className="flex items-center gap-1.5 text-footnote font-medium text-muted-foreground">
                <span className={cn("truncate", on && "text-primary")}>
                  {rangeName}
                  {x.label}
                </span>
                {c != null && (
                  <span
                    className={cn(
                      "tnum ml-auto inline-flex items-center rounded-full px-1 text-caption font-semibold",
                      c >= 0 ? "text-success" : "text-destructive",
                    )}
                    title={
                      range === "today"
                        ? tr("与昨日同时段相比", "vs yesterday by this time")
                        : tr("与上一个同长周期相比", "vs the previous period")
                    }
                  >
                    {c >= 0 ? (
                      <ArrowUpRight className="size-3" aria-hidden="true" />
                    ) : (
                      <ArrowDownRight className="size-3" aria-hidden="true" />
                    )}
                    {Math.abs(c).toFixed(1)}%
                  </span>
                )}
              </div>
              {!d ? (
                <Skeleton className="mt-2 h-7 w-28" />
              ) : (
                <div
                  className={cn(
                    "tnum mt-1 truncate text-title2 font-semibold tracking-[-0.02em] sm:text-title1",
                    x.id === "net" && net < 0 && "text-destructive",
                  )}
                >
                  {x.value}
                </div>
              )}
              <div className="mt-0.5 truncate text-footnote text-faint">{d ? x.foot : " "}</div>
            </button>
          );
        })}
      </div>
      <div className="px-2 pt-3 pb-2">
        {!d ? (
          <Skeleton className="mx-2 h-[260px]" />
        ) : (
          <Suspense fallback={<Skeleton className="mx-2 h-[260px]" />}>
            <MetricChart
              data={chartDays}
              metric={metric}
              axisLabel={(day) => `${Number(day.slice(5, 7))}/${Number(day.slice(8))}`}
            />
          </Suspense>
        )}
      </div>
      {d && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-separator px-4 py-2.5 text-footnote text-muted-foreground">
          <span>
            {tr("用户", "Users")} <b className="tnum font-semibold text-foreground">{d.users_total.toLocaleString()}</b>
          </span>
          <span>
            {tr("有效订阅", "Active subscriptions")}{" "}
            <b className="tnum font-semibold text-foreground">{d.subscribers.toLocaleString()}</b>
            {tr(`（本周 +${d.subscribers_7d}）`, ` (+${d.subscribers_7d} in 7 days)`)}
          </span>
          <span>
            {tr("当前在线", "Online now")}{" "}
            <b className="tnum font-semibold text-foreground">{d.online_users.toLocaleString()}</b>
            {tr(" 人", "")}
          </span>
          {metric === "net" && (
            <span data-revenue-split className="text-faint sm:ml-auto">
              {tr(
                "净营收 = 渠道实收 − 渠道退款，退款计入退款当天；余额、抵扣、优惠券部分不算营收",
                "Net = channel collected − channel refunded, refunds on their day; balance, credit and coupon parts are not revenue",
              )}
              {d.d30.manual_cents + d.d30.gift_cents > 0 &&
                tr(
                  `；30 天含人工 ${yuan(d.d30.manual_cents)}、赠送 ${yuan(d.d30.gift_cents)}`,
                  `; 30 days include manual ${yuan(d.d30.manual_cents)}, gifts ${yuan(d.d30.gift_cents)}`,
                )}
            </span>
          )}
          {range === "today" && (
            <span className="basis-full text-faint">
              {tr("今日按天显示近 14 天（没有按小时的数据）", "Today shows the last 14 days (no hourly data)")}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

const ACTION: Record<string, [string, string]> = {
  new: ["新购", "new"],
  renew: ["续费", "renewal"],
  switch: ["换套餐", "switch"],
  reset: ["流量重置", "traffic reset"],
};

function LatestOrders({ d }: { d: Dashboard | undefined }) {
  const tr = useTr();
  return (
    <Card className="flex min-w-0 flex-col">
      <div className="flex items-center px-4 pt-3.5 pb-2">
        <h2 className="text-headline font-semibold tracking-[-0.01em]">{tr("最新订单", "Latest orders")}</h2>
        <Button variant="ghost" size="sm" className="ml-auto" asChild>
          <Link to="/orders">
            {tr("全部", "All")}
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <ul className="flex-1 divide-y divide-separator px-2 pb-2">
        {!d && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mx-2 my-3 h-8" />)}
        {d?.latest_orders.length === 0 && (
          <li className="py-10 text-center text-body text-muted-foreground">{tr("还没有订单", "No orders yet")}</li>
        )}
        {d?.latest_orders.map((o) => {
          const st = orderState(o);
          const at = dateTime(o.created_at);
          const kind = ACTION[o.action];
          return (
            <li key={o.id}>
              <Link
                to={`/orders?open=${o.id}`}
                title={o.out_trade_no}
                className="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent"
              >
                <span className="tnum w-10 shrink-0 text-footnote text-faint">
                  {at.slice(0, 10) === d.today_date ? at.slice(11, 16) : at.slice(5, 10)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 truncate text-body font-medium">
                    {st === "unfulfilled" && (
                      <CircleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                    )}
                    <span className="truncate">{o.plan_name}</span>
                    {kind && <span className="shrink-0 font-normal text-faint">· {tr(...kind)}</span>}
                  </span>
                  <span className="block truncate text-footnote text-muted-foreground">
                    {o.user_email ?? o.user_label}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="tnum text-body font-semibold">{yuan(o.amount_cents)}</span>
                  {st !== "completed" && <OrdStatus state={st} />}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/* ---------- ③ 服务器 ---------- */

type Kind = "online" | "offline" | "quota" | "pending" | "deleting";
function kindOf(s: ServerView): Kind {
  if (s.deleting_at) return "deleting";
  if (!s.enrolled) return "pending";
  if (s.traffic_quota.exceeded_at) return "quota";
  return s.online ? "online" : "offline";
}
const RANK: Record<Kind, number> = { offline: 0, quota: 1, online: 2, pending: 3, deleting: 4 };
function kindLook(k: Kind, tr: Tr): { label: string; text: string; dot: string } {
  return {
    online: { label: tr("在线", "Online"), text: "text-success", dot: "bg-success" },
    offline: { label: tr("离线", "Offline"), text: "text-destructive", dot: "bg-destructive" },
    quota: { label: tr("额度用尽 · 已停用", "Quota used up · stopped"), text: "text-warning", dot: "bg-warning" },
    pending: {
      label: tr("待注册", "Not installed"),
      text: "text-muted-foreground",
      dot: "bg-transparent ring-1 ring-faint",
    },
    deleting: { label: tr("删除中", "Deleting"), text: "text-muted-foreground", dot: "bg-faint" },
  }[k];
}

function Fleet({ d }: { d: Dashboard | undefined }) {
  const tr = useTr();
  const lang = useLang();
  const servers = useServers();
  const upd = useUpdateStatus();
  const rollouts = useQuery({
    queryKey: ["rollouts"],
    queryFn: () =>
      get<{ id: string; status: string; current_wave: number; waves: number[]; version: string }[]>("/rollouts"),
  });
  const list = [...(servers.data ?? [])].sort(
    (a, b) => RANK[kindOf(a)] - RANK[kindOf(b)] || b.alerts_firing - a.alerts_firing || a.name.localeCompare(b.name),
  );
  const shown = list.slice(0, 8);
  const top = list
    .filter((s) => s.traffic_quota.used_bytes > 0 && !s.deleting_at)
    .sort((a, b) => b.traffic_quota.used_bytes - a.traffic_quota.used_bytes)
    .slice(0, 5);
  const s = d?.servers;
  const open = rollouts.data?.find((r) => r.status === "running" || r.status === "paused" || r.status === "halted");
  const u = upd.data;
  const link = (to: string, cls: string, text: string) => (
    <Link to={to} className={cn("font-medium hover:underline", cls)}>
      {text}
    </Link>
  );
  const parts: ReactNode[] = [];
  if (s) {
    if (s.offline)
      parts.push(link("/nodes?view=issue", "text-destructive", tr(`${s.offline} 台离线`, `${s.offline} offline`)));
    if (s.disabled)
      parts.push(link("/nodes?view=issue", "text-warning", tr(`${s.disabled} 台停用`, `${s.disabled} disabled`)));
    if (s.pending) parts.push(<span>{tr(`${s.pending} 台待注册`, `${s.pending} not installed`)}</span>);
  }
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-3">
        <h2 className="text-headline font-semibold tracking-[-0.01em] max-sm:flex-1">{tr("服务器", "Servers")}</h2>
        <p className="min-w-0 flex-1 text-body text-muted-foreground max-sm:order-last max-sm:basis-full" data-fleet>
          {!s ? (
            <Skeleton className="h-4 w-64" />
          ) : s.total === 0 ? (
            tr("还没有服务器", "No servers yet")
          ) : s.online === s.total && s.alerting === 0 ? (
            tr(`${s.total} 台全部在线`, `All ${s.total} online`)
          ) : (
            <>
              <b className="font-semibold text-foreground">{s.total}</b>
              {tr(" 台中 ", " servers, ")}
              <b className="font-semibold text-success">{s.online}</b>
              {tr(" 台在线", " online")}
              {parts.map((p, i) => (
                <span key={i}>
                  {i === 0 ? tr("，", ", ") : tr("、", ", ")}
                  {p}
                </span>
              ))}
              {s.alerting > 0 && (
                <>
                  {tr("；", "; ")}
                  {link("/alerts", "text-destructive", tr(`${s.alerting} 台告警中`, `${s.alerting} alerting`))}
                </>
              )}
            </>
          )}
        </p>
        <Button variant="ghost" size="sm" asChild>
          <Link to="/nodes">
            {tr("节点页", "Nodes")}
            <ChevronRight aria-hidden="true" />
          </Link>
        </Button>
      </div>
      {u?.update_available && (
        <Link
          to="/updates"
          className="mx-4 mb-3 flex items-center gap-2.5 rounded-lg bg-primary-soft px-3 py-2 text-body transition-[filter] hover:brightness-95"
        >
          <Download className="size-4 shrink-0 text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <b className="font-semibold text-primary">
              {tr(`agent ${u.update_available} 可用`, `agent ${u.update_available} available`)}
            </b>
            <span className="text-foreground/80">
              {tr(` · ${u.outdated_servers} 台还在旧版本`, ` · ${u.outdated_servers} on older versions`)}
              {open &&
                (open.status === "running"
                  ? tr(
                      ` · 灰度进行中（第 ${open.current_wave + 1}/${open.waves.length} 批）`,
                      ` · rollout running (wave ${open.current_wave + 1}/${open.waves.length})`,
                    )
                  : tr(" · 灰度已暂停", " · rollout paused"))}
            </span>
          </span>
          <ArrowRight className="size-4 shrink-0 text-primary" aria-hidden="true" />
        </Link>
      )}
      <div className="grid gap-px border-t border-separator bg-separator lg:grid-cols-[1fr_300px]">
        {servers.isError && !servers.data ? (
          <div className="bg-card">
            <ErrorState compact error={servers.error} onRetry={() => void servers.refetch()} />
          </div>
        ) : !servers.data ? (
          <div className="grid grid-cols-2 gap-px bg-separator xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="bg-card p-4">
                <Skeleton className="h-16" />
              </div>
            ))}
          </div>
        ) : list.length === 0 ? (
          <div className="bg-card px-4 py-8 text-center text-body text-muted-foreground">
            {tr("还没有服务器。", "No servers yet.")}{" "}
            <Link to="/nodes?new=server" className="text-primary hover:underline">
              {tr("添加服务器", "Add a server")}
            </Link>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-px bg-separator xl:grid-cols-4">
            {shown.map((sv) => {
              const k = kindOf(sv);
              const look = kindLook(k, tr);
              const tq = sv.traffic_quota;
              const qp = tq.bytes ? pct(tq.used_bytes, tq.bytes) : null;
              return (
                <li key={sv.id} className="bg-card">
                  <Link
                    to={`/nodes?open=server:${sv.id}`}
                    className="flex h-full flex-col gap-2 px-4 py-3 transition-colors hover:bg-accent max-sm:px-3"
                  >
                    <span className="flex items-center gap-2">
                      <span className={cn("size-2 shrink-0 rounded-full", look.dot)} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-body font-medium">{sv.name}</span>
                      {sv.alerts_firing > 0 && (
                        <Badge tone="danger" className="px-1.5" title={tr("告警中", "Alerting")}>
                          <Bell aria-hidden="true" />
                          {sv.alerts_firing}
                        </Badge>
                      )}
                    </span>
                    <span className={cn("truncate text-footnote", look.text)}>
                      {look.label}
                      {k === "online" && (
                        <span className="text-muted-foreground">
                          {sv.heartbeat?.cpu_percent != null && ` · CPU ${sv.heartbeat.cpu_percent.toFixed(0)}%`}
                          {sv.agent_version && ` · v${sv.agent_version.replace(/^v/, "")}`}
                        </span>
                      )}
                      {k === "offline" && sv.last_seen_at && (
                        <span className="text-muted-foreground">
                          {tr(
                            ` · 最后心跳 ${ago(sv.last_seen_at, lang)}`,
                            ` · last seen ${ago(sv.last_seen_at, lang)}`,
                          )}
                        </span>
                      )}
                    </span>
                    {qp !== null ? (
                      <span className="mt-auto">
                        <span className="mb-1 flex justify-between gap-2 text-caption text-muted-foreground">
                          <span className="tnum truncate">
                            {bytes(tq.used_bytes)} / {bytes(tq.bytes)}
                          </span>
                          <span
                            className={cn(
                              "tnum font-semibold",
                              tq.exceeded_at || qp >= 100
                                ? "text-destructive"
                                : qp >= 80
                                  ? "text-warning"
                                  : "text-foreground",
                            )}
                          >
                            {qp.toFixed(0)}%
                          </span>
                        </span>
                        <Meter
                          value={qp}
                          tone={tq.exceeded_at ? "danger" : usageTone(qp)}
                          label={tr("流量额度", "Traffic quota")}
                        />
                      </span>
                    ) : (
                      <span className="mt-auto text-caption text-faint">
                        {k === "pending"
                          ? tr("等待 agent 首次连接", "Waiting for the agent")
                          : tr("不限额度", "No quota")}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
            {list.length > shown.length && (
              <li className="bg-card">
                <Link
                  to="/nodes"
                  className="flex h-full items-center justify-center px-4 py-3 text-body text-primary hover:bg-accent"
                >
                  {tr(`还有 ${list.length - shown.length} 台`, `${list.length - shown.length} more`)}
                </Link>
              </li>
            )}
          </ul>
        )}
        <div className="bg-card px-4 py-3">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-body font-semibold">{tr("本周期流量最多", "Most traffic this period")}</h3>
            <span className="text-caption text-faint">{tr("网卡流量", "NIC traffic")}</span>
          </div>
          {top.length === 0 ? (
            <p className="py-4 text-footnote text-muted-foreground">
              {tr("本周期还没有流量。", "No traffic this period yet.")}
            </p>
          ) : (
            <ol className="grid gap-2.5">
              {top.map((sv, i) => (
                <li key={sv.id}>
                  <Link to={`/nodes?open=server:${sv.id}`} className="block rounded-md hover:bg-accent">
                    <span className="flex items-center gap-2 text-body">
                      <span className="tnum w-3 text-footnote text-faint">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate">{sv.name}</span>
                      <span className="tnum font-medium">{bytes(sv.traffic_quota.used_bytes)}</span>
                    </span>
                    <span className="mt-1 ml-5 block h-1 rounded-full bg-secondary">
                      <span
                        className="block h-full rounded-full bg-(--chart-1)"
                        style={{ width: `${(sv.traffic_quota.used_bytes / top[0].traffic_quota.used_bytes) * 100}%` }}
                      />
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Card>
  );
}
