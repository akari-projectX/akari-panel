// 节点 (NOD-*): servers (one agent each) → landing nodes (one inbound
// each) → entrances (direct and relays with TCP health, multipliers, node
// groups). Each server card shows the machine state, the traffic quota and
// its warnings; details and editors are centred dialogs (node-dialogs.tsx,
// server-dialog.tsx, entrance-dialog.tsx) opened from the URL (`?open=`),
// the search term lives in the URL too (`?q=`).
import { useMemo, useState } from "react";
import { del, patch, put } from "../../shared/api";
import { ago, bytes, dateOnly, pct, rateText } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { Stat } from "../kit";
import { useAction } from "../data";
import { overlaps } from "../rates";
import { setQuery, useQueryParam, useRoute } from "../router";
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
import { ApplyError, WarningList, entranceState, healthText } from "./node-common";
import { ServerDialog } from "./server-dialog";
import { UpdateBadge } from "./updates";
import {
  Activity,
  ArrowRightLeft,
  Bell,
  ChevronDown,
  Clock,
  Cpu,
  Download,
  EyeOff,
  FileText,
  Gauge,
  Layers,
  MemoryStick,
  Pause,
  Play,
  Plus,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Badge, Dot } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Input, Switch } from "../../shared/ui/form";
import { Callout, PageHeader } from "../../shared/ui/layout";
import { MenuItem, RowMenu } from "../../shared/ui/menu";
import { Meter, usageTone } from "../../shared/ui/meter";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { cn } from "../../shared/cn";

type Dialog =
  | { kind: "edit" | "quota" | "alerts"; server: ServerView }
  | { kind: "relay"; node: ServerNode; server: ServerView }
  | { kind: "install"; shown: Shown };

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

export function NodesPage() {
  const tr = useTr();
  const { query } = useRoute();
  const servers = useServers();
  const groups = useGroups();
  const [search, setSearch] = useQueryParam("q");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const creating = query.get("new");
  const open = query.get("open") ?? "";
  const [kind, openId] = open.split(":");
  const list = servers.data ?? [];
  const needle = search.trim().toLowerCase();
  const shown = needle ? list.filter((s) => matches(s, needle)) : list;
  const nodes = list.flatMap((s) => s.nodes);
  const entrances = nodes.flatMap((n) => n.entrances);
  const groupName = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g.name])), [groups.data]);
  const findEntrance = (id: string) => {
    for (const s of list) for (const n of s.nodes) for (const e of n.entrances) if (e.id === id) return { s, n, e };
    return null;
  };
  const relays = entrances.filter((e) => e.kind === "relay").length;

  return (
    <>
      <PageHeader
        title={tr("节点", "Nodes")}
        description={tr(
          "服务器（一台机器一个 agent）→ 落地节点（一个节点一种协议）→ 入口（直连与中转）。权限只来自 套餐 → 节点组 → 入口。",
          "Servers (one agent each) → landing nodes (one protocol each) → entrances (direct and relays). Access comes only from plan → node group → entrance.",
        )}
        actions={
          <>
            <UpdateBadge />
            <Button icon={Server} onClick={() => setQuery({ new: "server" }, false)}>
              {tr("添加服务器", "Add server")}
            </Button>
            <Button variant="primary" icon={Plus} onClick={() => setQuery({ new: "node" }, false)}>
              {tr("添加节点", "Add node")}
            </Button>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {servers.isPending ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : (
          <>
            <Stat
              icon={Server}
              label={tr("服务器在线", "Servers online")}
              value={`${list.filter((s) => s.online).length} / ${list.length}`}
              hint={tr(
                `超额停用 ${list.filter((s) => s.traffic_quota.exceeded_at).length} · 待安装 ${list.filter((s) => !s.enrolled).length}`,
                `${list.filter((s) => s.traffic_quota.exceeded_at).length} over quota · ${list.filter((s) => !s.enrolled).length} not installed`,
              )}
            />
            <Stat
              icon={Layers}
              label={tr("落地节点", "Landing nodes")}
              value={nodes.length}
              hint={tr(
                `启用 ${nodes.filter((n) => n.enabled).length}`,
                `${nodes.filter((n) => n.enabled).length} enabled`,
              )}
            />
            <Stat
              icon={ArrowRightLeft}
              label={tr("入口", "Entrances")}
              value={entrances.length}
              hint={tr(
                `直连 ${entrances.length - relays} · 中转 ${relays}`,
                `${entrances.length - relays} direct · ${relays} relays`,
              )}
            />
            <Stat
              icon={EyeOff}
              label={tr("探测失败已隐藏", "Hidden (probe failed)")}
              value={entrances.filter((e) => e.hidden_since).length}
              tone={entrances.some((e) => e.hidden_since) ? "danger" : undefined}
            />
          </>
        )}
      </div>
      <div className="relative mb-4 w-full sm:w-80">
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
      {servers.isError && (
        <Card>
          <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
        </Card>
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
          <EmptyState
            icon={Search}
            title={tr("没有匹配的服务器或节点", "No matching servers or nodes")}
            description={tr(
              `没有名称或地址包含「${search.trim()}」的服务器、节点或入口。`,
              `Nothing is named or addressed like "${search.trim()}".`,
            )}
            action={<Button onClick={() => setSearch(null)}>{tr("清除搜索", "Clear search")}</Button>}
          />
        </Card>
      )}
      <div className="space-y-4">
        {shown.map((s) => (
          <ServerCard key={s.id} s={s} groupName={groupName} onDialog={setDialog} />
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
  groupName,
  onDialog,
}: {
  s: ServerView;
  groupName: Map<string, string>;
  onDialog: (d: Dialog) => void;
}) {
  const tr = useTr();
  const lang = useLang();
  const confirm = useConfirm();
  const toast = useToast();
  const [expanded, setExpanded] = useState(true);
  const [state, tone] = serverState(s, tr);
  const hb = s.heartbeat;
  const q = s.traffic_quota;
  const qp = q.bytes ? pct(q.used_bytes, q.bytes) : null;
  const certDays = s.cert_not_after ? Math.floor((Date.parse(s.cert_not_after) - Date.now()) / 86_400_000) : null;
  const openServer = () => setQuery({ open: `server:${s.id}` }, false);
  const removeServer = async () => {
    const ents = s.nodes.reduce((n, x) => n + x.entrances.length, 0);
    const ok = await confirm({
      title: tr(`删除服务器 ${s.name}？`, `Delete server ${s.name}?`),
      impacts: [
        { label: tr("同时删除的节点", "Nodes deleted with it"), value: s.nodes.length },
        { label: tr("同时删除的入口", "Entrances deleted with it"), value: ents },
      ],
      description: tr(
        "agent 先收到空配置，随后吊销证书并删除。",
        "The agent gets the empty state first; then the certificates are revoked and it is deleted.",
      ),
      typeToConfirm: s.name,
      action: () => del(`/servers/${s.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("删除已开始", "Deletion started") });
  };
  const quotaMode =
    q.mode === "both" ? tr("双向", "both") : q.mode === "up" ? tr("仅上行", "up") : tr("仅下行", "down");
  return (
    <section aria-label={s.name}>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5">
          <div className="flex min-w-0 flex-1 basis-64 items-center gap-2">
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? tr(`收起 ${s.name} 的节点`, `Collapse ${s.name}`)
                  : tr(`展开 ${s.name} 的节点`, `Expand ${s.name}`)
              }
              onClick={() => setExpanded((v) => !v)}
              className="hit-44 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-secondary hover:text-foreground"
            >
              <ChevronDown
                className={cn("size-4 transition-transform duration-(--dur-fast)", !expanded && "-rotate-90")}
                aria-hidden="true"
              />
            </button>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="truncate text-headline font-semibold hover:underline"
                  onClick={openServer}
                >
                  {s.name}
                </button>
                <Badge tone={tone} dot>
                  {state}
                </Badge>
                {s.alerts_firing > 0 && (
                  <Badge tone="danger">{tr(`${s.alerts_firing} 条告警`, `${s.alerts_firing} alerts`)}</Badge>
                )}
              </div>
              <div className="truncate font-mono text-footnote text-muted-foreground">
                {[s.tls_domain, s.agent_addr].filter(Boolean).join(" · ") || tr("未设置域名", "no domain")}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-footnote text-muted-foreground max-md:w-full">
            {hb && (
              <>
                <span className="inline-flex items-center gap-1" title="CPU">
                  <Cpu className="size-3.5" aria-hidden="true" />
                  <span className="tnum">{hb.cpu_percent != null ? `${hb.cpu_percent.toFixed(0)}%` : "?"}</span>
                </span>
                <span className="inline-flex items-center gap-1" title={tr("内存", "Memory")}>
                  <MemoryStick className="size-3.5" aria-hidden="true" />
                  <span className="tnum">
                    {hb.mem_total_bytes ? `${pct(hb.mem_used_bytes ?? 0, hb.mem_total_bytes)}%` : "?"}
                  </span>
                </span>
                <span className="tnum">
                  ↓ {bytes(hb.metrics?.net_rx_bytes_per_sec ?? null)}/s ↑{" "}
                  {bytes(hb.metrics?.net_tx_bytes_per_sec ?? null)}/s
                </span>
              </>
            )}
            {s.agent_version && (
              <span>
                agent <span className="font-medium text-foreground">{s.agent_version}</span>
                {s.agent_os ? ` · ${s.agent_os}/${s.agent_arch}` : ""}
              </span>
            )}
            {certDays !== null && (
              <span className={cn("tnum", certDays < 14 && "font-medium text-warning")}>
                {tr(`证书 ${certDays} 天`, `cert ${certDays} days`)}
              </span>
            )}
            {!s.online && s.last_seen_at && (
              <span>{tr(`最后在线 ${ago(s.last_seen_at, lang)}`, `last seen ${ago(s.last_seen_at, lang)}`)}</span>
            )}
            {!s.online && s.lease_remaining_seconds !== null && s.lease_remaining_seconds > 0 && (
              <span>
                {tr(
                  `租约剩余 ${Math.round(s.lease_remaining_seconds / 3600)} 小时`,
                  `lease ${Math.round(s.lease_remaining_seconds / 3600)} h left`,
                )}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => onDialog({ kind: "quota", server: s })} icon={Gauge}>
              {tr("流量额度", "Quota")}
            </Button>
            <RowMenu label={tr(`服务器 ${s.name} 的操作`, `Actions of ${s.name}`)}>
              {(close) => (
                <>
                  <MenuItem icon={Activity} onClick={() => (close(), openServer())}>
                    {tr("状态与测速", "Status and latency")}
                  </MenuItem>
                  <MenuItem icon={Settings} onClick={() => (close(), onDialog({ kind: "edit", server: s }))}>
                    {tr("编辑服务器", "Edit server")}
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
                  <MenuItem
                    icon={Trash2}
                    danger
                    disabled={!!s.deleting_at}
                    onClick={() => (close(), void removeServer())}
                  >
                    {tr("删除服务器", "Delete server")}
                  </MenuItem>
                </>
              )}
            </RowMenu>
          </div>
        </div>
        {(qp !== null || q.exceeded_at || s.last_error || s.warnings.length > 0) && (
          <div className="space-y-2 px-4 pb-3">
            {qp !== null && (
              <div>
                <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-footnote text-muted-foreground">
                  <span>
                    {tr("流量额度", "Quota")} · {bytes(q.used_bytes)} / {bytes(q.bytes)} · {quotaMode}
                    {q.reset_day ? tr(` · 每月 ${q.reset_day} 日重置`, ` · resets on day ${q.reset_day}`) : ""}
                  </span>
                  <span className={cn("tnum font-semibold", q.exceeded_at ? "text-destructive" : "text-foreground")}>
                    {qp.toFixed(0)}%
                  </span>
                </div>
                <Meter
                  value={qp}
                  tone={q.exceeded_at ? "danger" : usageTone(qp)}
                  label={tr("流量额度用量", "Quota usage")}
                />
              </div>
            )}
            {q.exceeded_at && (
              <Callout tone="danger" title={tr("已超额", "Over quota")}>
                {tr(
                  "上面所有节点已下发空配置，订阅中已隐藏；下个周期或调高额度后自动恢复。",
                  "Every node on it gets the empty state and leaves subscriptions until the next period or a higher quota.",
                )}{" "}
                <button
                  type="button"
                  className="font-medium text-primary hover:underline"
                  onClick={() => onDialog({ kind: "quota", server: s })}
                >
                  {tr("调整额度", "Adjust the quota")}
                </button>
              </Callout>
            )}
            {s.last_error && <ApplyError error={s.last_error} at={s.last_error_at} />}
            <WarningList warnings={s.warnings.filter((w) => !(q.exceeded_at && w.includes("流量额度已用完")))} />
          </div>
        )}
        {expanded &&
          (s.nodes.length === 0 ? (
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

/** Many entrances start folded (unless one has a problem); a few are shown. */
function startExpanded(n: ServerNode): boolean {
  return n.entrances.length <= 6 || n.entrances.some((e) => e.hidden_since || !e.enabled);
}

function NodeRow({
  n,
  server,
  groupName,
  onRelay,
}: {
  n: ServerNode;
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
        `节点与它的 ${n.entrances.length} 个入口及全部凭据立即删除`,
        `The node, its ${n.entrances.length} entrances and every credential go at once`,
      ),
      typeToConfirm: n.name,
      action: () => del(`/nodes/${n.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("节点已删除", "Node deleted") });
  };
  const hidden = n.entrances.find((e) => e.hidden_since);
  return (
    <li data-node={n.name} className="border-b border-separator last:border-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-2">
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? tr(`收起 ${n.name} 的入口`, `Hide entrances of ${n.name}`)
                : tr(`展开 ${n.name} 的入口`, `Show entrances of ${n.name}`)
            }
            onClick={() => setExpanded((v) => !v)}
            className="hit-44 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-secondary hover:text-foreground"
          >
            <ChevronDown
              className={cn("size-4 transition-transform duration-(--dur-fast)", !expanded && "-rotate-90")}
              aria-hidden="true"
            />
          </button>
          <Dot tone={!n.enabled ? "neutral" : server.online ? "success" : "danger"} />
          <button
            type="button"
            className="min-w-0 truncate text-left text-body font-semibold hover:underline"
            onClick={() => setQuery({ open: `node:${n.id}` }, false)}
          >
            {n.display_name || n.name}
            {n.display_name && <span className="ml-1 font-normal text-muted-foreground">({n.name})</span>}
          </button>
          <Badge tone="outline">
            {n.protocol ?? tr("无入站", "no inbound")}
            {n.port ? ` :${n.port}` : ""}
          </Badge>
          {n.region && <span className="text-footnote text-muted-foreground">{n.region}</span>}
          {!n.enabled && <Badge>{tr("已停用", "Disabled")}</Badge>}
          {!n.visible && <Badge tone="outline">{tr("对用户隐藏", "Hidden from users")}</Badge>}
        </div>
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
            {n.entrances.map((e) => (
              <EntranceRow key={e.id} e={e} n={n} server={server} groupName={groupName} />
            ))}
          </ul>
          {hidden && (
            <div className="mx-4 mt-1">
              <Callout tone="danger">
                {tr(
                  `中转入口探测失败（自 ${dateOnly(hidden.hidden_since)}）：已从订阅隐藏并已告警，恢复后自动显示。`,
                  `A relay entrance fails its probe (since ${dateOnly(hidden.hidden_since)}): hidden from subscriptions and alerted; it comes back automatically.`,
                )}
              </Callout>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** One entrance: a button (keyboard and touch), a wrapped card on a phone. */
function EntranceRow({
  e,
  n,
  server,
  groupName,
}: {
  e: EntranceView;
  n: ServerNode;
  server: ServerView;
  groupName: Map<string, string>;
}) {
  const tr = useTr();
  const lang = useLang();
  const [h, ht] = healthText(e, tr, lang);
  const [st, stt] = entranceState(e, tr);
  const ov = overlaps(e.rate_rules).length > 0;
  const relay = e.kind === "relay";
  const groupsText = e.group_ids.map((g) => groupName.get(g) ?? g.slice(0, 6)).join(", ");
  return (
    <li data-entrance={e.id}>
      <button
        type="button"
        onClick={() => setQuery({ open: `entrance:${e.id}` }, false)}
        className="flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 py-2 pr-4 pl-14 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none max-sm:pl-11"
      >
        <span className="flex min-w-0 flex-1 basis-52 flex-wrap items-center gap-1.5">
          {relay ? (
            <ArrowRightLeft className="size-3.5 shrink-0 text-chart-2" aria-hidden="true" />
          ) : (
            <ShieldCheck className="size-3.5 shrink-0 text-chart-1" aria-hidden="true" />
          )}
          <span className="truncate text-body font-medium">{e.name}</span>
          {relay && <Badge tone="info">{tr("中转", "relay")}</Badge>}
          {e.tags.map((t) => (
            <span key={t} data-entrance-tag>
              <Badge>{t}</Badge>
            </span>
          ))}
        </span>
        <span className="min-w-0 truncate font-mono text-footnote text-muted-foreground max-sm:w-full lg:w-64">
          {e.connect_host ?? server.tls_domain ?? "—"}:{e.connect_port ?? n.port ?? "—"}
          {relay && (
            <>
              {" "}
              → :{e.listen_port} · {tr(`${e.source_cidrs.length} 个出口`, `${e.source_cidrs.length} egress`)}
            </>
          )}
        </span>
        <span className="tnum inline-flex items-center gap-1.5 text-body font-semibold">
          {rateText(Math.round(e.rate_now * 1000))}
          {e.rate_now !== e.rate && (
            <span className="text-footnote font-normal text-muted-foreground">
              ({tr("基础", "base")} {rateText(e.rate_permille)})
            </span>
          )}
          {e.rate_rules.length > 0 && (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 text-caption font-medium",
                ov ? "text-warning" : "text-faint",
              )}
              title={tr(`${e.rate_rules.length} 条时段规则`, `${e.rate_rules.length} time-window rules`)}
            >
              <Clock className="size-3" aria-hidden="true" />
              <span>{e.rate_rules.length}</span>
            </span>
          )}
          {ov && <TriangleAlert className="size-3.5 text-warning" aria-label={tr("时段重叠", "Overlapping windows")} />}
        </span>
        {groupsText && <span className="text-footnote text-muted-foreground">{groupsText}</span>}
        {relay && (
          <Badge tone={ht} dot>
            {h}
          </Badge>
        )}
        <Badge tone={stt}>{st}</Badge>
      </button>
    </li>
  );
}
