// 告警 (ALR-*; audit §5.12): the alert center (filters in the URL, firing
// counts by kind, acknowledge per row and in bulk, older pages, a detail
// dialog per alert with a link to its server) and the notification log
// (channel / status filters, pages, retry per row). Thresholds and the
// channels moved to 系统设置 → 通知 → 告警通道与阈值.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BellOff, BellRing, Check, CheckCheck, RotateCw, Server, Settings2 } from "lucide-react";
import { useState } from "react";
import { Link, Navigate } from "react-router";
import { get, post, qs } from "../../shared/api";
import { ago, dateTime } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Select } from "../../shared/ui/form";
import { Callout, KV, PageHeader } from "../../shared/ui/layout";
import { EmptyState } from "../../shared/ui/states";
import { DataTable, Pager, type Column } from "../../shared/ui/table";
import { Tabs } from "../../shared/ui/tabs";
import { useAction } from "../data";
import { navigate, setQuery, useRoute } from "../router";
import { useServers } from "../servers";
import { alertKindName } from "./node-dialogs";

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

const KINDS = [
  "offline",
  "cpu",
  "memory",
  "disk",
  "latency",
  "cert",
  "agent_cert",
  "last_error",
  "entrance_down",
  "traffic_quota",
];
const PAGE = 50;

function channelName(c: string, tr: Tr) {
  return ({ telegram: "Telegram", webhook: "Webhook", email: tr("邮件", "Email") } as Record<string, string>)[c] ?? c;
}
function deliveryState(s: string, tr: Tr): [string, Tone] {
  return (
    (
      {
        pending: [tr("待发送", "Pending"), "info"],
        sent: [tr("已发送", "Sent"), "success"],
        dead: [tr("发送失败", "Failed"), "danger"],
      } as Record<string, [string, Tone]>
    )[s] ?? [s, "neutral"]
  );
}
function eventName(e: string, tr: Tr) {
  return (
    (
      {
        firing: tr("触发", "Firing"),
        resolved: tr("恢复", "Resolved"),
        test: tr("测试", "Test"),
      } as Record<string, string>
    )[e] ?? e
  );
}

export function AlertsPage() {
  const tr = useTr();
  const { sub } = useRoute();
  // The old settings tab lives in the settings now.
  if (sub[0] === "settings") return <Navigate to="/settings/alert-channels" replace />;
  const tab = sub[0] === "notifications" ? "notifications" : "alerts";
  return (
    <>
      <PageHeader
        title={tr("告警", "Alerts")}
        description={tr(
          "服务器的告警事件与通知投递记录；每 30 秒评估一次。",
          "Server alert events and the notification deliveries; evaluated every 30 s.",
        )}
        actions={
          <Button size="sm" variant="ghost" icon={Settings2} asChild>
            <Link to="/settings/alert-channels">{tr("告警通道与阈值", "Channels and thresholds")}</Link>
          </Button>
        }
      />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={(v) => navigate(v === "alerts" ? "/alerts" : `/alerts/${v}`)}
          tabs={[
            { value: "alerts", label: tr("告警中心", "Alert center") },
            { value: "notifications", label: tr("通知记录", "Deliveries") },
          ]}
        />
      </div>
      {tab === "alerts" ? <AlertList /> : <Deliveries />}
    </>
  );
}

function AckButton({ id, label }: { id: number; label?: string }) {
  const tr = useTr();
  const [run, busy] = useAction();
  return (
    <Button
      size="sm"
      variant="outline"
      icon={Check}
      loading={busy}
      onClick={(e) => {
        e.stopPropagation();
        void run(() => post(`/alerts/${id}/ack`), { ok: tr("已确认", "Acknowledged") });
      }}
    >
      {label ?? tr("确认", "Acknowledge")}
    </Button>
  );
}

function AlertList() {
  const tr = useTr();
  const lang = useLang();
  const { query } = useRoute();
  const status = query.get("status") ?? "";
  const kind = query.get("kind") ?? "";
  const server = query.get("server") ?? "";
  const open = query.get("open");
  const servers = useServers();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runBulk, bulkBusy] = useAction();
  const q = useInfiniteQuery({
    queryKey: ["alerts", status, kind, server],
    queryFn: ({ pageParam }) =>
      get<{ alerts: Alert[]; firing: number; firing_by_kind: Record<string, number> }>(
        `/alerts${qs({ status, kind, server, before: pageParam, limit: PAGE })}`,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.alerts.length === PAGE ? last.alerts[PAGE - 1].id : undefined),
    refetchInterval: 30_000,
  });
  const rows = (q.data?.pages.flatMap((p) => p.alerts) ?? []).map((a) => ({ ...a, id: String(a.id), raw: a.id }));
  const head = q.data?.pages[0];
  const filtered = !!(status || kind || server);
  const setFilter = (p: Record<string, string | null>) => {
    setSelected(new Set());
    setQuery(p);
  };
  const unacked = rows.filter((r) => selected.has(r.id) && !r.acked_at);
  const ackSelected = () =>
    void runBulk(
      async () => {
        for (const r of unacked) await post(`/alerts/${r.raw}/ack`);
      },
      { ok: tr(`已确认 ${unacked.length} 条告警`, `${unacked.length} alerts acknowledged`) },
    ).then((r) => r !== undefined && setSelected(new Set()));
  const columns: Column<(typeof rows)[number]>[] = [
    { key: "kind", header: tr("类型", "Kind"), fixed: true, mobile: "title", cell: (a) => alertKindName(a.kind, tr) },
    { key: "server", header: tr("服务器", "Server"), cell: (a) => <span className="break-all">{a.server_name}</span> },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (a) => (
        <Badge tone={a.status === "firing" ? "danger" : "success"} dot>
          {a.status === "firing" ? tr("正在告警", "Firing") : tr("已恢复", "Resolved")}
        </Badge>
      ),
    },
    {
      key: "detail",
      header: tr("详情", "Detail"),
      cell: (a) => <span className="line-clamp-2 break-words text-muted-foreground">{a.detail || a.value}</span>,
    },
    {
      key: "fired",
      header: tr("触发", "Fired"),
      cell: (a) => <span className="whitespace-nowrap">{`${dateTime(a.fired_at)} (${ago(a.fired_at, lang)})`}</span>,
    },
    { key: "resolved", header: tr("恢复", "Resolved"), optional: true, cell: (a) => dateTime(a.resolved_at) },
    {
      key: "ack",
      header: tr("确认", "Ack"),
      fixed: true,
      cell: (a) =>
        a.acked_at ? (
          <span className="text-footnote break-all text-muted-foreground">{a.acked_by}</span>
        ) : (
          <AckButton id={a.raw} label={tr("确认", "Acknowledge")} />
        ),
    },
  ];
  const current = open ? rows.find((r) => r.id === open) : undefined;
  return (
    <>
      {head && head.firing > 0 && (
        <div className="mb-3 flex flex-wrap gap-2" aria-label={tr("正在告警（按类型）", "Firing by kind")}>
          {Object.entries(head.firing_by_kind).map(([k, n]) => (
            <button
              key={k}
              type="button"
              className="rounded-full focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
              onClick={() => setFilter({ kind: k, status: "firing" })}
            >
              <Badge tone="danger">
                {alertKindName(k, tr)} · {n}
              </Badge>
            </button>
          ))}
        </div>
      )}
      <DataTable
        label={tr("告警", "Alerts")}
        storageKey="alerts"
        rows={rows}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        bulkActions={() => (
          <Button
            size="sm"
            variant="primary"
            icon={CheckCheck}
            loading={bulkBusy}
            disabled={unacked.length === 0}
            onClick={ackSelected}
          >
            {tr(`确认所选（${unacked.length}）`, `Acknowledge (${unacked.length})`)}
          </Button>
        )}
        onRowClick={(a) => setQuery({ open: a.id }, false)}
        activeId={open}
        filtered={filtered}
        onClearFilters={() => setFilter({ status: null, kind: null, server: null })}
        empty={
          filtered ? undefined : (
            <EmptyState
              icon={BellOff}
              title={tr("没有告警", "No alerts")}
              description={tr(
                "服务器触发告警时会出现在这里，并按设置发送通知。",
                "Alerts show up here when servers trip a rule, and are delivered as configured.",
              )}
            />
          )
        }
        toolbar={
          <>
            <Select
              aria-label={tr("状态", "Status")}
              className="min-w-28 flex-1 sm:flex-none"
              value={status}
              onChange={(e) => setFilter({ status: e.target.value || null })}
            >
              <option value="">{tr("全部状态", "Any status")}</option>
              <option value="firing">{tr("正在告警", "Firing")}</option>
              <option value="resolved">{tr("已恢复", "Resolved")}</option>
            </Select>
            <Select
              aria-label={tr("类型", "Kind")}
              className="min-w-32 flex-1 sm:flex-none"
              value={kind}
              onChange={(e) => setFilter({ kind: e.target.value || null })}
            >
              <option value="">{tr("全部类型", "Any kind")}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {alertKindName(k, tr)}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("服务器", "Server")}
              className="min-w-32 flex-1 sm:flex-none"
              value={server}
              onChange={(e) => setFilter({ server: e.target.value || null })}
            >
              <option value="">{tr("全部服务器", "Any server")}</option>
              {(servers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </>
        }
        footer={
          <>
            <span className="tnum">{tr(`已加载 ${rows.length} 条`, `${rows.length} loaded`)}</span>
            {q.hasNextPage && (
              <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {tr("加载更早", "Load older")}
              </Button>
            )}
          </>
        }
      />
      {open && <AlertDialog alert={current} loading={q.isPending} onClose={() => setQuery({ open: null })} />}
    </>
  );
}

function AlertDialog({
  alert: a,
  loading,
  onClose,
}: {
  alert: (Omit<Alert, "id"> & { id: string; raw: number }) | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  const tr = useTr();
  const lang = useLang();
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      icon={BellRing}
      tone={a?.status === "firing" ? "danger" : "default"}
      title={a ? `${alertKindName(a.kind, tr)} · ${a.server_name}` : tr("告警", "Alert")}
      description={
        a && (
          <Badge tone={a.status === "firing" ? "danger" : "success"} dot>
            {a.status === "firing" ? tr("正在告警", "Firing") : tr("已恢复", "Resolved")}
          </Badge>
        )
      }
      footer={
        <>
          {a && (
            <Button variant="ghost" icon={Server} className="mr-auto" asChild>
              <Link to={`/nodes?open=server:${a.server_id}`}>{tr("查看服务器", "Open the server")}</Link>
            </Button>
          )}
          <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
          {a && !a.acked_at && <AckButton id={a.raw} label={tr("确认告警", "Acknowledge")} />}
        </>
      }
    >
      {!a ? (
        loading ? null : (
          <Callout tone="info">
            {tr(
              "这条告警不在当前列表里（可能被筛选掉或在更早的页）。",
              "This alert is not in the current list (filtered out, or on an older page).",
            )}
          </Callout>
        )
      ) : (
        <KV
          items={[
            [tr("类型", "Kind"), alertKindName(a.kind, tr)],
            [tr("服务器", "Server"), a.server_name],
            [tr("当前值", "Value"), a.value || "—"],
            [
              tr("详情", "Detail"),
              <span key="d" className="break-words">
                {a.detail || "—"}
              </span>,
            ],
            [tr("触发", "Fired"), `${dateTime(a.fired_at)}（${ago(a.fired_at, lang)}）`],
            [tr("恢复", "Resolved"), a.resolved_at ? dateTime(a.resolved_at) : tr("尚未恢复", "Not yet")],
            [
              tr("通知", "Notified"),
              a.notified
                ? tr("已通知", "Sent")
                : tr("未通知（冷却中或没有启用通道）", "Not sent (cooldown or no channel)"),
            ],
            [
              tr("确认", "Acknowledged"),
              a.acked_at ? `${a.acked_by ?? ""} · ${dateTime(a.acked_at)}` : tr("未确认", "No"),
            ],
          ]}
        />
      )}
    </Dialog>
  );
}

function RetryButton({ id }: { id: number }) {
  const tr = useTr();
  const [run, busy] = useAction();
  return (
    <Button
      size="sm"
      variant="outline"
      icon={RotateCw}
      loading={busy}
      onClick={() => void run(() => post(`/alerts/notifications/${id}/retry`), { ok: tr("已重新排队", "Requeued") })}
    >
      {tr("重试", "Retry")}
    </Button>
  );
}

function Deliveries() {
  const tr = useTr();
  const { query } = useRoute();
  const channel = query.get("channel") ?? "";
  const status = query.get("dstatus") ?? "";
  const [page, setPage] = useState({ offset: 0, limit: 20 });
  const q = useQuery({
    queryKey: ["alerts", "notifications"],
    queryFn: () => get<Notification[]>("/alerts/notifications"),
    refetchInterval: 30_000,
  });
  const all = (q.data ?? []).map((n) => ({ ...n, id: String(n.id), raw: n.id }));
  const matching = all.filter((n) => (!channel || n.channel === channel) && (!status || n.status === status));
  const rows = matching.slice(page.offset, page.offset + page.limit);
  const filtered = !!(channel || status);
  const setFilter = (p: Record<string, string | null>) => {
    setPage((x) => ({ ...x, offset: 0 }));
    setQuery(p);
  };
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "title",
      header: tr("标题", "Title"),
      fixed: true,
      mobile: "title",
      cell: (n) => <span className="break-words">{n.title ?? eventName(n.event, tr)}</span>,
    },
    { key: "event", header: tr("事件", "Event"), cell: (n) => eventName(n.event, tr) },
    { key: "channel", header: tr("通道", "Channel"), cell: (n) => channelName(n.channel, tr) },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (n) => {
        const [t, tone] = deliveryState(n.status, tr);
        return <Badge tone={tone}>{t}</Badge>;
      },
    },
    { key: "attempts", header: tr("尝试次数", "Attempts"), align: "right", cell: (n) => n.attempts },
    {
      key: "error",
      header: tr("最后错误（原文）", "Last error (as received)"),
      cell: (n) =>
        n.last_error ? (
          <span className="line-clamp-2 max-w-md text-footnote break-words text-muted-foreground" title={n.last_error}>
            {n.last_error}
          </span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    { key: "created", header: tr("时间", "Time"), cell: (n) => dateTime(n.created_at) },
    {
      key: "retry",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      fixed: true,
      cell: (n) => (n.status === "dead" ? <RetryButton id={n.raw} /> : null),
    },
  ];
  return (
    <DataTable
      label={tr("通知记录", "Deliveries")}
      storageKey="alert-deliveries"
      rows={rows}
      columns={columns}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
      filtered={filtered}
      onClearFilters={() => setFilter({ channel: null, dstatus: null })}
      empty={
        filtered ? undefined : (
          <EmptyState
            icon={BellOff}
            title={tr("还没有通知", "No deliveries yet")}
            description={tr(
              "告警触发或恢复时，每个启用的通道各发一条。",
              "One per enabled channel when an alert fires or resolves.",
            )}
          />
        )
      }
      toolbar={
        <>
          <Select
            aria-label={tr("通道", "Channel")}
            className="min-w-28 flex-1 sm:flex-none"
            value={channel}
            onChange={(e) => setFilter({ channel: e.target.value || null })}
          >
            <option value="">{tr("全部通道", "Any channel")}</option>
            {["telegram", "webhook", "email"].map((c) => (
              <option key={c} value={c}>
                {channelName(c, tr)}
              </option>
            ))}
          </Select>
          <Select
            aria-label={tr("投递状态", "Delivery status")}
            className="min-w-28 flex-1 sm:flex-none"
            value={status}
            onChange={(e) => setFilter({ dstatus: e.target.value || null })}
          >
            <option value="">{tr("全部状态", "Any status")}</option>
            {["pending", "sent", "dead"].map((s) => (
              <option key={s} value={s}>
                {deliveryState(s, tr)[0]}
              </option>
            ))}
          </Select>
          <span className="text-footnote text-muted-foreground">{tr("最近 100 条", "Latest 100")}</span>
        </>
      }
      footer={
        <Pager
          total={matching.length}
          offset={page.offset}
          limit={page.limit}
          onOffset={(o) => setPage((x) => ({ ...x, offset: o }))}
          onLimit={(l) => setPage({ offset: 0, limit: l })}
        />
      }
    />
  );
}
