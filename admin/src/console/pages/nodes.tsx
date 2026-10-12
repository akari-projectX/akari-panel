// 节点 (NOD-*, v2 proposal §4): /nodes is the fleet overview — what needs
// me first (offline, over quota, failing relays, waiting installs, expiring
// certificates, warnings, agent updates), then one health row per server
// (load, live rate, the period's quota, certificate, agent) with filters
// (`?view=`) and a search across servers, nodes and entrances (`?q=`,
// results grouped by kind, one click to the object). /nodes/<server id> is
// the server's workbench (node-server.tsx). Every dialog is URL-driven
// (node-dialogs.tsx `NodesDialogs`): `?new=server|node|relay`, `?node=`,
// `?entrance=`, `?action=install|enroll`; the old `?open=kind:id` links
// (dashboard, alerts, audit, tickets) are redirected.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  Clock,
  CloudOff,
  Download,
  EyeOff,
  Gauge,
  Hourglass,
  Plus,
  Radar,
  Server,
  TriangleAlert,
} from "lucide-react";
import { cn } from "../../shared/cn";
import { ago, bytes, dateOnly, pct } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { Badge, Dot } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Segmented } from "../../shared/ui/form";
import { Meter } from "../../shared/ui/meter";
import { PageHeader } from "../../shared/ui/layout";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { SearchField, StatStrip } from "../components/kit";
import {
  KindIcon,
  MiniBar,
  certDays,
  entranceCount,
  inboundLine,
  mbps,
  memPct,
  protocolName,
  regionOf,
} from "../components/nodes-bits";
import { ServerStatus, serverStateOf } from "../components/status";
import { useDebounced } from "../kit";
import { navigate, useQS, useRoute } from "../router";
import { useServers } from "../servers";
import type { ServerView } from "../types";
import { NodesDialogs } from "./node-dialogs";
import { ServerPage } from "./node-server";
import { warningTitle } from "./node-common";
import { UpdateBadge, useUpdateStatus } from "./update-status";

export function NodesPage() {
  const { sub, query } = useRoute();
  const servers = useServers();
  const list = servers.data;
  // Old deep links (`?open=server:…|node:…|entrance:…`) → the server page.
  const open = query.get("open") ?? "";
  useEffect(() => {
    const [kind, id] = open.split(":");
    if (!id) return;
    if (kind === "server") return navigate(`/nodes/${id}`, true);
    if (!list) return;
    for (const s of list)
      for (const n of s.nodes) {
        if (kind === "node" && n.id === id) return navigate(`/nodes/${s.id}?node=${id}`, true);
        if (kind === "entrance" && n.entrances.some((e) => e.id === id))
          return navigate(`/nodes/${s.id}?entrance=${id}`, true);
      }
  }, [open, list]);
  return (
    <>
      {sub[0] ? <ServerPage id={sub[0]} /> : <Fleet />}
      <NodesDialogs serverId={sub[0]} />
    </>
  );
}

/* ---------- 需要处理 ---------- */

type Problem = {
  tone: "danger" | "warning" | "info";
  icon: ReactNode;
  title: ReactNode;
  desc: ReactNode;
  to: string;
  action: string;
};

// Agent warning texts (server data, matched, never shown) that the quota and
// certificate problems above already report.
const COVERED_WARNINGS = [
  "流量额度已用完", // i18n-ok: agent warning text matched as data
  "agent 证书", // i18n-ok: agent warning text matched as data
];

function useProblems(list: ServerView[]): Problem[] {
  const tr = useTr();
  const lang = useLang();
  const updates = useUpdateStatus();
  const out: Problem[] = [];
  const live = list.filter((s) => !s.deleting_at);
  for (const s of live) {
    const st = serverStateOf(s);
    if (st === "offline")
      out.push({
        tone: "danger",
        icon: <CloudOff />,
        title: s.last_seen_at
          ? tr(
              `${s.name} 离线 · ${ago(s.last_seen_at, lang)}最后心跳`,
              `${s.name} offline · last seen ${ago(s.last_seen_at, lang)}`,
            )
          : tr(`${s.name} 离线`, `${s.name} offline`),
        desc:
          s.lease_expires_at && Date.parse(s.lease_expires_at) > Date.now()
            ? tr(
                `租约到期前 agent 按上一份配置继续服务；其上 ${entranceCount(s)} 个入口受影响`,
                `The agent serves its last configuration until its lease runs out; ${entranceCount(s)} entrances affected`,
              )
            : tr(
                `租约已到期，其上 ${entranceCount(s)} 个入口不可用`,
                `Lease expired; ${entranceCount(s)} entrances unavailable`,
              ),
        to: `/nodes/${s.id}`,
        action: tr("查看", "Open"),
      });
    if (st === "quota")
      out.push({
        tone: "danger",
        icon: <Gauge />,
        title: tr(`${s.name} 本周期流量额度已用完`, `${s.name} used up this period's quota`),
        desc: s.traffic_quota.next_reset_at
          ? tr(
              `节点已下发空配置，入口在订阅中隐藏；${dateOnly(s.traffic_quota.next_reset_at)} 自动恢复，或调高额度立即恢复`,
              `Its nodes have the empty configuration and are hidden; back on ${dateOnly(s.traffic_quota.next_reset_at)} or with a higher quota`,
            )
          : tr(
              "节点已下发空配置，入口在订阅中隐藏；调高额度立即恢复",
              "Its nodes have the empty configuration and are hidden; a higher quota brings them back",
            ),
        to: `/nodes/${s.id}?tab=quota`,
        action: tr("调整额度", "Adjust quota"),
      });
  }
  for (const s of live)
    for (const n of s.nodes)
      for (const e of n.entrances)
        if (e.hidden_since)
          out.push({
            tone: "danger",
            icon: <Radar />,
            title: tr(
              `入口「${e.name}」探测失败 · ${ago(e.hidden_since, lang)}`,
              `Entrance "${e.name}" failing its probe · ${ago(e.hidden_since, lang)}`,
            ),
            desc: tr(
              `${s.name} / ${n.name} · 已从订阅隐藏、已告警，恢复后自动显示`,
              `${s.name} / ${n.name} · hidden from subscriptions and alerted; it comes back on its own`,
            ),
            to: `/nodes/${s.id}?entrance=${e.id}`,
            action: tr("查看入口", "Open entrance"),
          });
  for (const s of live) {
    const st = serverStateOf(s);
    if (st === "pending")
      out.push({
        tone: "info",
        icon: <Hourglass />,
        title: tr(`${s.name} 等待安装`, `${s.name} waiting for its install`),
        desc: tr(
          `${ago(s.created_at, lang)}创建，agent 尚未连接。安装命令只显示一次，丢失可重新生成`,
          `Created ${ago(s.created_at, lang)}; the agent has not connected. The install command is shown once; issue a new one if lost`,
        ),
        to: `/nodes/${s.id}?action=install`,
        action: tr("安装命令", "Install command"),
      });
    const days = certDays(s);
    if (s.enrolled && days !== null && days < 14)
      out.push({
        tone: "warning",
        icon: <Clock />,
        title:
          days < 0
            ? tr(`${s.name} 证书已过期`, `${s.name}'s certificate has expired`)
            : tr(`${s.name} 证书 ${days} 天后到期`, `${s.name}'s certificate expires in ${days} days`),
        desc: tr("agent 会在到期前自动续期，失败时另行告警", "The agent renews it before expiry; a failure is alerted"),
        to: `/nodes/${s.id}`,
        action: tr("查看", "Open"),
      });
    if (s.last_error)
      out.push({
        tone: "warning",
        icon: <CircleAlert />,
        title: tr(`${s.name}：配置应用失败`, `${s.name}: apply failed`),
        desc: tr("agent 仍在运行上一份配置", "The agent keeps running the previous configuration"),
        to: `/nodes/${s.id}`,
        action: tr("查看", "Open"),
      });
    for (const w of s.warnings.filter((w) => !COVERED_WARNINGS.some((c) => w.includes(c))))
      out.push({
        tone: "warning",
        icon: <TriangleAlert />,
        title: tr(`${s.name}：${warningTitle(w, tr)}`, `${s.name}: ${warningTitle(w, tr)}`),
        desc: lang === "zh" ? w : tr("打开服务器查看原文", "Open the server for the details"),
        to: `/nodes/${s.id}`,
        action: tr("查看", "Open"),
      });
  }
  const newer = updates.data?.update_available;
  const behind = newer ? live.filter((s) => s.agent_version && s.agent_version !== newer) : [];
  if (newer && behind.length)
    out.push({
      tone: "info",
      icon: <Download />,
      title: tr(
        `${behind.length} 台服务器的 agent 可更新到 ${newer}`,
        `${behind.length} servers can update their agent to ${newer}`,
      ),
      desc: behind.map((s) => s.name).join(tr("、", ", ")),
      to: "/updates",
      action: tr("去更新", "Update"),
    });
  return out;
}

const PROBLEM_TONE = {
  danger: "bg-destructive-soft text-destructive",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
};

function Problems({ items }: { items: Problem[] }) {
  const tr = useTr();
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const shown = all ? items : items.slice(0, 5);
  return (
    <section className="mb-5" aria-label={tr("需要处理", "Needs attention")}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <h2 className="text-headline font-semibold">{tr("需要处理", "Needs attention")}</h2>
        <span className="tnum rounded-full bg-destructive-soft px-1.5 text-footnote font-semibold text-destructive">
          {items.length}
        </span>
        <Link to="/alerts" className="ml-auto text-footnote font-medium text-primary hover:underline">
          {tr("全部告警", "All alerts")}
        </Link>
      </div>
      <Card className="divide-y divide-separator overflow-hidden">
        {shown.map((p, i) => (
          <Link
            key={i}
            to={p.to}
            className="group flex min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          >
            <span
              className={cn(
                "inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] [&_svg]:size-4",
                PROBLEM_TONE[p.tone],
              )}
              aria-hidden="true"
            >
              {p.icon}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-semibold">{p.title}</span>
              <span className="block truncate text-footnote text-muted-foreground">{p.desc}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-0.5 text-footnote font-medium text-primary max-sm:hidden">
              {p.action}
              <ChevronRight className="size-3.5" aria-hidden="true" />
            </span>
            <ChevronRight className="size-4 shrink-0 text-faint sm:hidden" aria-hidden="true" />
          </Link>
        ))}
        {items.length > 5 && (
          <button
            type="button"
            onClick={() => setAll((a) => !a)}
            className="flex h-11 w-full items-center justify-center text-footnote font-medium text-primary hover:bg-accent"
          >
            {all ? tr("收起", "Show fewer") : tr(`再显示 ${items.length - 5} 条`, `Show ${items.length - 5} more`)}
          </button>
        )}
      </Card>
    </section>
  );
}

/* ---------- 服务器列表 ---------- */

/** Something on this server (or its entrances) wants a look. */
export function issueOf(s: ServerView): boolean {
  if (s.deleting_at) return false;
  const st = serverStateOf(s);
  return (
    st !== "online" ||
    !!s.last_error ||
    s.warnings.length > 0 ||
    s.alerts_firing > 0 ||
    s.nodes.some((n) => n.entrances.some((e) => !!e.hidden_since))
  );
}

const COLS = "lg:grid-cols-[minmax(230px,1.5fr)_128px_120px_minmax(190px,1.1fr)_76px_120px_20px]";

function ServerRow({ s, newer }: { s: ServerView; newer: string | null | undefined }) {
  const tr = useTr();
  const st = serverStateOf(s);
  const q = s.traffic_quota;
  const qp = q.bytes ? pct(q.used_bytes, q.bytes) : 0;
  const ents = entranceCount(s);
  const hidden = s.nodes.reduce((a, n) => a + n.entrances.filter((e) => e.hidden_since).length, 0);
  const live = st === "online";
  const hb = live ? s.heartbeat : null;
  const days = certDays(s);
  const canUpdate = !!newer && !!s.agent_version && s.agent_version !== newer;
  const region = regionOf(s);
  const tone =
    st === "online"
      ? s.warnings.length
        ? "warning"
        : "success"
      : st === "quota"
        ? "warning"
        : st === "pending" || st === "deleting"
          ? "neutral"
          : "danger";
  const modeText =
    q.mode === "both" ? tr("双向", "Both ways") : q.mode === "up" ? tr("仅上行", "Upload") : tr("仅下行", "Download");
  return (
    <Link
      to={`/nodes/${s.id}`}
      data-server={s.name}
      className={cn(
        "group grid items-center gap-x-4 gap-y-2.5 px-4 py-3 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none max-lg:grid-cols-[1fr_auto]",
        COLS,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Dot tone={tone} />
        <span
          className="inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-[6px] bg-secondary text-muted-foreground ring-1 ring-border ring-inset"
          aria-hidden="true"
        >
          <Server className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-body font-semibold">{s.name}</span>
            {st !== "online" && <ServerStatus state={st} />}
          </div>
          <div className="truncate text-footnote text-muted-foreground">
            {region ? `${region} · ` : ""}
            {tr(`${s.nodes.length} 节点 · ${ents} 入口`, `${s.nodes.length} nodes · ${ents} entrances`)}
            {hidden > 0 && <span className="text-destructive">{tr(` · ${hidden} 已隐藏`, ` · ${hidden} hidden`)}</span>}
          </div>
        </div>
      </div>
      <div className="lg:hidden">
        {s.alerts_firing > 0 ? (
          <Badge tone="danger">
            <CircleAlert className="size-3" aria-hidden="true" />
            {s.alerts_firing}
          </Badge>
        ) : (
          <ChevronRight className="size-4 text-faint" aria-hidden="true" />
        )}
      </div>
      <div className="grid gap-1 max-lg:hidden">
        <MiniBar label="CPU" value={hb?.cpu_percent != null ? Math.round(hb.cpu_percent) : null} />
        <MiniBar label={tr("内存", "Mem")} value={hb ? memPct(s) : null} />
      </div>
      <div className="tnum grid gap-0.5 text-footnote max-lg:hidden">
        {hb?.metrics ? (
          <>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ArrowUp className="size-3 text-chart-2" aria-label={tr("上行", "Up")} />
              <span className="text-foreground">{mbps(hb.metrics.net_tx_bytes_per_sec)}</span>
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <ArrowDown className="size-3 text-chart-1" aria-label={tr("下行", "Down")} />
              <span className="text-foreground">{mbps(hb.metrics.net_rx_bytes_per_sec)}</span>
            </span>
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </div>
      <div className="min-w-0 max-lg:col-span-2">
        {q.bytes ? (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-caption text-muted-foreground">
              <span className="truncate">
                {modeText}
                {q.next_reset_at
                  ? tr(
                      ` · ${dateOnly(q.next_reset_at).slice(5)} 重置`,
                      ` · resets ${dateOnly(q.next_reset_at).slice(5)}`,
                    )
                  : ""}
              </span>
              <span
                className={cn(
                  "tnum font-semibold",
                  qp >= 100 || q.exceeded_at ? "text-destructive" : qp >= 80 ? "text-warning" : "text-foreground",
                )}
              >
                {bytes(q.used_bytes)} / {bytes(q.bytes)}
              </span>
            </div>
            <Meter
              value={qp}
              tone={q.exceeded_at || qp >= 100 ? "danger" : qp >= 80 ? "warning" : "primary"}
              label={tr(`${s.name} 的流量额度用量`, `Quota usage of ${s.name}`)}
            />
          </>
        ) : (
          <span className="text-footnote text-faint">
            {st === "pending"
              ? tr("安装后可设置额度", "Set a quota once installed")
              : tr(`不限额度 · 本周期 ${bytes(q.used_bytes)}`, `No quota · ${bytes(q.used_bytes)} this period`)}
          </span>
        )}
      </div>
      <div className="tnum col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-footnote text-muted-foreground lg:hidden">
        {hb && (
          <span>
            CPU {hb.cpu_percent != null ? `${Math.round(hb.cpu_percent)}%` : "—"} · {tr("内存", "Mem")}{" "}
            {memPct(s) ?? "—"}%
          </span>
        )}
        {hb?.metrics && (
          <span>
            ↑{mbps(hb.metrics.net_tx_bytes_per_sec)} ↓{mbps(hb.metrics.net_rx_bytes_per_sec)}
          </span>
        )}
        {days !== null && s.enrolled && (
          <span className={cn(days < 14 && "font-medium text-warning")}>{tr(`证书 ${days} 天`, `cert ${days} d`)}</span>
        )}
        {canUpdate && <Badge tone="primary">{tr("agent 可更新", "agent update")}</Badge>}
      </div>
      <div
        className={cn(
          "tnum text-footnote max-lg:hidden",
          days !== null && days < 14 ? "font-semibold text-warning" : "text-muted-foreground",
        )}
      >
        {days !== null && s.enrolled ? tr(`证书 ${days} 天`, `cert ${days} d`) : <span className="text-faint">—</span>}
      </div>
      <div className="grid justify-items-start gap-0.5 text-footnote max-lg:hidden">
        <span className="tnum text-muted-foreground">
          {s.agent_version ? (
            `agent ${s.agent_version}`
          ) : (
            <span className="text-faint">{tr("未安装", "Not installed")}</span>
          )}
        </span>
        {canUpdate ? (
          <Badge tone="primary" className="text-caption">
            {tr(`可更新 ${newer}`, `${newer} available`)}
          </Badge>
        ) : s.alerts_firing > 0 ? (
          <Badge tone="danger" className="text-caption">
            <CircleAlert className="size-3" aria-hidden="true" />
            {tr(`${s.alerts_firing} 条告警`, `${s.alerts_firing} alerts`)}
          </Badge>
        ) : null}
      </div>
      <ChevronRight className="size-4 text-faint max-lg:hidden" aria-hidden="true" />
    </Link>
  );
}

type View = "all" | "issue" | "ok";

function Fleet() {
  const tr = useTr();
  const [qs, patch] = useQS();
  const servers = useServers();
  const updates = useUpdateStatus();
  const list = servers.data ?? [];
  const problems = useProblems(list);
  // The box answers at once; the URL (`?q=`, shareable) follows shortly after.
  const [search, setSearch] = useState(() => qs.get("q") ?? "");
  const debounced = useDebounced(search, 250);
  useEffect(() => patch({ q: debounced.trim() || null }, true), [debounced]); // eslint-disable-line react-hooks/exhaustive-deps
  const term = search.trim().toLowerCase();
  const v: View = qs.get("view") === "issue" ? "issue" : qs.get("view") === "ok" ? "ok" : "all";
  const live = list.filter((s) => !s.deleting_at);
  const nodes = list.flatMap((s) => s.nodes);
  const ents = nodes.flatMap((n) => n.entrances);
  const relays = ents.filter((e) => e.kind === "relay").length;
  const hidden = ents.filter((e) => e.hidden_since).length;
  const states = live.map(serverStateOf);
  const online = states.filter((x) => x === "online").length;
  const offline = states.filter((x) => x === "offline").length;
  const over = states.filter((x) => x === "quota").length;
  const pending = states.filter((x) => x === "pending").length;
  const protoCount = new Map<string, number>();
  for (const n of nodes)
    protoCount.set(protocolName(n.protocol, tr), (protoCount.get(protocolName(n.protocol, tr)) ?? 0) + 1);
  const sorted = [...list].sort((a, b) => Number(issueOf(b)) - Number(issueOf(a)));
  const rows = sorted.filter((s) => (v === "issue" ? issueOf(s) : v === "ok" ? !issueOf(s) : true));
  const issues = list.filter(issueOf).length;

  return (
    <>
      <PageHeader
        title={tr("节点", "Nodes")}
        description={tr(
          "服务器 → 落地节点 → 入口；用户能用哪些入口只由 套餐 → 节点组 决定。",
          "Servers → landing nodes → entrances; which entrances users get comes only from plan → node group.",
        )}
        actions={
          <>
            <UpdateBadge />
            <Button variant="outline" icon={Plus} className="max-sm:hidden" onClick={() => patch({ new: "node" })}>
              {tr("添加节点", "Add node")}
            </Button>
            <Button variant="primary" icon={Server} onClick={() => patch({ new: "server" })}>
              {tr("添加服务器", "Add server")}
            </Button>
          </>
        }
      />
      {servers.isPending ? (
        <Card>
          <SkeletonRows rows={6} height={60} />
        </Card>
      ) : servers.isError && !servers.data ? (
        <Card>
          <ErrorState
            title={tr("服务器列表加载失败", "Could not load the servers")}
            error={servers.error}
            onRetry={() => void servers.refetch()}
          />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Server}
            title={tr("添加第一台服务器", "Add your first server")}
            description={tr(
              "先在面板登记一台服务器（名称 + TLS 域名），拿到一次性安装命令，在服务器上执行后即可在它上面创建节点。",
              "Register a server (name + TLS domain), run the one-time install command on it, then create nodes on it.",
            )}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={Plus} onClick={() => patch({ new: "server" })}>
                  {tr("添加服务器", "Add server")}
                </Button>
                <Button variant="ghost" asChild>
                  <Link to="/settings/install">{tr("安装设置", "Install settings")}</Link>
                </Button>
              </div>
            }
          />
        </Card>
      ) : (
        <>
          <StatStrip
            className="mb-5"
            items={[
              {
                label: tr("服务器在线", "Servers online"),
                value: (
                  <>
                    {online}
                    <span className="text-faint"> / {live.length}</span>
                  </>
                ),
                foot:
                  [
                    offline && tr(`${offline} 离线`, `${offline} offline`),
                    over && tr(`${over} 额度用尽`, `${over} over quota`),
                    pending && tr(`${pending} 待安装`, `${pending} not installed`),
                  ]
                    .filter(Boolean)
                    .join(" · ") || tr("全部在线", "All online"),
                tone: online < live.length ? "warning" : undefined,
                onClick: () => patch({ view: v === "issue" ? null : "issue" }),
                active: v === "issue",
              },
              {
                label: tr("落地节点", "Landing nodes"),
                value: nodes.length,
                foot: [...protoCount].map(([p, n]) => `${p} ${n}`).join(" · ") || tr("还没有节点", "No nodes yet"),
              },
              {
                label: tr("入口", "Entrances"),
                value: ents.length,
                foot: tr(
                  `直连 ${ents.length - relays} · 中转 ${relays}`,
                  `${ents.length - relays} direct · ${relays} relays`,
                ),
              },
              {
                label: tr("探测失败已隐藏", "Hidden after failed probes"),
                value: hidden,
                tone: hidden ? "danger" : undefined,
                foot: tr("恢复后自动回到订阅", "Back in subscriptions once they recover"),
              },
            ]}
          />
          {!term && <Problems items={problems} />}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <SearchField
              value={search}
              onChange={setSearch}
              label={tr("搜索服务器、节点或入口", "Search servers, nodes or entrances")}
              placeholder={tr("搜索服务器、节点、入口、地址…", "Search servers, nodes, entrances, addresses…")}
              shortcut="/"
              className="w-full sm:w-80"
            />
            {!term && (
              <Segmented<View>
                label={tr("筛选", "Filter")}
                value={v}
                onChange={(x) => patch({ view: x === "all" ? null : x })}
                options={[
                  { value: "all", label: tr("全部", "All"), count: list.length },
                  { value: "issue", label: tr("需要关注", "Needs a look"), count: issues },
                  { value: "ok", label: tr("正常", "Healthy"), count: list.length - issues },
                ]}
              />
            )}
          </div>
          {term ? (
            <SearchResults list={list} term={term} onClear={() => setSearch("")} />
          ) : rows.length === 0 ? (
            <Card>
              <EmptyState
                icon={v === "issue" ? Server : TriangleAlert}
                title={
                  v === "issue"
                    ? tr("没有需要关注的服务器", "Nothing needs a look")
                    : tr("没有正常的服务器", "No healthy servers")
                }
                description={
                  v === "issue"
                    ? tr(
                        "服务器都在线、未超额、没有告警与警告，中转入口的探测都正常。",
                        "Every server is online, within quota, without alerts or warnings; every relay passes its probe.",
                      )
                    : tr("每台服务器都有需要处理的问题。", "Every server has something to look at.")
                }
                action={<Button onClick={() => patch({ view: null })}>{tr("显示全部", "Show all")}</Button>}
              />
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div
                className={cn(
                  "grid h-8 items-center gap-x-4 border-b border-separator px-4 text-footnote font-medium text-muted-foreground max-lg:hidden",
                  COLS,
                )}
                aria-hidden="true"
              >
                <span className="pl-[52px]">{tr("服务器", "Server")}</span>
                <span>{tr("负载", "Load")}</span>
                <span>{tr("实时速率", "Live rate")}</span>
                <span>{tr("流量额度（本周期）", "Quota (this period)")}</span>
                <span>{tr("证书", "Cert")}</span>
                <span>agent</span>
                <span />
              </div>
              <div className="divide-y divide-separator" role="list" aria-label={tr("服务器", "Servers")}>
                {rows.map((s) => (
                  <div role="listitem" key={s.id}>
                    <ServerRow s={s} newer={updates.data?.update_available} />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function SearchResults({ list, term, onClear }: { list: ServerView[]; term: string; onClear: () => void }) {
  const tr = useTr();
  const hit = (...xs: (string | number | null | undefined)[]) =>
    xs.some((x) => x !== null && x !== undefined && String(x).toLowerCase().includes(term));
  const ss = list.filter((s) => hit(s.name, s.tls_domain, s.agent_addr, regionOf(s)));
  const ns = list.flatMap((s) =>
    s.nodes
      .filter((n) => hit(n.name, n.display_name, n.region, n.protocol, n.transport, n.port))
      .map((n) => ({ s, n })),
  );
  const es = list.flatMap((s) =>
    s.nodes.flatMap((n) =>
      n.entrances
        .filter((e) => {
          const host = e.connect_host ?? s.tls_domain ?? "";
          const port = e.connect_port ?? n.port ?? "";
          return hit(e.name, host, `${host}:${port}`, e.listen_port, ...e.tags, ...e.source_cidrs);
        })
        .map((e) => ({ s, n, e })),
    ),
  );
  if (!ss.length && !ns.length && !es.length)
    return (
      <Card>
        <EmptyState
          icon={EyeOff}
          title={tr(`没有匹配「${term}」的服务器、节点或入口`, `Nothing matches "${term}"`)}
          description={tr(
            "可以搜名称、地区、域名、IP、端口或中转出口 IP。",
            "Search by name, region, domain, IP, port or relay egress IP.",
          )}
          action={<Button onClick={onClear}>{tr("清除搜索", "Clear search")}</Button>}
        />
      </Card>
    );
  const Group = ({ title, n, children }: { title: string; n: number; children: ReactNode }) =>
    n ? (
      <section aria-label={title}>
        <h3 className="mb-1.5 px-1 text-footnote font-semibold text-muted-foreground">
          {title} <span className="tnum text-faint">{n}</span>
        </h3>
        <Card className="divide-y divide-separator overflow-hidden">{children}</Card>
      </section>
    ) : null;
  const Item = ({
    to,
    lead,
    title,
    sub,
    trail,
  }: {
    to: string;
    lead: ReactNode;
    title: ReactNode;
    sub: ReactNode;
    trail?: ReactNode;
  }) => (
    <Link to={to} className="flex min-h-13 items-center gap-3 px-4 py-2 transition-colors hover:bg-accent">
      {lead}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body font-semibold">{title}</span>
        <span className="block truncate text-footnote text-muted-foreground">{sub}</span>
      </span>
      {trail}
      <ChevronRight className="size-4 shrink-0 text-faint" aria-hidden="true" />
    </Link>
  );
  const tile = (
    <span
      className="inline-flex h-6 w-8 shrink-0 items-center justify-center rounded-[6px] bg-secondary text-muted-foreground ring-1 ring-border ring-inset"
      aria-hidden="true"
    >
      <Server className="size-3.5" />
    </span>
  );
  return (
    <div className="grid gap-4">
      <p className="px-1 text-footnote text-muted-foreground">
        {tr(`找到 ${ss.length + ns.length + es.length} 项`, `${ss.length + ns.length + es.length} found`)} ·{" "}
        <button type="button" onClick={onClear} className="font-medium text-primary hover:underline">
          {tr("清除搜索", "Clear search")}
        </button>
      </p>
      <Group title={tr("服务器", "Servers")} n={ss.length}>
        {ss.map((s) => (
          <Item
            key={s.id}
            to={`/nodes/${s.id}`}
            lead={tile}
            title={s.name}
            sub={<span className="font-mono">{[s.tls_domain, s.agent_addr].filter(Boolean).join(" · ") || "—"}</span>}
            trail={<ServerStatus server={s} />}
          />
        ))}
      </Group>
      <Group title={tr("落地节点", "Landing nodes")} n={ns.length}>
        {ns.map(({ n, s }) => (
          <Item
            key={n.id}
            to={`/nodes/${s.id}?node=${n.id}`}
            lead={tile}
            title={n.display_name || n.name}
            sub={`${s.name} · ${inboundLine(n, tr)}`}
          />
        ))}
      </Group>
      <Group title={tr("入口", "Entrances")} n={es.length}>
        {es.map(({ e, n, s }) => (
          <Item
            key={e.id}
            to={`/nodes/${s.id}?entrance=${e.id}`}
            lead={<KindIcon kind={e.kind} />}
            title={e.name}
            sub={
              <>
                <span className="font-mono">
                  {e.connect_host ?? s.tls_domain ?? "—"}:{e.connect_port ?? n.port ?? "—"}
                </span>{" "}
                · {s.name} / {n.name}
              </>
            }
            trail={<span className="tnum text-body font-semibold">{`${Number(e.rate.toFixed(3))}x`}</span>}
          />
        ))}
      </Group>
    </div>
  );
}
