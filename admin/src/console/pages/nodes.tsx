// 节点 (NOD-*): servers (Q1, one agent each) → landing nodes (D2, one
// inbound each) → entrances (§5: direct + relays with TCP health, D9
// multipliers, node groups). Each server card shows the machine state, the
// D5 traffic quota and its warnings; the drawers and dialogs live in
// node-dialogs.tsx, server-drawer.tsx and entrance-drawer.tsx.
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { del, get, patch, put } from "../../shared/api";
import { ago, bytes, dateOnly, pct, rateText } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Icon } from "../../shared/ui/icons";
import { MenuItem, RowMenu, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  Dot,
  EmptyState,
  ErrorState,
  Input,
  PageHeader,
  Progress,
  Skeleton,
  Switch,
  usageTone,
  type Tone,
} from "../../shared/ui/primitives";
import { Stat, useRun } from "../kit";
import { overlaps } from "../rates";
import { setQuery, useRoute } from "../router";
import type { EntranceView, NodeGroup, ServerNode, ServerView } from "../types";
import { EntranceDrawer, RelayDialog } from "./entrance-drawer";
import {
  AlertRulesDialog,
  CreateNodeDialog,
  CreateServerDialog,
  InstallDialog,
  NodeDrawer,
  QuotaDialog,
  ServerEditDialog,
  type Shown,
} from "./node-dialogs";
import { ServerDrawer } from "./server-drawer";
import { UpdateBadge } from "./updates";

export function useServers() {
  return useQuery({ queryKey: ["servers"], queryFn: () => get<ServerView[]>("/servers"), refetchInterval: 10_000 });
}
export function useGroups() {
  return useQuery({ queryKey: ["node-groups"], queryFn: () => get<NodeGroup[]>("/node-groups") });
}

export function serverState(s: ServerView, tr: Tr): [string, Tone] {
  if (s.deleting_at) return [tr("删除中", "Deleting"), "neutral"];
  if (!s.enrolled) return [tr("待安装", "Not installed"), "info"];
  if (s.traffic_quota.exceeded_at) return [tr("超额停用", "Over quota"), "danger"];
  if (s.online) return [tr("在线", "Online"), "success"];
  return [tr("离线", "Offline"), "danger"];
}

export function entranceState(e: EntranceView, tr: Tr): [string, Tone] {
  if (!e.enabled) return [tr("已停用", "Disabled"), "neutral"];
  if (e.hidden_since) return [tr("已隐藏", "Hidden"), "danger"];
  return [tr("显示", "Shown"), "success"];
}

export function healthText(e: EntranceView, tr: Tr, lang: "zh" | "en"): [string, Tone] {
  if (e.kind === "direct") return [tr("直连", "direct"), "neutral"];
  if (e.health_ok === null) return [tr("未探测", "not tested"), "neutral"];
  if (e.health_ok) return [tr(`正常 · ${ago(e.health_at, lang)}`, `ok · ${ago(e.health_at, lang)}`), "success"];
  return [
    tr(
      `失败 ${e.health_failures} 次 · ${ago(e.health_at, lang)}`,
      `failed ×${e.health_failures} · ${ago(e.health_at, lang)}`,
    ),
    "danger",
  ];
}

type Dialog =
  | { kind: "edit" | "quota" | "alerts"; server: ServerView }
  | { kind: "relay"; node: ServerNode; server: ServerView }
  | { kind: "install"; shown: Shown };

export function NodesPage() {
  const tr = useTr();
  const { query } = useRoute();
  const servers = useServers();
  const groups = useGroups();
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const creating = query.get("new");
  const open = query.get("open") ?? "";
  const [kind, openId] = open.split(":");
  const list = servers.data ?? [];
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? list.filter(
        (s) =>
          s.name.toLowerCase().includes(needle) ||
          s.nodes.some(
            (n) => n.name.toLowerCase().includes(needle) || (n.display_name ?? "").toLowerCase().includes(needle),
          ),
      )
    : list;
  const nodes = list.flatMap((s) => s.nodes);
  const entrances = nodes.flatMap((n) => n.entrances);
  const groupName = useMemo(() => new Map((groups.data ?? []).map((g) => [g.id, g.name])), [groups.data]);
  const findEntrance = (id: string) => {
    for (const s of list) for (const n of s.nodes) for (const e of n.entrances) if (e.id === id) return { s, n, e };
    return null;
  };

  return (
    <>
      <PageHeader
        title={tr("节点", "Nodes")}
        description={tr(
          "服务器（一台机器一个 agent）→ 落地节点（一个节点一种协议）→ 入口（直连与中转）。",
          "Servers (one agent each) → landing nodes (one protocol each) → entrances (direct and relays).",
        )}
        actions={
          <>
            <UpdateBadge />
            <Button size="sm" icon="server" onClick={() => setQuery({ new: "server" }, false)}>
              {tr("添加服务器", "Add server")}
            </Button>
            <Button size="sm" variant="primary" icon="plus" onClick={() => setQuery({ new: "node" }, false)}>
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
              icon="server"
              label={tr("服务器在线", "Servers online")}
              value={`${list.filter((s) => s.online).length} / ${list.length}`}
            />
            <Stat
              icon="layers"
              label={tr("落地节点", "Landing nodes")}
              value={nodes.length}
              hint={tr(
                `启用 ${nodes.filter((n) => n.enabled).length}`,
                `${nodes.filter((n) => n.enabled).length} enabled`,
              )}
            />
            <Stat
              icon="route"
              label={tr("入口", "Entrances")}
              value={entrances.length}
              hint={tr(
                `直连 ${entrances.filter((e) => e.kind === "direct").length} · 中转 ${entrances.filter((e) => e.kind === "relay").length}`,
                `${entrances.filter((e) => e.kind === "direct").length} direct · ${entrances.filter((e) => e.kind === "relay").length} relays`,
              )}
            />
            <Stat
              icon="eyeOff"
              label={tr("探测失败已隐藏", "Hidden (probe failed)")}
              value={entrances.filter((e) => e.hidden_since).length}
              tone={entrances.some((e) => e.hidden_since) ? "danger" : undefined}
            />
          </>
        )}
      </div>
      <div className="mb-3">
        <Input
          type="search"
          className="h-8 w-full sm:w-72"
          aria-label={tr("搜索服务器或节点", "Search servers or nodes")}
          placeholder={tr("搜索服务器或节点…", "Search servers or nodes…")}
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
            icon="server"
            title={tr("还没有服务器", "No servers yet")}
            description={tr(
              "添加一台服务器，复制一行安装命令到机器上执行，然后在上面添加节点。",
              "Add a server, run the one-line install command on it, then add nodes.",
            )}
            action={
              <Button variant="primary" icon="plus" onClick={() => setQuery({ new: "node" }, false)}>
                {tr("添加节点", "Add node")}
              </Button>
            }
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
      {creating === "node" && (
        <CreateNodeDialog
          servers={list}
          groups={groups.data ?? []}
          onClose={() => setQuery({ new: null })}
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
      {kind === "server" && openId && <ServerDrawer id={openId} onClose={() => setQuery({ open: null })} />}
      {kind === "node" && openId && <NodeDrawer id={openId} onClose={() => setQuery({ open: null })} />}
      {kind === "entrance" &&
        openId &&
        (() => {
          const f = findEntrance(openId);
          return f ? (
            <EntranceDrawer
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
  const [state, tone] = serverState(s, tr);
  const hb = s.heartbeat;
  const q = s.traffic_quota;
  const qp = q.bytes ? pct(q.used_bytes, q.bytes) : null;
  const certDays = s.cert_not_after ? Math.floor((Date.parse(s.cert_not_after) - Date.now()) / 86_400_000) : null;
  const removeServer = async () => {
    const ok = await confirm({
      title: tr(`删除服务器 ${s.name}？`, `Delete server ${s.name}?`),
      impact: tr(
        `将同时删除 ${s.nodes.length} 个节点及其入口`,
        `Its ${s.nodes.length} nodes and their entrances go too`,
      ),
      description: tr(
        "agent 先收到空配置，随后吊销证书并删除。",
        "The agent gets the empty state first; then the certificates are revoked and it is deleted.",
      ),
      typeToConfirm: s.name,
      action: () => del(`/servers/${s.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("删除已开始", "Deletion started") });
  };
  return (
    <section aria-label={s.name}>
      <Card>
        <div className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Dot
                tone={
                  tone === "success" ? "success" : tone === "info" ? "info" : tone === "neutral" ? "neutral" : "danger"
                }
              />
              <button
                type="button"
                className="font-semibold hover:underline"
                onClick={() => setQuery({ open: `server:${s.id}` }, false)}
              >
                {s.name}
              </button>
              <Badge tone={tone}>{state}</Badge>
              {s.agent_version && (
                <Badge tone="outline">
                  agent {s.agent_version}
                  {s.agent_os ? ` · ${s.agent_os}/${s.agent_arch}` : ""}
                </Badge>
              )}
              {s.alerts_firing > 0 && (
                <Badge tone="danger">{tr(`${s.alerts_firing} 条告警`, `${s.alerts_firing} alerts`)}</Badge>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {s.tls_domain && <span>{s.tls_domain}</span>}
              {s.agent_addr && <span className="font-mono">{s.agent_addr}</span>}
              {certDays !== null && <span>{tr(`证书剩余 ${certDays} 天`, `certificate ${certDays} days left`)}</span>}
              {hb && (
                <span>
                  CPU {hb.cpu_percent?.toFixed(0) ?? "?"}% · {tr("内存", "mem")}{" "}
                  {hb.mem_total_bytes ? pct(hb.mem_used_bytes ?? 0, hb.mem_total_bytes) : "?"}% · ↓{" "}
                  {bytes(hb.metrics?.net_rx_bytes_per_sec ?? null)}/s ↑{" "}
                  {bytes(hb.metrics?.net_tx_bytes_per_sec ?? null)}
                  /s
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
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" onClick={() => onDialog({ kind: "quota", server: s })} icon="gauge">
              {tr("流量额度", "Quota")}
            </Button>
            <RowMenu label={tr(`服务器 ${s.name} 的操作`, `Actions of ${s.name}`)}>
              {(close) => (
                <>
                  <MenuItem icon="activity" onClick={() => (close(), setQuery({ open: `server:${s.id}` }, false))}>
                    {tr("状态与测速", "Status and latency")}
                  </MenuItem>
                  <MenuItem icon="settings" onClick={() => (close(), onDialog({ kind: "edit", server: s }))}>
                    {tr("编辑服务器", "Edit server")}
                  </MenuItem>
                  <MenuItem icon="bell" onClick={() => (close(), onDialog({ kind: "alerts", server: s }))}>
                    {tr("告警规则", "Alert rules")}
                  </MenuItem>
                  <MenuItem
                    icon="download"
                    onClick={() => (close(), onDialog({ kind: "install", shown: { server: s, mode: "install" } }))}
                  >
                    {s.enrolled ? tr("重装命令", "Reinstall command") : tr("安装命令", "Install command")}
                  </MenuItem>
                  <MenuItem
                    icon="file"
                    onClick={() => (close(), onDialog({ kind: "install", shown: { server: s, mode: "bootstrap" } }))}
                  >
                    {tr("手动引导文件", "Manual bootstrap file")}
                  </MenuItem>
                  <MenuItem icon="plus" onClick={() => (close(), setQuery({ new: "node", server: s.id }, false))}>
                    {tr("在此服务器上添加节点", "Add a node here")}
                  </MenuItem>
                  <MenuItem
                    icon="trash"
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
        <div className="space-y-2 px-4 pt-3 sm:px-5">
          {qp !== null && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-24 shrink-0">{tr("流量额度", "Quota")}</span>
              <Progress value={qp} tone={q.exceeded_at ? "danger" : usageTone(qp)} className="flex-1" />
              <span className="tabular-nums">
                {bytes(q.used_bytes)} / {bytes(q.bytes)} ·{" "}
                {q.mode === "both" ? tr("双向", "both") : q.mode === "up" ? tr("仅上行", "up") : tr("仅下行", "down")}
                {q.reset_day ? tr(` · 每月 ${q.reset_day} 日重置`, ` · resets on day ${q.reset_day}`) : ""}
              </span>
            </div>
          )}
          {q.exceeded_at && (
            <Callout tone="danger" title={tr("已超额", "Over quota")}>
              {tr(
                "上面所有节点已下发空配置，下个周期或调高额度后自动恢复。",
                "Every node on it gets the empty state until the next period or a higher quota.",
              )}
            </Callout>
          )}
          {s.last_error && (
            <Callout tone="danger" title={tr("配置应用失败", "Apply failed")}>
              {s.last_error}
            </Callout>
          )}
          {s.warnings.length > 0 && (
            <Callout tone="warning">
              <ul className="list-disc pl-4">
                {s.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
        </div>
        {s.nodes.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted-foreground">
            {tr("这台服务器上还没有节点。", "No nodes on this server yet.")}
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-border border-t border-border">
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
        )}
      </Card>
    </section>
  );
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
  const lang = useLang();
  const confirm = useConfirm();
  const [run] = useRun();
  const [expanded, setExpanded] = useState(true);
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
        invalidate: [["servers"]],
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
    if (ok)
      await run(() => patch(`/nodes/${n.id}`, { enabled: !n.enabled }), {
        ok: tr("已保存", "Saved"),
        invalidate: [["servers"]],
      });
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
    if (ok) void run(async () => undefined, { ok: tr("节点已删除", "Node deleted"), invalidate: [["servers"]] });
  };
  return (
    <li data-node={n.name}>
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px] sm:px-5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={tr("展开入口", "Show entrances")}
          onClick={() => setExpanded((v) => !v)}
          className="text-muted-foreground"
        >
          <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} />
        </button>
        <button
          type="button"
          className="min-w-0 text-left font-medium hover:underline"
          onClick={() => setQuery({ open: `node:${n.id}` }, false)}
        >
          {n.display_name || n.name}
          {n.display_name && <span className="ml-1 text-xs text-muted-foreground">({n.name})</span>}
        </button>
        <Badge tone="outline">
          {n.protocol ?? tr("无入站", "no inbound")}
          {n.port ? ` :${n.port}` : ""}
        </Badge>
        {n.region && <span className="text-xs text-muted-foreground">{n.region}</span>}
        {!n.enabled && <Badge>{tr("已停用", "Disabled")}</Badge>}
        {!n.visible && <Badge tone="outline">{tr("对用户隐藏", "Hidden from users")}</Badge>}
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
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
              <MenuItem icon="settings" onClick={() => (close(), setQuery({ open: `node:${n.id}` }, false))}>
                {tr("编辑节点与入站", "Edit node and inbound")}
              </MenuItem>
              <MenuItem icon="route" onClick={() => (close(), onRelay())}>
                {tr("添加中转入口", "Add relay entrance")}
              </MenuItem>
              <MenuItem icon={n.enabled ? "pause" : "play"} onClick={() => (close(), void toggleEnabled())}>
                {n.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
              </MenuItem>
              <MenuItem icon="trash" danger onClick={() => (close(), void remove())}>
                {tr("删除节点", "Delete node")}
              </MenuItem>
            </>
          )}
        </RowMenu>
      </div>
      {expanded && (
        <div className="scroll-thin overflow-x-auto px-4 pb-3 sm:px-5">
          <table className="w-full min-w-[640px] text-[12.5px]">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1.5 font-medium">{tr("入口", "Entrance")}</th>
                <th className="py-1.5 font-medium">{tr("连接地址", "Dial")}</th>
                <th className="py-1.5 font-medium">{tr("倍率", "Multiplier")}</th>
                <th className="py-1.5 font-medium">{tr("节点组", "Groups")}</th>
                <th className="py-1.5 font-medium">{tr("TCP 探测", "TCP probe")}</th>
                <th className="py-1.5 font-medium">{tr("订阅中", "In subscriptions")}</th>
              </tr>
            </thead>
            <tbody>
              {n.entrances.map((e) => {
                const [h, ht] = healthText(e, tr, lang);
                const [st, stt] = entranceState(e, tr);
                const ov = overlaps(e.rate_rules).length > 0;
                return (
                  <tr
                    key={e.id}
                    data-entrance={e.id}
                    className="cursor-pointer border-t border-border hover:bg-subtle"
                    onClick={() => setQuery({ open: `entrance:${e.id}` }, false)}
                  >
                    <td className="py-1.5">
                      <span className="flex items-center gap-1.5">
                        <Icon
                          name={e.kind === "direct" ? "zap" : "route"}
                          size={13}
                          className="text-muted-foreground"
                        />
                        {e.name}
                        {e.kind === "relay" && <Badge tone="info">{tr("中转", "relay")}</Badge>}
                      </span>
                    </td>
                    <td className="py-1.5 font-mono">
                      {e.connect_host ?? server.tls_domain ?? "—"}:{e.connect_port ?? n.port ?? "—"}
                      {e.kind === "relay" && (
                        <span className="ml-1 text-muted-foreground">
                          → :{e.listen_port} ·{" "}
                          {tr(`${e.source_cidrs.length} 个出口`, `${e.source_cidrs.length} egress`)}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5">
                      <span className="flex items-center gap-1">
                        {rateText(Math.round(e.rate_now * 1000))}
                        {e.rate_now !== e.rate && (
                          <span className="text-muted-foreground">
                            ({tr("基础", "base")} {rateText(e.rate_permille)})
                          </span>
                        )}
                        {e.rate_rules.length > 0 && (
                          <Badge tone="outline">
                            <Icon name="clock" size={11} />
                            {e.rate_rules.length}
                          </Badge>
                        )}
                        {ov && (
                          <Icon
                            name="alert"
                            size={13}
                            className="text-warning"
                            aria-label={tr("时段重叠", "Overlapping windows")}
                          />
                        )}
                      </span>
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {e.group_ids.map((g) => groupName.get(g) ?? g.slice(0, 6)).join(", ") || "—"}
                    </td>
                    <td className="py-1.5">
                      <Badge tone={ht}>{h}</Badge>
                    </td>
                    <td className="py-1.5">
                      <Badge tone={stt} dot>
                        {st}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {n.entrances.some((e) => e.hidden_since) && (
            <div className="mt-2">
              <Callout tone="danger">
                {tr(
                  `中转入口探测失败（自 ${dateOnly(n.entrances.find((e) => e.hidden_since)?.hidden_since)}）：已从订阅隐藏并已告警，恢复后自动显示。`,
                  `A relay entrance fails its probe (since ${dateOnly(n.entrances.find((e) => e.hidden_since)?.hidden_since)}): hidden from subscriptions and alerted; it comes back automatically.`,
                )}
              </Callout>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
