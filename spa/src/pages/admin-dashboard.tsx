// W21: 仪表盘 — the console's landing view (GET /dashboard, one aggregate
// read; src/dashboard.rs). Stat tiles, not charts: each figure is a single
// headline number with its context; the pending work links to its view.
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { LineChart } from "../components/line-chart";
import { ErrorText, TableNote } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { adminBase, get } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { UpdateAvailableBadge } from "./admin-update-check";
import { yuan } from "../lib/billing";
import { fmtDateTime, fmtTime, TZ_LABEL } from "../lib/datetime";
import { navigate } from "../lib/router";
import { humanBytes } from "../lib/utils";

export interface DashboardWindow {
  revenue_cents: number;
  orders: number;
  refunds_cents: number;
  signups: number;
}

export interface Dashboard {
  at: string;
  today_start: string;
  today: DashboardWindow;
  d7: DashboardWindow;
  d30: DashboardWindow;
  users_total: number;
  subscribers: number;
  online_users: number;
  nodes: { total: number; online: number; offline: number; disabled: number; pending: number; alerting: number };
  pending: {
    tickets_open: number;
    withdrawals: number;
    mail_failed: number;
    orders_unfulfilled: number;
    alerts_firing: number;
  };
  // W22 traffic history (UTC days; days without traffic are absent).
  traffic_days: { day: string; up_bytes: number; down_bytes: number; billed_bytes: number; users: number }[];
  traffic_top_nodes: {
    node_id: string;
    name: string | null;
    up_bytes: number;
    down_bytes: number;
    billed_bytes: number;
  }[];
  latest_orders: {
    id: string;
    out_trade_no: string;
    user_login: string;
    plan_name: string;
    amount_cents: number;
    status: string;
    created_at: string;
    paid_at: string | null;
  }[];
}

const ORDER_STATUS: Record<string, { text: string; variant: "success" | "secondary" | "outline" }> = {
  paid: { text: "已付款", variant: "success" },
  pending: { text: "待付款", variant: "outline" },
  expired: { text: "已过期", variant: "secondary" },
  cancelled: { text: "已取消", variant: "secondary" },
};

function go(view: string) {
  return (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(`${adminBase}/${view}`);
  };
}

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** A count of waiting work: a link to its view; highlighted when not zero. */
function Todo({ label, count, view }: { label: string; count: number; view: string }) {
  return (
    <a
      href={`${adminBase}/${view}`}
      onClick={go(view)}
      className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>{label}</span>
      <span
        className={`min-w-8 rounded-full px-2 py-0.5 text-center text-sm font-semibold tabular-nums ${
          count > 0 ? "bg-destructive text-destructive-foreground" : "bg-muted text-muted-foreground"
        }`}
      >
        {count}
      </span>
    </a>
  );
}

const money = (cents: number) => `¥${yuan(cents)}`;

/** The last `n` UTC days ending at `at` ("YYYY-MM-DD"), oldest first. */
export function lastDays(at: string, n: number): string[] {
  const end = Date.parse(`${at.slice(0, 10)}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

/** Fleet traffic per day (W22) with zero-filled missing days, and the top nodes. */
function TrafficCard({ d }: { d: Dashboard }) {
  const days = lastDays(d.at, 14);
  const by = new Map(d.traffic_days.map((r) => [r.day, r]));
  const up = days.map((x) => by.get(x)?.up_bytes ?? 0);
  const down = days.map((x) => by.get(x)?.down_bytes ?? 0);
  const total = up.reduce((a, b) => a + b, 0) + down.reduce((a, b) => a + b, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>流量（近 14 天）</h2>
        </CardTitle>
        <CardDescription>全部节点每日上下行（UTC 日），合计 {humanBytes(total)}。</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <LineChart
            title="每日流量"
            times={days.map((x) => `${x}T12:00:00Z`)}
            series={[
              { label: "下行", values: down, stroke: "stroke-sky-600", swatch: "bg-sky-600" },
              { label: "上行", values: up, stroke: "stroke-amber-600", swatch: "bg-amber-600" },
            ]}
            format={humanBytes}
          />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">流量最多的节点</h3>
          {d.traffic_top_nodes.length === 0 ? (
            <p className="text-sm text-muted-foreground">这段时间没有流量。</p>
          ) : (
            <ol className="space-y-1.5 text-sm">
              {d.traffic_top_nodes.map((n) => (
                <li key={n.node_id} className="flex items-baseline justify-between gap-3">
                  <a
                    className="min-w-0 truncate underline-offset-2 hover:underline"
                    href={`${adminBase}/nodes/${n.node_id}`}
                    onClick={go(`nodes/${n.node_id}`)}
                  >
                    {n.name ?? "（已删除的节点）"}
                  </a>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {humanBytes(n.up_bytes + n.down_bytes)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function AdminDashboard() {
  const q = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => get<Dashboard>("/dashboard"),
    refetchInterval: 30_000,
  });
  const d = q.data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">仪表盘</h1>
          <UpdateAvailableBadge />
        </div>
        {d && (
          <p className="text-xs text-muted-foreground">
            更新于 {fmtTime(d.at, true)}（{TZ_LABEL}；「今日」从 00:00 起算，每 30 秒刷新）
          </p>
        )}
      </div>
      {q.isError && <ErrorText>{adminErrorText(q.error, "仪表盘加载失败")}</ErrorText>}
      {q.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
      {d && (
        <>
          <section aria-labelledby="dash-revenue" className="space-y-3">
            <h2 id="dash-revenue" className="text-sm font-medium text-muted-foreground">
              营收（支付宝实收）
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {(
                [
                  ["今日", d.today],
                  ["近 7 天", d.d7],
                  ["近 30 天", d.d30],
                ] as const
              ).map(([label, w]) => (
                <Tile
                  key={label}
                  label={label}
                  value={money(w.revenue_cents)}
                  sub={
                    <>
                      {w.orders} 笔订单
                      {w.refunds_cents > 0 && ` · 退款 ${money(w.refunds_cents)}`} · 新注册 {w.signups}
                    </>
                  }
                />
              ))}
            </div>
          </section>
          <section aria-labelledby="dash-users" className="space-y-3">
            <h2 id="dash-users" className="text-sm font-medium text-muted-foreground">
              用户与节点
            </h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Tile label="用户总数" value={d.users_total} sub={`今日新注册 ${d.today.signups}`} />
              <Tile label="有效订阅" value={d.subscribers} sub="持有生效中套餐的用户" />
              <Tile label="在线用户" value={d.online_users} sub="各在线节点上报之和" />
              <Tile
                label="节点在线"
                value={`${d.nodes.online} / ${d.nodes.total}`}
                sub={
                  <>
                    离线 {d.nodes.offline} · 等待安装 {d.nodes.pending} · 已停用 {d.nodes.disabled}
                    {d.nodes.alerting > 0 && (
                      <span className="font-medium text-destructive"> · 告警 {d.nodes.alerting}</span>
                    )}
                  </>
                }
              />
            </div>
          </section>
          <TrafficCard d={d} />
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            <Card className="min-w-0 lg:col-span-1">
              <CardHeader>
                <CardTitle>
                  <h2>待处理</h2>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Todo label="待回复工单" count={d.pending.tickets_open} view="tickets" />
                <Todo label="待审核提现" count={d.pending.withdrawals} view="finance" />
                <Todo label="告警中" count={d.pending.alerts_firing} view="alerts" />
                <Todo label="开通失败的订单" count={d.pending.orders_unfulfilled} view="orders" />
                <Todo label="发送失败的邮件" count={d.pending.mail_failed} view="settings/failed-mail" />
              </CardContent>
            </Card>
            <Card className="min-w-0 lg:col-span-2">
              <CardHeader>
                <CardTitle>
                  <h2>最新订单</h2>
                </CardTitle>
                <CardDescription>
                  <a className="underline" href={`${adminBase}/orders`} onClick={go("orders")}>
                    查看全部订单
                  </a>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table label="最新订单">
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间（{TZ_LABEL}）</TableHead>
                      <TableHead>用户</TableHead>
                      <TableHead>套餐</TableHead>
                      <TableHead className="text-right">金额</TableHead>
                      <TableHead>状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {d.latest_orders.length === 0 && <TableNote colSpan={5}>还没有订单。</TableNote>}
                    {d.latest_orders.map((o) => {
                      const st = ORDER_STATUS[o.status] ?? { text: o.status, variant: "outline" as const };
                      return (
                        <TableRow key={o.id}>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {fmtDateTime(o.created_at)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap font-medium">{o.user_login}</TableCell>
                          <TableCell className="whitespace-nowrap">{o.plan_name}</TableCell>
                          <TableCell className="whitespace-nowrap text-right tabular-nums">
                            {money(o.amount_cents)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={st.variant}>{st.text}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
