// 仪表盘 (DSH-*): GET /dashboard (one aggregate read; site time zone days),
// the servers for the quota bars, the agent update badge.
import { useQuery } from "@tanstack/react-query";
import { get } from "../../shared/api";
import { bytes, dateTime, pct, yuan } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { Bars } from "../../shared/ui/charts";
import { Icon, type IconName } from "../../shared/ui/icons";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Dot,
  ErrorState,
  PageHeader,
  Progress,
  Skeleton,
  usageTone,
} from "../../shared/ui/primitives";
import { Stat } from "../kit";
import { navigate } from "../router";
import type { ServerView } from "../types";
import { OrderStatus } from "./orders";
import { UpdateBadge } from "./updates";

type Window = {
  revenue_cents: number;
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

/** The last 14 site days ending at `today` (YYYY-MM-DD), oldest first. */
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

export function DashboardPage() {
  const tr = useTr();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: () => get<Dashboard>("/dashboard"), refetchInterval: 30_000 });
  const servers = useQuery({ queryKey: ["servers"], queryFn: () => get<ServerView[]>("/servers") });
  const d = q.data;
  const loading = q.isPending;

  const header = (
    <PageHeader
      title={tr("仪表盘", "Dashboard")}
      description={
        d
          ? tr(
              `数据更新于 ${dateTime(d.at)}（${d.timezone}）· 按站点时区的日统计`,
              `Updated ${dateTime(d.at)} (${d.timezone}) · days of the site time zone`,
            )
          : undefined
      }
      actions={
        <>
          <UpdateBadge />
          <Button size="sm" icon="refresh" onClick={() => void q.refetch()} loading={q.isFetching && !loading}>
            {tr("刷新", "Refresh")}
          </Button>
          <Button size="sm" variant="primary" icon="plus" onClick={() => navigate("/users?new=1")}>
            {tr("新建用户", "New user")}
          </Button>
        </>
      }
    />
  );
  if (q.isError)
    return (
      <>
        {header}
        <Card>
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        </Card>
      </>
    );

  const days = d ? lastDays(d.today_date, 14) : [];
  const byDay = new Map((d?.traffic_days ?? []).map((x) => [x.day, x.billed_bytes]));
  const series = days.map((day) => byDay.get(day) ?? 0);
  const maxV = Math.max(1, ...series);
  const unit = maxV >= 1024 ** 4 ? 1024 ** 4 : maxV >= 1024 ** 3 ? 1024 ** 3 : 1024 ** 2;
  const unitName = unit === 1024 ** 4 ? "TiB" : unit === 1024 ** 3 ? "GiB" : "MiB";
  const window = (w: Window) =>
    tr(
      `${yuan(w.revenue_cents)} · ${w.orders} 单${w.refunds_cents ? ` · 退款 ${yuan(w.refunds_cents)}` : ""}`,
      `${yuan(w.revenue_cents)} · ${w.orders} orders${w.refunds_cents ? ` · refunds ${yuan(w.refunds_cents)}` : ""}`,
    );
  const s = d?.servers;

  const todos: [IconName, string, number, string][] = d
    ? [
        ["ticket", tr("待回复工单", "Tickets awaiting reply"), d.pending.tickets_open, "/tickets?status=open"],
        [
          "receipt",
          tr("已付款未开通的订单", "Paid, not fulfilled"),
          d.pending.orders_unfulfilled,
          "/orders?unfulfilled=1",
        ],
        ["wallet", tr("待审核提现", "Pending withdrawals"), d.pending.withdrawals, "/finance?status=pending"],
        ["mail", tr("发送失败的邮件", "Failed mail"), d.pending.mail_failed, "/settings/mail?outbox=dead"],
        ["bell", tr("正在告警", "Alerts firing"), d.pending.alerts_firing, "/alerts"],
      ]
    : [];

  return (
    <>
      {header}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading || !d ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28" />)
        ) : (
          <>
            <Stat
              icon="wallet"
              label={tr("今日营收", "Revenue today")}
              value={yuan(d.today.revenue_cents)}
              hint={
                <>
                  {tr(`7 天 ${window(d.d7)}`, `7d ${window(d.d7)}`)}
                  <br />
                  {tr(`30 天 ${window(d.d30)}`, `30d ${window(d.d30)}`)}
                  {d.d30.manual_cents > 0 &&
                    tr(
                      ` · 含人工 ${yuan(d.d30.manual_cents)}，赠送 ${yuan(d.d30.gift_cents)}`,
                      ` · manual ${yuan(d.d30.manual_cents)}, gifts ${yuan(d.d30.gift_cents)}`,
                    )}
                </>
              }
            />
            <Stat
              icon="users"
              label={tr("有效订阅", "Active subscriptions")}
              value={d.subscribers.toLocaleString()}
              hint={tr(
                `共 ${d.users_total.toLocaleString()} 个账户 · 今日注册 ${d.today.signups}`,
                `${d.users_total.toLocaleString()} accounts · ${d.today.signups} signed up today`,
              )}
            />
            <Stat
              icon="zap"
              label={tr("当前在线用户", "Online now")}
              value={d.online_users.toLocaleString()}
              hint={tr("在线服务器心跳之和", "Sum of the online servers' heartbeats")}
            />
            <Stat
              icon="server"
              label={tr("服务器在线", "Servers online")}
              value={`${s?.online ?? 0} / ${s?.total ?? 0}`}
              tone={s && (s.offline > 0 || s.alerting > 0) ? "warning" : undefined}
              hint={tr(
                `离线 ${s?.offline} · 停用 ${s?.disabled} · 待注册 ${s?.pending} · 告警 ${s?.alerting}`,
                `${s?.offline} offline · ${s?.disabled} disabled · ${s?.pending} not enrolled · ${s?.alerting} alerting`,
              )}
            />
          </>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title={tr("近 14 天全网流量（计费）", "Fleet traffic, last 14 days (billed)")}
            description={tr(`单位 ${unitName} · 站点时区的日`, `${unitName} · site days`)}
            actions={
              d && (
                <Badge tone="outline">
                  {tr("合计", "Total")} {bytes(series.reduce((a, b) => a + b, 0))}
                </Badge>
              )
            }
          />
          <CardBody>
            {loading ? (
              <Skeleton className="h-44 w-full" />
            ) : (
              <Bars
                data={series.map((v) => Number((v / unit).toFixed(2)))}
                labels={days.map((x) => x.slice(5))}
                unit={unitName}
              />
            )}
            {d && d.traffic_top_nodes.length > 0 && (
              <div className="mt-4">
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {tr("流量最多的节点", "Top nodes by traffic")}
                </div>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {d.traffic_top_nodes.slice(0, 6).map((n) => (
                    <li key={n.node_id} className="flex justify-between text-[13px]">
                      <span className="truncate">{n.name ?? tr("已删除的节点", "Deleted node")}</span>
                      <span className="tabular-nums text-muted-foreground">{bytes(n.billed_bytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={tr("待处理", "Needs attention")} />
          <CardBody className="space-y-1 py-2">
            {loading
              ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="my-2 h-8 w-full" />)
              : todos.map(([icon, label, n, to]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => navigate(to)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-[13px] hover:bg-muted"
                  >
                    <span className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <Icon name={icon} size={14} />
                    </span>
                    <span className="flex-1">{label}</span>
                    <Badge tone={n > 0 ? "danger" : "neutral"}>{n}</Badge>
                    <Icon name="chevronRight" size={14} className="text-muted-foreground" />
                  </button>
                ))}
          </CardBody>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader
            title={tr("最新订单", "Latest orders")}
            actions={
              <Button size="sm" variant="ghost" onClick={() => navigate("/orders")}>
                {tr("全部订单", "All orders")}
                <Icon name="chevronRight" size={14} />
              </Button>
            }
          />
          <ul className="divide-y divide-border">
            {loading && <Skeleton className="m-4 h-24" />}
            {d?.latest_orders.length === 0 && (
              <li className="px-5 py-6 text-center text-[13px] text-muted-foreground">
                {tr("还没有订单", "No orders yet")}
              </li>
            )}
            {d?.latest_orders.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/orders?open=${o.id}`)}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13px] hover:bg-subtle sm:px-5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{o.user_email ?? o.user_label}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {o.plan_name} · {o.out_trade_no} · {dateTime(o.created_at)}
                    </div>
                  </div>
                  <OrderStatus status={o.status} />
                  <div className="w-20 text-right font-medium tabular-nums">{yuan(o.amount_cents)}</div>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardHeader
            title={tr("服务器", "Servers")}
            actions={
              <Button size="sm" variant="ghost" onClick={() => navigate("/nodes")}>
                {tr("节点", "Nodes")}
                <Icon name="chevronRight" size={14} />
              </Button>
            }
          />
          <ul className="divide-y divide-border">
            {servers.isPending && <Skeleton className="m-4 h-20" />}
            {servers.data?.length === 0 && (
              <li className="px-5 py-6 text-center text-[13px] text-muted-foreground">
                {tr("还没有服务器", "No servers yet")}
              </li>
            )}
            {servers.data?.map((sv) => {
              const q2 = sv.traffic_quota;
              const qp = q2.bytes ? pct(q2.used_bytes, q2.bytes) : null;
              const hb = sv.heartbeat;
              return (
                <li key={sv.id} className="px-4 py-3 sm:px-5">
                  <div className="flex items-center gap-2 text-[13px]">
                    <Dot tone={sv.online ? "success" : "danger"} />
                    <span className="font-medium">{sv.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {sv.online && hb
                        ? `CPU ${hb.cpu_percent?.toFixed(0) ?? "?"}% · ${tr("内存", "mem")} ${
                            hb.mem_total_bytes ? pct(hb.mem_used_bytes ?? 0, hb.mem_total_bytes) : "?"
                          }%`
                        : tr("离线", "offline")}
                    </span>
                  </div>
                  {qp !== null && (
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Progress value={qp} tone={q2.exceeded_at ? "danger" : usageTone(qp)} className="flex-1" />
                      <span className="w-32 text-right tabular-nums">
                        {bytes(q2.used_bytes)} / {bytes(q2.bytes)}
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
