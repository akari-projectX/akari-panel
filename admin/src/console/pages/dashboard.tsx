// 仪表盘 (DSH-*): GET /dashboard (one aggregate read; site time zone days),
// the servers for the quota bars, the agent update badge. A failed poll
// keeps the last data on screen and says so (audit §5.2).
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronRight,
  LifeBuoy,
  Mail,
  PackageX,
  Plus,
  RefreshCw,
  Server,
  Users,
  Wallet,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { get } from "../../shared/api";
import { cn } from "../../shared/cn";
import { bytes, dateOnly, dateTime, pct, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge, Dot } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader } from "../../shared/ui/card";
import { TrendChart } from "../../shared/ui/charts";
import { PageHeader } from "../../shared/ui/layout";
import { Meter, usageTone } from "../../shared/ui/meter";
import { ErrorState, Skeleton } from "../../shared/ui/states";
import { navigate } from "../router";
import { useServers } from "../servers";
import type { ServerView } from "../types";
import { OrderStatus } from "./order-status";
import { UpdateBadge } from "./updates";

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

function Kpi({
  label,
  value,
  hint,
  tone,
  icon: Icon,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "danger" | "warning";
  icon: LucideIcon;
}) {
  return (
    <div className="flex flex-col rounded-xl bg-card p-4 shadow-card">
      <div className="flex items-center gap-1.5 text-footnote font-medium text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
        {label}
      </div>
      <div
        className={cn(
          "tnum mt-1.5 text-title2 font-semibold tracking-[-0.02em] sm:text-title1",
          tone === "danger" && "text-destructive",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 truncate text-footnote text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function DashboardPage() {
  const tr = useTr();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => get<Dashboard>("/dashboard"), refetchInterval: 30_000 });
  const servers = useServers();
  const d = q.data;
  const loading = q.isPending;

  const header = (
    <PageHeader
      title={tr("仪表盘", "Dashboard")}
      description={
        d
          ? tr(
              `${dateOnly(d.at)} · 站点时区 ${d.timezone} · 数据更新于 ${dateTime(d.at).slice(11, 16)}（${d.timezone}）`,
              `${dateOnly(d.at)} · site time zone ${d.timezone} · updated ${dateTime(d.at).slice(11, 16)} (${d.timezone})`,
            )
          : undefined
      }
      actions={
        <>
          <UpdateBadge />
          {q.isError && d && (
            <Badge tone="warning" role="status">
              {tr("刷新失败，显示的是上次的数据", "Refresh failed; showing the last data")}
            </Badge>
          )}
          <Button
            size="sm"
            variant="outline"
            icon={RefreshCw}
            onClick={() => void q.refetch()}
            loading={q.isFetching && !loading}
          >
            {tr("刷新", "Refresh")}
          </Button>
          <Button size="sm" variant="primary" icon={Plus} onClick={() => navigate("/users?new=1")}>
            {tr("新建用户", "New user")}
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
  const billed = days.map((day) => byDay.get(day)?.billed_bytes ?? 0);
  // Net revenue with its two parts: collected (by payment day) and refunded
  // channel money (by refund day).
  const split = (w: Window) =>
    tr(
      `实收 ${yuan(w.gross_cents)} · 退款 ${yuan(w.refunds_cents)} · 净额 ${yuan(w.revenue_cents)}`,
      `collected ${yuan(w.gross_cents)} · refunded ${yuan(w.refunds_cents)} · net ${yuan(w.revenue_cents)}`,
    );
  const s = d?.servers;

  const todos: [LucideIcon, string, number, string, string][] = d
    ? [
        [
          PackageX,
          tr("已付款未开通的订单", "Paid, not fulfilled"),
          d.pending.orders_unfulfilled,
          "/orders?unfulfilled=1",
          "#dc2626",
        ],
        [
          LifeBuoy,
          tr("待回复工单", "Tickets awaiting reply"),
          d.pending.tickets_open,
          "/tickets?status=open",
          "#7c3aed",
        ],
        [Wallet, tr("待审核提现", "Pending withdrawals"), d.pending.withdrawals, "/finance?status=pending", "#0d9488"],
        [Bell, tr("正在告警", "Alerts firing"), d.pending.alerts_firing, "/alerts", "#ea580c"],
        [Mail, tr("发送失败的邮件", "Failed mail"), d.pending.mail_failed, "/settings/mail?outbox=dead", "#64748b"],
      ]
    : [];
  const todoTotal = todos.reduce((a, t) => a + t[2], 0);
  const sorted = [...(servers.data ?? [])].sort(
    (a, b) => serverRank(a) - serverRank(b) || a.name.localeCompare(b.name),
  );

  return (
    <>
      {header}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        {loading || !d ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 rounded-xl" />)
        ) : (
          <>
            <Kpi
              icon={Wallet}
              label={tr("今日营收", "Revenue today")}
              value={yuan(d.today.revenue_cents)}
              tone={d.today.revenue_cents < 0 ? "danger" : undefined}
              hint={tr(
                `实收 ${yuan(d.today.gross_cents)} · 退款 ${yuan(d.today.refunds_cents)}`,
                `collected ${yuan(d.today.gross_cents)} · refunded ${yuan(d.today.refunds_cents)}`,
              )}
            />
            <Kpi
              icon={Users}
              label={tr("有效订阅", "Active subscriptions")}
              value={d.subscribers.toLocaleString()}
              hint={tr(
                `共 ${d.users_total.toLocaleString()} 个账户 · 今日注册 ${d.today.signups}`,
                `${d.users_total.toLocaleString()} accounts · ${d.today.signups} today`,
              )}
            />
            <Kpi
              icon={Wifi}
              label={tr("当前在线用户", "Online now")}
              value={d.online_users.toLocaleString()}
              hint={tr("在线服务器心跳之和", "Sum of the online servers' heartbeats")}
            />
            <Kpi
              icon={Server}
              label={tr("服务器在线", "Servers online")}
              value={`${s?.online ?? 0} / ${s?.total ?? 0}`}
              tone={s && (s.offline > 0 || s.alerting > 0) ? "warning" : undefined}
              hint={tr(
                `离线 ${s?.offline} · 停用 ${s?.disabled} · 待注册 ${s?.pending} · 告警 ${s?.alerting}`,
                `${s?.offline} offline · ${s?.disabled} disabled · ${s?.pending} pending · ${s?.alerting} alerting`,
              )}
            />
          </>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title={tr("近 14 天全网流量（计费）", "Fleet traffic, last 14 days (billed)")}
            description={tr("按站点时区的日；倍率之后的计费流量", "Site days; billed traffic after multipliers")}
          />
          <div className="px-4 pb-4">
            {loading ? (
              <Skeleton className="h-52 w-full" />
            ) : (
              <TrendChart
                title={tr("计费流量", "Billed traffic")}
                times={days}
                axisLabel={(t) => t.slice(5).replace("-", "/")}
                tipLabel={(t) => t}
                format={bytes}
                series={[{ label: tr("计费", "Billed"), values: billed, slot: 1 }]}
                height={200}
              />
            )}
            {d && d.traffic_top_nodes.length > 0 && (
              <div className="mt-3 border-t border-separator pt-3">
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
          </div>
        </Card>

        <Card>
          <CardHeader
            title={tr("待处理", "Needs attention")}
            description={tr("点击直接进入对应列表", "Opens the filtered list")}
            actions={todoTotal > 0 && <Badge tone="danger">{todoTotal}</Badge>}
          />
          <ul className="px-2 pb-2">
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <li key={i} className="px-2 py-2">
                    <Skeleton className="h-8 w-full" />
                  </li>
                ))
              : todos.map(([Icon, label, n, to, tint]) => (
                  <li key={label}>
                    <button
                      type="button"
                      onClick={() => navigate(to)}
                      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left text-body transition-colors hover:bg-accent"
                    >
                      <span
                        className="inline-flex size-7 shrink-0 items-center justify-center rounded-full"
                        style={{ background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint }}
                      >
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      <span className="flex-1">{label}</span>
                      <span className={cn("tnum font-semibold", n === 0 && "font-normal text-faint")}>{n}</span>
                      <ChevronRight className="size-4 text-faint" aria-hidden="true" />
                    </button>
                  </li>
                ))}
          </ul>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card>
          <CardHeader
            title={tr("营收", "Revenue")}
            description={tr("渠道实收 − 渠道退款，按站点时区", "Channel collected − refunded, site days")}
          />
          <dl className="mx-4 mb-4 divide-y divide-separator rounded-lg bg-window">
            {d
              ? (
                  [
                    [tr("今日", "Today"), d.today],
                    [tr("7 天", "7d"), d.d7],
                    [tr("30 天", "30d"), d.d30],
                  ] as [string, Window][]
                ).map(([k, w]) => (
                  <div key={k} className="grid gap-0.5 px-3 py-2.5">
                    <dt className="flex items-baseline justify-between gap-2 text-body">
                      <span className="text-muted-foreground">{k}</span>
                      <span className="tnum text-callout font-semibold">{yuan(w.revenue_cents)}</span>
                    </dt>
                    <dd className="text-footnote text-muted-foreground">
                      {`${k} ${split(w)}`}
                      {tr(` · ${w.orders} 单`, ` · ${w.orders} orders`)}
                    </dd>
                  </div>
                ))
              : Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="m-3 h-9" />)}
          </dl>
          {d && (
            <p data-revenue-split className="px-4 pb-4 text-footnote text-faint">
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

        <Card>
          <CardHeader
            title={tr("服务器", "Servers")}
            description={tr("问题在前；本周期流量额度", "Problems first; this period's traffic quota")}
            actions={
              <Button size="sm" variant="ghost" asChild>
                <Link to="/nodes">
                  {tr("全部", "All")}
                  <ChevronRight aria-hidden="true" />
                </Link>
              </Button>
            }
          />
          <ul className="px-2 pb-2">
            {servers.isPending && <Skeleton className="m-2 h-24" />}
            {servers.isError && (
              <li>
                <ErrorState compact error={servers.error} onRetry={() => void servers.refetch()} />
              </li>
            )}
            {servers.data?.length === 0 && (
              <li className="px-3 py-6 text-center text-body text-muted-foreground">
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
                    className="grid gap-1.5 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent"
                  >
                    <span className="flex items-center gap-2 text-body">
                      <Dot tone={tone} />
                      <span className="truncate font-medium">{sv.name}</span>
                      <span className="ml-auto shrink-0 text-footnote text-muted-foreground">
                        {sv.online && hb
                          ? `CPU ${hb.cpu_percent?.toFixed(0) ?? "?"}% · ${tr("内存", "mem")} ${
                              hb.mem_total_bytes ? pct(hb.mem_used_bytes ?? 0, hb.mem_total_bytes) : "?"
                            }%`
                          : word}
                      </span>
                    </span>
                    {qp !== null && (
                      <span className="flex items-center gap-2 text-caption text-muted-foreground">
                        <Meter
                          value={qp}
                          tone={q2.exceeded_at ? "danger" : usageTone(qp)}
                          className="flex-1"
                          label={tr("流量额度", "Traffic quota")}
                        />
                        <span className="tnum w-36 text-right">
                          {bytes(q2.used_bytes)} / {bytes(q2.bytes)}
                        </span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
            {sorted.length > 6 && (
              <li className="px-2 pt-1 text-footnote text-muted-foreground">
                {tr(`还有 ${sorted.length - 6} 台`, `${sorted.length - 6} more`)}
              </li>
            )}
          </ul>
        </Card>

        <Card>
          <CardHeader
            title={tr("最新订单", "Latest orders")}
            actions={
              <Button size="sm" variant="ghost" asChild>
                <Link to="/orders">
                  {tr("全部订单", "All orders")}
                  <ChevronRight aria-hidden="true" />
                </Link>
              </Button>
            }
          />
          <ul className="px-2 pb-2">
            {loading && <Skeleton className="m-2 h-24" />}
            {d?.latest_orders.length === 0 && (
              <li className="px-3 py-6 text-center text-body text-muted-foreground">
                {tr("还没有订单", "No orders yet")}
              </li>
            )}
            {d?.latest_orders.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/orders?open=${o.id}`)}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-body transition-colors hover:bg-accent"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{o.user_email ?? o.user_label}</div>
                    <div className="truncate text-footnote text-muted-foreground">
                      {o.plan_name} · {o.out_trade_no} · {dateTime(o.created_at)}
                    </div>
                  </div>
                  <OrderStatus status={o.status} />
                  <div className="tnum w-20 text-right font-medium">{yuan(o.amount_cents)}</div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
