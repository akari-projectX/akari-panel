// One server's workbench (/nodes/<server id>, v2 proposal §4 服务器页):
// header (status, TLS domain, address; 立即测速 with its cooldown, the install
// command, a menu), the facts card, its problems (over quota, offline, last
// error, warnings — Chinese title, one line, raw text on demand), then tabs
// (`?tab=`): 节点与入口 (node cards with their entrance tables), 监控
// (machine, latency, history, node traffic), 流量额度, 告警规则, 设置.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Ellipsis,
  Gauge,
  KeyRound,
  Layers,
  Pencil,
  Plus,
  Power,
  Radar,
  RefreshCw,
  Server,
  Settings2,
  ShieldBan,
  Terminal,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { del, get, patch, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { ago, bytes, dateOnly, dateTime, daysBefore, duration, pct, siteToday } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader, Group, Row } from "../../shared/ui/card";
import { LineChart, timeLabels } from "../../shared/ui/charts";
import { useConfirm } from "../../shared/ui/confirm";
import { Checkbox, Field, Input, Segmented, Select, Switch, SwitchField } from "../../shared/ui/form";
import { Banner, KV } from "../../shared/ui/layout";
import { Menu, MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { Meter } from "../../shared/ui/meter";
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";
import { FixCount, IconBadge, WarningItem } from "../components/kit";
import { AffixInput, RadioCards, numErr } from "../components/inputs";
import {
  KindIcon,
  Probe,
  RateCell,
  SubState,
  WhitelistState,
  certDays,
  entranceCount,
  entranceLatency,
  inboundLine,
  latencyRows,
  mbps,
  memPct,
  whitelistOf,
} from "../components/nodes-bits";
import { ServerStatus, serverStateOf } from "../components/status";
import { useAction } from "../data";
import { navigate, useQS } from "../router";
import { holdersOf, useGroups, usePlanList, useServers } from "../servers";
import { useCrumb } from "../session";
import type { ServerNode, ServerView } from "../types";
import { alertKindName, ALERT_KINDS } from "./node-common";
import { warningTitle } from "./node-common";
import { useUpdateStatus } from "./update-status";

type Tab = "nodes" | "monitor" | "quota" | "alerts" | "settings";
const TABS: Tab[] = ["nodes", "monitor", "quota", "alerts", "settings"];
/** The panel's built-in probe cooldown (nodestat.rs, 30 s). */
const PROBE_COOLDOWN = 30;

export function ServerPage({ id }: { id: string }) {
  const tr = useTr();
  const servers = useServers();
  const s = servers.data?.find((x) => x.id === id);
  useCrumb(s?.name ?? null);
  if (servers.isPending)
    return (
      <div role="status" aria-label={tr("加载中", "Loading")} className="grid gap-4">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  if (servers.isError && !servers.data)
    return (
      <Card>
        <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />
      </Card>
    );
  if (!s)
    return (
      <>
        <BackLink />
        <Card>
          <EmptyState
            icon={Server}
            title={tr("找不到这台服务器", "Server not found")}
            description={tr("它可能已被删除。", "It may have been deleted.")}
            action={
              <Button asChild>
                <Link to="/nodes">{tr("返回节点", "Back to nodes")}</Link>
              </Button>
            }
          />
        </Card>
      </>
    );
  return <ServerBody s={s} />;
}

function BackLink() {
  const tr = useTr();
  return (
    <Link
      to="/nodes"
      className="hit-44 mb-2 inline-flex items-center gap-0.5 text-body font-medium text-primary hover:underline"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      {tr("节点", "Nodes")}
    </Link>
  );
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Delete a server: the impact, the name typed; then back to the fleet. */
export function useDeleteServer() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const groups = useGroups();
  const plans = usePlanList();
  return async (s: ServerView) => {
    const ents = s.nodes.flatMap((n) => n.entrances);
    const relays = ents.filter((e) => e.kind === "relay").length;
    const users =
      groups.data && plans.data
        ? holdersOf(
            ents.map((e) => e.id),
            groups.data,
            plans.data,
          )
        : null;
    const ok = await confirm({
      title: tr(`删除服务器「${s.name}」？`, `Delete server "${s.name}"?`),
      description: tr(
        "agent 先收到空配置，随后证书吊销，其上的节点和入口一起删除，订阅里对应线路立即消失。历史流量记录保留。此操作不可撤销。",
        "The agent gets the empty configuration, then its certificate is revoked and its nodes and entrances are deleted; their lines leave subscriptions at once. Traffic history is kept. This cannot be undone.",
      ),
      impacts: [
        {
          label: tr("同时删除的节点", "Nodes deleted with it"),
          value: s.nodes.map((n) => n.name).join(tr("、", ", ")) || tr("无", "none"),
        },
        {
          label: tr("同时删除的入口", "Entrances deleted with it"),
          value: tr(`${ents.length} 个（中转 ${relays}）`, `${ents.length} (${relays} relays)`),
        },
        ...(users === null
          ? []
          : [
              {
                label: tr("受影响用户（按套餐估算）", "Users affected (from the plans)"),
                value: users.toLocaleString(),
              },
            ]),
        ...(s.heartbeat?.metrics
          ? [{ label: tr("当前在线用户", "Online now"), value: s.heartbeat.metrics.online_users }]
          : []),
      ],
      typeToConfirm: s.name,
      confirmLabel: tr("删除服务器", "Delete server"),
      action: () => del(`/servers/${s.id}`),
    });
    if (ok) {
      toast({
        tone: "success",
        title: tr("删除已开始", "Deletion started"),
        description: tr(
          "列表已更新；agent 吊销后自动完成",
          "The list is updated; it completes once the agent is revoked",
        ),
      });
      navigate("/nodes");
    }
  };
}

const QUOTA_WARNING = "流量额度已用完"; // i18n-ok: agent warning text matched as data, never shown

function ServerBody({ s }: { s: ServerView }) {
  const tr = useTr();
  const lang = useLang();
  const [qs, patchQs] = useQS();
  const [run, probing] = useAction();
  const remove = useDeleteServer();
  const updates = useUpdateStatus();
  const now = useNow();
  const tabParam = qs.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "nodes";
  const setTab = (t: Tab) => patchQs({ tab: t === "nodes" ? null : t });
  const st = serverStateOf(s);
  const hb = st === "online" ? s.heartbeat : null;
  const q = s.traffic_quota;
  const qp = q.bytes ? pct(q.used_bytes, q.bytes) : null;
  const days = certDays(s);
  const newer = updates.data?.update_available;
  const canUpdate = !!newer && !!s.agent_version && s.agent_version !== newer;
  const since = s.probe_requested_at ? Math.floor((now - Date.parse(s.probe_requested_at)) / 1000) : null;
  const cooling = since !== null && since >= 0 && since < PROBE_COOLDOWN ? PROBE_COOLDOWN - since : 0;
  const lease = s.lease_expires_at ? Math.max(0, Math.round((Date.parse(s.lease_expires_at) - now) / 1000)) : null;
  const rules = useQuery({
    queryKey: ["servers", s.id, "alert-rules"],
    queryFn: () => get<AlertRules>(`/servers/${s.id}/alert-rules`),
  });
  const overrides = rules.data
    ? THRESHOLDS.filter(([k]) => rules.data![k] !== null).length +
      rules.data.disabled.length +
      (rules.data.muted ? 1 : 0)
    : 0;
  // The quota card already says the quota is used up: drop the agent's warning text for it.
  const warnings = s.warnings.filter((w) => !(q.exceeded_at && w.includes(QUOTA_WARNING)));
  return (
    <>
      <BackLink />
      <header className="mb-5 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
          <IconBadge icon={Server} tone="neutral" className="size-12 rounded-[12px]" />
          <div className="min-w-0">
            <h1 className="truncate text-title2 font-bold tracking-[-0.02em] sm:text-title1">{s.name}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
              <ServerStatus state={st} />
              {s.tls_domain && <span className="font-mono text-footnote">{s.tls_domain}</span>}
              {s.agent_addr && <span className="font-mono text-footnote text-faint">{s.agent_addr}</span>}
            </div>
          </div>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {s.enrolled && (
            <Button
              variant="outline"
              icon={Radar}
              loading={probing}
              disabled={cooling > 0 || st !== "online"}
              title={cooling > 0 ? tr("每 30 秒最多测一次", "At most one test per 30 s") : undefined}
              onClick={() =>
                void run(() => post(`/servers/${s.id}/probe`), {
                  ok: tr("已请求测速，结果稍后出现", "Test requested; results follow shortly"),
                })
              }
            >
              {cooling > 0 ? (
                <span className="tnum">{tr(`${cooling} 秒后可再测`, `Again in ${cooling} s`)}</span>
              ) : (
                tr("立即测速", "Test now")
              )}
            </Button>
          )}
          <Button
            variant={s.enrolled ? "outline" : "primary"}
            icon={Terminal}
            onClick={() => patchQs({ action: "install" })}
          >
            <span className={cn(s.enrolled && "max-sm:sr-only")}>{tr("安装命令", "Install command")}</span>
          </Button>
          <Menu
            label={tr(`服务器 ${s.name} 的操作`, `Actions of ${s.name}`)}
            trigger={
              <Button
                variant="outline"
                size="icon"
                icon={Ellipsis}
                aria-label={tr(`服务器 ${s.name} 的操作`, `Actions of ${s.name}`)}
              />
            }
          >
            <MenuItem icon={Pencil} onClick={() => setTab("settings")}>
              {tr("编辑服务器", "Edit server")}
            </MenuItem>
            <MenuItem icon={Plus} onClick={() => patchQs({ new: "node", server: s.id })}>
              {tr("在此服务器添加节点", "Add a node here")}
            </MenuItem>
            <MenuItem icon={Bell} onClick={() => setTab("alerts")}>
              {tr("告警规则", "Alert rules")}
            </MenuItem>
            <MenuItem icon={KeyRound} onClick={() => patchQs({ action: "enroll" })}>
              {tr("重新生成注册令牌", "New enrollment token")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} danger disabled={!!s.deleting_at} onClick={() => void remove(s)}>
              {tr("删除服务器", "Delete server")}
            </MenuItem>
          </Menu>
        </div>
      </header>

      <Card className="mb-4 p-4">
        <KV
          cols={4}
          items={[
            {
              k: tr("最后心跳", "Last heartbeat"),
              v: (
                <span className={cn(st === "offline" && "text-destructive")}>
                  {s.heartbeat ? ago(s.heartbeat.ts, lang) : s.last_seen_at ? ago(s.last_seen_at, lang) : "—"}
                </span>
              ),
            },
            {
              k: tr("租约剩余", "Lease left"),
              v:
                lease === null ? (
                  "—"
                ) : (
                  <span className={cn("tnum", lease === 0 && "text-destructive")}>
                    {lease === 0 ? tr("已过期", "Expired") : duration(lease, lang)}
                  </span>
                ),
            },
            {
              k: "agent",
              v: s.agent_version ? (
                <span className="inline-flex items-center gap-1.5">
                  {s.agent_version}
                  {s.agent_os && (
                    <span className="font-normal text-muted-foreground">
                      {s.agent_os}/{s.agent_arch}
                    </span>
                  )}
                  {canUpdate && (
                    <Link to="/updates">
                      <Badge tone="primary" title={tr(`可更新到 ${newer}`, `${newer} available`)}>
                        {tr("可更新", "Update")}
                      </Badge>
                    </Link>
                  )}
                </span>
              ) : (
                <span className="text-faint">{tr("未安装", "Not installed")}</span>
              ),
            },
            {
              k: tr("证书剩余", "Certificate"),
              v:
                days !== null && s.enrolled ? (
                  <span className={cn("tnum", days < 14 && "text-warning")}>{tr(`${days} 天`, `${days} d`)}</span>
                ) : (
                  "—"
                ),
            },
            {
              k: tr("节点 / 入口", "Nodes / entrances"),
              v: (
                <span className="tnum">
                  {s.nodes.length} / {entranceCount(s)}
                </span>
              ),
            },
            { k: tr("运行时长", "Uptime"), v: hb ? duration(hb.uptime_seconds ?? null, lang) : "—" },
            {
              k: tr("当前连接", "Connections"),
              v: <span className="tnum">{hb ? hb.connections.toLocaleString() : "—"}</span>,
            },
            {
              k: tr("本周期额度", "This period"),
              v:
                qp === null ? (
                  tr("不限", "No quota")
                ) : (
                  <span className={cn("tnum", q.exceeded_at && "text-destructive")}>
                    {qp}%
                    {q.next_reset_at
                      ? tr(
                          ` · ${dateOnly(q.next_reset_at).slice(5)} 重置`,
                          ` · resets ${dateOnly(q.next_reset_at).slice(5)}`,
                        )
                      : ""}
                  </span>
                ),
            },
          ]}
        />
      </Card>

      <div className="mb-4 grid gap-2 empty:hidden">
        {q.exceeded_at && (
          <Banner
            tone="danger"
            icon={<Gauge />}
            title={tr("本周期流量额度已用完。", "This period's quota is used up.")}
            action={
              <Button size="sm" variant="primary" onClick={() => setTab("quota")}>
                {tr("调整额度", "Adjust quota")}
              </Button>
            }
          >
            {tr(
              "此服务器上的所有节点已下发空配置，入口在订阅里隐藏。重置后自动恢复；调高额度可立即恢复。",
              "Every node here has the empty configuration and its entrances are hidden. It comes back at the reset, or at once with a higher quota.",
            )}
          </Banner>
        )}
        {st === "offline" && (
          <WarningItem
            tone="danger"
            title={tr("agent 离线", "The agent is offline")}
            at={
              s.last_seen_at
                ? tr(`最后心跳 ${ago(s.last_seen_at, lang)}`, `last seen ${ago(s.last_seen_at, lang)}`)
                : undefined
            }
            desc={
              lease
                ? tr(
                    `租约还剩 ${duration(lease, lang)}：到期前 agent 按上一份配置继续服务。`,
                    `${duration(lease, lang)} of lease left: the agent keeps serving its last configuration until then.`,
                  )
                : tr(
                    "租约已到期。检查服务器网络与 agent 服务状态。",
                    "The lease has expired. Check the server's network and the agent service.",
                  )
            }
          />
        )}
        {s.last_error && (
          <WarningItem
            tone="danger"
            title={tr("配置应用失败", "Apply failed")}
            at={s.last_error_at ? dateTime(s.last_error_at) : undefined}
            desc={tr(
              "agent 没能应用最新配置，仍在运行上一份配置。常见原因：端口被占用、证书文件缺失、入站参数不被这个版本支持。",
              "The agent could not apply the latest configuration and keeps running the previous one. Usual causes: a port in use, a missing certificate file, a setting this version does not support.",
            )}
            raw={s.last_error}
          />
        )}
        {warnings.map((w) => (
          <WarningItem key={w} title={warningTitle(w, tr)} raw={w} />
        ))}
      </div>

      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        label={tr("服务器", "Server")}
        tabs={[
          { value: "nodes", label: tr("节点与入口", "Nodes and entrances"), count: entranceCount(s) },
          { value: "monitor", label: tr("监控", "Monitor") },
          {
            value: "quota",
            label: (
              <>
                {tr("流量额度", "Quota")}
                {q.exceeded_at && (
                  <span className="size-1.5 rounded-full bg-destructive" aria-label={tr("已超额", "over")} />
                )}
              </>
            ),
          },
          {
            value: "alerts",
            label: (
              <>
                {tr("告警规则", "Alert rules")}
                {overrides > 0 && (
                  <span className="text-faint">{tr(`覆盖 ${overrides}`, `${overrides} overrides`)}</span>
                )}
              </>
            ),
          },
          { value: "settings", label: tr("设置", "Settings") },
        ]}
      />
      {tab === "nodes" && <NodesTab s={s} />}
      {tab === "monitor" && <MonitorTab s={s} />}
      {tab === "quota" && <QuotaTab key={`${s.id}-${q.bytes}-${q.mode}-${q.reset_day}`} s={s} />}
      {tab === "alerts" && <AlertsTab s={s} />}
      {tab === "settings" && <SettingsTab s={s} />}
    </>
  );
}

/* ================= 节点与入口 ================= */

function NodesTab({ s }: { s: ServerView }) {
  const tr = useTr();
  const [, patchQs] = useQS();
  if (!s.enrolled && !s.deleting_at)
    return (
      <Card>
        <EmptyState
          icon={Terminal}
          title={tr("等待 agent 首次连接", "Waiting for the agent")}
          description={tr(
            "在服务器上以 root 执行安装命令。agent 连上后这里会显示机器状态。命令丢了可以重新生成，旧命令会立即失效。",
            "Run the install command on the server as root. Once the agent connects the machine shows up here. A lost command can be issued again; the old one stops working.",
          )}
          action={
            <>
              <Button variant="primary" icon={Terminal} onClick={() => patchQs({ action: "install" })}>
                {tr("查看安装命令", "Install command")}
              </Button>
              <Button variant="ghost" icon={Plus} onClick={() => patchQs({ new: "node", server: s.id })}>
                {tr("先建节点", "Add a node first")}
              </Button>
            </>
          }
        />
      </Card>
    );
  return (
    <div className="grid gap-4">
      {s.nodes.length === 0 && (
        <p className="px-1 text-body text-muted-foreground">
          {tr("这台服务器上还没有节点。", "No nodes on this server yet.")}
        </p>
      )}
      {s.nodes.map((n) => (
        <NodeCard key={n.id} n={n} s={s} />
      ))}
      <button
        type="button"
        disabled={!!s.deleting_at}
        onClick={() => patchQs({ new: "node", server: s.id })}
        className="flex h-12 items-center justify-center gap-1.5 rounded-xl border border-dashed border-[color-mix(in_srgb,var(--foreground)_18%,transparent)] text-body font-medium text-primary transition-colors hover:bg-primary-soft disabled:opacity-50"
      >
        <Plus className="size-4" aria-hidden="true" />
        {tr("在此服务器添加节点", "Add a node here")}
      </button>
    </div>
  );
}

const ENT_COLS = "sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1.2fr)_108px_100px_84px_16px]";

/** Disable / enable a node (disabling asks first) — node card switch, menu and node dialog. */
export function useToggleNode() {
  const tr = useTr();
  const confirm = useConfirm();
  const [run] = useAction();
  return async (n: Pick<ServerNode, "id" | "name" | "enabled" | "entrances">, online?: number | null) => {
    if (n.enabled) {
      const ok = await confirm({
        title: tr(`停用节点「${n.name}」？`, `Disable node "${n.name}"?`),
        description: tr(
          "节点会下发空配置，在线用户立即断开，其入口从订阅隐藏。再次启用后约 5 秒恢复。",
          "The node gets the empty configuration: online users are cut off and its entrances leave subscriptions. Enabling it again restores it in about 5 s.",
        ),
        impacts: [
          { label: tr("从订阅隐藏的入口", "Entrances hidden"), value: n.entrances.length },
          ...(online != null ? [{ label: tr("服务器当前在线用户", "Online on the server"), value: online }] : []),
        ],
        confirmLabel: tr("停用节点", "Disable node"),
        tone: "warning",
      });
      if (!ok) return;
    }
    await run(() => patch(`/nodes/${n.id}`, { enabled: !n.enabled }), {
      ok: n.enabled ? tr("节点已停用", "Node disabled") : tr("节点已启用", "Node enabled"),
    });
  };
}

/** Delete a node (type its name). */
export function useDeleteNode() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const groups = useGroups();
  const plans = usePlanList();
  return async (n: Pick<ServerNode, "id" | "name" | "entrances">) => {
    const users =
      groups.data && plans.data
        ? holdersOf(
            n.entrances.map((e) => e.id),
            groups.data,
            plans.data,
          )
        : null;
    const ok = await confirm({
      title: tr(`删除节点「${n.name}」？`, `Delete node "${n.name}"?`),
      description: tr(
        "节点的入站与它的全部入口（含中转的派生入站和白名单）都会删除，订阅里对应线路立即消失。服务器本身不受影响。",
        "The node's inbound and all its entrances (relays' derived inbounds and allowlists too) are deleted; their lines leave subscriptions at once. The server stays.",
      ),
      impacts: [
        { label: tr("同时删除的入口", "Entrances deleted with it"), value: n.entrances.length },
        ...(users === null
          ? []
          : [{ label: tr("授权用户（按套餐估算）", "Users with access (from the plans)"), value: users }]),
      ],
      typeToConfirm: n.name,
      confirmLabel: tr("删除节点", "Delete node"),
      action: () => del(`/nodes/${n.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("节点已删除", "Node deleted") });
    return ok;
  };
}

function NodeCard({ n, s }: { n: ServerNode; s: ServerView }) {
  const tr = useTr();
  const lang = useLang();
  const [, patchQs] = useQS();
  const [run] = useAction();
  const toggle = useToggleNode();
  const remove = useDeleteNode();
  const issues = n.entrances.some((e) => !!e.hidden_since || !e.enabled);
  const [open, setOpen] = useState(!(n.entrances.length > 6 && !issues));
  const relays = n.entrances.filter((e) => e.kind === "relay").length;
  const openNode = (ntab?: string) => patchQs({ node: n.id, ntab: ntab ?? null });
  const wl = whitelistOf(s);
  const lat = n.entrances.map((e) => entranceLatency(s, n, e)?.delay_ms).filter((x): x is number => x != null);
  const avg = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const online = s.heartbeat?.metrics?.online_users ?? null;
  const menu = (
    <RowMenu label={tr(`节点 ${n.name} 的操作`, `Actions of ${n.name}`)}>
      {(close) => (
        <>
          <MenuItem icon={Pencil} onClick={() => (close(), openNode())}>
            {tr("编辑节点", "Edit node")}
          </MenuItem>
          <MenuItem icon={Settings2} onClick={() => (close(), openNode("inbound"))}>
            {tr("编辑入站", "Edit inbound")}
          </MenuItem>
          <MenuItem icon={ShieldBan} onClick={() => (close(), openNode("audit"))}>
            {tr("出站拦截与流量", "Blocking and traffic")}
          </MenuItem>
          <MenuItem icon={Plus} onClick={() => (close(), patchQs({ new: "relay", for: n.id }))}>
            {tr("添加中转入口", "Add relay entrance")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Power} onClick={() => (close(), void toggle(n, online))}>
            {n.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
          </MenuItem>
          <MenuItem icon={Trash2} danger onClick={() => (close(), void remove(n))}>
            {tr("删除节点", "Delete node")}
          </MenuItem>
        </>
      )}
    </RowMenu>
  );
  return (
    <section aria-label={n.name} data-node={n.name}>
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3">
          <div className="flex min-w-0 flex-1 basis-72 items-center gap-2">
            <button
              type="button"
              onClick={() => openNode()}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              aria-label={tr(`编辑节点 ${n.name}`, `Edit node ${n.name}`)}
            >
              <IconBadge icon={Layers} size="sm" />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-headline font-semibold">{n.display_name || n.name}</span>
                  {n.display_name && <span className="truncate text-footnote text-muted-foreground">{n.name}</span>}
                  {!n.enabled && <Badge tone="outline">{tr("已停用", "Disabled")}</Badge>}
                  {!n.visible && <Badge>{tr("对用户隐藏", "Hidden from users")}</Badge>}
                </span>
                <span className="block text-footnote text-muted-foreground sm:truncate">
                  {inboundLine(n, tr)}
                  {n.region ? ` · ${n.region}` : ""}
                </span>
              </span>
            </button>
            <span className="sm:hidden">{menu}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 max-sm:w-full">
            <button
              type="button"
              onClick={() => openNode("audit")}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-footnote font-medium ring-1 ring-inset pointer-coarse:h-10",
                n.block_rules_enabled
                  ? "bg-primary-soft text-primary ring-transparent"
                  : "text-muted-foreground ring-border",
              )}
            >
              <ShieldBan className="size-3.5" aria-hidden="true" />
              {n.block_rules_enabled ? tr("出站拦截 开", "Blocking on") : tr("出站拦截 关", "Blocking off")}
            </button>
            <span className="flex min-h-11 items-center gap-2 text-footnote text-muted-foreground sm:min-h-0">
              {tr("启用", "Enabled")}
              <Switch
                checked={n.enabled}
                label={tr(`启用节点 ${n.name}`, `Node ${n.name} enabled`)}
                onChange={() => void toggle(n, online)}
              />
            </span>
            <span className="flex min-h-11 items-center gap-2 text-footnote text-muted-foreground sm:min-h-0">
              {tr("对用户显示", "Shown")}
              <Switch
                checked={n.visible}
                label={tr(`${n.name} 对用户显示`, `${n.name} shown to users`)}
                onChange={(v) =>
                  void run(() => patch(`/nodes/${n.id}`, { visible: v }), {
                    ok: v
                      ? tr("已对用户显示", "Shown to users")
                      : tr("已对用户隐藏（节点照常运行）", "Hidden from users (still serving)"),
                  })
                }
              />
            </span>
            <span className="max-sm:hidden">{menu}</span>
          </div>
        </div>
        <div className="border-t border-separator">
          <div className="flex items-center gap-2 px-4 py-2">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={
                open
                  ? tr(`收起 ${n.name} 的入口`, `Hide entrances of ${n.name}`)
                  : tr(`展开 ${n.name} 的入口`, `Show entrances of ${n.name}`)
              }
              className="hit-44 -ml-1 inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-footnote font-semibold text-muted-foreground hover:text-foreground"
            >
              <ChevronDown
                className={cn("size-4 transition-transform duration-(--dur-fast)", !open && "-rotate-90")}
                aria-hidden="true"
              />
              {tr("入口", "Entrances")}{" "}
              <span className="tnum font-normal">
                {tr(
                  `${n.entrances.length} · 直连 ${n.entrances.length - relays} · 中转 ${relays}`,
                  `${n.entrances.length} · ${n.entrances.length - relays} direct · ${relays} relays`,
                )}
              </span>
            </button>
            {!open && !issues && (
              <span className="tnum truncate text-footnote text-success max-sm:hidden">
                <CircleCheck className="mr-1 inline size-3.5" aria-hidden="true" />
                {avg !== null
                  ? tr(`全部正常 · 平均 ${avg} ms · 全部订阅中`, `All fine · ${avg} ms on average · all listed`)
                  : tr("全部正常 · 全部订阅中", "All fine · all listed")}
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={Plus}
              className="ml-auto text-primary"
              onClick={() => patchQs({ new: "relay", for: n.id })}
            >
              <span className="max-sm:sr-only">{tr("添加中转入口", "Add relay entrance")}</span>
            </Button>
          </div>
          {open && (
            <>
              <div
                className={cn(
                  "hidden h-7 items-center gap-x-4 border-y border-separator bg-window/60 px-4 text-caption font-medium text-muted-foreground sm:grid",
                  ENT_COLS,
                )}
                aria-hidden="true"
              >
                <span className="pl-9">{tr("入口 · 节点组", "Entrance · groups")}</span>
                <span>{tr("连接地址", "Address")}</span>
                <span>{tr("倍率", "Multiplier")}</span>
                <span>{tr("TCP 探测", "TCP probe")}</span>
                <span>{tr("订阅", "Listing")}</span>
                <span />
              </div>
              <ul
                className="divide-y divide-separator max-sm:border-t max-sm:border-separator"
                aria-label={tr(`${n.name} 的入口`, `Entrances of ${n.name}`)}
              >
                {n.entrances.map((e) => (
                  <li key={e.id} data-entrance={e.id}>
                    <button
                      type="button"
                      onClick={() => patchQs({ entrance: e.id })}
                      className={cn(
                        "grid w-full grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                        ENT_COLS,
                        e.hidden_since && "bg-destructive-soft/40",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <KindIcon kind={e.kind} />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-body font-semibold">{e.name}</span>
                            {e.tags.map((t) => (
                              <span key={t} data-entrance-tag>
                                <Badge className="text-caption">{t}</Badge>
                              </span>
                            ))}
                          </span>
                          <span className="flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground">
                            <GroupNames ids={e.group_ids} />
                            {e.kind === "relay" && <WhitelistState w={wl} />}
                          </span>
                        </span>
                      </span>
                      <span className="sm:hidden">
                        <RateCell e={e} />
                      </span>
                      <span className="truncate font-mono text-footnote text-muted-foreground max-sm:col-span-2 max-sm:pl-9">
                        {e.connect_host ?? s.tls_domain ?? "—"}:{e.connect_port ?? n.port ?? "—"}
                      </span>
                      <span className="max-sm:hidden">
                        <RateCell e={e} />
                      </span>
                      <span className="max-sm:pl-9">
                        <Probe e={e} latency={entranceLatency(s, n, e)} />
                      </span>
                      <span className="max-sm:justify-self-end">
                        <SubState e={e} server={s} />
                      </span>
                      <ChevronRight className="size-4 text-faint max-sm:hidden" aria-hidden="true" />
                      {e.hidden_since && (
                        <span className="col-span-full flex items-start gap-1.5 pl-9 text-footnote text-destructive">
                          <Radar className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                          <span>
                            {tr(
                              `TCP 探测连续失败 ${e.health_failures} 次（最近 ${ago(e.health_at, lang)}）：已从订阅隐藏、已告警，恢复后自动显示。`,
                              `The TCP probe failed ${e.health_failures} times in a row (last ${ago(e.health_at, lang)}): hidden from subscriptions and alerted; it comes back on its own.`,
                            )}
                          </span>
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Card>
    </section>
  );
}

function GroupNames({ ids }: { ids: string[] }) {
  const tr = useTr();
  const groups = useGroups();
  if (ids.length === 0) return <span className="text-warning">{tr("不在任何节点组", "In no node group")}</span>;
  const names = ids.map((g) => groups.data?.find((x) => x.id === g)?.name).filter(Boolean);
  return (
    <span className="truncate">
      {names.join(tr("、", ", ")) || tr(`${ids.length} 个节点组`, `${ids.length} groups`)}
    </span>
  );
}

/* ================= 监控 ================= */

type Status = {
  heartbeat: ServerView["heartbeat"];
  latency: { source: string; target: string; delay_ms: number | null; error: string | null; measured_at: string }[];
};
type Point = {
  t: string;
  cpu: number | null;
  mem_used: number | null;
  mem_total: number | null;
  rx_bps: number | null;
  tx_bps: number | null;
};
const RANGES = ["1h", "6h", "24h", "7d", "30d", "90d"] as const;

function Tile({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="tnum rounded-lg bg-window p-3 text-footnote ring-1 ring-border ring-inset">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-1 font-semibold">{children}</div>
    </div>
  );
}

function Usage({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="rounded-lg bg-window p-3 ring-1 ring-border ring-inset">
      <div className="flex justify-between text-footnote text-muted-foreground">
        {label}
        <span className="tnum font-semibold text-foreground">{value === null ? "—" : `${value}%`}</span>
      </div>
      <Meter value={value ?? 0} className="mt-2" label={label} />
    </div>
  );
}

function MonitorTab({ s }: { s: ServerView }) {
  const tr = useTr();
  const lang = useLang();
  const [range, setRange] = useState<(typeof RANGES)[number]>("24h");
  const st = useQuery({
    queryKey: ["servers", s.id, "status"],
    queryFn: () => get<Status>(`/servers/${s.id}/status`),
    refetchInterval: 10_000,
  });
  const m = useQuery({
    queryKey: ["servers", s.id, "metrics", range],
    queryFn: () => get<{ points: Point[] }>(`/servers/${s.id}/metrics?range=${range}`),
  });
  const hb = s.online ? s.heartbeat : null;
  const met = hb?.metrics;
  const disk =
    met?.disk_total_bytes && met.disk_used_bytes != null
      ? Math.round((met.disk_used_bytes / met.disk_total_bytes) * 100)
      : null;
  const pts = m.data?.points ?? [];
  const times = pts.map((p) => p.t);
  const lat = (st.data?.latency ?? latencyRows(s)).filter((l) => l.source === "panel" || l.source === "agent");
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <Card>
          <CardHeader
            title={tr("机器状态", "Machine")}
            description={
              hb
                ? tr(`来自 agent 心跳 · ${ago(hb.ts, lang)}`, `From the agent's heartbeat · ${ago(hb.ts, lang)}`)
                : tr("没有最新心跳", "No recent heartbeat")
            }
            icon={<IconBadge icon={Activity} size="sm" />}
          />
          <div className="grid grid-cols-2 gap-3 px-4 pb-4">
            <Usage label="CPU" value={hb?.cpu_percent != null ? Math.round(hb.cpu_percent) : null} />
            <Usage label={tr("内存", "Memory")} value={hb ? memPct(s) : null} />
            <Usage label={tr("磁盘", "Disk")} value={disk} />
            <Tile label={tr("实时速率", "Live rate")}>
              <span className="flex flex-wrap gap-3">
                <span className="inline-flex items-center gap-0.5">
                  <ArrowUp className="size-3 text-chart-2" aria-label={tr("上行", "Up")} />
                  {mbps(met?.net_tx_bytes_per_sec)}
                </span>
                <span className="inline-flex items-center gap-0.5">
                  <ArrowDown className="size-3 text-chart-1" aria-label={tr("下行", "Down")} />
                  {mbps(met?.net_rx_bytes_per_sec)}
                </span>
              </span>
            </Tile>
            <Tile label={tr("连接 / 在线用户", "Connections / online")}>
              {hb ? `${hb.connections.toLocaleString()} / ${met?.online_users ?? "—"}` : "—"}
            </Tile>
            <Tile label={tr("运行时长 · 平台", "Uptime · platform")}>
              {hb ? duration(hb.uptime_seconds ?? null, lang) : "—"}
              {s.agent_os ? ` · ${s.agent_os}/${s.agent_arch}` : ""}
            </Tile>
          </div>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader
            title={tr("入口延迟", "Entrance latency")}
            description={tr(
              "面板 → 各入口的 TCP 连接耗时与 agent 测速；探测失败的中转自动从订阅隐藏",
              "Panel → each entrance (TCP) and the agent's own tests; failing relays leave subscriptions automatically",
            )}
          />
          {st.isError ? (
            <ErrorState
              compact
              title={tr("延迟数据加载失败", "Could not load latency")}
              error={st.error}
              onRetry={() => void st.refetch()}
            />
          ) : lat.length === 0 ? (
            <p className="px-4 pb-4 text-body text-muted-foreground">{tr("还没有测速结果。", "No results yet.")}</p>
          ) : (
            <table className="w-full text-body">
              <thead>
                <tr className="border-y border-separator text-footnote text-muted-foreground">
                  <th className="h-8 px-4 text-left font-medium">{tr("节点 / 入口", "Node / entrance")}</th>
                  <th className="px-4 text-right font-medium">{tr("延迟", "Latency")}</th>
                  <th className="px-4 text-right font-medium max-sm:hidden">{tr("测于", "Tested")}</th>
                </tr>
              </thead>
              <tbody>
                {lat.map((l) => (
                  <tr key={`${l.source}-${l.target}`} className="border-b border-separator last:border-0">
                    <td className="px-4 py-2">
                      <span className="font-medium">{l.target}</span>{" "}
                      <span className="text-caption text-faint">
                        {l.source === "panel" ? tr("面板 TCP", "panel TCP") : "agent"}
                      </span>
                    </td>
                    <td
                      className={cn("tnum px-4 text-right", l.delay_ms === null && "font-semibold text-destructive")}
                      title={l.error ?? undefined}
                    >
                      {l.delay_ms === null ? tr("失败", "Failed") : `${l.delay_ms} ms`}
                    </td>
                    <td className="tnum px-4 text-right text-faint max-sm:hidden">{ago(l.measured_at, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card>
        <CardHeader
          title={tr("历史", "History")}
          className="flex-wrap"
          actions={
            <Segmented
              size="sm"
              label={tr("时间范围", "Range")}
              value={range}
              onChange={setRange}
              options={RANGES.map((r) => ({ value: r, label: r }))}
            />
          }
        />
        {m.isError ? (
          <ErrorState
            title={tr("监控数据加载失败", "Could not load the history")}
            error={m.error}
            onRetry={() => void m.refetch()}
          />
        ) : m.isPending ? (
          <LoadingBlock rows={6} className="px-4 pb-4" />
        ) : pts.length === 0 ? (
          <p className="px-4 pb-4 text-body text-muted-foreground">
            {tr("这段时间没有机器状态记录。", "No machine records in this range.")}
          </p>
        ) : (
          <div className="grid gap-6 px-4 pb-4 lg:grid-cols-2">
            <LineChart
              title={tr("CPU 与内存（%）", "CPU and memory (%)")}
              times={times}
              {...timeLabels(times)}
              max={100}
              legend="latest"
              format={(v) => `${v.toFixed(0)}%`}
              series={[
                { label: "CPU", values: pts.map((p) => p.cpu), slot: 1 },
                {
                  label: tr("内存", "Memory"),
                  values: pts.map((p) => (p.mem_used != null && p.mem_total ? (p.mem_used / p.mem_total) * 100 : null)),
                  slot: 3,
                },
              ]}
            />
            <LineChart
              title={tr("速率", "Rate")}
              times={times}
              {...timeLabels(times)}
              legend="latest"
              format={(v) => mbps(v)}
              series={[
                { label: tr("下行", "Down"), values: pts.map((p) => p.rx_bps), slot: 1, area: true },
                { label: tr("上行", "Up"), values: pts.map((p) => p.tx_bps), slot: 2, area: true },
              ]}
            />
          </div>
        )}
      </Card>
      {s.nodes.length > 0 && <NodeTrafficCard s={s} />}
    </div>
  );
}

type NodeTraffic = {
  days: { day: string; up_bytes: number; down_bytes: number; billed_bytes: number }[];
  top_users: { user_id: string; email: string | null; billed_bytes: number }[];
};

export function useNodeTraffic(id: string) {
  const to = siteToday();
  const from = daysBefore(to, 29);
  return useQuery({
    queryKey: ["traffic", "node", id],
    queryFn: () => get<NodeTraffic>(`/nodes/${id}/traffic?from=${from}&to=${to}`),
  });
}

/** Raw (solid) vs billed (dashed) per day, the last 30 site days; the top users link to their traffic. */
export function NodeTrafficBody({ id, height = 200, topN = 5 }: { id: string; height?: number; topN?: number }) {
  const tr = useTr();
  const q = useNodeTraffic(id);
  if (q.isError)
    return (
      <ErrorState
        compact
        title={tr("节点流量加载失败", "Could not load the node's traffic")}
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  if (q.isPending) return <LoadingBlock rows={4} />;
  const to = siteToday();
  const all: string[] = [];
  for (let i = 29; i >= 0; i--) all.push(daysBefore(to, i));
  const by = new Map(q.data.days.map((r) => [r.day, r]));
  const times = all.map((d) => `${d}T12:00:00Z`);
  const raw = q.data.days.reduce((a, r) => a + r.up_bytes + r.down_bytes, 0);
  const billed = q.data.days.reduce((a, r) => a + r.billed_bytes, 0);
  const top = q.data.top_users.slice(0, topN);
  const max = top[0]?.billed_bytes || 1;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div>
        <div className="tnum mb-1 text-footnote text-muted-foreground">
          {tr("原始", "Raw")} <b className="text-foreground">{bytes(raw)}</b> · {tr("计费", "Billed")}{" "}
          <b className="text-foreground">{bytes(billed)}</b>
        </div>
        <LineChart
          title={tr("节点每日流量（近 30 天）", "Node traffic per day (30 days)")}
          times={times}
          {...timeLabels(times)}
          height={height}
          legend="total"
          format={bytes}
          series={[
            {
              label: tr("原始", "Raw"),
              values: all.map((d) => (by.get(d) ? by.get(d)!.up_bytes + by.get(d)!.down_bytes : 0)),
              slot: 1,
            },
            {
              label: tr("计费", "Billed"),
              values: all.map((d) => by.get(d)?.billed_bytes ?? 0),
              slot: 4,
              dashed: true,
            },
          ]}
        />
      </div>
      <div>
        <div className="mb-2 text-footnote font-medium text-muted-foreground">
          {tr("用量最高的用户（30 天，计费）", "Top users (30 days, billed)")}
        </div>
        {top.length === 0 ? (
          <p className="text-body text-muted-foreground">{tr("这段时间没有流量。", "No traffic in this period.")}</p>
        ) : (
          <ol className="grid gap-0.5" aria-label={tr("用量最高的用户", "Top users")}>
            {top.map((u, i) => (
              <li key={u.user_id}>
                <Link
                  to={`/users?open=${u.user_id}&tab=traffic`}
                  className="flex min-h-10 items-center gap-2.5 rounded-md px-2 hover:bg-accent"
                >
                  <span className="tnum w-4 text-footnote text-faint">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium">
                      {u.email ?? tr("已删除的用户", "Deleted user")}
                    </span>
                    <span
                      className="mt-1 block h-[3px] rounded-full bg-chart-1/40"
                      style={{ width: `${(u.billed_bytes / max) * 100}%` }}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="tnum text-footnote font-semibold">{bytes(u.billed_bytes)}</span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function NodeTrafficCard({ s }: { s: ServerView }) {
  const tr = useTr();
  const [nodeId, setNodeId] = useState(s.nodes[0]!.id);
  const id = s.nodes.some((n) => n.id === nodeId) ? nodeId : s.nodes[0]!.id;
  return (
    <Card>
      <CardHeader
        title={tr("节点流量", "Node traffic")}
        description={tr(
          "近 30 天每日原始流量与按倍率折算的计费流量",
          "Raw and billed (after multipliers) per day, the last 30 days",
        )}
        className="flex-wrap"
        actions={
          s.nodes.length > 1 ? (
            <Segmented
              size="sm"
              label={tr("节点", "Node")}
              value={id}
              onChange={setNodeId}
              options={s.nodes.map((n) => ({ value: n.id, label: n.name }))}
            />
          ) : undefined
        }
      />
      <div className="px-4 pb-4">
        <NodeTrafficBody id={id} />
      </div>
    </Card>
  );
}

/* ================= 保存栏 ================= */

function SaveBar({
  errors,
  dirty,
  note,
  label,
  busy,
  onReset,
}: {
  errors: number;
  dirty: boolean;
  note?: ReactNode;
  label?: string;
  busy?: boolean;
  onReset: () => void;
}) {
  const tr = useTr();
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-separator bg-[color-mix(in_srgb,var(--window),var(--card)_40%)] px-4 py-3">
      <span className="mr-auto text-footnote text-muted-foreground">{note}</span>
      {errors > 0 ? (
        <FixCount n={errors} />
      ) : dirty ? (
        <span className="text-footnote text-muted-foreground">{tr("有未保存的修改", "Unsaved changes")}</span>
      ) : null}
      <Button variant="ghost" disabled={!dirty || busy} onClick={onReset}>
        {tr("还原", "Revert")}
      </Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
        {label ?? tr("保存", "Save")}
      </Button>
    </div>
  );
}

/* ================= 流量额度 ================= */

const GiB = 1024 ** 3;

function QuotaTab({ s }: { s: ServerView }) {
  const tr = useTr();
  const q = s.traffic_quota;
  const startUnit = q.bytes && q.bytes >= 1024 * GiB && q.bytes % (1024 * GiB) === 0 ? "TiB" : "GiB";
  const start = {
    mode: q.mode,
    amount: q.bytes ? String(+(q.bytes / (startUnit === "TiB" ? 1024 * GiB : GiB)).toFixed(3)) : "",
    unit: startUnit as "GiB" | "TiB",
    day: q.reset_day ? String(q.reset_day) : "",
  };
  const [f, setF] = useState(start);
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const amountErr = f.amount.trim()
    ? !/^\d+(\.\d+)?$/.test(f.amount.trim()) || Number(f.amount) <= 0
      ? tr("请输入大于 0 的数字；留空表示不限额度", "Enter a number above 0; empty = no quota")
      : undefined
    : undefined;
  const dayErr = f.day.trim()
    ? !/^\d+$/.test(f.day.trim()) || +f.day < 1 || +f.day > 31
      ? tr("请输入 1–31 的整数", "Enter a whole number from 1 to 31")
      : undefined
    : undefined;
  const errors = (amountErr ? 1 : 0) + (dayErr ? 1 : 0);
  const newBytes =
    f.amount.trim() && !amountErr ? Math.round(Number(f.amount) * (f.unit === "TiB" ? 1024 * GiB : GiB)) : null;
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  const qp = q.bytes ? pct(q.used_bytes, q.bytes) : null;
  const exceeded = !!q.exceeded_at;
  // A straight-line forecast of 90 % from this period's pace (null when it cannot be told).
  let forecast: string | null = null;
  if (q.bytes && q.period_start && q.used_bytes > 0 && !exceeded) {
    const el = Date.now() - Date.parse(q.period_start);
    const left = q.bytes * 0.9 - q.used_bytes;
    if (el > 3_600_000 && left > 0) {
      const at = Date.now() + (left / q.used_bytes) * el;
      if (!q.next_reset_at || at < Date.parse(q.next_reset_at)) forecast = dateOnly(new Date(at).toISOString());
    }
  }
  const save = async () => {
    setTried(true);
    if (errors) return;
    await run(
      () =>
        patch(`/servers/${s.id}`, {
          traffic_quota_bytes: newBytes,
          traffic_quota_mode: f.mode,
          traffic_quota_reset_day: f.day.trim() ? Number(f.day) : null,
        }),
      { ok: tr("流量额度已保存", "Quota saved") },
    );
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card className="overflow-hidden">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <CardHeader
            title={tr("服务器流量额度", "Server traffic quota")}
            description={tr(
              "按这台机器的网卡流量计（与服务商账单一致），超出后其上所有节点停止服务，直到下个周期或调高额度。与用户套餐流量无关。",
              "Counted from this machine's network interface (like the provider's bill). Over it, every node here stops until the next period or a higher quota. Unrelated to users' plan traffic.",
            )}
          />
          <div className="grid gap-5 px-4 pt-2 pb-5">
            <Field group label={tr("计费方式", "What counts")}>
              <RadioCards
                label={tr("计费方式", "What counts")}
                value={f.mode}
                onChange={(mode) => setF({ ...f, mode })}
                items={[
                  {
                    value: "both",
                    title: tr("双向", "Both ways"),
                    desc: tr("上行 + 下行都计入（多数按量计费 VPS）", "Upload + download (most metered VPS)"),
                  },
                  {
                    value: "up",
                    title: tr("仅上行", "Upload only"),
                    desc: tr("只计出站（服务器发给用户）", "Outbound only (server to users)"),
                  },
                  { value: "down", title: tr("仅下行", "Download only"), desc: tr("只计入站", "Inbound only") },
                ]}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={tr("每周期额度", "Quota per period")}
                error={tried || f.amount ? amountErr : undefined}
                hint={tr("留空 = 不限额度", "Empty = no quota")}
              >
                <div className="flex gap-2">
                  <Input
                    value={f.amount}
                    onChange={(e) => setF({ ...f, amount: e.target.value })}
                    inputMode="decimal"
                    className="tnum"
                    placeholder={tr("不限", "None")}
                  />
                  <Select
                    aria-label={tr("单位", "Unit")}
                    className="w-24 shrink-0"
                    value={f.unit}
                    onChange={(e) => setF({ ...f, unit: e.target.value as "GiB" | "TiB" })}
                  >
                    <option value="GiB">GiB</option>
                    <option value="TiB">TiB</option>
                  </Select>
                </div>
              </Field>
              <Field
                label={tr("每月重置日", "Monthly reset day")}
                error={dayErr}
                hint={tr(
                  "1–31；小月没有的日期按月末重置；留空 = 不重置",
                  "1–31; short months reset on their last day; empty = never",
                )}
              >
                <Input
                  value={f.day}
                  onChange={(e) => setF({ ...f, day: e.target.value })}
                  inputMode="numeric"
                  className="tnum"
                />
              </Field>
            </div>
            {exceeded && newBytes !== null && newBytes > q.used_bytes && (
              <Banner tone="success" icon={<CircleCheck />} title={tr("保存后立即恢复：", "Restored on save:")}>
                {tr(
                  `新额度 ${bytes(newBytes)} 高于本周期已用 ${bytes(q.used_bytes)}，节点会在约 5 秒内重新下发配置，入口回到订阅。`,
                  `The new quota ${bytes(newBytes)} is above this period's ${bytes(q.used_bytes)}; the nodes get their configuration again within about 5 s.`,
                )}
              </Banner>
            )}
            {exceeded && newBytes !== null && newBytes <= q.used_bytes && (
              <Banner tone="warning" icon={<TriangleAlert />}>
                {tr(
                  `新额度仍不高于本周期已用 ${bytes(q.used_bytes)}，保存后服务器继续停用。`,
                  `The new quota is still not above this period's ${bytes(q.used_bytes)}; the server stays stopped.`,
                )}
              </Banner>
            )}
          </div>
          <SaveBar
            errors={tried ? errors : 0}
            dirty={dirty}
            busy={busy}
            onReset={() => (setF(start), setTried(false))}
            note={tr("保存后约 5 秒生效 · 写入审计", "Applies in about 5 s · audited")}
          />
        </form>
      </Card>
      <Card className={cn("h-fit p-4", exceeded && "ring-1 ring-destructive/40 ring-inset")}>
        <div className="text-footnote font-medium text-muted-foreground">
          {tr("本周期已用", "Used this period")} ·{" "}
          {q.mode === "both"
            ? tr("双向", "both ways")
            : q.mode === "up"
              ? tr("仅上行", "upload")
              : tr("仅下行", "download")}
        </div>
        <div className={cn("tnum mt-1 text-title2 font-semibold", exceeded && "text-destructive")}>
          {bytes(q.used_bytes)}
        </div>
        <div className="tnum text-footnote text-muted-foreground">
          {q.bytes ? tr(`共 ${bytes(q.bytes)} · ${qp}%`, `of ${bytes(q.bytes)} · ${qp}%`) : tr("不限额度", "No quota")}
        </div>
        {q.bytes ? <Meter value={qp ?? 0} className="mt-3 h-2" label={tr("额度用量", "Quota usage")} /> : null}
        <div className="tnum mt-2 flex justify-between gap-2 text-caption text-faint">
          <span>
            {q.period_start ? tr(`周期开始 ${dateOnly(q.period_start)}`, `from ${dateOnly(q.period_start)}`) : ""}
          </span>
          <span>
            {q.next_reset_at
              ? tr(`${dateOnly(q.next_reset_at)} 重置`, `resets ${dateOnly(q.next_reset_at)}`)
              : tr("不重置", "never resets")}
          </span>
        </div>
        <div className="tnum mt-1 text-caption text-faint">
          {tr("接收 / 发送", "Rx / tx")} {bytes(q.rx_bytes)} / {bytes(q.tx_bytes)}
        </div>
        {exceeded ? (
          <div className="mt-4 rounded-lg bg-destructive-soft p-3 text-footnote">
            <div className="flex items-center gap-1.5 font-semibold text-destructive">
              <Gauge className="size-4" aria-hidden="true" />
              {tr(
                `已超额 · ${dateTime(q.exceeded_at)} 起停用`,
                `Over quota · stopped since ${dateTime(q.exceeded_at)}`,
              )}
            </div>
            <p className="mt-1 text-foreground/80">
              {tr(
                "节点已下发空配置，用户连接被断开，入口在订阅中隐藏。下个周期或把额度调到高于已用后自动恢复。",
                "The nodes have the empty configuration, users are cut off and the entrances are hidden. It comes back with the next period or a quota above the usage.",
              )}
            </p>
          </div>
        ) : forecast ? (
          <p className="mt-4 text-footnote text-muted-foreground">
            {tr(`按当前速度，预计 ${forecast} 用到 90%。`, `At this pace, 90 % is reached around ${forecast}.`)}
          </p>
        ) : null}
      </Card>
    </div>
  );
}

/* ================= 告警规则 ================= */

type AlertRules = {
  muted: boolean;
  disabled: string[];
  offline_secs: number | null;
  cpu_percent: number | null;
  cpu_minutes: number | null;
  mem_percent: number | null;
  mem_minutes: number | null;
  disk_percent: number | null;
  cert_days: number | null;
};
type NumKey =
  "offline_secs" | "cpu_percent" | "cpu_minutes" | "mem_percent" | "mem_minutes" | "disk_percent" | "cert_days";
/** The panel's ranges (alerts/mod.rs `Thresholds::check`); empty = the global value. */
const THRESHOLDS: [NumKey, number, number][] = [
  ["offline_secs", 30, 86_400],
  ["cpu_percent", 1, 100],
  ["cpu_minutes", 1, 60],
  ["mem_percent", 1, 100],
  ["mem_minutes", 1, 60],
  ["disk_percent", 1, 100],
  ["cert_days", 1, 90],
];

function AlertsTab({ s }: { s: ServerView }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["servers", s.id, "alert-rules"],
    queryFn: () => get<AlertRules>(`/servers/${s.id}/alert-rules`),
  });
  const g = useQuery({
    queryKey: ["alerts", "settings"],
    queryFn: () => get<Partial<Record<NumKey, number | null>>>("/alerts/settings"),
  });
  if (q.isError)
    return (
      <Card>
        <ErrorState
          title={tr("告警规则加载失败", "Could not load the alert rules")}
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      </Card>
    );
  if (!q.data)
    return (
      <Card className="p-4">
        <LoadingBlock rows={5} />
      </Card>
    );
  return <AlertsForm key={JSON.stringify(q.data)} s={s} rules={q.data} globals={g.data ?? {}} />;
}

function AlertsForm({
  s,
  rules,
  globals,
}: {
  s: ServerView;
  rules: AlertRules;
  globals: Partial<Record<NumKey, number | null>>;
}) {
  const tr = useTr();
  const start = {
    muted: rules.muted,
    disabled: rules.disabled,
    text: Object.fromEntries(THRESHOLDS.map(([k]) => [k, rules[k] === null ? "" : String(rules[k])])) as Record<
      NumKey,
      string
    >,
  };
  const [f, setF] = useState(start);
  const [run, busy] = useAction();
  const label: Record<NumKey, [string, string]> = {
    offline_secs: [tr("离线多少秒告警", "Offline after"), tr("秒", "s")],
    cpu_percent: [tr("CPU 高于", "CPU above"), "%"],
    cpu_minutes: [tr("CPU 持续", "CPU for"), tr("分钟", "min")],
    mem_percent: [tr("内存高于", "Memory above"), "%"],
    mem_minutes: [tr("内存持续", "Memory for"), tr("分钟", "min")],
    disk_percent: [tr("磁盘高于", "Disk above"), "%"],
    cert_days: [tr("证书剩余少于", "Certificate under"), tr("天", "d")],
  };
  const errs = THRESHOLDS.map(([k, min, max]) => numErr(f.text[k], tr, { int: true, min, max, allowEmpty: true }));
  const nErr = errs.filter(Boolean).length;
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  const overridden = THRESHOLDS.filter(([k]) => f.text[k].trim()).length;
  const save = async () => {
    if (nErr) return;
    const body: AlertRules = { ...rules, muted: f.muted, disabled: f.disabled };
    for (const [k] of THRESHOLDS) body[k] = f.text[k].trim() ? Number(f.text[k]) : null;
    await run(() => put(`/servers/${s.id}/alert-rules`, body), { ok: tr("告警规则已保存", "Alert rules saved") });
  };
  return (
    <Card className="overflow-hidden">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <CardHeader
          title={tr(`${s.name} 的告警覆盖`, `Alert overrides of ${s.name}`)}
          description={
            <>
              {tr(
                "只对这台服务器生效。留空 = 使用全局设置（输入框里的灰色数字），全局值在 ",
                "This server only. Empty = the global value (the grey number in the box); global values are in ",
              )}
              <Link to="/settings/alerts" className="text-primary hover:underline">
                {tr("设置 → 告警", "Settings → Alerts")}
              </Link>
              {tr(" 修改。", ".")}
            </>
          }
        />
        <div className="grid gap-5 px-4 pt-1 pb-5">
          <div
            className={cn(
              "flex items-center gap-3 rounded-xl px-4 py-3 ring-1 ring-inset",
              f.muted ? "bg-warning-soft ring-transparent" : "bg-window ring-border",
            )}
          >
            {f.muted ? (
              <BellOff className="size-5 text-warning" aria-hidden="true" />
            ) : (
              <Bell className="size-5 text-muted-foreground" aria-hidden="true" />
            )}
            <SwitchField
              className="min-w-0 flex-1"
              checked={f.muted}
              onChange={(muted) => setF({ ...f, muted })}
              label={tr("静音这台服务器", "Mute this server")}
              description={tr(
                "仍然记录告警，但不发送通知。适合维护期间。",
                "Alerts are still recorded but not sent. For maintenance.",
              )}
            />
          </div>
          <Field
            group
            label={tr("关闭的告警种类", "Kinds turned off")}
            hint={tr("勾选的种类在这台服务器上不会触发", "Checked kinds never fire on this server")}
          >
            <div className="flex flex-wrap gap-2">
              {ALERT_KINDS.map((k) => {
                const on = f.disabled.includes(k);
                return (
                  <label
                    key={k}
                    className={cn(
                      "flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-body ring-1 ring-inset pointer-coarse:min-h-11",
                      on ? "bg-secondary text-muted-foreground line-through ring-transparent" : "ring-border",
                    )}
                  >
                    <Checkbox
                      checked={on}
                      label={alertKindName(k, tr)}
                      onChange={(c) =>
                        setF({ ...f, disabled: c ? [...f.disabled, k] : f.disabled.filter((x) => x !== k) })
                      }
                    />
                    {alertKindName(k, tr)}
                  </label>
                );
              })}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {THRESHOLDS.map(([k], i) => {
              const gv = globals[k];
              return (
                <Field
                  key={k}
                  label={label[k][0]}
                  error={errs[i]}
                  hint={
                    f.text[k].trim()
                      ? gv != null
                        ? tr(`全局 ${gv} ${label[k][1]}`, `global ${gv} ${label[k][1]}`)
                        : tr("全局未启用", "off globally")
                      : tr("使用全局", "global value")
                  }
                >
                  <AffixInput
                    suffix={label[k][1]}
                    inputMode="numeric"
                    value={f.text[k]}
                    placeholder={gv != null ? String(gv) : tr("全局", "global")}
                    onChange={(e) => setF({ ...f, text: { ...f.text, [k]: e.target.value } })}
                  />
                </Field>
              );
            })}
          </div>
        </div>
        <SaveBar
          errors={nErr}
          dirty={dirty}
          busy={busy}
          onReset={() => setF(start)}
          note={
            f.muted
              ? tr(
                  `已覆盖 ${overridden} 项、关闭 ${f.disabled.length} 种、已静音`,
                  `${overridden} overridden, ${f.disabled.length} kinds off, muted`,
                )
              : tr(
                  `已覆盖 ${overridden} 项、关闭 ${f.disabled.length} 种`,
                  `${overridden} overridden, ${f.disabled.length} kinds off`,
                )
          }
        />
      </form>
    </Card>
  );
}

/* ================= 设置 ================= */

type DomainCheck = {
  addresses: string[];
  expected: string[];
  matches: boolean | null;
  cloudflare: boolean;
  error: string | null;
};

function useDomainCheck() {
  const tr = useTr();
  const [res, setRes] = useState<{
    text: string;
    tone: "success" | "warning" | "danger" | "info";
    raw?: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async (domain: string, nodeId?: string) => {
    setChecking(true);
    setRes(null);
    try {
      const v = await post<DomainCheck>("/inbound-templates/check-domain", { domain: domain.trim(), node_id: nodeId });
      if (v.error)
        setRes({ text: tr("无法解析这个域名", "The domain does not resolve"), tone: "danger", raw: v.error });
      else if (v.cloudflare)
        setRes({
          text: tr(
            "解析到 Cloudflare（橙云）：自动证书与直连都会失败",
            "Resolves to Cloudflare (proxied): certificates and direct dialing fail",
          ),
          tone: "danger",
        });
      else if (v.matches === false)
        setRes({
          text: tr(
            `未解析到本机（${v.addresses.join(", ")} ≠ ${v.expected.join(", ")}）`,
            `Does not resolve to this server (${v.addresses.join(", ")} ≠ ${v.expected.join(", ")})`,
          ),
          tone: "warning",
        });
      else
        setRes({
          text: tr(`已解析到 ${v.addresses.join(", ")}`, `Resolves to ${v.addresses.join(", ")}`),
          tone: "success",
        });
      return v;
    } catch {
      setRes({ text: tr("检查失败，请稍后重试", "The check failed; try again"), tone: "danger" });
      return null;
    } finally {
      setChecking(false);
    }
  };
  return { res, setRes, checking, check };
}

export function CheckResult({ res }: { res: ReturnType<typeof useDomainCheck>["res"] }) {
  const tr = useTr();
  if (!res) return null;
  const color = {
    success: "text-success",
    warning: "text-warning",
    danger: "text-destructive",
    info: "text-muted-foreground",
  }[res.tone];
  return (
    <span role="status" className={cn("block text-footnote", color)}>
      {res.tone === "success" && <CircleCheck className="mr-1 inline size-3.5" aria-hidden="true" />}
      {res.text}
      {res.raw && (
        <details className="mt-0.5 text-muted-foreground">
          <summary className="cursor-default">{tr("详细信息", "Details")}</summary>
          <span className="font-mono text-caption break-all">{res.raw}</span>
        </details>
      )}
    </span>
  );
}

export { useDomainCheck };

function SettingsTab({ s }: { s: ServerView }) {
  const tr = useTr();
  const [, patchQs] = useQS();
  const confirm = useConfirm();
  const remove = useDeleteServer();
  const start = {
    name: s.name,
    domain: s.tls_domain ?? "",
    cap: s.traffic_max_rate_bytes_per_sec ? String(Math.round(s.traffic_max_rate_bytes_per_sec / 125000)) : "",
  };
  const [f, setF] = useState(start);
  const [run, busy] = useAction();
  const dc = useDomainCheck();
  const nameErr = !f.name.trim() ? tr("名称不能为空", "Enter a name") : undefined;
  const capErr = numErr(f.cap, tr, { int: true, min: 1, max: 10_000_000, allowEmpty: true });
  const errors = (nameErr ? 1 : 0) + (capErr ? 1 : 0);
  const dirty = JSON.stringify(f) !== JSON.stringify(start);
  const tlsChanged = f.domain.trim() !== (s.tls_domain ?? "");
  const ents = entranceCount(s);
  const save = async () => {
    if (errors) return;
    const body: Record<string, unknown> = {};
    if (f.name.trim() !== s.name) body.name = f.name.trim();
    if (tlsChanged) body.tls_domain = f.domain.trim() || null;
    const capBytes = f.cap.trim() ? Number(f.cap) * 125000 : null;
    if (capBytes !== s.traffic_max_rate_bytes_per_sec) body.traffic_max_rate_bytes_per_sec = capBytes;
    if (!Object.keys(body).length) return;
    if (tlsChanged) {
      const v = f.domain.trim() ? await dc.check(f.domain, s.nodes[0]?.id) : null;
      const ok = await confirm({
        title: tr("修改 TLS 域名并重建？", "Change the TLS domain and rebuild?"),
        tone: "warning",
        details: (
          <div className="grid gap-3 text-body">
            <div className="rounded-lg bg-window px-3 py-2 font-mono text-footnote ring-1 ring-border ring-inset">
              <span className="text-muted-foreground line-through">{s.tls_domain ?? tr("（无）", "(none)")}</span> →{" "}
              {f.domain.trim() || tr("（无）", "(none)")}
              {v && !v.error && (
                <div
                  className={cn(
                    "mt-1 font-sans",
                    v.matches === false || v.cloudflare ? "text-warning" : "text-success",
                  )}
                >
                  {v.cloudflare
                    ? tr("解析到 Cloudflare（橙云）", "Resolves to Cloudflare (proxied)")
                    : tr(
                        `新域名解析到 ${v.addresses.join(", ")}`,
                        `The new domain resolves to ${v.addresses.join(", ")}`,
                      )}
                </div>
              )}
              {v?.error && (
                <div className="mt-1 font-sans text-destructive">
                  {tr("新域名无法解析", "The new domain does not resolve")}
                </div>
              )}
            </div>
            <ul className="grid list-disc gap-1 pl-5 text-foreground/85">
              <li>{tr("agent 为新域名自动申请证书", "The agent obtains a certificate for the new domain")}</li>
              <li>
                {tr(
                  `重建其上 ${s.nodes.length} 个节点的入站，在线用户自动重连`,
                  `The inbounds of its ${s.nodes.length} nodes are rebuilt; online users reconnect`,
                )}
              </li>
              <li>
                {tr(
                  "使用该域名的直连入口地址随之改变，用户需更新订阅",
                  "Direct entrances on this domain change address; users refresh their subscription",
                )}
              </li>
            </ul>
          </div>
        ),
        confirmLabel: tr("保存并重建", "Save and rebuild"),
      });
      if (!ok) return;
    }
    await run(() => patch(`/servers/${s.id}`, body), { ok: tr("已保存", "Saved") });
  };
  return (
    <div className="grid max-w-3xl gap-6">
      <Card className="overflow-hidden">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <CardHeader
            title={tr("服务器", "Server")}
            description={tr(
              "名称只在后台显示；TLS 域名用于 agent 证书与直连入口。",
              "The name is for the console; the TLS domain is for the agent's certificate and direct entrances.",
            )}
          />
          <div className="grid gap-4 px-4 pt-1 pb-5 sm:grid-cols-2">
            <Field label={tr("服务器名称", "Server name")} required error={nameErr}>
              <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </Field>
            <Field
              label={tr("计费速率上限", "Billing rate cap")}
              error={capErr}
              hint={tr(
                "上下行合计，超出部分不计费（防止 agent 被攻破后虚报）；按网卡带宽填时填 2 倍。留空 = 默认 10000",
                "Upload + download; bytes above it are not billed (guards against an over-reporting agent); twice the NIC speed. Empty = default 10000",
              )}
            >
              <AffixInput
                suffix="Mbps"
                inputMode="numeric"
                value={f.cap}
                placeholder="10000"
                onChange={(e) => setF({ ...f, cap: e.target.value })}
              />
            </Field>
            <Field
              className="sm:col-span-2"
              label={tr("TLS 域名", "TLS domain")}
              hint={
                tlsChanged ? (
                  <span className="text-warning">
                    {tr(
                      "改域名会重签证书并重建这台服务器上的全部入站，直连用户需要更新订阅。保存前会再确认。",
                      "A new domain means a new certificate and rebuilt inbounds; direct users refresh their subscription. You confirm before saving.",
                    )}
                  </span>
                ) : (
                  tr("留空 = 手动放置证书", "Empty = certificate files by hand")
                )
              }
            >
              <div className="flex gap-2">
                <Input
                  value={f.domain}
                  className="font-mono"
                  onChange={(e) => (setF({ ...f, domain: e.target.value }), dc.setRes(null))}
                />
                <Button
                  icon={RefreshCw}
                  className="shrink-0"
                  disabled={!f.domain.trim()}
                  loading={dc.checking}
                  onClick={() => void dc.check(f.domain, s.nodes[0]?.id)}
                >
                  {tr("检查解析", "Check DNS")}
                </Button>
              </div>
            </Field>
            <div className="sm:col-span-2 empty:hidden">
              <CheckResult res={dc.res} />
            </div>
          </div>
          <SaveBar
            errors={errors}
            dirty={dirty}
            busy={busy}
            onReset={() => (setF(start), dc.setRes(null))}
            label={tlsChanged ? tr("保存并重建…", "Save and rebuild…") : undefined}
          />
        </form>
      </Card>

      <Group
        title={tr("安装与注册", "Install and enrollment")}
        footer={
          <>
            {tr("安装脚本来源、镜像与默认参数在 ", "Install sources, mirrors and defaults are in ")}
            <Link to="/settings/install" className="text-primary hover:underline">
              {tr("设置 → 安装", "Settings → Install")}
            </Link>
            {tr("。", ".")}
          </>
        }
      >
        <Row
          label={tr("安装命令", "Install command")}
          description={tr(
            "重装系统或换机器时用。生成新命令后旧命令立即失效，只显示一次。",
            "For a reinstall or a new machine. A new command replaces the old one; it is shown once.",
          )}
          icon={<Terminal className="size-4 text-muted-foreground" aria-hidden="true" />}
        >
          <Button size="sm" onClick={() => patchQs({ action: "install" })}>
            {tr("重新生成安装命令", "New install command")}
          </Button>
        </Row>
        <Row
          label={tr("注册令牌与引导文件", "Enrollment token and bootstrap file")}
          description={tr(
            "agent 证书失效（如“证书校验未通过”）时，重新生成后在服务器上重新引导。旧证书立即作废。",
            'When the agent\'s certificate fails (e.g. "certificate verify failed"), issue a new one and bootstrap again. The old certificate is revoked.',
          )}
          icon={<KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />}
        >
          <Button size="sm" onClick={() => patchQs({ action: "enroll" })}>
            {tr("重新生成注册令牌", "New enrollment token")}
          </Button>
        </Row>
      </Group>

      <section className="grid gap-1.5">
        <h3 className="px-1 text-footnote font-semibold text-destructive">{tr("危险操作", "Danger zone")}</h3>
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card ring-1 ring-destructive/25 ring-inset">
          <div className="min-w-0 flex-1 basis-56">
            <div className="text-body font-semibold">{tr("删除这台服务器", "Delete this server")}</div>
            <div className="text-footnote text-muted-foreground">
              {tr(
                `同时删除其上 ${s.nodes.length} 个节点、${ents} 个入口；agent 会被吊销。不可撤销。`,
                `Deletes its ${s.nodes.length} nodes and ${ents} entrances too; the agent is revoked. Cannot be undone.`,
              )}
            </div>
          </div>
          <Button variant="destructive-soft" icon={Trash2} disabled={!!s.deleting_at} onClick={() => void remove(s)}>
            {tr("删除服务器…", "Delete server…")}
          </Button>
        </div>
      </section>
    </div>
  );
}
