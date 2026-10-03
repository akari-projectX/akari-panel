// 节点管理（R18-2）：节点列表、新建/编辑向导（协议模板）、一键安装命令。
// 后台只做中文（R18）。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  adminBase,
  del,
  get,
  patch,
  post,
  put,
  type CheckDestView,
  type GeneratedAccount,
  type Inbound,
  type InboundSpec,
  type InstallView,
  type NodeEnrollment,
  type NodeUpdateStatus,
  type NodeSummary,
  type NodeView,
  type RenderedInbounds,
  type TemplateCatalog,
} from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { UpdateAvailableBadge } from "./admin-update-check";
import { fmtDate, fmtDateTime, fmtDuration } from "../lib/datetime";
import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { RowMenu } from "../components/row-menu";
import { navigate, usePath } from "../lib/router";
import {
  NodeOpsCard,
  NodeOpsFields,
  changedFromDefaults,
  emptyOps,
  opsToBody,
  type NodeOpsValue,
} from "./admin-node-form";
import { NodeAlertRulesCard } from "./admin-alerts";
import { NodeDetail, NodeLiveCells, NodeLiveHeads } from "./admin-node-status";
import { NodeCertStatus, TlsDomainField } from "./admin-node-cert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

// Server errors in Chinese (known messages / status classes mapped, the rest
// shown verbatim after "操作失败："); `fallback` when there is no error object.
const msg = (err: unknown, fallback: string) => (err instanceof Error ? adminErrorText(err) : fallback);

const selectCls = "h-9 rounded-lg border border-border bg-card px-3 text-sm";

// What the install card shows: the one-line command (and, after a create,
// the bootstrap file for the manual path).
interface InstallShown {
  name: string;
  install: InstallView;
  needsCertificate: boolean;
  bootstrap?: string;
}

export function AdminNodes() {
  // W11: live status columns, refreshed every 5 s. W17: the list reads the
  // summary view (the list's columns only, ETag-revalidated); the node
  // page and the editor fetch the full node.
  const nodes = useQuery({
    queryKey: ["nodes", "summary"],
    queryFn: () => get<NodeSummary[]>("/nodes?view=summary"),
    refetchInterval: 5000,
  });
  // W11: node detail = /{prefix}/admin/nodes/<id> (deep link, back button).
  const path = usePath();
  const detailId = path.startsWith(`${adminBase}/nodes/`) ? path.slice(`${adminBase}/nodes/`.length) : null;
  const detailQ = useFullNode(detailId, 5000);
  const detail = detailQ.data ?? null;
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<InstallShown | null>(null);
  const [bootstrap, setBootstrap] = useState<NodeEnrollment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const node = useFullNode(selected).data ?? null;
  const confirm = useConfirm();

  // Re-install: a fresh one-line command (the previous unused one stops
  // working; once the agent enrolls with it, the node's older certificate
  // is revoked).
  async function reinstall(n: NodeSummary) {
    setError(null);
    if (
      n.enrolled &&
      !(await confirm({
        title: `为「${n.name}」生成新的安装命令？`,
        message: "节点用它重新注册后，当前证书将失效（正在运行的 agent 需要用新命令重装）。",
        confirmLabel: "生成",
      }))
    ) {
      return;
    }
    try {
      const install = await post<InstallView>(`/nodes/${n.id}/install`, {
        origin: location.origin,
      });
      setBootstrap(null);
      setShown({ name: n.name, install, needsCertificate: n.needs_certificate });
      await nodes.refetch();
    } catch (err) {
      setError(msg(err, "生成安装命令失败"));
    }
  }

  // Manual path (ops): a bootstrap file (手动引导文件) with a 24 h token.
  async function newBootstrap(n: NodeSummary) {
    setError(null);
    if (
      n.enrolled &&
      !(await confirm({
        title: `为「${n.name}」生成新的手动引导文件？`,
        message: "文件里的注册令牌单次有效；节点用它注册后，当前证书将失效。",
        confirmLabel: "生成",
      }))
    ) {
      return;
    }
    try {
      setShown(null);
      setBootstrap(await post<NodeEnrollment>(`/nodes/${n.id}/enroll-token`, undefined));
      await nodes.refetch();
    } catch (err) {
      setError(msg(err, "签发令牌失败"));
    }
  }

  async function toggle(n: NodeSummary) {
    setError(null);
    if (
      n.enabled &&
      !(await confirm({
        title: `停用节点「${n.name}」？`,
        message: "节点上的所有入站与用户连接会立即断开，可随时重新启用。",
        confirmLabel: "停用",
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await patch(`/nodes/${n.id}`, { enabled: !n.enabled });
      await nodes.refetch();
    } catch (err) {
      setError(msg(err, n.enabled ? "停用失败" : "启用失败"));
    }
  }

  // Deletion revokes the node's certificate for good: the agent is pushed
  // the empty state, then the node disappears.
  async function remove(n: NodeSummary) {
    setError(null);
    if (
      !(await confirm({
        title: `删除节点「${n.name}」？`,
        message: "节点停止服务，证书永久吊销（不可恢复，重新上线需新建节点）。",
        confirmLabel: "删除",
        destructive: true,
      }))
    ) {
      return;
    }
    try {
      await del(`/nodes/${n.id}`);
      if (selected === n.id) setSelected(null);
      await nodes.refetch();
    } catch (err) {
      setError(msg(err, "删除失败"));
    }
  }

  return (
    <div className="space-y-6">
      {creating ? (
        <NodeWizard
          onCancel={() => setCreating(false)}
          onCreated={async (e, needsCert) => {
            setCreating(false);
            setBootstrap(null);
            if (e.install) {
              setShown({
                name: e.name,
                install: e.install,
                needsCertificate: needsCert,
                bootstrap: e.bootstrap,
              });
            } else {
              setBootstrap(e);
            }
            await nodes.refetch();
          }}
        />
      ) : null}
      {detail && <NodeDetail key={detail.id} node={detail} onClose={() => navigate(`${adminBase}/nodes`)} />}
      {detail && <NodeAlertRulesCard key={`rules-${detail.id}`} nodeId={detail.id} />}
      {detailId && detailQ.isError && (
        <p role="alert" className="text-sm text-destructive">
          {adminErrorText(detailQ.error, "节点加载失败")}
        </p>
      )}
      {shown && <InstallCard shown={shown} onClose={() => setShown(null)} />}
      {bootstrap && <BootstrapCard enrollment={bootstrap} onClose={() => setBootstrap(null)} />}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex flex-wrap items-center gap-2">
              <h1>节点</h1>
              <UpdateAvailableBadge />
            </CardTitle>
            <CardDescription>agent 主动连接面板；新建后在节点服务器上执行一行安装命令即可上线。</CardDescription>
          </div>
          {!creating && (
            <Button
              onClick={() => {
                setCreating(true);
                setShown(null);
              }}
            >
              新建节点
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {error && (
            <p role="alert" className="mb-2 text-sm text-destructive">
              {error}
            </p>
          )}
          {nodes.isPending ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : nodes.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {adminErrorText(nodes.error, "节点列表加载失败")}
            </p>
          ) : (nodes.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">还没有节点。点击「新建节点」开始。</p>
          ) : (
            <Table label="节点列表">
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky left-0 z-[1] bg-card">名称</TableHead>
                  <TableHead>状态</TableHead>
                  <NodeLiveHeads />
                  <TableHead>地区 / 地址</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead className="sticky right-0 z-[1] bg-card text-right">
                    <span className="sr-only">操作</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(nodes.data ?? []).map((n) => (
                  <TableRow key={n.id}>
                    <TableCell className="sticky left-0 z-[1] bg-card font-medium">
                      <span className="whitespace-nowrap">{n.display_name ?? n.name}</span>
                      {n.display_name && <span className="block text-xs text-muted-foreground">{n.name}</span>}
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {n.traffic_rate !== 1 && <Badge variant="outline">{n.traffic_rate}x</Badge>}
                        {!n.visible && <Badge variant="secondary">已隐藏</Badge>}
                        {n.tags.map((t) => (
                          <Badge key={t} variant="secondary">
                            {t}
                          </Badge>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <NodeStatusCell n={n} />
                    </TableCell>
                    <NodeLiveCells n={n} />
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {n.region ?? "—"}
                      <span className="block text-xs">{n.server_addr ?? "未设置地址"}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {n.agent_version ?? "—"}
                      {n.agent_os && n.agent_arch && (
                        <span className="block text-xs">
                          {n.agent_os}/{n.agent_arch}
                        </span>
                      )}
                      {n.update_status && <UpdateBadge s={n.update_status} />}
                    </TableCell>
                    <TableCell className="sticky right-0 z-[1] bg-card text-right">
                      <span className="inline-flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`${n.name} 详情`}
                          onClick={() => navigate(`${adminBase}/nodes/${n.id}`)}
                        >
                          详情
                        </Button>
                        <RowMenu
                          label={`${n.name} 的更多操作`}
                          items={[
                            {
                              label: n.id === selected ? "收起配置" : "配置",
                              onSelect: () => setSelected(n.id === selected ? null : n.id),
                            },
                            {
                              label: n.enrolled ? "重装命令" : "安装命令",
                              disabled: !!n.deleting_at,
                              onSelect: () => void reinstall(n),
                            },
                            {
                              label: "手动引导文件",
                              disabled: !!n.deleting_at,
                              onSelect: () => void newBootstrap(n),
                            },
                            {
                              label: n.enabled ? "停用" : "启用",
                              disabled: !!n.deleting_at,
                              onSelect: () => void toggle(n),
                            },
                            {
                              label: "删除",
                              destructive: true,
                              disabled: !!n.deleting_at,
                              onSelect: () => void remove(n),
                            },
                          ]}
                        />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {/* key: switching nodes must never carry one node's form into another (F1). */}
      {node && <NodeEditor key={node.id} node={node} />}
      {node && <NodeOpsCard key={`ops-${node.id}`} node={node} />}
    </div>
  );
}

/** The full node (GET /nodes/{id}), when an id is given. */
function useFullNode(id: string | null, refetchInterval?: number) {
  return useQuery({
    queryKey: ["nodes", "full", id],
    queryFn: () => get<NodeView>(`/nodes/${id}`),
    enabled: !!id,
    refetchInterval,
  });
}

/** Seconds of lease left, from the expiry (the summary carries no ticking counter). */
export function leaseLeft(expires: string | null, now: number = Date.now()): number | null {
  if (!expires) return null;
  return Math.floor((new Date(expires).getTime() - now) / 1000);
}

function StatusBadge({ n }: { n: Pick<NodeSummary, "deleting_at" | "enabled" | "status" | "enrolled"> }) {
  if (n.deleting_at) return <Badge variant="destructive">删除中</Badge>;
  if (!n.enabled) return <Badge variant="secondary">已停用</Badge>;
  if (n.status === "online") return <Badge variant="success">在线</Badge>;
  if (!n.enrolled) return <Badge variant="outline">等待安装</Badge>;
  return <Badge variant="outline">{n.status === "offline" ? "离线" : n.status}</Badge>;
}

export function formatLease(secs: number | null): string {
  return fmtDuration(secs);
}

/**
 * The status cell (W21, audit M4/Minor 7): the badge, then what matters for
 * this state — a node waiting for its install shows the install link's
 * expiry (not a lease); an enrolled one carries its lease and certificate
 * in the tooltip; warnings, apply failures and firing alerts follow.
 */
export function NodeStatusCell({ n }: { n: NodeSummary }) {
  const lease = leaseLeft(n.lease_expires_at);
  const tip = n.enrolled
    ? [
        `失联租约剩余 ${formatLease(lease)}`,
        n.cert_not_after && `agent 证书有效期至 ${fmtDate(n.cert_not_after)}`,
        n.last_seen_at && `最后在线 ${fmtDateTime(n.last_seen_at)}`,
      ]
        .filter(Boolean)
        .join("\n")
    : undefined;
  return (
    <div className="space-y-0.5" title={tip}>
      <StatusBadge n={n} />
      {!n.enrolled && !n.deleting_at && (
        <span className="block whitespace-nowrap text-xs text-muted-foreground">
          {n.enroll_token_expires_at
            ? `安装链接 ${fmtDateTime(n.enroll_token_expires_at)} 过期`
            : "安装链接已过期，请重新生成"}
        </span>
      )}
      {n.enrolled && lease != null && lease <= 0 && n.status !== "online" && (
        <span className="block whitespace-nowrap text-xs text-destructive">失联租约已到期</span>
      )}
      {n.warnings.length > 0 && (
        <span className="block whitespace-nowrap text-xs font-medium text-amber-700" title={n.warnings.join("\n")}>
          {n.warnings.length} 条警告
        </span>
      )}
      {n.last_error && (
        <span className="block whitespace-nowrap text-xs font-medium text-destructive" title={n.last_error}>
          配置应用失败
        </span>
      )}
      {n.alerts_firing > 0 && (
        <a
          className="block whitespace-nowrap text-xs font-medium text-destructive underline"
          href={`${adminBase}/alerts`}
          onClick={(e) => {
            e.preventDefault();
            navigate(`${adminBase}/alerts`);
          }}
        >
          {n.alerts_firing} 条告警
        </a>
      )}
    </div>
  );
}

// --- inbound templates -------------------------------------------------------

type TemplateKind = InboundSpec["template"];

const TEMPLATE_LABELS: Record<TemplateKind, string> = {
  vless_reality: "VLESS + REALITY + Vision（推荐，无需证书与域名）",
  vless_reality_xhttp: "VLESS + REALITY + XHTTP（无需证书）",
  vless_tls_vision: "VLESS + TCP + TLS + Vision（需节点证书）",
  vless_ws_tls: "VLESS + WebSocket + TLS（需节点证书）",
  vmess_ws: "VMess + WebSocket（可选 TLS）",
  vmess_tcp: "VMess + TCP（无 TLS）",
  trojan_tls: "Trojan + TLS（需节点证书）",
  transport: "VLESS/VMess/Trojan + WS / HTTPUpgrade / XHTTP / gRPC（自选传输）",
  shadowsocks_2022: "Shadowsocks 2022（多用户，TCP+UDP）",
  hysteria2: "Hysteria 2（QUIC/UDP，需节点证书）",
};

const NETWORK_LABELS: Record<string, string> = {
  ws: "WebSocket",
  httpupgrade: "HTTPUpgrade",
  xhttp: "XHTTP（sing-box 不支持；Clash 仅 VLESS）",
  grpc: "gRPC（需 TLS）",
};

// Templates that read the node's TLS certificate.
export function specNeedsCertificate(s: InboundSpec): boolean {
  switch (s.template) {
    case "vless_tls_vision":
    case "vless_ws_tls":
    case "trojan_tls":
    case "hysteria2":
      return true;
    case "vmess_ws":
    case "transport":
      return !!s.tls_domain || !!s.tls;
    default:
      return false;
  }
}

// One row of the form; strings while editing, converted on submit.
interface SpecRow {
  key: number;
  template: TemplateKind;
  port: string;
  tag: string;
  dest: string;
  customDest: string;
  serverName: string;
  fingerprint: string;
  domain: string;
  path: string;
  tls: boolean;
  // W8 (optional so older callers/tests keep working).
  vision?: boolean;
  protocol?: "vless" | "vmess" | "trojan";
  network?: "ws" | "httpupgrade" | "xhttp" | "grpc";
  host?: string;
  mode?: string;
  serviceName?: string;
  method?: string;
}

let rowSeq = 0;
function newRow(template: TemplateKind = "vless_reality", port = "443"): SpecRow {
  rowSeq += 1;
  return {
    key: rowSeq,
    template,
    port,
    tag: "",
    dest: "",
    customDest: "",
    serverName: "",
    fingerprint: "chrome",
    domain: "",
    path: "",
    tls: false,
    vision: true,
    protocol: "vless",
    network: "ws",
    host: "",
    mode: "auto",
    serviceName: "",
    method: "",
  };
}

// Which L4 a template listens on (Hysteria 2 is UDP only, Shadowsocks both).
function rowL4(t: TemplateKind): ("tcp" | "udp")[] {
  if (t === "hysteria2") return ["udp"];
  if (t === "shadowsocks_2022") return ["tcp", "udp"];
  return ["tcp"];
}

// Form rows → API specs; an error string for the first invalid row.
// nodeDomain (W10): the node's TLS domain — TLS rows without their own
// domain use it (the panel fills it in).
export function toSpecs(rows: SpecRow[], nodeDomain = ""): InboundSpec[] | string {
  const hasNodeDomain = nodeDomain.trim() !== "";
  const out: InboundSpec[] = [];
  const ports = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const n = i + 1;
    const port = Number(r.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `第 ${n} 个入站：端口须为 1–65535`;
    for (const l4 of rowL4(r.template)) {
      if (ports.has(`${port}/${l4}`)) return `第 ${n} 个入站：端口 ${port} 重复`;
    }
    for (const l4 of rowL4(r.template)) ports.add(`${port}/${l4}`);
    const tag = r.tag.trim() || undefined;
    const domain = r.domain.trim();
    const reality = () => {
      const dest = r.dest === "custom" ? r.customDest.trim() : r.dest;
      return {
        dest: dest || undefined,
        server_name: r.serverName.trim() || undefined,
        fingerprint: r.fingerprint || undefined,
      };
    };
    if (
      (r.template === "vless_reality" || r.template === "vless_reality_xhttp") &&
      r.dest === "custom" &&
      !r.customDest.trim()
    )
      return `第 ${n} 个入站：请填写自定义目标站点`;
    switch (r.template) {
      case "vless_reality":
        out.push({
          template: "vless_reality",
          port,
          tag,
          ...reality(),
          vision: r.vision === false ? false : undefined,
        });
        break;
      case "vless_reality_xhttp":
        out.push({
          template: "vless_reality_xhttp",
          port,
          tag,
          ...reality(),
          path: r.path.trim() || undefined,
          mode: r.mode && r.mode !== "auto" ? r.mode : undefined,
        });
        break;
      case "vless_ws_tls":
      case "trojan_tls":
      case "vless_tls_vision":
      case "hysteria2": {
        if (!domain && !hasNodeDomain) return `第 ${n} 个入站：请填写证书域名（或填写节点域名）`;
        if (r.template === "vless_ws_tls")
          out.push({
            template: "vless_ws_tls",
            port,
            tag,
            domain: domain || undefined,
            path: r.path.trim() || undefined,
          });
        else out.push({ template: r.template, port, tag, domain: domain || undefined });
        break;
      }
      case "vmess_ws": {
        if (r.tls && !domain && !hasNodeDomain) return `第 ${n} 个入站：启用 TLS 时请填写证书域名（或填写节点域名）`;
        out.push({
          template: "vmess_ws",
          port,
          tag,
          path: r.path.trim() || undefined,
          tls_domain: r.tls ? domain || undefined : undefined,
          tls: r.tls && !domain ? true : undefined,
        });
        break;
      }
      case "vmess_tcp":
        out.push({ template: "vmess_tcp", port, tag });
        break;
      case "transport": {
        const protocol = r.protocol ?? "vless";
        const network = r.network ?? "ws";
        const tls = r.tls || protocol === "trojan" || network === "grpc";
        if (tls && !domain && !hasNodeDomain)
          return `第 ${n} 个入站：Trojan 与 gRPC 必须启用 TLS，请填写证书域名（或填写节点域名）`;
        out.push({
          template: "transport",
          port,
          tag,
          protocol,
          network,
          path: network !== "grpc" ? r.path.trim() || undefined : undefined,
          host: network !== "grpc" ? r.host?.trim() || undefined : undefined,
          mode: network === "xhttp" && r.mode && r.mode !== "auto" ? r.mode : undefined,
          service_name: network === "grpc" ? r.serviceName?.trim() || undefined : undefined,
          tls_domain: tls ? domain || undefined : undefined,
          tls: tls && !domain ? true : undefined,
        });
        break;
      }
      case "shadowsocks_2022":
        out.push({ template: "shadowsocks_2022", port, tag, method: r.method || undefined });
        break;
    }
  }
  return out;
}

const CERT_FILE = "/run/credentials/akari-agent.service/tls_fullchain.pem";

export function needsCertificate(inbounds: Inbound[]): boolean {
  return inbounds.some((i) => JSON.stringify(i).includes(CERT_FILE));
}

function TemplateRows({
  rows,
  setRows,
  catalog,
  nodeDomain = "",
}: {
  rows: SpecRow[];
  setRows: (r: SpecRow[]) => void;
  catalog: TemplateCatalog | undefined;
  nodeDomain?: string;
}) {
  const domainHint = nodeDomain.trim() ? `默认：${nodeDomain.trim()}` : "node1.example.com";
  const [checks, setChecks] = useState<Record<number, string>>({});
  const update = (key: number, p: Partial<SpecRow>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...p } : r)));

  async function checkDest(r: SpecRow) {
    const dest = r.dest === "custom" ? r.customDest.trim() : r.dest || catalog?.reality_dests[0];
    if (!dest) return;
    setChecks((c) => ({ ...c, [r.key]: "检测中…" }));
    try {
      const v = await post<CheckDestView>("/inbound-templates/check-dest", { dest });
      setChecks((c) => ({
        ...c,
        [r.key]: v.ok
          ? `可用：TLS 1.3 + h2${v.trusted ? "" : "（证书非公共信任）"}`
          : `不可用：${v.error ?? "未知原因"}`,
      }));
    } catch (err) {
      setChecks((c) => ({ ...c, [r.key]: adminErrorText(err, "检测失败") }));
    }
  }

  return (
    <div className="space-y-3">
      {rows.map((r, i) => (
        <div key={r.key} className="space-y-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`tpl-${r.key}`}>入站 {i + 1} 协议</Label>
              <select
                id={`tpl-${r.key}`}
                className={selectCls}
                value={r.template}
                onChange={(e) => update(r.key, { template: e.target.value as TemplateKind })}
              >
                {(Object.keys(TEMPLATE_LABELS) as TemplateKind[]).map((k) => (
                  <option key={k} value={k}>
                    {TEMPLATE_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`port-${r.key}`}>端口</Label>
              <Input
                id={`port-${r.key}`}
                className="w-24"
                inputMode="numeric"
                value={r.port}
                onChange={(e) => update(r.key, { port: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`tag-${r.key}`}>标签（可选）</Label>
              <Input
                id={`tag-${r.key}`}
                className="w-40"
                value={r.tag}
                placeholder="自动生成"
                onChange={(e) => update(r.key, { tag: e.target.value })}
              />
            </div>
            {rows.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
              >
                移除
              </Button>
            )}
          </div>
          {(r.template === "vless_reality" || r.template === "vless_reality_xhttp") && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`dest-${r.key}`}>目标站点（dest）</Label>
                <select
                  id={`dest-${r.key}`}
                  className={selectCls}
                  value={r.dest}
                  onChange={(e) => update(r.key, { dest: e.target.value })}
                >
                  <option value="">{catalog?.reality_dests[0] ?? "www.apple.com"}（默认）</option>
                  {(catalog?.reality_dests ?? []).slice(1).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                  <option value="custom">自定义…</option>
                </select>
              </div>
              {r.dest === "custom" && (
                <div className="space-y-1.5">
                  <Label htmlFor={`cdest-${r.key}`}>自定义目标（域名[:端口]）</Label>
                  <Input
                    id={`cdest-${r.key}`}
                    className="w-56"
                    value={r.customDest}
                    placeholder="example.com:443"
                    onChange={(e) => update(r.key, { customDest: e.target.value })}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`sni-${r.key}`}>SNI（可选）</Label>
                <Input
                  id={`sni-${r.key}`}
                  className="w-48"
                  value={r.serverName}
                  placeholder="同目标站点"
                  onChange={(e) => update(r.key, { serverName: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`fp-${r.key}`}>客户端指纹</Label>
                <select
                  id={`fp-${r.key}`}
                  className={selectCls}
                  value={r.fingerprint}
                  onChange={(e) => update(r.key, { fingerprint: e.target.value })}
                >
                  {(catalog?.fingerprints ?? ["chrome"]).map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => checkDest(r)}>
                检测目标站点
              </Button>
              {checks[r.key] && (
                <span className="text-xs text-muted-foreground" role="status">
                  {checks[r.key]}
                </span>
              )}
            </div>
          )}
          {r.template === "vless_reality" && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={r.vision !== false}
                onChange={(e) => update(r.key, { vision: e.target.checked })}
              />
              Vision 流控（xtls-rprx-vision，推荐）
            </label>
          )}
          {r.template === "transport" && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`proto-${r.key}`}>代理协议</Label>
                <select
                  id={`proto-${r.key}`}
                  className={selectCls}
                  value={r.protocol ?? "vless"}
                  onChange={(e) => update(r.key, { protocol: e.target.value as SpecRow["protocol"] })}
                >
                  <option value="vless">VLESS</option>
                  <option value="vmess">VMess</option>
                  <option value="trojan">Trojan（需 TLS）</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`net-${r.key}`}>传输方式</Label>
                <select
                  id={`net-${r.key}`}
                  className={selectCls}
                  value={r.network ?? "ws"}
                  onChange={(e) => update(r.key, { network: e.target.value as SpecRow["network"] })}
                >
                  {Object.entries(NETWORK_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              {r.protocol !== "trojan" && r.network !== "grpc" && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={r.tls} onChange={(e) => update(r.key, { tls: e.target.checked })} />
                  启用 TLS
                </label>
              )}
              {(r.tls || r.protocol === "trojan" || r.network === "grpc") && (
                <div className="space-y-1.5">
                  <Label htmlFor={`tdom-${r.key}`}>证书域名</Label>
                  <Input
                    id={`tdom-${r.key}`}
                    className="w-56"
                    value={r.domain}
                    placeholder={domainHint}
                    onChange={(e) => update(r.key, { domain: e.target.value })}
                  />
                </div>
              )}
              {r.network === "grpc" ? (
                <div className="space-y-1.5">
                  <Label htmlFor={`svc-${r.key}`}>gRPC 服务名（可选）</Label>
                  <Input
                    id={`svc-${r.key}`}
                    className="w-40"
                    value={r.serviceName ?? ""}
                    placeholder="随机生成"
                    onChange={(e) => update(r.key, { serviceName: e.target.value })}
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor={`tpath-${r.key}`}>路径（可选）</Label>
                    <Input
                      id={`tpath-${r.key}`}
                      className="w-40"
                      value={r.path}
                      placeholder="随机生成"
                      onChange={(e) => update(r.key, { path: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`host-${r.key}`}>Host（可选）</Label>
                    <Input
                      id={`host-${r.key}`}
                      className="w-48"
                      value={r.host ?? ""}
                      placeholder="不设置"
                      onChange={(e) => update(r.key, { host: e.target.value })}
                    />
                  </div>
                </>
              )}
            </div>
          )}
          {(r.template === "vless_reality_xhttp" || (r.template === "transport" && r.network === "xhttp")) && (
            <div className="flex flex-wrap items-end gap-3">
              {r.template === "vless_reality_xhttp" && (
                <div className="space-y-1.5">
                  <Label htmlFor={`xpath-${r.key}`}>XHTTP 路径（可选）</Label>
                  <Input
                    id={`xpath-${r.key}`}
                    className="w-40"
                    value={r.path}
                    placeholder="随机生成"
                    onChange={(e) => update(r.key, { path: e.target.value })}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`mode-${r.key}`}>XHTTP 模式</Label>
                <select
                  id={`mode-${r.key}`}
                  className={selectCls}
                  value={r.mode ?? "auto"}
                  onChange={(e) => update(r.key, { mode: e.target.value })}
                >
                  {(catalog?.xhttp_modes ?? ["auto", "packet-up", "stream-up", "stream-one"]).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          {r.template === "shadowsocks_2022" && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor={`method-${r.key}`}>加密方式</Label>
                <select
                  id={`method-${r.key}`}
                  className={selectCls}
                  value={r.method ?? ""}
                  onChange={(e) => update(r.key, { method: e.target.value })}
                >
                  {(catalog?.ss_methods ?? ["2022-blake3-aes-128-gcm", "2022-blake3-aes-256-gcm"]).map((m, idx) => (
                    <option key={m} value={idx === 0 ? "" : m}>
                      {m}
                      {idx === 0 ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <p className="text-xs text-muted-foreground">
                服务端密钥自动生成；每个用户一把独立密钥。移除用户会整体重建节点（断开该节点所有连接）。
              </p>
            </div>
          )}
          {(r.template === "vless_tls_vision" || r.template === "hysteria2") && (
            <div className="space-y-1.5">
              <Label htmlFor={`vdom-${r.key}`}>证书域名</Label>
              <Input
                id={`vdom-${r.key}`}
                className="w-56"
                value={r.domain}
                placeholder={domainHint}
                onChange={(e) => update(r.key, { domain: e.target.value })}
              />
            </div>
          )}
          {(r.template === "vless_ws_tls" || r.template === "trojan_tls" || r.template === "vmess_ws") && (
            <div className="flex flex-wrap items-end gap-3">
              {r.template === "vmess_ws" && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={r.tls} onChange={(e) => update(r.key, { tls: e.target.checked })} />
                  启用 TLS
                </label>
              )}
              {(r.template !== "vmess_ws" || r.tls) && (
                <div className="space-y-1.5">
                  <Label htmlFor={`dom-${r.key}`}>证书域名</Label>
                  <Input
                    id={`dom-${r.key}`}
                    className="w-56"
                    value={r.domain}
                    placeholder={domainHint}
                    onChange={(e) => update(r.key, { domain: e.target.value })}
                  />
                </div>
              )}
              {r.template !== "trojan_tls" && (
                <div className="space-y-1.5">
                  <Label htmlFor={`path-${r.key}`}>WebSocket 路径（可选）</Label>
                  <Input
                    id={`path-${r.key}`}
                    className="w-40"
                    value={r.path}
                    placeholder="随机生成"
                    onChange={(e) => update(r.key, { path: e.target.value })}
                  />
                </div>
              )}
            </div>
          )}
          {(r.template === "vless_ws_tls" ||
            r.template === "trojan_tls" ||
            r.template === "vless_tls_vision" ||
            r.template === "hysteria2" ||
            ((r.template === "vmess_ws" || r.template === "transport") &&
              (r.tls || (r.template === "transport" && (r.protocol === "trojan" || r.network === "grpc"))))) && (
            <p className="text-xs text-muted-foreground">
              {nodeDomain.trim() ? (
                <>证书由 agent 为节点域名 {nodeDomain.trim()} 自动申请与续期，无需手工操作。</>
              ) : (
                <>
                  填写上方「节点域名」即可自动申请证书；否则请把证书放在节点的{" "}
                  {catalog?.tls_cert_dir ?? "/etc/akari-agent/tls"}/fullchain.pem 与 privkey.pem，放好后执行 systemctl
                  restart akari-agent。
                </>
              )}
            </p>
          )}
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => setRows([...rows, newRow("vless_reality", "")])}>
        添加入站
      </Button>
    </div>
  );
}

// --- create wizard -----------------------------------------------------------

function NodeWizard({
  onCreated,
  onCancel,
}: {
  onCreated: (e: NodeEnrollment, needsCert: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const catalog = useQuery({
    queryKey: ["inbound-templates"],
    queryFn: () => get<TemplateCatalog>("/inbound-templates"),
  });
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [addr, setAddr] = useState("");
  const [tlsDomain, setTlsDomain] = useState("");
  const [rows, setRows] = useState<SpecRow[]>(() => [newRow()]);
  const [raw, setRaw] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // W11: xboard-style fields (display name, tags, multiplier, groups...).
  const [ops, setOps] = useState<NodeOpsValue>(emptyOps);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const opsBody = opsToBody(ops);
    if (typeof opsBody === "string") {
      setError(opsBody);
      return;
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      install: { origin: location.origin },
      ...changedFromDefaults(opsBody),
    };
    if (region.trim()) body.region = region.trim();
    if (addr.trim()) body.server_addr = addr.trim();
    if (tlsDomain.trim()) body.tls_domain = tlsDomain.trim();
    let needsCert = false;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as Inbound[];
        body.inbounds = parsed;
        needsCert = Array.isArray(parsed) && needsCertificate(parsed);
      } catch {
        setError("入站 JSON 格式错误");
        return;
      }
    } else {
      const specs = toSpecs(rows, tlsDomain);
      if (typeof specs === "string") {
        setError(specs);
        return;
      }
      body.templates = specs;
      // With a node domain the agent obtains the certificate itself.
      needsCert = specs.some(specNeedsCertificate) && !tlsDomain.trim();
    }
    setBusy(true);
    try {
      const res = await post<NodeEnrollment>("/nodes", body);
      await onCreated(res, needsCert);
    } catch (err) {
      setError(msg(err, "创建失败"));
    } finally {
      setBusy(false);
    }
  }

  // Advanced: start the raw editor from the rendered templates.
  async function toRaw() {
    setError(null);
    const specs = toSpecs(rows, tlsDomain);
    if (typeof specs === "string") {
      setRaw("[]");
      return;
    }
    try {
      const r = await post<RenderedInbounds>("/inbound-templates/render", {
        templates: specs,
        tls_domain: tlsDomain.trim() || undefined,
      });
      setRaw(JSON.stringify(r.inbounds, null, 2));
    } catch (err) {
      setError(msg(err, "生成 JSON 失败"));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>新建节点</h2>
        </CardTitle>
        <CardDescription>
          填写基本信息并选择协议模板，面板会生成入站配置（REALITY 密钥对、shortId 等）。创建后给出一行安装命令。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={submit}>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="nn-name">名称（内部，唯一）</Label>
              <Input
                id="nn-name"
                className="w-48"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={64}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nn-region">地区（用户可见）</Label>
              <Input
                id="nn-region"
                className="w-40"
                value={region}
                placeholder="东京"
                onChange={(e) => setRegion(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nn-addr">公网地址（IP 或域名）</Label>
              <Input
                id="nn-addr"
                className="w-64"
                value={addr}
                placeholder="203.0.113.10 或 node1.example.com"
                onChange={(e) => setAddr(e.target.value)}
              />
            </div>
          </div>
          <NodeOpsFields value={ops} onChange={setOps} idPrefix="nn-ops" />
          <TlsDomainField id="nn-tls" value={tlsDomain} onChange={setTlsDomain} serverAddr={addr} />
          {raw === null ? (
            <>
              <TemplateRows rows={rows} setRows={setRows} catalog={catalog.data} nodeDomain={tlsDomain} />
              <Button type="button" variant="ghost" size="sm" onClick={toRaw}>
                高级：直接编辑入站 JSON
              </Button>
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="nn-raw">Xray 入站 JSON（数组）</Label>
              <textarea
                id="nn-raw"
                className="h-64 w-full rounded-lg border border-border bg-card p-3 font-mono text-xs"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                spellCheck={false}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setRaw(null)}>
                返回模板
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {busy ? "创建中…" : "创建并生成安装命令"}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --- install command ---------------------------------------------------------

function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex items-start gap-2">
        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 text-xs">{text}</pre>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
    </div>
  );
}

function useCountdown(until: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
}

function InstallCard({ shown, onClose }: { shown: InstallShown; onClose: () => void }) {
  const { install } = shown;
  const left = useCountdown(install.expires_at);
  const [manual, setManual] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>安装「{shown.name}」</h2>
        </CardTitle>
        <CardDescription>
          在节点服务器（Linux，systemd，amd64/arm64）上以 root 执行下面的命令。命令只显示这一次，
          {left > 0 ? `${Math.floor(left / 60)} 分 ${left % 60} 秒后过期` : "已过期，请重新生成"}
          ；节点注册成功后立即失效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CopyLine label="curl" text={install.command} />
        {install.command_wget && <CopyLine label="或 wget" text={install.command_wget} />}
        {install.pin && (
          <p className="text-xs text-muted-foreground">
            面板证书不是公共 CA 签发的（例如仅用 IP 部署），命令已固定面板证书公钥（{install.pin}
            ）：curl 在发送请求前校验它，公钥不符即中止，所以 -k
            不会在未校验的情况下生效。面板证书更换后需重新生成命令。
          </p>
        )}
        {install.warnings.length > 0 && (
          <div role="alert">
            <ul className="list-disc space-y-1 pl-5 text-sm text-amber-700">
              {install.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {shown.needsCertificate && (
          <p className="text-sm text-amber-600">
            该节点有 TLS 入站：请把证书放在节点的 /etc/akari-agent/tls/fullchain.pem 与 privkey.pem，然后执行 systemctl
            restart akari-agent。
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          卸载：在节点上执行 <code>{install.uninstall_command}</code>。以 root 登录时可去掉 sudo。
        </p>
        {shown.bootstrap && (
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setManual(!manual)}>
              {manual ? "隐藏手动安装" : "手动安装（手动引导文件）"}
            </Button>
            {manual && <BootstrapBody name={shown.name} bootstrap={shown.bootstrap} />}
          </div>
        )}
        <Button variant="outline" onClick={onClose}>
          完成
        </Button>
      </CardContent>
    </Card>
  );
}

function BootstrapBody({ name, bootstrap }: { name: string; bootstrap: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([bootstrap], { type: "application/toml" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-bootstrap.toml`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-muted-foreground">
        保存为节点上的 /etc/akari-agent/bootstrap.toml（权限 0600），再按部署文档安装 agent 与 systemd
        单元。文件只含一次性令牌，不含私钥。
      </p>
      <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">{bootstrap}</pre>
      <Button type="button" onClick={download}>
        下载
      </Button>
    </div>
  );
}

// The bootstrap file (manual path): shown once (only the token's hash is kept).
function BootstrapCard({ enrollment, onClose }: { enrollment: NodeEnrollment; onClose: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>「{enrollment.name}」的手动引导文件</h2>
        </CardTitle>
        <CardDescription>
          只显示这一次。注册令牌单次有效，{fmtDateTime(enrollment.expires_at)}（北京时间）过期。保存为节点上的
          /etc/akari-agent/bootstrap.toml。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <BootstrapBody name={enrollment.name} bootstrap={enrollment.bootstrap} />
        <Button variant="outline" onClick={onClose}>
          完成
        </Button>
      </CardContent>
    </Card>
  );
}

// --- editor --------------------------------------------------------------------

function describeInbound(i: Inbound): string {
  const ss = (i.streamSettings ?? {}) as Record<string, unknown>;
  const net = typeof ss.network === "string" ? ss.network : "tcp";
  const sec = typeof ss.security === "string" ? ss.security : "none";
  const proto = typeof i.protocol === "string" ? i.protocol : "?";
  return `${proto} · ${net}${sec !== "none" ? ` · ${sec}` : ""}`;
}

function NodeEditor({ node }: { node: NodeView }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const catalog = useQuery({
    queryKey: ["inbound-templates"],
    queryFn: () => get<TemplateCatalog>("/inbound-templates"),
  });

  // Basics (own error/state: F4).
  const [name, setName] = useState(node.name);
  const [serverAddr, setServerAddr] = useState(node.server_addr ?? "");
  const [region, setRegion] = useState(node.region ?? "");
  const [tlsDomain, setTlsDomain] = useState(node.tls_domain ?? "");
  const [basicsMsg, setBasicsMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Inbounds: the pending list (starts as the stored one).
  const [pending, setPending] = useState<Inbound[]>(() => node.xray_inbounds);
  const [adding, setAdding] = useState<SpecRow[] | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [inboundMsg, setInboundMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Manual assignment.
  const [userId, setUserId] = useState("");
  const [inboundTag, setInboundTag] = useState(node.xray_inbounds[0]?.tag ?? "");
  const [protocol, setProtocol] = useState("vless");
  const [account, setAccount] = useState<GeneratedAccount | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  async function saveBasics(e: React.FormEvent) {
    e.preventDefault();
    setBasicsMsg(null);
    const domainChanges = (tlsDomain.trim().toLowerCase() || null) !== (node.tls_domain ?? null);
    if (
      domainChanges &&
      !(await confirm({
        title: "更改节点域名？",
        message: "会向节点下发新配置（重建 xray，断开现有连接）。",
        confirmLabel: "继续",
      }))
    )
      return;
    try {
      await patch(`/nodes/${node.id}`, {
        name: name.trim(),
        server_addr: serverAddr.trim() || null,
        region: region.trim() || null,
        tls_domain: tlsDomain.trim() || null,
      });
      setBasicsMsg({ ok: true, text: "已保存" });
      await queryClient.invalidateQueries({ queryKey: ["nodes"] });
    } catch (err) {
      setBasicsMsg({ ok: false, text: msg(err, "保存失败") });
    }
  }

  async function addFromTemplates() {
    if (!adding) return;
    setInboundMsg(null);
    const specs = toSpecs(adding, node.tls_domain ?? "");
    if (typeof specs === "string") {
      setInboundMsg({ ok: false, text: specs });
      return;
    }
    const taken = pending
      .map((i) => (typeof i.port === "number" ? i.port : Number(i.port)))
      .filter((p) => Number.isInteger(p));
    try {
      const r = await post<RenderedInbounds>("/inbound-templates/render", {
        templates: specs,
        taken_ports: taken,
        tls_domain: node.tls_domain ?? undefined,
      });
      setPending([...pending, ...r.inbounds]);
      setAdding(null);
    } catch (err) {
      setInboundMsg({ ok: false, text: msg(err, "生成失败") });
    }
  }

  async function saveInbounds() {
    setInboundMsg(null);
    let list = pending;
    if (raw !== null) {
      try {
        list = JSON.parse(raw) as Inbound[];
      } catch {
        setInboundMsg({ ok: false, text: "入站 JSON 格式错误" });
        return;
      }
    }
    const before = new Set(node.xray_inbounds.map((i) => i.tag));
    const removed = [...before].filter((t) => !list.some((i) => i.tag === t));
    if (
      !(await confirm({
        title: "保存入站？",
        message:
          removed.length > 0
            ? `将移除 ${removed.join("、")}，这些入站上的用户凭据会被删除；节点会重建配置并断开现有连接。`
            : "节点会重建配置并断开现有连接。",
        confirmLabel: "保存并下发",
        destructive: removed.length > 0,
      }))
    ) {
      return;
    }
    try {
      await put(`/nodes/${node.id}/inbounds`, { inbounds: list });
      setPending(list);
      setRaw(null);
      setInboundMsg({ ok: true, text: "已下发" });
      await queryClient.invalidateQueries({ queryKey: ["nodes"] });
    } catch (err) {
      setInboundMsg({ ok: false, text: msg(err, "保存失败") });
    }
  }

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    setAssignError(null);
    try {
      const acc = await post<GeneratedAccount>(`/users/${userId.trim()}/nodes/${node.id}`, {
        inbound_tag: inboundTag,
        protocol,
      });
      setAccount(acc);
    } catch (err) {
      setAssignError(msg(err, "分配失败"));
    }
  }

  async function unassign() {
    setAssignError(null);
    setAccount(null);
    if (!userId.trim()) {
      setAssignError("请填写用户 ID");
      return;
    }
    if (
      !(await confirm({
        title: "把该用户从此节点移除？",
        message: "其在此节点上的连接会被断开。",
        confirmLabel: "移除",
        destructive: true,
      }))
    )
      return;
    try {
      await del(`/users/${userId.trim()}/nodes/${node.id}`);
    } catch (err) {
      setAssignError(msg(err, "移除失败"));
    }
  }

  const dirty = raw !== null || JSON.stringify(pending) !== JSON.stringify(node.xray_inbounds);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>配置「{node.name}」</h2>
        </CardTitle>
        <CardDescription>入站变更会以完整快照下发给 agent（重建 xray，断开现有连接）。</CardDescription>
        {node.last_error && (
          <p role="alert" className="mt-2 break-all text-sm text-destructive">
            最近一次应用失败
            {node.failed_config_version !== null &&
              `（cfg ${node.failed_config_version} · usr ${node.failed_user_version}）`}
            {node.last_error_at && ` 于 ${fmtDateTime(node.last_error_at)}`}：{node.last_error}
          </p>
        )}
        {node.warnings.length > 0 && (
          <div role="alert">
            <ul className="mt-2 list-disc pl-5 text-sm text-amber-700">
              {node.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <NodeCertStatus node={node} />
      </CardHeader>
      <CardContent className="space-y-6">
        <form className="flex flex-wrap items-end gap-3" onSubmit={saveBasics}>
          <div className="space-y-1.5">
            <Label htmlFor="ed-name">名称</Label>
            <Input
              id="ed-name"
              className="w-48"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={64}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="saddr">公网地址</Label>
            <Input
              id="saddr"
              className="w-64"
              value={serverAddr}
              onChange={(e) => setServerAddr(e.target.value)}
              placeholder="node.example.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="region">地区（用户可见）</Label>
            <Input
              id="region"
              className="w-40"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="东京"
            />
          </div>
          <TlsDomainField
            id="ed-tls"
            value={tlsDomain}
            onChange={setTlsDomain}
            nodeId={node.id}
            serverAddr={serverAddr}
          />
          <Button variant="outline" type="submit">
            保存
          </Button>
          {basicsMsg && (
            <span
              role={basicsMsg.ok ? "status" : "alert"}
              className={`text-sm ${basicsMsg.ok ? "text-emerald-700" : "text-destructive"}`}
            >
              {basicsMsg.text}
            </span>
          )}
        </form>

        <div className="space-y-3">
          <p className="text-sm font-medium">入站</p>
          {raw === null ? (
            <>
              {pending.length === 0 ? (
                <p className="text-sm text-muted-foreground">没有入站。</p>
              ) : (
                <Table label="入站列表">
                  <TableHeader>
                    <TableRow>
                      <TableHead>标签</TableHead>
                      <TableHead>协议</TableHead>
                      <TableHead>端口</TableHead>
                      <TableHead className="text-right">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pending.map((i) => (
                      <TableRow key={i.tag}>
                        <TableCell className="font-mono text-xs">{i.tag}</TableCell>
                        <TableCell>{describeInbound(i)}</TableCell>
                        <TableCell>{String(i.port ?? "—")}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPending(pending.filter((x) => x.tag !== i.tag))}
                          >
                            移除
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {adding ? (
                <div className="space-y-2">
                  <TemplateRows
                    rows={adding}
                    setRows={setAdding}
                    catalog={catalog.data}
                    nodeDomain={node.tls_domain ?? ""}
                  />
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={addFromTemplates}>
                      加入列表
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setAdding(null)}>
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAdding([newRow("vless_reality", "")])}
                  >
                    从模板添加入站
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setRaw(JSON.stringify(pending, null, 2))}
                  >
                    高级：编辑 JSON
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="inbounds">Xray 入站 JSON（数组）</Label>
              <textarea
                id="inbounds"
                className="h-64 w-full rounded-lg border border-border bg-card p-3 font-mono text-xs"
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                spellCheck={false}
              />
              <Button type="button" variant="ghost" size="sm" onClick={() => setRaw(null)}>
                放弃 JSON 修改
              </Button>
            </div>
          )}
          <div className="flex items-center gap-3">
            <Button type="button" disabled={!dirty} onClick={saveInbounds}>
              保存并下发入站
            </Button>
            {inboundMsg && (
              <span
                role={inboundMsg.ok ? "status" : "alert"}
                className={`text-sm ${inboundMsg.ok ? "text-emerald-700" : "text-destructive"}`}
              >
                {inboundMsg.text}
              </span>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border p-4">
          <p className="mb-1 text-sm font-medium">手动分配（覆盖套餐）</p>
          <p className="mb-3 text-xs text-muted-foreground">
            通常用户的节点权限来自套餐（套餐 →
            节点组）。手动分配会在此节点上固定该用户的权限，与套餐无关；移除后交还给套餐。
          </p>
          <form className="flex flex-wrap items-end gap-3" onSubmit={assign}>
            <div className="space-y-1.5">
              <Label htmlFor="uid">用户 ID</Label>
              <Input
                id="uid"
                className="w-72 font-mono text-xs"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="用户 UUID"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="itag">入站</Label>
              <select
                id="itag"
                className={selectCls}
                value={inboundTag}
                onChange={(e) => setInboundTag(e.target.value)}
              >
                {node.xray_inbounds.map((i) => (
                  <option key={i.tag} value={i.tag}>
                    {i.tag}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proto">协议</Label>
              <select id="proto" className={selectCls} value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                <option value="vless">vless</option>
                <option value="vmess">vmess</option>
                <option value="trojan">trojan</option>
              </select>
            </div>
            <Button type="submit">生成并分配</Button>
            <Button type="button" variant="outline" onClick={unassign}>
              从节点移除该用户
            </Button>
          </form>
          {assignError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {assignError}
            </p>
          )}
          {account && (
            <pre className="mt-3 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(account, null, 2)}</pre>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// M6: the node's latest rollout entry (Updates view has the details).
function UpdateBadge({ s }: { s: NodeUpdateStatus }) {
  // W23: the entry of a finished rollout from before the node's last
  // reinstall is history, not its current state.
  if (s.superseded) {
    return (
      <div
        className="text-xs text-muted-foreground"
        title={`节点已于此后重装，此为历史记录${s.detail ? `：${s.detail}` : ""}`}
      >
        {s.version}: {s.status}（重装前）
      </div>
    );
  }
  const tone =
    s.status === "failed" ? "text-destructive" : s.status === "healthy" ? "text-muted-foreground" : "text-primary";
  return (
    <div className={`text-xs ${tone}`} title={s.detail ?? undefined}>
      {s.version}: {s.status}
    </div>
  );
}
