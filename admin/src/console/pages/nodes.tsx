// 节点 (NOD-*): servers (one agent each) → landing nodes (one inbound
// each) → entrances (direct and relays with TCP health, multipliers, node
// groups), drawn as one hierarchy per server card: the machine and its
// quota meter in the header, the nodes under it, their entrances on a tree
// line. Filters 全部 / 有异常 / 中转入口 (`?view=`) and the search
// (`?q=`) live in the URL; details and editors are centred dialogs
// (node-dialogs.tsx, server-dialog.tsx, entrance-dialog.tsx) opened from
// the URL too (`?open=`, `?new=`).
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { del, patch, put } from "../../shared/api";
import { ago, bytes, dateOnly, dateTime, pct, rateText } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { useDebounced } from "../kit";
import { useAction } from "../data";
import { overlaps } from "../rates";
import { setQuery, useRoute } from "../router";
import type { EntranceView, ServerNode, ServerView } from "../types";
import { serverState, useGroups, useServers } from "../servers";
import { EntranceDialog, RelayDialog } from "./entrance-dialog";
import {
  AlertRulesDialog,
  CreateNodeDialog,
  CreateServerDialog,
  InstallDialog,
  NodeDialog,
  QuotaDialog,
  ServerEditDialog,
  type Shown,
} from "./node-dialogs";
import { ApplyError, Summary, WarningList, entranceState } from "./node-common";
import { ServerDialog } from "./server-dialog";
import { UpdateBadge, useUpdateStatus } from "./update-status";
import {
  Activity,
  ArrowRightLeft,
  Bell,
  ChevronDown,
  CircleAlert,
  Clock,
  Cpu,
  Download,
  FileText,
  Layers,
  MemoryStick,
  Pause,
  Play,
  Plus,
  Radar,
  Route,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Badge, Dot, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Input, Segmented, Switch } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { MenuItem, RowMenu } from "../../shared/ui/menu";
import { Meter, usageTone } from "../../shared/ui/meter";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { cn } from "../../shared/cn";

type Dialog =
  | { kind: "edit" | "quota" | "alerts"; server: ServerView }
  | { kind: "relay"; node: ServerNode; server: ServerView }
  | { kind: "install"; shown: Shown };

type View = "all" | "issue" | "relay";

/** Does a server (or one of its nodes / entrances) match the search? */
function matches(s: ServerView, needle: string): boolean {
  const has = (v: string | null | undefined) => !!v && v.toLowerCase().includes(needle);
  return (
    has(s.name) ||
    has(s.tls_domain) ||
    has(s.agent_addr) ||
    s.nodes.some(
      (n) =>
        has(n.name) ||
        has(n.display_name) ||
        has(n.region) ||
        n.entrances.some((e) => has(e.name) || has(e.connect_host) || e.tags.some(has)),
    )
  );
}

/** Something on the machine itself needs a look (an uninstalled or deleting server does not count). */
function serverIssue(s: ServerView): boolean {
  if (s.deleting_at || !s.enrolled) return false;
  return !s.online || !!s.traffic_quota.exceeded_at || !!s.last_error || s.alerts_firing > 0 || s.warnings.length > 0;
}

/** A relay that fails its TCP probe (hidden from subscriptions after three in a row). */
function entranceIssue(e: EntranceView): boolean {
  return !!e.hidden_since || e.health_ok === false;
}

/**
 * The server as the filter shows it (null = not shown): 有异常 keeps a whole
 * server whose machine has a problem, else only its failing entrances;
 * 中转入口 keeps only relays.
 */
function project(s: ServerView, view: View): ServerView | null {
  if (view === "all") return s;
  if (view === "issue" && serverIssue(s)) return s;
  const keep = view === "relay" ? (e: EntranceView) => e.kind === "relay" : entranceIssue;
  const nodes = s.nodes
    .map((n) => ({ ...n, entrances: n.entrances.filter(keep) }))
    .filter((n) => n.entrances.length > 0);
  return nodes.length ? { ...s, nodes } : null;
}

const PROTOCOLS: Record<string, string> = {
  vless: "VLESS",
  vmess: "VMess",
  trojan: "Trojan",
  shadowsocks: "SS2022",
  hysteria: "Hysteria 2",
};
const protocolName = (p: string | null, tr: Tr) => (p ? (PROTOCOLS[p] ?? p) : tr("无入站", "no inbound"));

export function NodesPage() {
  const tr = useTr();
  const { query } = useRoute();
  const servers = useServers();
  const groups = useGroups();
  // The box answers at once; the URL (`?q=`, shareable, kept on reload) follows shortly after.
  const [search, setSearch] = useState(() => query.get("q") ?? "");
  const debounced = useDebounced(search, 250);
  useEffect(() => setQuery({ q: debounced.trim() ? debounced : null }), [debounced]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const creating = query.get("new");
  const open = query.get("open") ?? "";
  const [kind, openId] = open.split(":");
  const viewParam = query.get("view");
  const view: View = viewParam === "issue" || viewParam === "relay" ? viewParam : "all";
  const list = servers.data ?? [];
  const needle = search.trim().toLowerCase();
  const filtered = list.map((s) => project(s, view)).filter((s): s is ServerView => s !== null);
  const shown = needle ? filtered.filter((s) => matches(s, needle)) : filtered;
  const nodes = list.flatMap((s) => s.nodes);
  const entrances = nodes.flatMap((n) => n.entrances);
  const groupName = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g.name])), [groups.data]);
  const findEntrance = (id: string) => {
    for (const s of list) for (const n of s.nodes) for (const e of n.entrances) if (e.id === id) return { s, n, e };
    return null;
  };
  const relays = entrances.filter((e) => e.kind === "relay").length;
  const issues = list.filter((s) => project(s, "issue")).length;
  const hidden = entrances.filter((e) => e.hidden_since).length;
  const live = list.filter((s) => !s.deleting_at);
  const over = live.filter((s) => s.traffic_quota.exceeded_at).length;
  const offline = live.filter((s) => s.enrolled && !s.online && !s.traffic_quota.exceeded_at).length;
  const pending = live.filter((s) => !s.enrolled).length;
  const protoCount = new Map<string, number>();
  for (const n of nodes) {
    const k = protocolName(n.protocol, tr);
    protoCount.set(k, (protoCount.get(k) ?? 0) + 1);
  }
  const filtering = view !== "all";

  return (
    <>
      <PageHeader
        title={tr("节点", "Nodes")}
        description={tr(
          "服务器 → 落地节点 → 入口。权限只来自 套餐 → 节点组 → 入口。",
          "Servers → landing nodes → entrances. Access comes only from plan → node group → entrance.",
        )}
        actions={
          <>
            <UpdateBadge />
            <Button
              variant="outline"
              icon={Route}
              className="max-sm:hidden"
              disabled={nodes.length === 0}
              onClick={() => setQuery({ new: "relay" }, false)}
            >
              {tr("添加中转入口", "Add relay entrance")}
            </Button>
            <Button variant="outline" icon={Plus} onClick={() => setQuery({ new: "node" }, false)}>
              {tr("添加节点", "Add node")}
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setQuery({ new: "server" }, false)}>
              {tr("添加服务器", "Add server")}
            </Button>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {servers.isPending ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)
        ) : (
          <>
            <Summary
              icon={Server}
              label={tr("服务器在线", "Servers online")}
              value={`${live.filter((s) => s.online && !s.traffic_quota.exceeded_at).length} / ${live.length}`}
              tone={over + offline > 0 ? "warning" : undefined}
              foot={
                [
                  over && tr(`${over} 超额停用`, `${over} over quota`),
                  offline && tr(`${offline} 离线`, `${offline} offline`),
                  pending && tr(`${pending} 待安装`, `${pending} not installed`),
                ]
                  .filter(Boolean)
                  .join(" · ") || tr("全部在线", "All online")
              }
            />
            <Summary
              icon={ShieldCheck}
              label={tr("落地节点", "Landing nodes")}
              value={nodes.length}
              foot={[...protoCount].map(([p, n]) => `${p} ${n}`).join(" · ") || tr("还没有节点", "No nodes yet")}
            />
            <Summary
              icon={ArrowRightLeft}
              label={tr("入口", "Entrances")}
              value={entrances.length}
              foot={tr(
                `直连 ${entrances.length - relays} · 中转 ${relays}`,
                `${entrances.length - relays} direct · ${relays} relays`,
              )}
            />
            <Summary
              icon={Radar}
              label={tr("健康检查失败", "Failing health checks")}
              value={hidden}
              tone={hidden > 0 ? "danger" : undefined}
              foot={
                hidden > 0 ? tr("已从订阅隐藏", "Hidden from subscriptions") : tr("中转入口均正常", "Relays are fine")
              }
            />
          </>
        )}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented<View>
          label={tr("筛选", "Filter")}
          value={view}
          onChange={(v) => setQuery({ view: v === "all" ? null : v })}
          options={[
            { value: "all", label: tr("全部", "All") },
            { value: "issue", label: tr("有异常", "Issues"), count: issues || undefined },
            { value: "relay", label: tr("中转入口", "Relays") },
          ]}
        />
        <div className="relative w-full sm:ml-auto sm:w-72">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
            aria-hidden="true"
          />
          <Input
            type="search"
            className="pl-8"
            aria-label={tr("搜索服务器、节点或入口", "Search servers, nodes or entrances")}
            placeholder={tr("搜索服务器、节点或入口…", "Search servers, nodes or entrances…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {servers.isError && (
        <Card>
          <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
        </Card>
      )}
      {servers.isPending && (
        <div className="grid gap-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      )}
      {servers.isSuccess && list.length === 0 && (
        <Card>
          <EmptyState
            icon={Server}
            title={tr("还没有服务器", "No servers yet")}
            description={tr(
              "先添加一台服务器，把一行安装命令复制到机器上执行，然后在上面添加节点。",
              "Add a server first, run the one-line install command on it, then add nodes.",
            )}
            action={
              <Button variant="primary" icon={Plus} onClick={() => setQuery({ new: "server" }, false)}>
                {tr("添加服务器", "Add server")}
              </Button>
            }
          />
        </Card>
      )}
      {servers.isSuccess && list.length > 0 && shown.length === 0 && (
        <Card>
          {needle ? (
            <EmptyState
              icon={Search}
              title={tr("没有匹配的服务器或节点", "No matching servers or nodes")}
              description={tr(
                `没有名称或地址包含「${search.trim()}」的服务器、节点或入口${filtering ? "（在当前筛选里）" : ""}。`,
                `Nothing is named or addressed like "${search.trim()}"${filtering ? " (in this filter)" : ""}.`,
              )}
              action={<Button onClick={() => setSearch("")}>{tr("清除搜索", "Clear search")}</Button>}
            />
          ) : (
            <EmptyState
              icon={view === "issue" ? ShieldCheck : ArrowRightLeft}
              title={
                view === "issue"
                  ? tr("没有异常", "Nothing needs a look")
                  : tr("还没有中转入口", "No relay entrances yet")
              }
              description={
                view === "issue"
                  ? tr(
                      "服务器都在线、未超额、没有告警，中转入口的健康检查都正常。",
                      "Every server is online, within quota and without alerts; every relay passes its health check.",
                    )
                  : tr(
                      "中转入口把外部中转机转发到落地节点上的派生入站。",
                      "A relay entrance forwards an external relay to a derived inbound on a landing node.",
                    )
              }
              action={<Button onClick={() => setQuery({ view: null })}>{tr("显示全部", "Show all")}</Button>}
            />
          )}
        </Card>
      )}
      <div className="grid gap-3">
        {shown.map((s) => (
          <ServerCard
            key={s.id}
            s={s}
            full={list.find((x) => x.id === s.id) ?? s}
            groupName={groupName}
            onDialog={setDialog}
          />
        ))}
      </div>

      {creating === "server" && (
        <CreateServerDialog
          onClose={() => setQuery({ new: null })}
          onShown={(shown) => setDialog({ kind: "install", shown })}
        />
      )}
      {creating === "node" && servers.isSuccess && (
        <CreateNodeDialog
          servers={list}
          groups={groups.data ?? []}
          onClose={() => setQuery({ new: null, server: null })}
          onShown={(shown) => setDialog({ kind: "install", shown })}
        />
      )}
      {creating === "relay" && servers.isSuccess && (
        <RelayDialog servers={list} groups={groups.data ?? []} onClose={() => setQuery({ new: null })} />
      )}
      {dialog?.kind === "install" && <InstallDialog shown={dialog.shown} onClose={() => setDialog(null)} />}
      {dialog?.kind === "edit" && <ServerEditDialog server={dialog.server} onClose={() => setDialog(null)} />}
      {dialog?.kind === "quota" && <QuotaDialog server={dialog.server} onClose={() => setDialog(null)} />}
      {dialog?.kind === "alerts" && <AlertRulesDialog server={dialog.server} onClose={() => setDialog(null)} />}
      {dialog?.kind === "relay" && (
        <RelayDialog node={dialog.node} groups={groups.data ?? []} onClose={() => setDialog(null)} />
      )}
      {kind === "server" && openId && (
        <ServerDialog id={openId} server={list.find((s) => s.id === openId)} onClose={() => setQuery({ open: null })} />
      )}
      {kind === "node" && openId && <NodeDialog id={openId} onClose={() => setQuery({ open: null })} />}
      {kind === "entrance" &&
        openId &&
        (() => {
          const f = findEntrance(openId);
          return f ? (
            <EntranceDialog
              key={f.e.id}
              entrance={f.e}
              node={f.n}
              server={f.s}
              groups={groups.data ?? []}
              onClose={() => setQuery({ open: null })}
            />
          ) : null;
        })()}
    </>
  );
}

function ServerCard({
  s,
  full,
  groupName,
  onDialog,
}: {
  /** The server as the filter shows it. */
  s: ServerView;
  /** The whole server (counts in the delete confirmation). */
  full: ServerView;
  groupName: Map<string, string>;
  onDialog: (d: Dialog) => void;
}) {
  const tr = useTr();
  const lang = useLang();
  const confirm = useConfirm();
  const toast = useToast();
  const updates = useUpdateStatus();
  const [expanded, setExpanded] = useState(true);
  const [state, tone] = serverState(s, tr);
  const hb = s.heartbeat;
  const q = s.traffic_quota;
  const qp = q.bytes ? pct(q.used_bytes, q.bytes) : null;
  const overState = !!q.exceeded_at && s.enrolled && !s.deleting_at;
  const certDays = s.cert_not_after ? Math.floor((Date.parse(s.cert_not_after) - Date.now()) / 86_400_000) : null;
  const newer = updates.data?.update_available;
  const canUpdate = !!newer && !!s.agent_version && s.agent_version !== newer;
  const openServer = () => setQuery({ open: `server:${s.id}` }, false);
  const removeServer = async () => {
    const ents = full.nodes.reduce((n, x) => n + x.entrances.length, 0);
    const ok = await confirm({
      title: tr(`删除服务器 ${s.name}？`, `Delete server ${s.name}?`),
      impacts: [
        { label: tr("同时删除的节点", "Nodes deleted with it"), value: full.nodes.length },
        { label: tr("同时删除的入口", "Entrances deleted with it"), value: ents },
      ],
      description: tr(
        "agent 先收到空配置，随后吊销证书并删除。",
        "The agent gets the empty state first; then the certificates are revoked and it is deleted.",
      ),
      typeToConfirm: s.name,
      confirmLabel: tr("删除服务器", "Delete server"),
      action: () => del(`/servers/${s.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("删除已开始", "Deletion started") });
  };
  const quotaMode =
    q.mode === "both" ? tr("双向", "both ways") : q.mode === "up" ? tr("仅上行", "upload") : tr("仅下行", "download");
  const rx = hb?.metrics?.net_rx_bytes_per_sec;
  const txr = hb?.metrics?.net_tx_bytes_per_sec;
  const warnings = s.warnings.filter((w) => !(q.exceeded_at && w.includes("流量额度已用完")));
  return (
    <section aria-label={s.name}>
      <Card className="overflow-hidden">
        <div className="relative flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
          <div className="flex min-w-0 flex-1 basis-64 items-center gap-3 max-md:pr-10">
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? tr(`收起 ${s.name} 的节点`, `Collapse ${s.name}`)
                  : tr(`展开 ${s.name} 的节点`, `Expand ${s.name}`)
              }
              onClick={() => setExpanded((v) => !v)}
              className="hit-44 -ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-faint hover:bg-secondary hover:text-foreground"
            >
              <ChevronDown
                className={cn("size-4 transition-transform duration-(--dur-fast)", !expanded && "-rotate-90")}
                aria-hidden="true"
              />
            </button>
            <span
              className="inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-[6px] bg-secondary text-muted-foreground ring-1 ring-border ring-inset"
              aria-hidden="true"
            >
              <Server className="size-3.5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <button
                  type="button"
                  className="truncate text-left text-headline font-semibold hover:underline"
                  onClick={openServer}
                >
                  {s.name}
                </button>
                <Badge tone={tone} dot={!overState}>
                  {overState && <TriangleAlert aria-hidden="true" />}
                  {state}
                </Badge>
                {q.exceeded_at && !overState && (
                  // Not installed (or being deleted) and over quota: both facts show.
                  <Badge tone="danger">
                    <TriangleAlert aria-hidden="true" />
                    {tr("超额停用", "Over quota")}
                  </Badge>
                )}
                {s.alerts_firing > 0 && (
                  <Badge tone="danger">
                    <Bell aria-hidden="true" />
                    {tr(`${s.alerts_firing} 条告警`, `${s.alerts_firing} alerts`)}
                  </Badge>
                )}
              </div>
              <div className="truncate font-mono text-footnote text-muted-foreground">
                {[s.tls_domain, s.agent_addr].filter(Boolean).join(" · ") || tr("未设置域名", "no domain")}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote text-muted-foreground max-md:w-full max-md:justify-between">
            {hb && (
              <>
                <span className="inline-flex items-center gap-1" title="CPU">
                  <Cpu className="size-3.5" aria-label="CPU" />
                  <span className="tnum">{hb.cpu_percent != null ? `${hb.cpu_percent.toFixed(0)}%` : "?"}</span>
                </span>
                <span className="inline-flex items-center gap-1" title={tr("内存", "Memory")}>
                  <MemoryStick className="size-3.5" aria-label={tr("内存", "Memory")} />
                  <span className="tnum">
                    {hb.mem_total_bytes ? `${pct(hb.mem_used_bytes ?? 0, hb.mem_total_bytes)}%` : "?"}
                  </span>
                </span>
                {(rx != null || txr != null) && (
                  <span className="tnum max-sm:hidden" title={tr("网卡速率（上行 / 下行）", "NIC rate (up / down)")}>
                    ↑ {bytes(txr ?? null)}/s ↓ {bytes(rx ?? null)}/s
                  </span>
                )}
              </>
            )}
            {s.agent_version && (
              <span
                className="inline-flex items-center gap-1"
                title={s.agent_os ? `${s.agent_os}/${s.agent_arch}` : undefined}
              >
                agent <span className="tnum font-medium text-foreground">{s.agent_version}</span>
                {canUpdate && (
                  <Badge tone="primary" className="ml-1">
                    {tr(`可更新 ${newer}`, `${newer} available`)}
                  </Badge>
                )}
              </span>
            )}
            {certDays !== null && (
              <span className={cn("tnum", certDays < 14 && "font-medium text-warning")}>
                {tr(`证书 ${certDays} 天`, `cert ${certDays} days`)}
              </span>
            )}
            {!s.online && s.enrolled && s.last_seen_at && (
              <span>{tr(`最后在线 ${ago(s.last_seen_at, lang)}`, `last seen ${ago(s.last_seen_at, lang)}`)}</span>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDialog({ kind: "quota", server: s })}
            className="-m-1.5 w-[calc(100%+12px)] rounded-lg p-1.5 text-left transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none md:w-60"
          >
            <span className="mb-1 flex justify-between gap-2 text-caption text-muted-foreground">
              <span className="truncate">
                {tr("流量额度", "Quota")} · {qp === null ? tr("不限", "unlimited") : quotaMode}
                {qp !== null && q.reset_day
                  ? tr(` · 每月 ${q.reset_day} 日重置`, ` · resets on day ${q.reset_day}`)
                  : ""}
              </span>
              {qp !== null && (
                <span className={cn("tnum font-semibold", q.exceeded_at ? "text-destructive" : "text-foreground")}>
                  {qp.toFixed(0)}%
                </span>
              )}
            </span>
            {qp !== null ? (
              <>
                <Meter
                  value={qp}
                  tone={q.exceeded_at ? "danger" : usageTone(qp)}
                  label={tr("流量额度用量", "Quota usage")}
                />
                <span className="tnum mt-1 block text-caption text-faint">
                  {bytes(q.used_bytes)} / {bytes(q.bytes)}
                </span>
              </>
            ) : (
              <span className="tnum block text-caption text-faint">
                {tr(`本周期 ${bytes(q.used_bytes)} · 点此设置`, `${bytes(q.used_bytes)} this period · set one`)}
              </span>
            )}
          </button>
          <div className="max-md:absolute max-md:top-2.5 max-md:right-2.5">
            <ServerMenu s={s} onDialog={onDialog} openServer={openServer} remove={removeServer} />
          </div>
        </div>
        {(q.exceeded_at || s.last_error || warnings.length > 0 || (s.enrolled && !s.online && !s.deleting_at)) && (
          <div className="grid gap-2 px-4 pb-3">
            {q.exceeded_at && (
              <Notice tone="warning">
                {tr(
                  "本周期额度已用完：上面所有节点已下发空配置，订阅中已隐藏。",
                  "This period's quota is used up: every node on it has the empty configuration and is hidden from subscriptions.",
                )}
                {q.next_reset_at
                  ? tr(
                      `下个周期（${dateOnly(q.next_reset_at)}）或调高额度后自动恢复。`,
                      ` It comes back with the next period (${dateOnly(q.next_reset_at)}) or a higher quota.`,
                    )
                  : tr("调高额度后自动恢复。", " It comes back with a higher quota.")}
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => onDialog({ kind: "quota", server: s })}
                >
                  {tr("调整额度", "Adjust the quota")}
                </button>
              </Notice>
            )}
            {s.enrolled && !s.online && !s.deleting_at && !q.exceeded_at && (
              <Notice tone="danger">
                {s.last_seen_at
                  ? tr(`${ago(s.last_seen_at, lang)}收到最后一次心跳`, `Last heartbeat ${ago(s.last_seen_at, lang)}`)
                  : tr("还没有收到心跳", "No heartbeat yet")}
                {s.lease_remaining_seconds !== null && s.lease_remaining_seconds > 0
                  ? tr(
                      `（租约剩余 ${leaseText(s.lease_remaining_seconds, "zh")}，到期前 agent 继续按旧配置服务）。`,
                      ` (lease ${leaseText(s.lease_remaining_seconds, "en")} left; the agent keeps serving its last configuration until then).`,
                    )
                  : tr("（租约已到期）。", " (lease expired).")}
              </Notice>
            )}
            {s.last_error && <ApplyError error={s.last_error} at={s.last_error_at} />}
            <WarningList warnings={warnings} />
          </div>
        )}
        {expanded &&
          (full.nodes.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-separator bg-window/60 px-4 py-3">
              <p className="text-body text-muted-foreground">
                {tr("这台服务器上还没有节点。", "No nodes on this server yet.")}
              </p>
              <Button size="sm" icon={Plus} onClick={() => setQuery({ new: "node", server: s.id }, false)}>
                {tr("在此服务器上添加节点", "Add a node here")}
              </Button>
            </div>
          ) : (
            <ul className="border-t border-separator bg-window/60">
              {s.nodes.map((n) => (
                <NodeRow
                  key={n.id}
                  n={n}
                  full={full.nodes.find((x) => x.id === n.id) ?? n}
                  server={s}
                  groupName={groupName}
                  onRelay={() => onDialog({ kind: "relay", node: n, server: s })}
                />
              ))}
            </ul>
          ))}
      </Card>
    </section>
  );
}

function leaseText(secs: number, lang: "zh" | "en"): string {
  if (secs < 3600) {
    const m = Math.max(1, Math.round(secs / 60));
    return lang === "zh" ? `${m} 分钟` : `${m} min`;
  }
  const h = Math.round(secs / 3600);
  return lang === "zh" ? `${h} 小时` : `${h} h`;
}

/** An inline note under a server header (the prototype's soft band). */
function Notice({ tone, children }: { tone: "warning" | "danger"; children: ReactNode }) {
  const Icon = tone === "warning" ? TriangleAlert : CircleAlert;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-3 py-2 text-footnote",
        tone === "warning" ? "bg-warning-soft" : "bg-destructive-soft",
      )}
    >
      <Icon
        className={cn("mt-0.5 size-3.5 shrink-0", tone === "warning" ? "text-warning" : "text-destructive")}
        aria-hidden="true"
      />
      <span>{children}</span>
    </div>
  );
}

function ServerMenu({
  s,
  onDialog,
  openServer,
  remove,
}: {
  s: ServerView;
  onDialog: (d: Dialog) => void;
  openServer: () => void;
  remove: () => Promise<void>;
}) {
  const tr = useTr();
  return (
    <RowMenu label={tr(`服务器 ${s.name} 的操作`, `Actions of ${s.name}`)}>
      {(close) => (
        <>
          <MenuItem icon={Activity} onClick={() => (close(), openServer())}>
            {tr("状态与测速", "Status and latency")}
          </MenuItem>
          <MenuItem icon={Settings} onClick={() => (close(), onDialog({ kind: "edit", server: s }))}>
            {tr("编辑服务器", "Edit server")}
          </MenuItem>
          <MenuItem icon={Layers} onClick={() => (close(), onDialog({ kind: "quota", server: s }))}>
            {tr("流量额度", "Traffic quota")}
          </MenuItem>
          <MenuItem icon={Bell} onClick={() => (close(), onDialog({ kind: "alerts", server: s }))}>
            {tr("告警规则", "Alert rules")}
          </MenuItem>
          <MenuItem
            icon={Download}
            onClick={() => (close(), onDialog({ kind: "install", shown: { server: s, mode: "install" } }))}
          >
            {s.enrolled ? tr("重装命令", "Reinstall command") : tr("安装命令", "Install command")}
          </MenuItem>
          <MenuItem
            icon={FileText}
            onClick={() => (close(), onDialog({ kind: "install", shown: { server: s, mode: "bootstrap" } }))}
          >
            {tr("手动引导文件", "Manual bootstrap file")}
          </MenuItem>
          <MenuItem icon={Plus} onClick={() => (close(), setQuery({ new: "node", server: s.id }, false))}>
            {tr("在此服务器上添加节点", "Add a node here")}
          </MenuItem>
          <MenuItem icon={Trash2} danger disabled={!!s.deleting_at} onClick={() => (close(), void remove())}>
            {tr("删除服务器", "Delete server")}
          </MenuItem>
        </>
      )}
    </RowMenu>
  );
}

/** Many entrances start folded (unless one has a problem); a few are shown. */
function startExpanded(n: ServerNode): boolean {
  return n.entrances.length <= 6 || n.entrances.some((e) => e.hidden_since || !e.enabled);
}

function NodeRow({
  n,
  full,
  server,
  groupName,
  onRelay,
}: {
  /** The node as the filter shows it. */
  n: ServerNode;
  full: ServerNode;
  server: ServerView;
  groupName: Map<string, string>;
  onRelay: () => void;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [run] = useAction();
  const [expanded, setExpanded] = useState(() => startExpanded(n));
  const toggleBlock = async (on: boolean) => {
    const ok = await confirm({
      title: on ? tr("开启审计规则？", "Turn on block rules?") : tr("关闭审计规则？", "Turn off block rules?"),
      description: tr(
        "开关会重建该节点的入站，断开在线连接（规则内容变化热更新，不断线）。",
        "Switching rebuilds the node's inbound and drops live connections (rule edits apply live).",
      ),
      tone: "warning",
    });
    if (ok)
      await run(() => put(`/nodes/${n.id}/block-rules`, { enabled: on }), {
        ok: on ? tr("审计规则已开启", "Block rules on") : tr("审计规则已关闭", "Block rules off"),
      });
  };
  const toggleEnabled = async () => {
    const ok = await confirm({
      title: n.enabled
        ? tr(`停用节点 ${n.name}？`, `Disable ${n.name}?`)
        : tr(`启用节点 ${n.name}？`, `Enable ${n.name}?`),
      description: n.enabled
        ? tr("停用后节点下发空配置，用户断开。", "A disabled node gets the empty state; users are cut off.")
        : undefined,
      tone: n.enabled ? "warning" : "default",
    });
    if (ok) await run(() => patch(`/nodes/${n.id}`, { enabled: !n.enabled }), { ok: tr("已保存", "Saved") });
  };
  const remove = async () => {
    const ok = await confirm({
      title: tr(`删除节点 ${n.name}？`, `Delete node ${n.name}?`),
      impact: tr(
        `节点与它的 ${full.entrances.length} 个入口及全部凭据立即删除`,
        `The node, its ${full.entrances.length} entrances and every credential go at once`,
      ),
      typeToConfirm: n.name,
      confirmLabel: tr("删除节点", "Delete node"),
      action: () => del(`/nodes/${n.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("节点已删除", "Node deleted") });
  };
  const hidden = n.entrances.find((e) => e.hidden_since);
  return (
    <li data-node={n.name} className="border-b border-separator last:border-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5 pr-4 pl-10 max-sm:pl-3">
        <div className="flex min-w-0 flex-1 basis-56 flex-wrap items-center gap-x-2.5 gap-y-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? tr(`收起 ${n.name} 的入口`, `Hide entrances of ${n.name}`)
                : tr(`展开 ${n.name} 的入口`, `Show entrances of ${n.name}`)
            }
            onClick={() => setExpanded((v) => !v)}
            className="hit-44 -ml-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-faint hover:bg-secondary hover:text-foreground"
          >
            <ChevronDown
              className={cn("size-3.5 transition-transform duration-(--dur-fast)", !expanded && "-rotate-90")}
              aria-hidden="true"
            />
          </button>
          <Dot
            tone={
              !n.enabled
                ? "neutral"
                : server.traffic_quota.exceeded_at
                  ? "warning"
                  : server.online
                    ? "success"
                    : "danger"
            }
          />
          <button
            type="button"
            className="min-w-0 truncate text-left text-body font-semibold hover:underline"
            onClick={() => setQuery({ open: `node:${n.id}` }, false)}
          >
            {n.display_name || n.name}
            {n.display_name && <span className="ml-1 font-normal text-muted-foreground">({n.name})</span>}
          </button>
          <Badge tone="outline">{protocolName(n.protocol, tr)}</Badge>
          <span className="truncate text-footnote text-muted-foreground">
            {n.region && <span>{n.region} · </span>}
            {n.port ? <span className="tnum">:{n.port}</span> : null}
          </span>
          {!n.enabled && <Badge>{tr("已停用", "Disabled")}</Badge>}
          {!n.visible && <Badge tone="outline">{tr("对用户隐藏", "Hidden from users")}</Badge>}
        </div>
        <span className="tnum text-footnote text-muted-foreground">
          {tr(`入口 ${full.entrances.length}`, `${full.entrances.length} entrances`)}
        </span>
        <span className="flex items-center gap-2 text-footnote text-muted-foreground">
          {tr("审计规则", "Block rules")}
          <Switch
            checked={n.block_rules_enabled}
            label={tr(`${n.name} 的审计规则`, `Block rules of ${n.name}`)}
            onChange={(v) => void toggleBlock(v)}
          />
        </span>
        <RowMenu label={tr(`节点 ${n.name} 的操作`, `Actions of ${n.name}`)}>
          {(close) => (
            <>
              <MenuItem icon={Settings} onClick={() => (close(), setQuery({ open: `node:${n.id}` }, false))}>
                {tr("编辑节点与入站", "Edit node and inbound")}
              </MenuItem>
              <MenuItem icon={ArrowRightLeft} onClick={() => (close(), onRelay())}>
                {tr("添加中转入口", "Add relay entrance")}
              </MenuItem>
              <MenuItem icon={n.enabled ? Pause : Play} onClick={() => (close(), void toggleEnabled())}>
                {n.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
              </MenuItem>
              <MenuItem icon={Trash2} danger onClick={() => (close(), void remove())}>
                {tr("删除节点", "Delete node")}
              </MenuItem>
            </>
          )}
        </RowMenu>
      </div>
      {expanded && (
        <div className="pb-2">
          <ul aria-label={tr(`${n.name} 的入口`, `Entrances of ${n.name}`)}>
            {n.entrances.map((e, i) => (
              <EntranceRow
                key={e.id}
                e={e}
                n={n}
                server={server}
                groupName={groupName}
                last={i === n.entrances.length - 1}
              />
            ))}
          </ul>
          {hidden && (
            <div className="mx-4 mt-1 sm:ml-[72px]">
              <Notice tone="danger">
                {tr(
                  `中转入口探测失败（自 ${dateOnly(hidden.hidden_since)}）：已从订阅隐藏并已告警，恢复后自动显示。`,
                  `A relay entrance fails its probe (since ${dateOnly(hidden.hidden_since)}): hidden from subscriptions and alerted; it comes back automatically.`,
                )}
              </Notice>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** The health column: a relay's TCP probe (direct entrances are not probed). */
function Health({ e }: { e: EntranceView }) {
  const tr = useTr();
  const lang = useLang();
  if (e.kind === "direct")
    return (
      <span className="text-faint" title={tr("直连入口不做健康检查", "Direct entrances are not probed")}>
        —
      </span>
    );
  if (e.health_ok === null)
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Dot tone="neutral" />
        {tr("未探测", "Not tested")}
      </span>
    );
  if (e.health_ok)
    return (
      <span
        className="inline-flex items-center gap-1.5 text-muted-foreground"
        title={e.health_at ? dateTime(e.health_at) : undefined}
      >
        <Dot tone="success" />
        {tr(`正常 · ${ago(e.health_at, lang)}`, `OK · ${ago(e.health_at, lang)}`)}
      </span>
    );
  const since = e.hidden_since ?? e.health_at;
  return (
    <span className="inline-flex items-center gap-1.5 text-destructive" title={e.health_error ?? undefined}>
      <Dot tone="danger" />
      {tr(`失败 ×${e.health_failures} · ${ago(since, lang)}`, `Failed ×${e.health_failures} · ${ago(since, lang)}`)}
    </span>
  );
}

/** One entrance on the node's tree line: a button (keyboard and touch); wraps into two lines on a phone. */
function EntranceRow({
  e,
  n,
  server,
  groupName,
  last,
}: {
  e: EntranceView;
  n: ServerNode;
  server: ServerView;
  groupName: Map<string, string>;
  last: boolean;
}) {
  const tr = useTr();
  const [st, stt] = entranceState(e, tr);
  const ov = overlaps(e.rate_rules).length > 0;
  const relay = e.kind === "relay";
  const groupsText = e.group_ids.map((g) => groupName.get(g) ?? g.slice(0, 6)).join("、");
  return (
    <li data-entrance={e.id}>
      <button
        type="button"
        onClick={() => setQuery({ open: `entrance:${e.id}` }, false)}
        className="relative flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 py-2 pr-4 pl-[72px] text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none max-sm:pl-9"
      >
        <span
          aria-hidden="true"
          className={cn("absolute top-0 left-[56px] w-px bg-border max-sm:left-5", last ? "h-1/2" : "h-full")}
        />
        <span aria-hidden="true" className="absolute top-1/2 left-[56px] h-px w-3 bg-border max-sm:left-5" />
        <span className="flex min-w-0 flex-1 basis-52 flex-wrap items-center gap-x-2 gap-y-1">
          {relay ? (
            <ArrowRightLeft className="size-3.5 shrink-0 text-chart-2" aria-hidden="true" />
          ) : (
            <ShieldCheck className="size-3.5 shrink-0 text-chart-1" aria-hidden="true" />
          )}
          <span className="sr-only">
            {relay ? tr("中转入口", "Relay entrance") : tr("直连入口", "Direct entrance")}
          </span>
          <span className="min-w-0 truncate text-body font-medium">{e.name}</span>
          {e.tags.map((t) => (
            <span key={t} data-entrance-tag>
              <Badge className="text-caption">{t}</Badge>
            </span>
          ))}
        </span>
        <span className="w-56 truncate font-mono text-footnote text-muted-foreground max-lg:hidden">
          {e.connect_host ?? server.tls_domain ?? "—"}:{e.connect_port ?? n.port ?? "—"}
          {relay && <span className="sr-only"> → :{e.listen_port}</span>}
        </span>
        <span className="tnum inline-flex w-24 items-center gap-1.5 text-body font-semibold">
          {rateText(Math.round(e.rate_now * 1000))}
          {e.rate_rules.length > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-caption font-medium",
                ov ? "text-warning" : "text-faint",
              )}
              title={
                ov
                  ? tr(
                      `${e.rate_rules.length} 条时段规则，有重叠（取最高）`,
                      `${e.rate_rules.length} time-window rules, overlapping (highest applies)`,
                    )
                  : tr(`${e.rate_rules.length} 条时段规则`, `${e.rate_rules.length} time-window rules`)
              }
            >
              <Clock className="size-3" aria-hidden="true" />
              <span>{e.rate_rules.length}</span>
            </span>
          )}
          {e.rate_now !== e.rate && (
            <span className="sr-only">
              ({tr("基础", "base")} {rateText(e.rate_permille)})
            </span>
          )}
          {e.group_ids.length > 0 && (
            <span
              className="inline-flex items-center gap-0.5 text-caption font-medium text-faint"
              title={tr(`节点组：${groupsText}`, `Node groups: ${groupsText}`)}
            >
              <Layers className="size-3" aria-hidden="true" />
              <span className="sr-only">{tr("节点组", "Node groups")}</span>
              <span>{e.group_ids.length}</span>
            </span>
          )}
        </span>
        <span className="w-36 text-footnote">
          <Health e={e} />
        </span>
        <span className="text-right sm:w-16">
          <Badge tone={stt === "danger" ? "outline" : (stt as Tone)}>{st}</Badge>
        </span>
      </button>
    </li>
  );
}
