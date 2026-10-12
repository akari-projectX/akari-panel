// 告警 (ALR-*; v2 alerts-*, an incident board):
// - 正在告警: one card per firing alert (critical / warning strip, kind
//   icon, server, value and rule, how long, acknowledge with its own
//   spinner, open the server); tick cards → floating bar "确认 N 条";
//   none firing = a calm green card.
// - 历史: resolved alerts grouped by site day, kind chips with 7-day counts
//   (?kind=), server filter (?server=), older pages; no match = clear.
// - Detail (?open=<id>): facts + the timeline (fired → each channel's
//   notification → acknowledged → still firing / resolved).
// - /alerts/outbox: the notification log merged per event (delivered
//   channels as chips, failed / waiting ones as cards with their reason and
//   retry), ?channel= / ?status= / ?page=.
// Thresholds and channels live in 系统设置 → 告警通道与阈值 (a link here).
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { get, post, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateOnly, dateTime } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Segmented, Select } from "../../shared/ui/form";
import { Callout, KV, PageHeader } from "../../shared/ui/layout";
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from "../../shared/ui/states";
import { useAction } from "../data";
import { AsyncButton, ChannelIcon, RawError, SelectionBar, Timeline, type TimelineItem } from "../components/kit";
import { ALERT_KIND_ICON, alertKindName, alertSevere, dayLabel, waitText } from "../components/ops-bits";
import { navigate, useQS, useRoute } from "../router";
import { useServers } from "../servers";

type Alert = {
  id: number;
  server_id: string;
  server_name: string;
  kind: string;
  status: string;
  fired_at: string;
  resolved_at: string | null;
  value: string;
  detail: string;
  notified: boolean;
  acked_at: string | null;
  acked_by: string | null;
};
type AlertList = {
  alerts: Alert[];
  firing: number;
  firing_by_kind: Record<string, number>;
  resolved_7d_by_kind: Record<string, number>;
};
type Notification = {
  id: number;
  alert_id: number | null;
  channel: string;
  event: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  title: string | null;
};

const PAGE = 50;
type Ch = "telegram" | "webhook" | "email";
const isCh = (c: string): c is Ch => c === "telegram" || c === "webhook" || c === "email";
const serverLink = (id: string) => `/nodes?open=server:${id}`;

function channelName(c: string, tr: Tr) {
  return ({ telegram: "Telegram", webhook: "Webhook", email: tr("邮件", "Email") } as Record<string, string>)[c] ?? c;
}
function eventName(e: string, tr: Tr) {
  return (
    (
      {
        firing: tr("触发", "Firing"),
        resolved: tr("恢复", "Resolved"),
        test: tr("测试", "Test"),
        billing: tr("计费", "Billing"),
      } as Record<string, string>
    )[e] ?? e
  );
}
/** A delivery's raw error → one sentence. */
function deliveryReason(raw: string, tr: Tr): string {
  const s = raw.toLowerCase();
  const code = /\b([45]\d\d)\b/.exec(raw)?.[1];
  if (/timed? ?out|timeout/.test(s)) return tr("连接超时", "Timed out");
  if (s.includes("refused")) return tr("连接被拒绝：对方没有在监听", "Connection refused");
  if (/dns|resolve|lookup/.test(s)) return tr("域名解析失败", "DNS lookup failed");
  if (/certificate|tls|handshake/.test(s)) return tr("TLS 握手或证书出错", "TLS or certificate error");
  if (code === "401" || code === "403" || /unauthori[sz]ed|forbidden/.test(s))
    return tr("对方拒绝了凭据（token 或签名）", "Credentials refused (token or signature)");
  if (code) return tr(`对方返回 ${code}`, `The receiver answered ${code}`);
  return tr("发送失败", "Delivery failed");
}

export function AlertsPage() {
  const tr = useTr();
  const { sub } = useRoute();
  const loc = useLocation();
  // Older links: the settings tab and the old log path.
  if (sub[0] === "settings") return <Navigate to="/settings/alerts" replace />;
  if (sub[0] === "notifications") return <Navigate to={`/alerts/outbox${loc.search}`} replace />;
  const out = sub[0] === "outbox";
  return (
    <>
      <PageHeader
        title={tr("告警", "Alerts")}
        description={
          out
            ? tr(
                "每条告警通知发往各通道的记录，失败的可以逐条重试",
                "Each alert notice per channel; retry the failed ones",
              )
            : tr(
                "服务器越过阈值时触发；确认后在恢复前不再重复通知",
                "Fires when a server crosses a threshold; acknowledged alerts stop repeating until resolved",
              )
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          label={tr("告警视图", "Alerts view")}
          value={out ? "outbox" : "alerts"}
          onChange={(v) => navigate(v === "outbox" ? "/alerts/outbox" : "/alerts")}
          options={[
            {
              value: "alerts",
              label: (
                <>
                  <Bell className="size-3.5" aria-hidden="true" />
                  {tr("告警", "Alerts")}
                </>
              ),
            },
            {
              value: "outbox",
              label: (
                <>
                  <Upload className="size-3.5" aria-hidden="true" />
                  {tr("通知记录", "Notifications")}
                </>
              ),
            },
          ]}
        />
        <Link
          to="/settings/alerts"
          className="ml-auto inline-flex items-center gap-1 text-footnote text-muted-foreground hover:text-primary"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          {tr("阈值与通道在 系统设置 → 告警通道与阈值", "Thresholds and channels: Settings → Alert channels")}
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      {out ? <Outbox /> : <Board />}
    </>
  );
}

function KindTile({ a, size = 36 }: { a: Pick<Alert, "kind" | "status">; size?: number }) {
  const Icon = ALERT_KIND_ICON[a.kind] ?? Bell;
  const resolved = a.status !== "firing";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[10px] [&_svg]:size-[50%]",
        resolved
          ? "bg-secondary text-muted-foreground"
          : alertSevere(a.kind)
            ? "bg-destructive text-white"
            : "bg-warning text-white",
      )}
      style={{ width: size, height: size }}
    >
      <Icon />
    </span>
  );
}

function SevBadge({ kind }: { kind: string }) {
  const tr = useTr();
  return alertSevere(kind) ? (
    <Badge tone="danger">{tr("严重", "Critical")}</Badge>
  ) : (
    <Badge tone="warning">{tr("警告", "Warning")}</Badge>
  );
}

function useAck() {
  const tr = useTr();
  const [run] = useAction();
  return (a: Alert) =>
    run(() => post(`/alerts/${a.id}/ack`), {
      ok: tr(`已确认：${a.server_name} ${alertKindName(a.kind, tr)}`, `Acknowledged: ${a.server_name}`),
    });
}

function FiringCard({
  a,
  selected,
  onSelect,
  onOpen,
}: {
  a: Alert;
  selected: boolean;
  onSelect: (v: boolean) => void;
  onOpen: () => void;
}) {
  const tr = useTr();
  const lang = useLang();
  const ack = useAck();
  const severe = alertSevere(a.kind);
  return (
    <Card
      data-alert={a.id}
      className={cn(
        "relative flex flex-col overflow-hidden transition-shadow hover:shadow-raised",
        selected && "shadow-[0_0_0_1.5px_var(--primary),0_0_0_4px_var(--ring)]",
      )}
    >
      <span
        className={cn("absolute inset-x-0 top-0 h-[3px]", severe ? "bg-destructive" : "bg-warning")}
        aria-hidden="true"
      />
      <div className="flex items-start gap-3 px-4 pt-4">
        <KindTile a={a} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <SevBadge kind={a.kind} />
            <span className="truncate text-footnote text-muted-foreground">{alertKindName(a.kind, tr)}</span>
          </div>
          <button
            type="button"
            onClick={onOpen}
            className="mt-0.5 block max-w-full truncate text-left text-headline font-semibold hover:underline"
          >
            {a.server_name}
          </button>
        </div>
        {!a.acked_at && (
          <span className="pt-1">
            <Checkbox checked={selected} onChange={onSelect} label={tr("选择", "Select")} />
          </span>
        )}
      </div>
      <div className="mx-4 mt-3 rounded-lg bg-window px-3 py-2 ring-1 ring-border ring-inset">
        <div className={cn("tnum text-callout font-semibold", severe ? "text-destructive" : "text-warning")}>
          {a.value || "—"}
        </div>
        {a.detail && <div className="line-clamp-2 text-footnote text-muted-foreground">{a.detail}</div>}
      </div>
      <div className="flex flex-wrap items-baseline gap-1.5 px-4 pt-2.5 text-footnote text-muted-foreground">
        <span>{tr("已持续", "Firing for")}</span>
        <span className="tnum text-callout font-semibold text-foreground">{waitText(a.fired_at, lang)}</span>
        <span>· {tr(`${dateTime(a.fired_at).slice(11, 16)} 开始`, `since ${dateTime(a.fired_at).slice(11, 16)}`)}</span>
      </div>
      <div className="mt-auto flex items-center gap-2 px-4 pt-3 pb-3.5">
        {a.acked_at ? (
          <span className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-footnote text-muted-foreground">
            <Check className="size-3.5 shrink-0 text-success" aria-hidden="true" />
            {tr(
              `${a.acked_by ?? ""} ${dateTime(a.acked_at).slice(11, 16)} 已确认 · 恢复前不再提醒`,
              `${a.acked_by ?? ""} acknowledged ${dateTime(a.acked_at).slice(11, 16)} · quiet until resolved`,
            )}
          </span>
        ) : (
          <AsyncButton size="sm" variant="primary" icon={Check} className="flex-1" onClick={() => ack(a)}>
            {tr("确认", "Acknowledge")}
          </AsyncButton>
        )}
        <Button size="sm" variant="outline" asChild className={cn(!a.acked_at && "flex-1")}>
          <Link to={serverLink(a.server_id)}>{tr("查看服务器", "Open the server")}</Link>
        </Button>
      </div>
    </Card>
  );
}

function KindChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-footnote font-medium whitespace-nowrap transition-colors pointer-coarse:h-9",
        on ? "bg-foreground text-card" : "bg-card text-foreground/80 shadow-card hover:bg-accent",
      )}
    >
      {children}
    </button>
  );
}

function Board() {
  const tr = useTr();
  const lang = useLang();
  const [query, patch] = useQS();
  const kind = query.get("kind") ?? "";
  const server = query.get("server") ?? "";
  const open = query.get("open");
  const servers = useServers();
  const [sel, setSel] = useState<number[]>([]);
  const [run] = useAction();
  const firingQ = useQuery({
    queryKey: ["alerts", "firing", kind, server],
    queryFn: () => get<AlertList>(`/alerts${qs({ status: "firing", kind, server, limit: 200 })}`),
    refetchInterval: 30_000,
  });
  const histQ = useInfiniteQuery({
    queryKey: ["alerts", "history", kind, server],
    queryFn: ({ pageParam }) =>
      get<AlertList>(`/alerts${qs({ status: "resolved", kind, server, before: pageParam, limit: PAGE })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.alerts.length === PAGE ? last.alerts[PAGE - 1].id : undefined),
    refetchInterval: 60_000,
  });
  // Counts for the chips: without the kind filter (the chips are that filter).
  const countsQ = useQuery({
    queryKey: ["alerts", "counts", server],
    queryFn: () => get<AlertList>(`/alerts${qs({ server, limit: 1 })}`),
    refetchInterval: 60_000,
  });
  const firing = firingQ.data?.alerts ?? [];
  const history = useMemo(() => histQ.data?.pages.flatMap((p) => p.alerts) ?? [], [histQ.data]);
  const filtered = !!(kind || server);
  const setFilter = (p: Record<string, string | null>) => {
    setSel([]);
    patch(p);
  };
  const counts = Object.entries(countsQ.data?.resolved_7d_by_kind ?? {}).sort((a, b) => b[1] - a[1]);
  if (kind && !counts.some(([k]) => k === kind)) counts.push([kind, 0]);
  const days = useMemo(() => {
    const g = new Map<string, Alert[]>();
    for (const a of history) {
      const d = dateOnly(a.resolved_at ?? a.fired_at);
      g.set(d, [...(g.get(d) ?? []), a]);
    }
    return [...g.entries()];
  }, [history]);
  const unacked = firing.filter((a) => !a.acked_at);
  const selected = firing.filter((a) => sel.includes(a.id) && !a.acked_at);
  const ackSelected = () =>
    run(
      async () => {
        for (const a of selected) await post(`/alerts/${a.id}/ack`);
        return selected.length;
      },
      { ok: tr(`已确认 ${selected.length} 条告警`, `${selected.length} alerts acknowledged`) },
    ).then((r) => {
      if (r !== undefined) setSel([]);
      return r;
    });
  const current = open ? [...firing, ...history].find((a) => String(a.id) === open) : undefined;
  const anyFiring = (countsQ.data?.firing ?? 0) > 0;

  return (
    <>
      <section className="mb-7">
        <div className="mb-2.5 flex items-center gap-2 px-1">
          <h2 className="text-headline font-semibold">{tr("正在告警", "Firing")}</h2>
          {firing.length > 0 && (
            <Badge tone="danger" className="tnum">
              {firing.length}
            </Badge>
          )}
          {unacked.length > 1 && (
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSel(unacked.map((a) => a.id))}>
              {tr("全选未确认", "Select unacknowledged")}
            </Button>
          )}
        </div>
        {firingQ.isPending ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-56 rounded-xl" />
            ))}
          </div>
        ) : firingQ.isError && !firingQ.data ? (
          <Card>
            <ErrorState
              title={tr("告警加载失败", "Alerts did not load")}
              error={firingQ.error}
              onRetry={() => void firingQ.refetch()}
            />
          </Card>
        ) : firing.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {firing.map((a) => (
              <FiringCard
                key={a.id}
                a={a}
                selected={sel.includes(a.id)}
                onSelect={(v) => setSel(v ? [...sel, a.id] : sel.filter((x) => x !== a.id))}
                onOpen={() => patch({ open: String(a.id) })}
              />
            ))}
          </div>
        ) : (
          <Card className="relative flex items-center gap-4 overflow-hidden px-5 py-5" data-calm>
            <div className="pointer-events-none absolute -top-16 -left-10 size-48 rounded-full bg-success-soft blur-2xl" />
            <span className="relative inline-flex size-11 items-center justify-center rounded-2xl bg-success text-white">
              <CheckCircle2 className="size-6" aria-hidden="true" />
            </span>
            <div className="relative">
              <div className="text-title3 font-semibold">
                {filtered && anyFiring
                  ? tr("这个筛选下没有正在触发的告警", "Nothing firing under this filter")
                  : tr("没有正在触发的告警", "Nothing is firing")}
              </div>
              <div className="text-body text-muted-foreground">
                {history[0]?.resolved_at
                  ? tr(
                      `最近一次恢复：${history[0].server_name} ${alertKindName(history[0].kind, tr)}，${dateTime(history[0].resolved_at)}。`,
                      `Last resolved: ${history[0].server_name} ${alertKindName(history[0].kind, tr)}, ${dateTime(history[0].resolved_at)}.`,
                    )
                  : tr("全部服务器都在阈值之内。", "Every server is within its thresholds.")}
              </div>
            </div>
          </Card>
        )}
      </section>

      <section>
        <div className="mb-2.5 flex flex-wrap items-center gap-2 px-1">
          <h2 className="text-headline font-semibold">{tr("历史", "History")}</h2>
          <span className="text-footnote text-faint">{tr("计数为近 7 天", "counts: last 7 days")}</span>
          <Select
            aria-label={tr("服务器", "Server")}
            className="ml-auto w-44 max-sm:w-full"
            value={server}
            onChange={(e) => setFilter({ server: e.target.value || null })}
          >
            <option value="">{tr("全部服务器", "All servers")}</option>
            {(servers.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div
          className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]"
          role="group"
          aria-label={tr("种类", "Kind")}
        >
          <KindChip on={!kind} onClick={() => setFilter({ kind: null })}>
            {tr("全部种类", "All kinds")}{" "}
            <span className="tnum opacity-70">{counts.reduce((x, y) => x + y[1], 0)}</span>
          </KindChip>
          {counts.map(([k, n]) => {
            const Icon = ALERT_KIND_ICON[k] ?? Bell;
            return (
              <KindChip key={k} on={kind === k} onClick={() => setFilter({ kind: kind === k ? null : k })}>
                <Icon className="size-3.5" aria-hidden="true" />
                {alertKindName(k, tr)} <span className="tnum opacity-70">{n}</span>
              </KindChip>
            );
          })}
        </div>
        <Card className="overflow-hidden">
          {histQ.isPending ? (
            <SkeletonRows rows={6} />
          ) : histQ.isError && history.length === 0 ? (
            <ErrorState
              title={tr("告警历史加载失败", "History did not load")}
              error={histQ.error}
              onRetry={() => void histQ.refetch()}
            />
          ) : history.length === 0 ? (
            filtered ? (
              <EmptyState
                icon={BellOff}
                title={tr("没有匹配的记录", "No matching records")}
                description={tr(
                  "这个服务器和种类的组合没有已恢复的告警。",
                  "No resolved alerts for this server and kind.",
                )}
                action={
                  <Button variant="outline" onClick={() => setFilter({ kind: null, server: null })}>
                    {tr("清除筛选", "Clear filters")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={BellOff}
                title={tr("还没有告警历史", "No alert history yet")}
                description={tr(
                  "服务器越过阈值又恢复后会记在这里。",
                  "Alerts land here once a server crosses a threshold and recovers.",
                )}
              />
            )
          ) : (
            <>
              {days.map(([day, list]) => (
                <div key={day}>
                  <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-separator bg-window px-4 py-1.5 text-footnote font-semibold text-muted-foreground">
                    {dayLabel(day, tr, lang)}
                    <span className="font-normal text-faint">{tr(`${list.length} 条`, `${list.length}`)}</span>
                  </div>
                  <ul className="divide-y divide-separator">
                    {list.map((a) => (
                      <li key={a.id} data-alert={a.id}>
                        <button
                          type="button"
                          onClick={() => patch({ open: String(a.id) })}
                          className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-accent"
                        >
                          <KindTile a={a} size={28} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-body font-medium">
                              {a.server_name}{" "}
                              <span className="font-normal text-muted-foreground">· {alertKindName(a.kind, tr)}</span>
                            </span>
                            <span className="block truncate text-footnote text-muted-foreground">
                              {a.detail || a.value}
                              {a.acked_by && tr(` · ${a.acked_by} 已确认`, ` · acknowledged by ${a.acked_by}`)}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end">
                            <span className="tnum text-footnote">
                              {dateTime(a.fired_at).slice(11, 16)}–{dateTime(a.resolved_at).slice(11, 16)}
                            </span>
                            <span className="text-caption text-faint">
                              {tr(
                                `持续 ${waitText(a.fired_at, lang, a.resolved_at)}`,
                                `lasted ${waitText(a.fired_at, lang, a.resolved_at)}`,
                              )}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {histQ.hasNextPage && (
                <button
                  type="button"
                  onClick={() => void histQ.fetchNextPage()}
                  disabled={histQ.isFetchingNextPage}
                  className="flex h-10 w-full items-center justify-center border-t border-separator text-body text-primary hover:bg-accent"
                >
                  {histQ.isFetchingNextPage ? tr("加载中…", "Loading…") : tr("加载更早", "Load older")}
                </button>
              )}
            </>
          )}
        </Card>
      </section>

      <SelectionBar count={selected.length} onClear={() => setSel([])}>
        <AsyncButton size="sm" variant="primary" icon={Check} onClick={ackSelected}>
          {tr(`确认 ${selected.length} 条`, `Acknowledge ${selected.length}`)}
        </AsyncButton>
      </SelectionBar>
      {open && (
        <AlertDialog
          a={current}
          loading={firingQ.isPending || histQ.isPending}
          onClose={() => patch({ open: null }, true)}
        />
      )}
    </>
  );
}

function AlertDialog({ a, loading, onClose }: { a: Alert | undefined; loading: boolean; onClose: () => void }) {
  const tr = useTr();
  const lang = useLang();
  const ack = useAck();
  const notes = useQuery({
    queryKey: ["alerts", "notifications"],
    queryFn: () => get<Notification[]>("/alerts/notifications"),
    enabled: !!a,
  });
  const firing = a?.status === "firing";
  const items: TimelineItem[] = [];
  if (a) {
    items.push({
      title: tr(`触发：${a.value || alertKindName(a.kind, tr)}`, `Fired: ${a.value || alertKindName(a.kind, tr)}`),
      time: dateTime(a.fired_at),
      tone: alertSevere(a.kind) ? "danger" : "warning",
      body: a.detail || undefined,
    });
    const mine = (notes.data ?? [])
      .filter((n) => n.alert_id === a.id)
      .sort((x, y) => x.created_at.localeCompare(y.created_at));
    for (const n of mine) {
      const ok = n.status === "sent";
      items.push({
        title: (
          <span className="inline-flex items-center gap-1.5">
            {isCh(n.channel) && <ChannelIcon ch={n.channel} size={18} />}
            {ok
              ? tr(
                  `已通知 ${channelName(n.channel, tr)}（${eventName(n.event, tr)}）`,
                  `Notified ${channelName(n.channel, tr)} (${eventName(n.event, tr)})`,
                )
              : n.status === "dead"
                ? tr(`${channelName(n.channel, tr)} 通知失败`, `${channelName(n.channel, tr)} notice failed`)
                : tr(`${channelName(n.channel, tr)} 等待发送`, `${channelName(n.channel, tr)} notice waiting`)}
          </span>
        ),
        time: dateTime(n.sent_at ?? n.created_at),
        tone: ok ? "success" : n.status === "dead" ? "danger" : "info",
        body:
          n.status === "dead" ? (
            <>
              {n.last_error && (
                <RawError
                  message={tr(
                    `${deliveryReason(n.last_error, tr)}，已试 ${n.attempts} 次。`,
                    `${deliveryReason(n.last_error, tr)}; ${n.attempts} attempts.`,
                  )}
                  raw={n.last_error}
                />
              )}
              <Link to="/alerts/outbox?status=failed" className="text-primary hover:underline">
                {tr("去通知记录重试 →", "Retry in the notification log →")}
              </Link>
            </>
          ) : undefined,
      });
    }
    if (!mine.length && !notes.isPending)
      items.push({
        title: a.notified ? tr("已通知", "Notified") : tr("没有发出通知", "No notice sent"),
        time: "",
        tone: "neutral",
        body: a.notified
          ? tr("通知记录只保留最近 100 条。", "The log keeps the latest 100 notices.")
          : tr("冷却中或没有启用的通道。", "Cooling down, or no channel enabled."),
      });
    if (a.acked_at)
      items.push({
        title: tr(`${a.acked_by ?? ""} 确认`, `Acknowledged by ${a.acked_by ?? ""}`),
        time: dateTime(a.acked_at),
        tone: "info",
        body: tr("确认后恢复前不再重复通知", "No repeats until it resolves"),
      });
    items.push(
      firing
        ? {
            title: tr("仍在触发", "Still firing"),
            time: tr(`已持续 ${waitText(a.fired_at, lang)}`, `for ${waitText(a.fired_at, lang)}`),
            tone: "neutral",
            body: tr("恢复时会再通知一次", "A notice goes out when it resolves"),
          }
        : {
            title: tr("已恢复", "Resolved"),
            time: dateTime(a.resolved_at),
            tone: "success",
            body: tr(
              `共持续 ${waitText(a.fired_at, lang, a.resolved_at)}`,
              `Lasted ${waitText(a.fired_at, lang, a.resolved_at)}`,
            ),
          },
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      icon={a ? ALERT_KIND_ICON[a.kind] : Bell}
      tone={firing ? "danger" : "default"}
      title={a ? `${alertKindName(a.kind, tr)} · ${a.server_name}` : tr("告警", "Alert")}
      description={
        a &&
        tr(
          `告警 #${a.id} · ${alertSevere(a.kind) ? "严重" : "警告"} · ${firing ? "正在告警" : "已恢复"}`,
          `Alert #${a.id} · ${alertSevere(a.kind) ? "critical" : "warning"} · ${firing ? "firing" : "resolved"}`,
        )
      }
      footer={
        <>
          {a && (
            <Button variant="secondary" icon={ExternalLink} className="mr-auto" asChild>
              <Link to={serverLink(a.server_id)}>{tr("查看服务器", "Open the server")}</Link>
            </Button>
          )}
          <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
          {a && firing && !a.acked_at && (
            <AsyncButton variant="primary" icon={Check} onClick={() => ack(a)}>
              {tr("确认", "Acknowledge")}
            </AsyncButton>
          )}
        </>
      }
    >
      {!a ? (
        loading ? (
          <SkeletonRows rows={4} />
        ) : (
          <Callout tone="info">
            {tr(
              "这条告警不在当前列表里（可能被筛选掉或在更早的页）。",
              "This alert is not in the current list (filtered out, or on an older page).",
            )}
          </Callout>
        )
      ) : (
        <>
          <KV
            cols={3}
            items={[
              {
                k: tr("服务器", "Server"),
                v: (
                  <Link to={serverLink(a.server_id)} className="text-primary hover:underline">
                    {a.server_name}
                  </Link>
                ),
              },
              { k: tr("种类", "Kind"), v: alertKindName(a.kind, tr) },
              {
                k: firing ? tr("已持续", "Firing for") : tr("持续", "Lasted"),
                v: waitText(a.fired_at, lang, a.resolved_at),
              },
              { k: tr("当前值", "Value"), v: a.value || "—", span: 2 },
              { k: tr("开始", "Started"), v: dateTime(a.fired_at) },
            ]}
          />
          <h4 className="mt-5 mb-3 text-footnote font-semibold text-muted-foreground">{tr("经过", "Timeline")}</h4>
          {notes.isPending ? <SkeletonRows rows={3} /> : <Timeline items={items} />}
        </>
      )}
    </Dialog>
  );
}

/* ---------- 通知记录 ---------- */

function RetryButton({ id }: { id: number }) {
  const tr = useTr();
  const [run] = useAction();
  return (
    <AsyncButton
      size="sm"
      variant="outline"
      done={tr("已重发", "Requeued")}
      onClick={() => run(() => post(`/alerts/notifications/${id}/retry`), { ok: tr("已重新排队", "Requeued") })}
    >
      {tr("重试", "Retry")}
    </AsyncButton>
  );
}

function Outbox() {
  const tr = useTr();
  const [query, patch] = useQS();
  const ch = query.get("channel") ?? "";
  const stParam = query.get("status") ?? "";
  const st = stParam === "failed" ? "dead" : stParam === "pending" || stParam === "sent" ? stParam : "";
  const page = Math.max(1, Number(query.get("page") ?? 1) || 1);
  const q = useQuery({
    queryKey: ["alerts", "notifications"],
    queryFn: () => get<Notification[]>("/alerts/notifications"),
    refetchInterval: 30_000,
  });
  const all = q.data ?? [];
  const list = all.filter((n) => (!ch || n.channel === ch) && (!st || n.status === st));
  // One row per event (an alert's firing / resolved notice to every channel).
  const groups = useMemo(() => {
    const m = new Map<string, Notification[]>();
    for (const n of list) {
      const k =
        n.alert_id != null ? `${n.alert_id}:${n.event}` : `${n.title ?? ""}:${n.event}:${n.created_at.slice(0, 16)}`;
      m.set(k, [...(m.get(k) ?? []), n]);
    }
    return [...m.values()];
  }, [list]);
  const per = 20;
  const pages = Math.max(1, Math.ceil(groups.length / per));
  const p = Math.min(page, pages);
  const shown = groups.slice((p - 1) * per, p * per);
  const filtered = !!(ch || st);
  const dead = all.filter((n) => n.status === "dead").length;
  const setP = (n: number) => patch({ page: n <= 1 ? null : String(n) }, true);
  const statusBadge = (s: string) =>
    s === "dead" ? (
      <Badge tone="danger">
        <X aria-hidden="true" />
        {tr("发送失败", "Failed")}
      </Badge>
    ) : s === "pending" ? (
      <Badge tone="info">{tr("等待发送", "Waiting")}</Badge>
    ) : (
      <Badge tone="success">
        <Check aria-hidden="true" />
        {tr("已发送", "Sent")}
      </Badge>
    );
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          size="sm"
          label={tr("通道", "Channel")}
          value={ch || "all"}
          onChange={(v) => patch({ channel: v === "all" ? null : v, page: null }, true)}
          options={[
            { value: "all", label: tr("全部通道", "All channels") },
            { value: "telegram", label: "Telegram" },
            { value: "webhook", label: "Webhook" },
            { value: "email", label: tr("邮件", "Email") },
          ]}
        />
        <Segmented
          size="sm"
          label={tr("投递状态", "Delivery status")}
          value={stParam === "failed" || stParam === "pending" || stParam === "sent" ? stParam : "all"}
          onChange={(v) => patch({ status: v === "all" ? null : v, page: null }, true)}
          options={[
            { value: "all", label: tr("全部", "All") },
            { value: "failed", label: tr("失败", "Failed"), count: dead || undefined },
            { value: "pending", label: tr("等待", "Waiting") },
            { value: "sent", label: tr("已发送", "Sent") },
          ]}
        />
        <span className="ml-auto text-footnote text-faint max-sm:hidden">
          {tr("最近 100 条通知", "The latest 100 notices")}
        </span>
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <SkeletonRows rows={8} height={56} />
        ) : q.isError && !q.data ? (
          <ErrorState
            title={tr("通知记录加载失败", "The notification log did not load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        ) : shown.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={BellOff}
              title={tr("没有匹配的记录", "No matching records")}
              action={
                <Button variant="outline" onClick={() => patch({ channel: null, status: null, page: null }, true)}>
                  {tr("清除筛选", "Clear filters")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Upload}
              title={tr("还没有发出过通知", "No notices yet")}
              description={tr(
                "告警触发、恢复和通道测试都会记在这里。",
                "Firing, resolved and test notices are logged here.",
              )}
              action={
                <Button variant="outline" asChild>
                  <Link to="/settings/alerts">{tr("去配置通道", "Set up channels")}</Link>
                </Button>
              }
            />
          )
        ) : (
          <ul className="divide-y divide-separator">
            {shown.map((g) => {
              const e = g[0];
              const bad = g.some((o) => o.status === "dead");
              const title = e.title ?? eventName(e.event, tr);
              return (
                <li key={e.id} className="px-4 py-3" data-row>
                  <div className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 translate-y-[-2px] rounded-full",
                        bad ? "bg-destructive" : "bg-success",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-body font-medium">
                      {e.alert_id != null ? (
                        <Link to={`/alerts?open=${e.alert_id}`} className="hover:text-primary hover:underline">
                          {title}
                        </Link>
                      ) : (
                        title
                      )}
                      <span className="ml-1.5 font-normal text-faint">· {eventName(e.event, tr)}</span>
                    </span>
                    <span className="tnum shrink-0 text-footnote text-faint">{dateTime(e.created_at)}</span>
                  </div>
                  {g.some((o) => o.status === "sent") && (
                    <div className="mt-2 flex flex-wrap gap-1.5 pl-3.5">
                      {g
                        .filter((o) => o.status === "sent")
                        .map((o) => (
                          <span
                            key={o.id}
                            className="inline-flex h-7 items-center gap-1.5 rounded-full bg-window pr-2.5 pl-1 text-footnote ring-1 ring-border ring-inset"
                          >
                            {isCh(o.channel) && <ChannelIcon ch={o.channel} size={20} />}
                            {channelName(o.channel, tr)}
                            <Check className="size-3.5 text-success" aria-hidden="true" />
                            <span className="sr-only">{tr("已发送", "Sent")}</span>
                          </span>
                        ))}
                    </div>
                  )}
                  {g.some((o) => o.status !== "sent") && (
                    <div className="mt-2 grid gap-2 pl-3.5 md:grid-cols-2">
                      {g
                        .filter((o) => o.status !== "sent")
                        .map((o) => (
                          <div
                            key={o.id}
                            className={cn(
                              "flex min-w-0 items-start gap-2 rounded-lg px-2.5 py-2 ring-1 ring-inset",
                              o.status === "dead"
                                ? "bg-destructive-soft/50 ring-destructive/20"
                                : "bg-window ring-border",
                            )}
                          >
                            {isCh(o.channel) && <ChannelIcon ch={o.channel} size={22} />}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="text-footnote font-medium">{channelName(o.channel, tr)}</span>
                                {statusBadge(o.status)}
                              </div>
                              <div className="truncate text-caption text-muted-foreground">
                                {tr(`已试 ${o.attempts} 次`, `${o.attempts} attempts`)}
                              </div>
                              {o.last_error && (
                                <RawError
                                  className="mt-0.5"
                                  message={<span className="text-destructive">{deliveryReason(o.last_error, tr)}</span>}
                                  raw={o.last_error}
                                />
                              )}
                            </div>
                            {o.status === "dead" && <RetryButton id={o.id} />}
                          </div>
                        ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {shown.length > 0 && (
          <div className="flex items-center gap-2 border-t border-separator px-4 py-2 text-footnote text-muted-foreground">
            <span className="tnum">
              {tr(
                `第 ${(p - 1) * per + 1}–${Math.min(p * per, groups.length)} 个事件，共 ${groups.length} 个（${list.length} 条通知）`,
                `Events ${(p - 1) * per + 1}–${Math.min(p * per, groups.length)} of ${groups.length} (${list.length} notices)`,
              )}
            </span>
            <span className="ml-auto" />
            <Button
              size="icon-sm"
              variant="ghost"
              icon={ChevronLeft}
              disabled={p <= 1}
              onClick={() => setP(p - 1)}
              aria-label={tr("上一页", "Previous page")}
            />
            <span className="tnum">
              {p} / {pages}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              icon={ChevronRight}
              disabled={p >= pages}
              onClick={() => setP(p + 1)}
              aria-label={tr("下一页", "Next page")}
            />
          </div>
        )}
      </Card>
    </>
  );
}
