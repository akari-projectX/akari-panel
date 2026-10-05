// R22 系统设置：主域名 / 订阅域名 / 节点通信域名 + 信任 Cloudflare；
// W12：延迟测试（测速间隔、测速地址、面板 TCP 测速）；
// W25（R39）：节点通信（安装命令、ACME、撤权方式）与安全（保留期、
// Cloudflare 网段、额外发布公钥）。这些设置只存数据库，panel.toml 不再参与。
// 后台管理只有中文。类型手工镜像 src/settings.rs 的 SettingsView。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useState } from "react";

import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { Tabs } from "../components/tabs";
import { adminBase, get, post, put } from "../lib/api";
import { navigate, usePath } from "../lib/router";
import { AlertSettingsCard } from "./admin-alerts";
import { adminErrorText } from "../lib/admin-errors";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { BrandingSettings } from "./admin-branding";
import { MailSettings } from "./admin-mail-settings";
import { MailTemplates } from "./admin-mail-templates";
import { PaymentSettings } from "./admin-payments";

// W21 (M11): 系统设置 in tabs, each a deep link /admin/settings/<tab>.
export const SETTINGS_TABS = [
  { id: "site", label: "站点" },
  { id: "node", label: "节点通信" },
  { id: "probe", label: "测速" },
  { id: "security", label: "安全" },
  { id: "payments", label: "支付" },
  { id: "signup", label: "注册" },
  { id: "mail", label: "邮件" },
  { id: "mail-templates", label: "邮件模板" },
  { id: "failed-mail", label: "失败邮件" },
  { id: "alerts", label: "告警" },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** The tab named by "/{prefix}/admin/settings/<tab>" (站点 by default). */
export function settingsTabOf(path: string): SettingsTab {
  const base = `${adminBase}/settings/`;
  const seg = path.startsWith(base) ? path.slice(base.length).split("/")[0] : "";
  return SETTINGS_TABS.find((t) => t.id === seg)?.id ?? "site";
}

export type Source = "settings" | "default" | "main" | "browser" | "unset";

export interface DomainView {
  value: string | null;
  display: string | null;
  effective: string | null;
  source: Source;
}

export interface AffectedNode {
  id: string;
  name: string;
  reason: "enrolled" | "pending" | "unknown";
}

export interface ServerNameView {
  name: string;
  display: string;
  source: string;
  first_used_at: string;
  current: boolean;
  locked: string | null;
  nodes: AffectedNode[];
}

export interface SettingsView {
  version: number;
  updated_at: string | null;
  main: DomainView;
  sub: DomainView;
  // W21: 站点名称 (null = "Akari").
  site_name: string | null;
  node: {
    value: string | null;
    display: string | null;
    // null = 未设置节点通信域名：无法生成安装命令/注册文件。
    panel_addr: string | null;
    server_name: string | null;
    source: Source;
    default_port: number;
  };
  trust_cloudflare: { value: boolean | null; effective: boolean; source: Source };
  server_names: ServerNameView[];
  legacy_nodes: AffectedNode[];
  certificate_names: string[];
  hot_reload: boolean;
  host_gate: boolean;
  ask_enabled: boolean;
  cloudflare_ranges: number;
  probe: ProbeView;
  node_ops: NodeOpsView;
  security: SecurityView;
  // 本实例 panel.toml 里已废弃的配置项（已导入或忽略，应删除）。
  obsolete_config_keys: string[];
  warnings: string[];
}

/** One editable value: stored (null = 未设置), effective, built-in default. */
export interface Field<T> {
  value: T | null;
  effective: T;
  default: T;
  source: Source;
}

export interface ProbeView {
  interval_secs: Field<number>;
  urls: Field<string[]>;
  panel_tcp: Field<boolean>;
  timeout_ms: number;
  attempts: number;
  manual_cooldown_secs: number;
}

export type RemoveMode = "gate" | "rebuild";

export interface NodeOpsView {
  install_tls_pin: string | null;
  // null = 官方发布地址；"" = 不使用备用下载。
  install_fallback_url: string | null;
  install_fallback_effective: string | null;
  install_fallback_default: string;
  acme_directory_url: string | null;
  acme_email: string | null;
  remove_mode: Field<RemoveMode>;
}

export interface SecurityView {
  audit_retention_days: Field<number>;
  traffic_daily_retention_days: Field<number>;
  cloudflare_ranges: string[] | null;
  cloudflare_ranges_shipped: number;
  extra_release_keys: string[] | null;
  release_keys: { id: string; label: string; official: boolean }[];
}

/** 秒 → "5 小时" / "90 分钟" / "1 天 2 小时"。 */
export function humanInterval(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.round((secs % 3600) / 60);
  const parts = [d && `${d} 天`, h && `${h} 小时`, m && `${m} 分钟`].filter(Boolean);
  return parts.length ? parts.join(" ") : `${secs} 秒`;
}

/** 测速表单 → PUT /settings/probe 的请求体；输入不合法时返回错误文案。 */
export function probeBody(
  version: number,
  minutes: string,
  urls: string,
  tcp: "default" | "on" | "off",
): { body: Record<string, unknown> } | { error: string } {
  let interval: number | null = null;
  if (minutes.trim() !== "") {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m < 10 || m > 10080) return { error: "测速间隔须在 10 分钟到 7 天（10080 分钟）之间" };
    interval = Math.round(m * 60);
  }
  const list = urls
    .split("\n")
    .map((u) => u.trim())
    .filter((u) => u !== "");
  if (list.length > 4) return { error: "测速地址最多 4 个" };
  const bad = list.find((u) => !/^https?:\/\/[^\s/?#@]+([/?#]\S*)?$/i.test(u));
  if (bad) return { error: `测速地址 ${bad} 不是有效的 http(s) 地址` };
  if (new Set(list).size !== list.length) return { error: "测速地址不能重复" };
  return {
    body: {
      version,
      interval_secs: interval,
      urls: list.length ? list : null,
      panel_tcp: tcp === "default" ? null : tcp === "on",
    },
  };
}

export interface DnsCheck {
  domain: string;
  addresses: { ip: string; cloudflare: boolean }[];
  level: "ok" | "warn" | "block";
  message: string;
}

type Kind = "main" | "sub" | "node";

const SOURCE_TEXT: Record<Source, string> = {
  settings: "已设置",
  default: "默认值",
  main: "跟随主域名",
  browser: "未设置（使用浏览器当前地址）",
  unset: "未设置",
};

const REASON_TEXT: Record<AffectedNode["reason"], string> = {
  enrolled: "已注册的节点在使用",
  pending: "未使用的安装命令/注册文件包含它",
  unknown: "早期注册，未记录",
};

const errText = (err: unknown, fallback: string) => (err instanceof Error ? adminErrorText(err) : fallback);

/** 去掉 :端口 与 [] 后的主机名（小写）。 */
export function hostOf(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("[")) return v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  const parts = v.split(":");
  return (parts.length === 2 ? parts[0] : v).replace(/\.$/, "");
}

const isIpLiteral = (h: string) => /^[\d.]+$/.test(h) || h.includes(":");

/**
 * 保存主域名后，当前浏览器访问的地址还能不能用（与后端 host gate 规则一致：
 * IP 地址总是可以；域名只接受主域名/订阅域名）。IDN 的比较交给后端兜底。
 */
export function hostStillAllowed(current: string, main: string, sub: string): boolean {
  const h = current
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (main.trim() === "") return true;
  if (isIpLiteral(h)) return true;
  return [main, sub].filter((d) => d.trim() !== "").some((d) => hostOf(d) === h);
}

function SourceBadge({ source }: { source: Source }) {
  return <Badge variant={source === "settings" ? "default" : "secondary"}>{SOURCE_TEXT[source]}</Badge>;
}

function DnsResult({ check }: { check: DnsCheck }) {
  const color =
    check.level === "ok" ? "text-emerald-700" : check.level === "warn" ? "text-amber-700" : "text-destructive";
  return (
    <div role="status" className={`mt-2 rounded-lg bg-muted p-3 text-sm ${color}`}>
      <p>{check.message}</p>
      {check.addresses.length > 0 && (
        <ul className="mt-1 text-xs text-muted-foreground">
          {check.addresses.map((a) => (
            <li key={a.ip}>
              {a.ip}
              {a.cloudflare ? "（Cloudflare）" : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DomainField(props: {
  id: Kind;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  help: React.ReactNode;
  effective: React.ReactNode;
  source: Source;
  check: DnsCheck | null;
  checking: boolean;
  onCheck: () => void;
  checkError: string | null;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={`settings-${props.id}`}>{props.label}</Label>
        <SourceBadge source={props.source} />
      </div>
      <div className="flex gap-2">
        <Input
          id={`settings-${props.id}`}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(e) => props.onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="button"
          variant="outline"
          disabled={props.checking || props.value.trim() === ""}
          onClick={props.onCheck}
        >
          {props.checking ? "检测中…" : "DNS 检测"}
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">{props.help}</div>
      <div className="text-xs">当前生效：{props.effective}</div>
      {props.checkError && (
        <p role="alert" className="text-sm text-destructive">
          {props.checkError}
        </p>
      )}
      {props.check && <DnsResult check={props.check} />}
    </div>
  );
}

// The forms below are keyed by the settings version, so a save remounts the
// form with the server's values; its "已保存" note lives here to survive that.
const SavedFlash = createContext<[string | null, (id: string | null) => void]>([null, () => {}]);

function useSavedFlash(id: string): [boolean, (v: boolean) => void] {
  const [flash, setFlash] = useContext(SavedFlash);
  return [flash === id, (v) => setFlash(v ? id : null)];
}

export function AdminSettings() {
  const tab = settingsTabOf(usePath());
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsView>("/settings") });
  const needsSettings = tab === "site" || tab === "node" || tab === "probe" || tab === "security";
  const flash = useState<string | null>(null);
  return (
    <SavedFlash.Provider value={flash}>
      <div className="space-y-6">
        <h1 className="text-xl font-semibold tracking-tight">系统设置</h1>
        <Tabs
          label="系统设置分类"
          tabs={SETTINGS_TABS}
          value={tab}
          onChange={(t) => {
            flash[1](null);
            navigate(`${adminBase}/settings/${t}`);
          }}
        >
          {needsSettings && settings.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
          {needsSettings && settings.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errText(settings.error, "加载失败")}
            </p>
          )}
          {needsSettings && settings.data && settings.data.obsolete_config_keys.length > 0 && (
            <ObsoleteKeys keys={settings.data.obsolete_config_keys} />
          )}
          {/* key: 重新加载（保存/他人修改）后表单回到服务器的值 */}
          {settings.data && tab === "site" && (
            <div className="space-y-6">
              <SiteForm data={settings.data} />
              <BrandingSettings />
              <SettingsForm key={`domains-${settings.data.version}`} data={settings.data} mode="site" />
            </div>
          )}
          {settings.data && tab === "node" && (
            <div className="space-y-6">
              <SettingsForm key={`node-${settings.data.version}`} data={settings.data} mode="node" />
              <NodeOpsForm key={`nodeops-${settings.data.version}`} data={settings.data} />
              <ServerNames data={settings.data} />
            </div>
          )}
          {settings.data && tab === "probe" && (
            <ProbeForm key={`probe-${settings.data.version}`} data={settings.data} />
          )}
          {settings.data && tab === "security" && (
            <SecurityForm key={`security-${settings.data.version}`} data={settings.data} />
          )}
          {/* W15：注册 / 邮件 / 失败邮件（独立的设置行与版本号） */}
          {tab === "payments" && <PaymentSettings />}
          {tab === "signup" && <MailSettings part="signup" />}
          {tab === "mail" && <MailSettings part="mail" />}
          {tab === "mail-templates" && <MailTemplates />}
          {tab === "failed-mail" && <MailSettings part="failed" />}
          {tab === "alerts" && <AlertSettingsCard />}
        </Tabs>
      </div>
    </SavedFlash.Provider>
  );
}

/** W21: 站点名称 — browser titles of both bundles and the mail headers. */
function SiteForm({ data }: { data: SettingsView }) {
  const qc = useQueryClient();
  const [name, setName] = useState(data.site_name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (name.trim().length > 64) return setError("站点名称最多 64 个字符");
    setBusy(true);
    try {
      const res = await put<SettingsView>("/settings/site", { version: data.version, site_name: name.trim() || null });
      qc.setQueryData(["settings"], res);
      await qc.invalidateQueries({ queryKey: ["auth-options"] });
      setSaved(true);
    } catch (err) {
      setError(errText(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>站点名称</h2>
        </CardTitle>
        <CardDescription>
          显示在浏览器标签页标题、后台顶栏和所有邮件的标题与页眉中（邮件「发件人名称」留空时也用它）。留空 = Akari。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={save} aria-label="站点名称设置">
          <div className="min-w-56 flex-1 space-y-1.5 sm:max-w-sm">
            <Label htmlFor="settings-site-name">站点名称</Label>
            <Input
              id="settings-site-name"
              value={name}
              maxLength={64}
              placeholder="Akari"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存站点名称"}
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {saved && (
          <p role="status" className="mt-2 text-sm text-emerald-700">
            已保存。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// The domain row of 系统设置 (one PUT with every value): the 站点 tab edits
// the main/subscription domains and Cloudflare trust, the 节点通信 tab the
// node domain; each sends the other values unchanged.
function SettingsForm({ data, mode }: { data: SettingsView; mode: "site" | "node" }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [main, setMain] = useState(data.main.display ?? "");
  const [sub, setSub] = useState(data.sub.display ?? "");
  const [node, setNode] = useState(data.node.display ?? "");
  const [trust, setTrust] = useState<"default" | "on" | "off">(
    data.trust_cloudflare.value === null ? "default" : data.trust_cloudflare.value ? "on" : "off",
  );
  const [checks, setChecks] = useState<Partial<Record<Kind, DnsCheck>>>({});
  const [checkErrors, setCheckErrors] = useState<Partial<Record<Kind, string>>>({});
  const [checking, setChecking] = useState<Kind | null>(null);
  const [forceNode, setForceNode] = useState(false);
  const [confirmHost, setConfirmHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>(data.warnings);
  const [saved, setSaved] = useSavedFlash(`domains-${mode}`);

  const value = { main, sub, node } as const;
  const nodeChanged = node.trim() !== (data.node.display ?? "");
  const hostAtRisk = !hostStillAllowed(location.hostname, main, sub);
  const nodeBlocked = checks.node?.level === "block";

  async function dnsCheck(kind: Kind): Promise<DnsCheck | null> {
    setChecking(kind);
    setCheckErrors((e) => ({ ...e, [kind]: undefined }));
    try {
      const res = await post<DnsCheck>("/settings/dns-check", { kind, domain: value[kind].trim() });
      setChecks((c) => ({ ...c, [kind]: res }));
      return res;
    } catch (err) {
      setCheckErrors((e) => ({ ...e, [kind]: errText(err, "检测失败") }));
      return null;
    } finally {
      setChecking(null);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (nodeChanged && node.trim() !== "") {
      // 改节点通信域名前先检测：解析到 Cloudflare 时要求明确的强制确认。
      const c = checks.node?.domain ? checks.node : await dnsCheck("node");
      if (c?.level === "block" && !forceNode) {
        setError("节点通信域名解析到了 Cloudflare（橙色云朵）。请改为灰色云朵，或勾选下方的强制保存。");
        return;
      }
    }
    if (nodeChanged) {
      const target = node.trim() === "" ? "空（之后无法生成新的安装命令和注册文件）" : node.trim();
      const ok = await confirm({
        title: `把节点通信域名改为 ${target}？`,
        message:
          "· 只影响之后新生成的安装命令和注册文件；\n" +
          "· 已经注册的节点继续使用它们注册时的域名，不会断线（面板证书会同时包含新旧域名）；\n" +
          "· 新域名必须是灰色云朵（仅 DNS），并且节点能直连面板的 gRPC 端口。",
        confirmLabel: "确认修改",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await put<SettingsView>("/settings", {
        version: data.version,
        main_domain: main.trim() || null,
        sub_domain: sub.trim() || null,
        node_domain: node.trim() || null,
        trust_cloudflare: trust === "default" ? null : trust === "on",
        force_node_cloudflare: forceNode,
        confirm_host_change: confirmHost,
      });
      setWarnings(res.warnings);
      setSaved(true);
      qc.setQueryData(["settings"], res);
    } catch (err) {
      setError(errText(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{mode === "site" ? "域名" : "节点通信域名"}</h2>
        </CardTitle>
        <CardDescription>
          这些设置只保存在数据库中（panel.toml 不再包含它们）。修改立即在所有面板实例生效，无需重启。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={save} aria-label={mode === "site" ? "域名设置" : "节点通信域名设置"}>
          {mode === "site" && (
            <>
              <DomainField
                id="main"
                label="主域名"
                value={main}
                onChange={setMain}
                placeholder="panel.example.com"
                source={data.main.source}
                effective={data.main.effective ?? "浏览器当前地址"}
                help={
                  <>
                    后台管理、用户门户、节点一键安装链接、支付宝回调地址都使用这个域名。可以开启 Cloudflare
                    橙色云朵（SSL 模式请选 Full (strict)）。设置后，面板只接受通过主域名、订阅域名或 IP
                    地址的访问，其他域名一律返回 404。
                  </>
                }
                check={checks.main ?? null}
                checking={checking === "main"}
                onCheck={() => void dnsCheck("main")}
                checkError={checkErrors.main ?? null}
              />
              <DomainField
                id="sub"
                label="订阅域名"
                value={sub}
                onChange={setSub}
                placeholder="sub.example.com（留空 = 使用主域名）"
                source={data.sub.source}
                effective={data.sub.effective ?? "浏览器当前地址"}
                help={
                  <>
                    用户拿到的订阅链接使用这个域名，建议在 Cloudflare 开启<strong>橙色云朵</strong>
                    （代理），隐藏服务器 IP、抵御扫描。配合下方「信任 Cloudflare」，面板才能看到用户的真实 IP。
                  </>
                }
                check={checks.sub ?? null}
                checking={checking === "sub"}
                onCheck={() => void dnsCheck("sub")}
                checkError={checkErrors.sub ?? null}
              />
            </>
          )}
          {mode === "node" && (
            <>
              <DomainField
                id="node"
                label="节点通信域名"
                value={node}
                onChange={(v) => {
                  setNode(v);
                  setChecks((c) => ({ ...c, node: undefined }));
                  setForceNode(false);
                }}
                placeholder="node.example.com 或 node.example.com:8443"
                source={data.node.source}
                effective={
                  data.node.panel_addr ? (
                    <>
                      {data.node.panel_addr}（证书名称 {data.node.server_name}）
                    </>
                  ) : (
                    <span className="text-destructive">未设置：设置之前无法生成安装命令和注册文件</span>
                  )
                }
                help={
                  <>
                    节点 agent 连接面板 gRPC 端口用的域名，写进新的安装命令和注册文件。必须是
                    <strong>灰色云朵</strong>（仅 DNS，不经过代理）：agent 与面板之间是双向 TLS 直连，经过 Cloudflare
                    代理会被它终止 TLS，节点就连不上了。不写端口时使用 gRPC 监听端口 {data.node.default_port}。
                  </>
                }
                check={checks.node ?? null}
                checking={checking === "node"}
                onCheck={() => void dnsCheck("node")}
                checkError={checkErrors.node ?? null}
              />
              {nodeBlocked && (
                <label className="flex items-start gap-2 text-sm text-destructive">
                  <input type="checkbox" checked={forceNode} onChange={(e) => setForceNode(e.target.checked)} />
                  我确认这个域名不会经过 Cloudflare 代理（例如检测结果已过时），仍然保存。
                </label>
              )}
            </>
          )}

          {mode === "site" && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="settings-trust">信任 Cloudflare</Label>
                <SourceBadge source={data.trust_cloudflare.source} />
              </div>
              <select
                id="settings-trust"
                className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm"
                value={trust}
                onChange={(e) => setTrust(e.target.value as "default" | "on" | "off")}
              >
                <option value="default">默认（关闭）</option>
                <option value="on">开启</option>
                <option value="off">关闭</option>
              </select>
              <p className="text-xs text-muted-foreground">
                开启后，来自 Cloudflare 官方 IP 段（{data.cloudflare_ranges} 个网段，可在「安全」中替换）的请求会读取
                CF-Connecting-IP 作为用户真实 IP，用于登录/订阅限速和审计。只有请求确实经过受信任的反向代理和 Cloudflare
                时才读取，直接访问源站伪造的头会被忽略。没有使用 Cloudflare 时请保持关闭。
              </p>
            </div>
          )}

          {hostAtRisk && (
            <label className="flex items-start gap-2 text-sm text-amber-700">
              <input type="checkbox" checked={confirmHost} onChange={(e) => setConfirmHost(e.target.checked)} />
              你当前通过 {location.hostname} 访问，保存后这个地址将无法打开后台（只接受主域名、订阅域名和 IP
              地址）。我已确认主域名可以正常打开。
            </label>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && <p className="text-sm text-emerald-700">已保存，所有面板实例已生效。</p>}
          {warnings.length > 0 && (
            <div role="status">
              <ul className="space-y-1 text-sm text-amber-700">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <Button type="submit" disabled={busy || (hostAtRisk && !confirmHost)}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ProbeForm({ data }: { data: SettingsView }) {
  const qc = useQueryClient();
  const p = data.probe;
  const [minutes, setMinutes] = useState(p.interval_secs.value === null ? "" : String(p.interval_secs.value / 60));
  const [urls, setUrls] = useState((p.urls.value ?? []).join("\n"));
  const [tcp, setTcp] = useState<"default" | "on" | "off">(
    p.panel_tcp.value === null ? "default" : p.panel_tcp.value ? "on" : "off",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useSavedFlash("probe");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const req = probeBody(data.version, minutes, urls, tcp);
    if ("error" in req) {
      setError(req.error);
      return;
    }
    setBusy(true);
    try {
      const res = await put<SettingsView>("/settings/probe", req.body);
      qc.setQueryData(["settings"], res);
      setSaved(true);
    } catch (err) {
      setError(errText(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>延迟测试</h2>
        </CardTitle>
        <CardDescription>
          节点 agent 按间隔从节点本机访问测速地址（与 Clash 的 url-test 相同，每次测 {p.attempts} 次取中位数，单次超时{" "}
          {p.timeout_ms / 1000} 秒），面板同时测量到各入站端口的 TCP 连接时间；用户门户显示 agent 的结果。留空 =
          默认值。保存后立即下发到所有在线节点，无需重启。
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* noValidate：范围错误用下面的中文提示，而不是浏览器自带的气泡 */}
        <form className="space-y-6" onSubmit={save} noValidate>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="probe-interval">测速间隔（分钟）</Label>
              <SourceBadge source={p.interval_secs.source} />
            </div>
            <Input
              id="probe-interval"
              type="number"
              min={10}
              max={10080}
              step="any"
              value={minutes}
              placeholder={`留空 = 默认（${humanInterval(p.interval_secs.default)}）`}
              onChange={(e) => setMinutes(e.target.value)}
            />
            <div className="text-xs text-muted-foreground">
              10 分钟到 7 天。间隔越短，节点访问测速地址越频繁。缩短间隔时，面板的 TCP 测速会在新间隔内重新安排。
            </div>
            <div className="text-xs">当前生效：{humanInterval(p.interval_secs.effective)}</div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="probe-urls">测速地址</Label>
              <SourceBadge source={p.urls.source} />
            </div>
            <textarea
              id="probe-urls"
              className="min-h-20 w-full rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-sm"
              value={urls}
              placeholder={p.urls.default.join("\n")}
              onChange={(e) => setUrls(e.target.value)}
              spellCheck={false}
            />
            <div className="text-xs text-muted-foreground">
              每行一个 http(s) 地址，最多 4 个；第一个为主地址，前一个没有响应时才依次尝试后面的。建议使用返回 204
              的地址（如 generate_204）。
            </div>
            <div className="break-all text-xs">当前生效：{p.urls.effective.join("、")}</div>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="probe-tcp">面板 TCP 测速</Label>
              <SourceBadge source={p.panel_tcp.source} />
            </div>
            <select
              id="probe-tcp"
              className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm"
              value={tcp}
              onChange={(e) => setTcp(e.target.value as "default" | "on" | "off")}
            >
              <option value="default">默认（{p.panel_tcp.default ? "开启" : "关闭"}）</option>
              <option value="on">开启</option>
              <option value="off">关闭</option>
            </select>
            <p className="text-xs text-muted-foreground">
              面板按同样的间隔测量到每个入站对外地址的 TCP 连接时间（UDP 入站除外），显示在节点详情页。
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && <p className="text-sm text-emerald-700">已保存，已通知所有在线节点。</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存测速设置"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ServerNames({ data }: { data: SettingsView }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function remove(n: ServerNameView) {
    const users = n.nodes.map((x) => `· ${x.name}（${REASON_TEXT[x.reason]}）`).join("\n");
    const msg =
      (n.nodes.length > 0
        ? `以下节点仍在使用它，移除后它们将无法连接面板，需要重新安装：\n${users}\n\n`
        : "没有记录到正在使用它的节点。") +
      (data.legacy_nodes.length > 0
        ? `\n另有 ${data.legacy_nodes.length} 个早期注册的节点没有记录使用的域名，也可能受影响。\n`
        : "") +
      "\n此操作不可撤销（之后重新保存该域名可以恢复）。";
    const ok = await confirm({
      title: `从面板证书中移除 ${n.display}？`,
      message: msg,
      confirmLabel: "移除",
      destructive: true,
    });
    if (!ok) return;
    setBusy(n.name);
    setError(null);
    try {
      await post("/settings/server-names/remove", { name: n.name, confirm: true });
      await qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (err) {
      setError(errText(err, "移除失败"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>节点通信证书域名</h2>
        </CardTitle>
        <CardDescription>
          面板 gRPC
          证书包含下列所有名称。已注册的节点一直使用注册时的域名，所以更换节点通信域名不会删除旧名称；只有在这里手动移除才会生效。
          {data.hot_reload && " 证书变更即时生效，无需重启。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Table label="证书域名">
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>来源</TableHead>
              <TableHead>使用中的节点</TableHead>
              <TableHead>
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.server_names.map((n) => (
              <TableRow key={n.name}>
                <TableCell>
                  {n.display} {n.current && <Badge>当前</Badge>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {n.source === "settings" ? "系统设置" : n.source === "config" ? "旧版配置文件（已导入）" : "注册文件"}
                </TableCell>
                <TableCell className="text-xs">
                  {n.nodes.length === 0 ? "—" : n.nodes.map((x) => x.name).join("、")}
                </TableCell>
                <TableCell className="text-right">
                  {n.locked ? (
                    <span className="text-xs text-muted-foreground" title={n.locked}>
                      不可移除
                    </span>
                  ) : (
                    <Button variant="outline" size="sm" disabled={busy === n.name} onClick={() => void remove(n)}>
                      移除
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {data.legacy_nodes.length > 0 && (
          <p className="text-xs text-muted-foreground">
            早期注册、未记录域名的节点：{data.legacy_nodes.map((x) => x.name).join("、")}（一般使用旧版配置文件中的
            grpc.server_name，来源为「旧版配置文件」的名称）。
          </p>
        )}
        <p className="text-xs text-muted-foreground">本实例证书当前包含：{data.certificate_names.join("、") || "—"}</p>
        <p className="text-xs text-muted-foreground">
          反向代理证书：
          {data.ask_enabled
            ? "已启用 Caddy 按需签发（主域名、订阅域名自动获取证书）"
            : "未启用 Caddy ask 端点（tls_ask.bind），新域名需要手动配置反向代理证书"}
          ；域名访问限制：{data.host_gate ? "已开启" : "未开启（设置主域名后开启）"}。
        </p>
      </CardContent>
    </Card>
  );
}

/** W25: obsolete keys still in THIS instance's panel.toml. */
function ObsoleteKeys({ keys }: { keys: string[] }) {
  return (
    <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
      本实例的配置文件 panel.toml 中还有已废弃的配置项：
      <span className="font-mono">{keys.map((k) => k.replace(/\.\*$/, "")).join("、")}</span>。
      它们在首次启动时已导入到系统设置（如果当时这里还没有值），之后一律忽略——以这里的设置为准。请从 panel.toml
      中删除它们。
    </div>
  );
}

const PIN_RE = /^sha256\/\/[A-Za-z0-9+/]{43}=$/;
const FALLBACK_RE = /^https:\/\/[A-Za-z0-9\-._~:/?#[\]@+,=%{}]*$/;

/** 节点通信表单 → PUT /settings/nodes 的请求体；输入不合法时返回错误文案。 */
export function nodeOpsBody(
  version: number,
  f: {
    pin: string;
    fallback: "default" | "custom" | "none";
    fallbackUrl: string;
    acmeUrl: string;
    acmeEmail: string;
    removeMode: RemoveMode;
  },
): { body: Record<string, unknown> } | { error: string } {
  const pin = f.pin.trim();
  if (pin !== "" && !PIN_RE.test(pin)) return { error: "安装命令公钥钉扎格式应为 sha256//<base64>" };
  const url = f.fallbackUrl.trim();
  if (f.fallback === "custom" && !(FALLBACK_RE.test(url) && url.includes("{arch}") && url.length <= 512)) {
    return { error: "备用下载地址必须是含 {arch} 的 https:// 地址" };
  }
  const acme = f.acmeUrl.trim();
  if (acme !== "" && !/^https:\/\/[^\s@/]+(\/\S*)?$/.test(acme)) return { error: "ACME 目录必须是 https:// 地址" };
  const email = f.acmeEmail.trim();
  if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "ACME 邮箱不是有效的邮箱地址" };
  return {
    body: {
      version,
      install_tls_pin: pin || null,
      install_fallback_url: f.fallback === "custom" ? url : null,
      install_fallback_disabled: f.fallback === "none",
      acme_directory_url: acme || null,
      acme_email: email || null,
      remove_mode: f.removeMode,
    },
  };
}

function NodeOpsForm({ data }: { data: SettingsView }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const n = data.node_ops;
  const [pin, setPin] = useState(n.install_tls_pin ?? "");
  const [fallback, setFallback] = useState<"default" | "custom" | "none">(
    n.install_fallback_url === null ? "default" : n.install_fallback_url === "" ? "none" : "custom",
  );
  const [fallbackUrl, setFallbackUrl] = useState(n.install_fallback_url || "");
  const [acmeUrl, setAcmeUrl] = useState(n.acme_directory_url ?? "");
  const [acmeEmail, setAcmeEmail] = useState(n.acme_email ?? "");
  const [removeMode, setRemoveMode] = useState<RemoveMode>(n.remove_mode.effective);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useSavedFlash("nodeops");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const req = nodeOpsBody(data.version, { pin, fallback, fallbackUrl, acmeUrl, acmeEmail, removeMode });
    if ("error" in req) return setError(req.error);
    if (removeMode !== n.remove_mode.effective && removeMode === "rebuild") {
      const ok = await confirm({
        title: "改为「重建」撤权方式？",
        message:
          "之后每次删除或更换用户凭据，节点都会整体重建 xray，节点上所有连接都会断开。只在怀疑按用户撤权（默认）有问题时临时使用。",
        confirmLabel: "确认修改",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await put<SettingsView>("/settings/nodes", req.body);
      qc.setQueryData(["settings"], res);
      setSaved(true);
    } catch (err) {
      setError(errText(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>安装命令与节点证书</h2>
        </CardTitle>
        <CardDescription>
          一键安装命令、节点自动证书（ACME）与撤权方式。留空 = 默认值；保存后所有面板实例立即生效。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={save} aria-label="安装命令与节点证书设置" noValidate>
          <div className="space-y-2">
            <Label htmlFor="nodeops-pin">安装命令公钥钉扎</Label>
            <Input
              id="nodeops-pin"
              value={pin}
              placeholder="留空 = 生成命令时自动探测"
              onChange={(e) => setPin(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              面板网页证书公钥的 sha256//… 指纹（curl
              --pinnedpubkey）。通常留空：生成安装命令时面板会自己连接主域名检查证书， 公共 CA
              签发的证书不需要钉扎，自签证书会自动钉扎。只有面板连不上自己的公网地址时才需要手工填写。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="nodeops-fallback">备用下载地址</Label>
            <select
              id="nodeops-fallback"
              className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm"
              value={fallback}
              onChange={(e) => setFallback(e.target.value as "default" | "custom" | "none")}
            >
              <option value="default">默认（官方 GitHub 发布）</option>
              <option value="custom">自定义地址</option>
              <option value="none">不使用备用下载</option>
            </select>
            {fallback === "custom" && (
              <Input
                id="nodeops-fallback-url"
                aria-label="自定义备用下载地址"
                value={fallbackUrl}
                placeholder={n.install_fallback_default}
                onChange={(e) => setFallbackUrl(e.target.value)}
                spellCheck={false}
              />
            )}
            <p className="text-xs text-muted-foreground">
              「更新」页没有上传某个架构的完整发布时，安装脚本从这里下载 agent（{"{arch}"} = amd64 / arm64，同目录的
              SHA256SUMS 用于校验）。当前生效：{n.install_fallback_effective ?? "不使用"}
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="nodeops-acme-url">ACME 目录</Label>
              <Input
                id="nodeops-acme-url"
                value={acmeUrl}
                placeholder="留空 = Let's Encrypt"
                onChange={(e) => setAcmeUrl(e.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="nodeops-acme-email">ACME 邮箱</Label>
              <Input
                id="nodeops-acme-email"
                value={acmeEmail}
                placeholder="可留空（证书到期通知）"
                onChange={(e) => setAcmeEmail(e.target.value)}
                spellCheck={false}
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              设置了节点域名的节点由 agent 自己申请证书（HTTP-01/TLS-ALPN-01）。测试时可填 Let's Encrypt 测试环境
              https://acme-staging-v02.api.letsencrypt.org/directory。下一次下发配置时生效。
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="nodeops-remove-mode">撤权方式</Label>
              <SourceBadge source={n.remove_mode.source} />
            </div>
            <select
              id="nodeops-remove-mode"
              className="h-9 rounded-lg border border-border bg-transparent px-3 text-sm"
              value={removeMode}
              onChange={(e) => setRemoveMode(e.target.value as RemoveMode)}
            >
              <option value="gate">按用户撤权（默认，推荐）</option>
              <option value="rebuild">重建（每次删除/更换凭据都断开节点上所有连接）</option>
            </select>
            <p className="text-xs text-muted-foreground">
              删除用户或更换凭据时，默认只断开该用户的连接；「重建」是应急回退开关。随下一次租约下发到节点。
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && <p className="text-sm text-emerald-700">已保存，所有面板实例已生效。</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存安装与证书设置"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** 安全表单 → PUT /settings/security 的请求体；输入不合法时返回错误文案。 */
export function securityBody(
  version: number,
  f: { auditDays: string; trafficDays: string; ranges: string; keys: string },
): { body: Record<string, unknown> } | { error: string } {
  const days = (v: string, label: string, min: number) => {
    if (v.trim() === "") return { ok: null as number | null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 36500 || (n !== 0 && n < min)) {
      return { err: `${label}：0（永久）${min > 1 ? `或 ${min}` : ""}到 36500 天` };
    }
    return { ok: n };
  };
  const audit = days(f.auditDays, "审计日志保留天数", 1);
  if ("err" in audit) return { error: audit.err as string };
  const traffic = days(f.trafficDays, "流量明细保留天数", 32);
  if ("err" in traffic) return { error: traffic.err as string };
  const lines = (t: string) =>
    t
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x !== "" && !x.startsWith("#"));
  const ranges = lines(f.ranges);
  const bad = ranges.find((r) => !/^[0-9a-fA-F:.]+(\/\d{1,3})?$/.test(r));
  if (bad) return { error: `Cloudflare 网段 ${bad} 不是有效的 CIDR` };
  if (ranges.length > 256) return { error: "Cloudflare 网段最多 256 条" };
  const keys = lines(f.keys);
  if (keys.length > 16) return { error: "额外信任的发布公钥最多 16 个" };
  const badKey = keys.find((k) => !/^[A-Za-z0-9+/]{43}=(\s+\S.*)?$/.test(k));
  if (badKey) return { error: `${badKey.slice(0, 20)}… 不是「base64 公钥 标签」的格式` };
  return {
    body: {
      version,
      audit_retention_days: audit.ok,
      traffic_daily_retention_days: traffic.ok,
      cloudflare_ranges: ranges.length ? ranges : null,
      extra_release_keys: keys.length ? keys : null,
    },
  };
}

function SecurityForm({ data }: { data: SettingsView }) {
  const qc = useQueryClient();
  const s = data.security;
  const [auditDays, setAuditDays] = useState(
    s.audit_retention_days.value === null ? "" : String(s.audit_retention_days.value),
  );
  const [trafficDays, setTrafficDays] = useState(
    s.traffic_daily_retention_days.value === null ? "" : String(s.traffic_daily_retention_days.value),
  );
  const [ranges, setRanges] = useState((s.cloudflare_ranges ?? []).join("\n"));
  const [keys, setKeys] = useState((s.extra_release_keys ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useSavedFlash("security");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const req = securityBody(data.version, { auditDays, trafficDays, ranges, keys });
    if ("error" in req) return setError(req.error);
    setBusy(true);
    try {
      const res = await put<SettingsView>("/settings/security", req.body);
      qc.setQueryData(["settings"], res);
      setSaved(true);
    } catch (err) {
      setError(errText(err, "保存失败"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>安全与数据保留</h2>
        </CardTitle>
        <CardDescription>留空 = 默认值；保存后所有面板实例立即生效。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={save} aria-label="安全设置" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="security-audit-days">审计日志保留天数</Label>
              <Input
                id="security-audit-days"
                type="number"
                min={0}
                max={36500}
                value={auditDays}
                placeholder={`留空 = 默认（${s.audit_retention_days.default} 天）`}
                onChange={(e) => setAuditDays(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                0 = 永久保留。当前生效：{s.audit_retention_days.effective} 天
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="security-traffic-days">流量明细保留天数</Label>
              <Input
                id="security-traffic-days"
                type="number"
                min={0}
                max={36500}
                value={trafficDays}
                placeholder={`留空 = 默认（${s.traffic_daily_retention_days.default} 天）`}
                onChange={(e) => setTrafficDays(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                每日明细超过这个天数后归并为按月统计。0 = 永久保留按日明细，否则至少 32 天。当前生效：
                {s.traffic_daily_retention_days.effective} 天
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="security-cf-ranges">Cloudflare 网段</Label>
            <textarea
              id="security-cf-ranges"
              className="min-h-20 w-full rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-sm"
              value={ranges}
              placeholder={`留空 = 面板内置的列表（${s.cloudflare_ranges_shipped} 个网段）`}
              onChange={(e) => setRanges(e.target.value)}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              每行一个 CIDR，替换内置列表（用于「信任 Cloudflare」与 DNS 检测）。只在 Cloudflare
              公布了新网段而面板还没更新时填写，来源 https://www.cloudflare.com/ips/。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="security-release-keys">额外信任的发布公钥</Label>
            <ul className="text-xs text-muted-foreground">
              {s.release_keys.map((k) => (
                <li key={k.id}>
                  <span className="font-mono">{k.id}</span> {k.label} {k.official ? "（官方，内置）" : "（额外）"}
                </li>
              ))}
            </ul>
            <textarea
              id="security-release-keys"
              className="min-h-16 w-full rounded-lg border border-border bg-transparent px-3 py-2 font-mono text-sm"
              value={keys}
              placeholder="每行一个「base64 公钥 标签」，通常留空"
              onChange={(e) => setKeys(e.target.value)}
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              官方发布公钥已编译进面板。这里的公钥只决定面板接受上传哪些 agent
              发布；节点只运行用它自己内置的公钥验签通过的版本， 所以这里加的公钥不能让节点运行未经官方签名的程序。
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {saved && <p className="text-sm text-emerald-700">已保存，所有面板实例已生效。</p>}
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : "保存安全设置"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
