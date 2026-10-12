// 仪表盘 (DSH-*): GET /dashboard (one aggregate read; site time zone days),
// the servers for the quota bars, the agent update badge. Layout from the
// 2026-10 design (dashboard-*.png): KPI cards with chips, fleet traffic,
// needs-attention list, servers with quota meters, net revenue, latest
// orders. The period control (今日 / 7 天 / 30 天, in the URL as ?range=)
// picks the revenue window shown and the CSV export range. A failed poll
// keeps the last data on screen and says so (audit §5.2).
//
// Where the design shows data the API does not have, the closest real data
// is shown instead (no invented numbers):
// - traffic split 直连 / 中转 → 下行 / 上行 (raw bytes per site day);
// - daily net-revenue bars → the three windows (today, 7 d, 30 d), collected
//   and refunded;
// - KPI trend % → net revenue against the longer window's daily average
//   (today vs 7 d, 7 d vs 30 d; none for 30 d); no KPI sparklines (no
//   per-day series for those figures).
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronRight,
  Download,
  LifeBuoy,
  MailWarning,
  PackageX,
  RefreshCw,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { Suspense, lazy, useState } from "react";
import { Link } from "react-router";
import { get, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { bytes, dateTime, daysBefore, pct, yuan } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge, Dot } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader } from "../../shared/ui/card";
import { Segmented } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { Meter, usageTone } from "../../shared/ui/meter";
import { ActionRow, KpiCard, Legend, TrendChip, actionRowClass, type SoftTone } from "../../shared/ui/stat";
import { ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { errorText } from "../../shared/errors";
import { useQueryParam } from "../router";
import { useServers } from "../servers";
import type { ServerView } from "../types";
import { downloadFile } from "./download";
import { OrderStatus } from "./order-status";
import { UpdateBadge } from "./update-status";

// recharts is the biggest library on this page: the charts stream in after
// the cards (their own chunk), so the first screen does not wait for them.
const TrendChart = lazy(() => import("../../shared/ui/charts").then((m) => ({ default: m.TrendChart })));

type Window = {
  /** Net: gross − refunds (docs/PAYMENTS.md "Revenue"). */
  revenue_cents: number;
  gross_cents: number;
  manual_cents: number;
  gift_cents: number;
  orders: number;
  refunds_cents: number;
  signups: number;
};

type Dashboard = {
  at: string;
  timezone: string;
  today_date: string;
  today: Window;
  d7: Window;
  d30: Window;
  users_total: number;
  subscribers: number;
  online_users: number;
  servers: { total: number; online: number; offline: number; disabled: number; pending: number; alerting: number };
  pending: {
    tickets_open: number;
    withdrawals: number;
    mail_failed: number;
    orders_unfulfilled: number;
    alerts_firing: number;
  };
  traffic_days: { day: string; up_bytes: number; down_bytes: number; billed_bytes: number; users: number }[];
  traffic_top_nodes: { node_id: string; name: string | null; billed_bytes: number }[];
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
  }[];
};

/** The last n site days ending at `today` (YYYY-MM-DD), oldest first. */
function lastDays(today: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(`${today}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d);
    x.setUTCDate(d.getUTCDate() - i);
    out.push(x.toISOString().slice(0, 10));
  }
  return out;
}

/** "2026 年 10 月 12 日 星期一" / "Monday, October 12, 2026" for a site day (YYYY-MM-DD). */
function longDate(day: string, lang: "zh" | "en"): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (lang === "en")
    return d.toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  const wd = d.toLocaleDateString("zh-CN", { timeZone: "UTC", weekday: "long" });
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 ${wd}`;
}

type Range = "today" | "d7" | "d30";
const DAYS: Record<Range, number> = { today: 1, d7: 7, d30: 30 };

/** Net revenue of `w` against the daily average of the longer window (percent), if meaningful. */
function trend(d: Dashboard, r: Range): number | null {
  const [cur, base] =
    r === "today"
      ? [d.today.revenue_cents, d.d7.revenue_cents / 7]
      : r === "d7"
        ? [d.d7.revenue_cents / 7, d.d30.revenue_cents / 30]
        : [0, 0];
  if (r === "d30" || base <= 0) return null;
  return ((cur - base) / base) * 100;
}

/** A server's state as a dot tone and a word (4 states, not just up/down). */
function serverDot(s: ServerView, tr: Tr): ["success" | "warning" | "danger" | "neutral" | "info", string] {
  if (s.deleting_at) return ["neutral", tr("删除中", "Deleting")];
  if (!s.enrolled) return ["info", tr("待安装", "Not installed")];
  if (s.traffic_quota.exceeded_at) return ["warning", tr("超额停用", "Over quota")];
  if (s.online) return ["success", tr("在线", "Online")];
  return ["danger", tr("离线", "Offline")];
}
const serverRank = (s: ServerView) =>
  s.deleting_at ? 4 : !s.online && s.enrolled ? 0 : s.traffic_quota.exceeded_at ? 1 : s.alerts_firing > 0 ? 2 : 3;

export function DashboardPage() {
  const tr = useTr();
  const lang = useLang();
  const toast = useToast();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => get<Dashboard>("/dashboard"), refetchInterval: 30_000 });
  const servers = useServers();
  const [rangeParam, setRange] = useQueryParam("range");
  const range: Range = rangeParam === "today" || rangeParam === "d30" ? rangeParam : "d7";
  const [exporting, setExporting] = useState(false);
  const d = q.data;
  const loading = q.isPending;
  const rangeLabel = { today: tr("今日", "Today"), d7: tr("7 天", "7 days"), d30: tr("30 天", "30 days") };

  const exportCsv = async () => {
    if (!d || exporting) return;
    setExporting(true);
    const to = d.today_date;
    const from = daysBefore(to, DAYS[range] - 1);
    try {
      await downloadFile(`/orders/export.csv${qs({ from, to })}`, `akari-orders-${to}.csv`);
      toast({ tone: "success", title: tr("已开始下载", "Download started") });
    } catch (e) {
      toast({ tone: "error", title: errorText(e, lang) });
    } finally {
      setExporting(false);
    }
  };

  const header = (
    <PageHeader
      title={tr("仪表盘", "Dashboard")}
      description={
        d ? (
          <span className="inline-flex flex-wrap items-center gap-x-1">
            <span>
              {tr(
                `${longDate(d.today_date, "zh")} · 站点时区 ${d.timezone}`,
                `${longDate(d.today_date, "en")} · site time zone ${d.timezone}`,
              )}
            </span>
            <span className="text-faint">
              · {tr(`${dateTime(d.at).slice(11, 16)} 更新`, `updated ${dateTime(d.at).slice(11, 16)}`)}
            </span>
            <button
              type="button"
              onClick={() => void q.refetch()}
              aria-label={tr("刷新", "Refresh")}
              title={tr("刷新", "Refresh")}
              className="hit-44 inline-flex size-5 items-center justify-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className={cn("size-3.5", q.isFetching && !loading && "animate-spin")} aria-hidden="true" />
            </button>
          </span>
        ) : undefined
      }
      actions={
        <>
          <UpdateBadge />
          {q.isError && d && (
            <Badge tone="warning" role="status">
              {tr("刷新失败，显示的是上次的数据", "Refresh failed; showing the last data")}
            </Badge>
          )}
          <Segmented
            value={range}
            onChange={(v) => setRange(v === "d7" ? null : v)}
            label={tr("时间范围", "Period")}
            options={[
              { value: "today", label: rangeLabel.today },
              { value: "d7", label: rangeLabel.d7 },
              { value: "d30", label: rangeLabel.d30 },
            ]}
          />
          <Button
            variant="outline"
            icon={Download}
            className="max-sm:hidden"
            loading={exporting}
            disabled={!d}
            onClick={() => void exportCsv()}
            title={tr("导出所选时间范围的订单 CSV", "Export the period's orders (CSV)")}
          >
            {tr("导出", "Export")}
          </Button>
        </>
      }
    />
  );
  if (q.isError && !d)
    return (
      <>
        {header}
        <Card>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </Card>
      </>
    );

  const days = d ? lastDays(d.today_date, 14) : [];
  const byDay = new Map((d?.traffic_days ?? []).map((x) => [x.day, x]));
  const down = days.map((day) => byDay.get(day)?.down_bytes ?? 0);
  const up = days.map((day) => byDay.get(day)?.up_bytes ?? 0);
  const billedTotal = days.reduce((a, day) => a + (byDay.get(day)?.billed_bytes ?? 0), 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const s = d?.servers;
  const w = d?.[range];
  const t = d ? trend(d, range) : null;
  const serverProblems = s ? s.offline + s.alerting : 0;

  const todos: { icon: LucideIcon; tone: SoftTone; label: string; n: number; to: string }[] = d
    ? [
        {
          icon: PackageX,
          tone: "danger",
          label: tr("已付款未开通的订单", "Paid, not fulfilled"),
          n: d.pending.orders_unfulfilled,
          to: "/orders?unfulfilled=1",
        },
        {
          icon: LifeBuoy,
          tone: "warning",
          label: tr("待回复工单", "Tickets awaiting reply"),
          n: d.pending.tickets_open,
          to: "/tickets?status=open",
        },
        {
          icon: Wallet,
          tone: "warning",
          label: tr("待审核提现", "Pending withdrawals"),
          n: d.pending.withdrawals,
          to: "/finance?status=pending",
        },
        {
          icon: Bell,
          tone: "danger",
          label: tr("正在告警", "Alerts firing"),
          n: d.pending.alerts_firing,
          to: "/alerts",
        },
        {
          icon: MailWarning,
          tone: "neutral",
          label: tr("发送失败的邮件", "Failed mail"),
          n: d.pending.mail_failed,
          to: "/status?mail=dead",
        },
      ]
    : [];
  const todoTotal = todos.reduce((a, x) => a + x.n, 0);
  const sorted = [...(servers.data ?? [])].sort(
    (a, b) => serverRank(a) - serverRank(b) || a.name.localeCompare(b.name),
  );
  const windows: [Range, Window][] = d
    ? [
        ["today", d.today],
        ["d7", d.d7],
        ["d30", d.d30],
      ]
    : [];

  return (
    <>
      {header}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading || !d || !w ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
        ) : (
          <>
            <KpiCard
              data-kpi="revenue"
              label={tr(`${rangeLabel[range]}净营收`, `Net revenue, ${rangeLabel[range].toLowerCase()}`)}
              value={yuan(w.revenue_cents)}
              tone={w.revenue_cents < 0 ? "danger" : undefined}
              chip={
                t != null && (
                  <TrendChip
                    dir={t >= 0.05 ? "up" : t <= -0.05 ? "down" : "flat"}
                    label={
                      range === "today"
                        ? tr(`较 7 天日均 ${t.toFixed(1)}%`, `${t.toFixed(1)}% vs the 7-day daily average`)
                        : tr(`7 天日均较 30 天日均 ${t.toFixed(1)}%`, `${t.toFixed(1)}% vs the 30-day daily average`)
                    }
                  >
                    {Math.abs(t).toFixed(1)}%
                  </TrendChip>
                )
              }
              foot={tr(
                `实收 ${yuan(w.gross_cents)} · 退款 ${yuan(w.refunds_cents)}`,
                `collected ${yuan(w.gross_cents)} · refunded ${yuan(w.refunds_cents)}`,
              )}
            />
            <KpiCard
              label={tr("有效订阅", "Active subscriptions")}
              value={d.subscribers.toLocaleString()}
              chip={
                w.signups > 0 && (
                  <TrendChip dir="up" label={tr(`${rangeLabel[range]}注册 ${w.signups}`, `${w.signups} sign-ups`)}>
                    {w.signups}
                  </TrendChip>
                )
              }
              foot={tr(
                `共 ${d.users_total.toLocaleString()} 个账户 · ${rangeLabel[range]}注册 ${w.signups}`,
                `${d.users_total.toLocaleString()} accounts · ${w.signups} sign-ups`,
              )}
            />
            <KpiCard
              label={tr("当前在线用户", "Online now")}
              value={d.online_users.toLocaleString()}
              foot={tr("在线服务器心跳之和", "Sum of the online servers' heartbeats")}
            />
            <KpiCard
              label={tr("服务器在线", "Servers online")}
              value={`${s?.online ?? 0} / ${s?.total ?? 0}`}
              tone={serverProblems > 0 ? "warning" : undefined}
              chip={
                serverProblems > 0 && (
                  <TrendChip dir="down" tone="danger">
                    {tr(`${serverProblems} 异常`, `${serverProblems} issues`)}
                  </TrendChip>
                )
              }
              foot={tr(
                `离线 ${s?.offline} · 停用 ${s?.disabled} · 待注册 ${s?.pending} · 告警 ${s?.alerting}`,
                `${s?.offline} offline · ${s?.disabled} disabled · ${s?.pending} pending · ${s?.alerting} alerting`,
              )}
            />
          </>
        )}
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_360px]">
        <Card className="min-w-0">
          <CardHeader
            title={tr("全网流量", "Fleet traffic")}
            description={tr(
              `近 14 天，按站点时区的日（计费前原始流量；计费 ${bytes(billedTotal)}）`,
              `Last 14 site days (raw traffic before multipliers; billed ${bytes(billedTotal)})`,
            )}
            actions={
              d && (
                <Legend
                  items={[
                    { label: tr("下行", "Down"), slot: 1, value: bytes(sum(down)) },
                    { label: tr("上行", "Up"), slot: 2, value: bytes(sum(up)) },
                  ]}
                />
              )
            }
          />
          <div className="px-2 pb-3">
            {loading ? (
              <Skeleton className="mx-2 h-60" />
            ) : (
              <Suspense fallback={<Skeleton className="mx-2 h-60" />}>
                <TrendChart
                  title={tr("近 14 天全网流量", "Fleet traffic, last 14 days")}
                  hideCaption
                  times={days}
                  axisLabel={(x) => x.slice(5).replace("-", "/").replace(/^0/, "").replace("/0", "/")}
                  tipLabel={(x) => x}
                  format={bytes}
                  series={[
                    { label: tr("下行", "Down"), values: down, slot: 1 },
                    { label: tr("上行", "Up"), values: up, slot: 2 },
                  ]}
                  height={240}
                />
              </Suspense>
            )}
          </div>
          {d && d.traffic_top_nodes.length > 0 && (
            <div className="mx-4 mb-3 border-t border-separator pt-3">
              <div className="mb-1.5 text-footnote font-medium text-muted-foreground">
                {tr("流量最多的节点", "Top nodes by traffic")}
              </div>
              <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                {d.traffic_top_nodes.slice(0, 6).map((n) => (
                  <li key={n.node_id} className="flex justify-between gap-3 text-body">
                    <span className="truncate">{n.name ?? tr("已删除的节点", "Deleted node")}</span>
                    <span className="tnum text-muted-foreground">{bytes(n.billed_bytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card className="flex flex-col">
          <CardHeader
            title={tr("待处理", "Needs attention")}
            description={tr("点击直接进入对应列表", "Opens the filtered list")}
            actions={todoTotal > 0 && <Badge tone="danger">{todoTotal}</Badge>}
          />
          <ul className="flex-1 px-2 pb-2">
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <li key={i} className="px-2 py-1.5">
                    <Skeleton className="h-8 w-full" />
                  </li>
                ))
              : todos.map((x) => (
                  <li key={x.label}>
                    <Link to={x.to} className={actionRowClass}>
                      <ActionRow
                        icon={x.icon}
                        tone={x.n > 0 ? x.tone : "neutral"}
                        label={x.label}
                        count={<span className={cn(x.n === 0 && "font-normal text-faint")}>{x.n}</span>}
                      />
                    </Link>
                  </li>
                ))}
          </ul>
        </Card>
      </div>

      <div className="mt-3 grid gap-3 xl:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader
            title={tr("服务器", "Servers")}
            description={tr(
              "问题在前；CPU、内存与本周期流量额度（D5，网卡流量）",
              "Problems first; CPU, memory and this period's traffic quota (D5, NIC traffic)",
            )}
            actions={
              <Button size="sm" variant="ghost" asChild>
                <Link to="/nodes">
                  {tr("全部", "All")}
                  <ChevronRight aria-hidden="true" />
                </Link>
              </Button>
            }
          />
          <ul className="divide-y divide-separator px-4 pb-2">
            {servers.isPending && <Skeleton className="my-2 h-24" />}
            {servers.isError && (
              <li>
                <ErrorState compact error={servers.error} onRetry={() => void servers.refetch()} />
              </li>
            )}
            {servers.data?.length === 0 && (
              <li className="py-6 text-center text-body text-muted-foreground">
                {tr("还没有服务器", "No servers yet")}
              </li>
            )}
            {sorted.slice(0, 6).map((sv) => {
              const q2 = sv.traffic_quota;
              const qp = q2.bytes ? pct(q2.used_bytes, q2.bytes) : null;
              const hb = sv.heartbeat;
              const [tone, word] = serverDot(sv, tr);
              return (
                <li key={sv.id}>
                  <Link
                    to={`/nodes?open=server:${sv.id}`}
                    className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent sm:grid-cols-[minmax(0,1.3fr)_72px_minmax(0,1fr)]"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Dot tone={tone} />
                      <span className="min-w-0">
                        <span className="block truncate text-body font-medium">{sv.name}</span>
                        <span className="block truncate text-footnote text-muted-foreground">
                          {sv.online && hb
                            ? `CPU ${hb.cpu_percent?.toFixed(0) ?? "?"}% · ${tr("内存", "mem")} ${
                                hb.mem_total_bytes ? pct(hb.mem_used_bytes ?? 0, hb.mem_total_bytes) : "?"
                              }%`
                            : word}
                        </span>
                      </span>
                    </span>
                    <span className="tnum truncate text-right text-footnote text-muted-foreground sm:text-left">
                      {sv.agent_version ? `v${sv.agent_version.replace(/^v/, "")}` : "—"}
                    </span>
                    <span className="col-span-2 sm:col-span-1">
                      {qp !== null ? (
                        <>
                          <span className="mb-1 flex justify-between gap-2 text-caption text-muted-foreground">
                            <span className="tnum truncate">
                              {bytes(q2.used_bytes)} / {bytes(q2.bytes)}
                            </span>
                            <span
                              className={cn(
                                "tnum font-semibold",
                                q2.exceeded_at || qp >= 100
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
                            tone={q2.exceeded_at ? "danger" : usageTone(qp)}
                            label={tr("流量额度", "Traffic quota")}
                          />
                        </>
                      ) : (
                        <span className="block text-caption text-faint">{tr("无流量额度", "No traffic quota")}</span>
                      )}
                    </span>
                  </Link>
                </li>
              );
            })}
            {sorted.length > 6 && (
              <li className="pt-2 text-footnote text-muted-foreground">
                {tr(`还有 ${sorted.length - 6} 台`, `${sorted.length - 6} more`)}
              </li>
            )}
          </ul>
        </Card>

        <Card className="min-w-0">
          <CardHeader
            title={tr("净营收", "Net revenue")}
            description={tr(
              "渠道实收 − 渠道退款，按站点时区（与 CSV 同口径）",
              "Channel collected − refunded, site days (same basis as the CSV)",
            )}
            actions={
              w && (
                <span className="tnum text-headline font-semibold" title={rangeLabel[range]}>
                  {yuan(w.revenue_cents)}
                </span>
              )
            }
          />
          <div className="px-2">
            {loading || !d ? (
              <Skeleton className="mx-2 h-44" />
            ) : (
              <Suspense fallback={<Skeleton className="mx-2 h-44" />}>
                <TrendChart
                  title={tr("各时间范围的实收与退款", "Collected and refunded by period")}
                  hideCaption
                  kind="bar"
                  legend="none"
                  times={windows.map(([id]) => id)}
                  axisLabel={(x) => rangeLabel[x as Range] ?? x}
                  format={yuan}
                  series={[
                    { label: tr("实收", "Collected"), values: windows.map(([, x]) => x.gross_cents), slot: 1 },
                    { label: tr("退款", "Refunded"), values: windows.map(([, x]) => x.refunds_cents), slot: 2 },
                  ]}
                  height={180}
                />
              </Suspense>
            )}
          </div>
          <dl className="mx-4 mt-2 divide-y divide-separator rounded-lg bg-window ring-1 ring-border ring-inset">
            {d
              ? windows.map(([id, x]) => (
                  <div
                    key={id}
                    data-revenue-window={id}
                    className={cn(
                      "flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-2 text-body",
                      id === range && "bg-primary-soft/60",
                    )}
                  >
                    <dt className="w-12 shrink-0 font-medium">{rangeLabel[id]}</dt>
                    <dd className="tnum flex min-w-0 flex-1 flex-wrap gap-x-3 text-footnote text-muted-foreground">
                      <span>
                        {tr("实收", "Collected")}
                        {yuan(x.gross_cents)}
                      </span>
                      <span>
                        {tr("退款", "Refunded")}
                        {yuan(x.refunds_cents)}
                      </span>
                      <span className="font-semibold text-foreground">
                        {tr("净额", "Net")}
                        {yuan(x.revenue_cents)}
                      </span>
                      <span>{tr(`${x.orders} 单`, `${x.orders} orders`)}</span>
                    </dd>
                  </div>
                ))
              : Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="m-3 h-5" />)}
          </dl>
          {d && (
            <p data-revenue-split className="px-4 pt-2 pb-4 text-footnote text-faint">
              {tr(
                "按付款日计实收、按退款日扣退款；余额、抵扣、优惠券部分不算营收",
                "Collected by payment day, refunds by refund day; balance, credit and coupon parts are not revenue",
              )}
              {d.d30.manual_cents > 0 &&
                tr(
                  `。30 天含人工 ${yuan(d.d30.manual_cents)}、赠送 ${yuan(d.d30.gift_cents)}`,
                  `. 30d includes manual ${yuan(d.d30.manual_cents)}, gifts ${yuan(d.d30.gift_cents)}`,
                )}
            </p>
          )}
        </Card>
      </div>

      <Card className="mt-3">
        <CardHeader
          title={tr("最新订单", "Latest orders")}
          actions={
            <Button size="sm" variant="ghost" asChild>
              <Link to="/orders">
                {tr("查看全部", "View all")}
                <ChevronRight aria-hidden="true" />
              </Link>
            </Button>
          }
        />
        <ul className="divide-y divide-separator px-4 pb-1">
          {loading && <Skeleton className="my-2 h-24" />}
          {d?.latest_orders.length === 0 && (
            <li className="py-6 text-center text-body text-muted-foreground">{tr("还没有订单", "No orders yet")}</li>
          )}
          {d?.latest_orders.map((o) => (
            <li key={o.id}>
              <Link
                to={`/orders?open=${o.id}`}
                className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent"
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 truncate text-body font-medium">
                    {o.plan_name}
                    <span className="truncate font-normal text-muted-foreground">· {o.out_trade_no}</span>
                  </span>
                  <span className="block truncate text-footnote text-muted-foreground">
                    {o.user_email ?? o.user_label} · {dateTime(o.created_at)}
                  </span>
                </span>
                <OrderStatus status={o.status} />
                <span className="tnum w-20 shrink-0 text-right text-body font-semibold">{yuan(o.amount_cents)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
