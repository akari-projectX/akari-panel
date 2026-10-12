// Node and server forms (NOD-03…07, 09…14, 20): add server / node,
// install command and bootstrap file, server edit (TLS domain check),
// D5 quota, per-server alert rules, and the node dialog (display fields,
// the inbound, block rules status, traffic) with one save for all of it.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { get, patch, post, put } from "../../shared/api";
import { bytes, dateTime, daysBefore, downloadText, siteToday } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { TrendChart, timeLabels } from "../../shared/ui/charts";
import { CopyButton, FormError, Mono, SectionTitle, useConfirmFree, useErrText } from "../kit";
import { useAction } from "../data";
import { parseRate } from "../rates";
import { navigate, setQuery, useRoute } from "../router";
import { holdersOf, useGroups, usePlanList, useServers } from "../servers";
import { EntranceDialog, RelayDialog } from "./entrance-dialog";
import { useCrumb } from "../session";
import type { EntranceView, NodeGroup, ServerView } from "../types";
import { JsonInbound, TemplateFields, newTemplateForm, parseInbound, toSpec, type TemplateForm } from "./inbound-form";
import {
  FixCount,
  GroupPicker,
  PORT,
  TagsField,
  WarningList,
  num,
  shown,
  chips,
  tagValues,
  type Chips,
  type NumRule,
} from "./node-common";
import { Activity, Bell, Download, Gauge, Layers, Server } from "lucide-react";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Segmented, Select, Switch } from "../../shared/ui/form";
import { Callout, KV } from "../../shared/ui/layout";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";

type InstallView = {
  url: string;
  command: string;
  command_wget: string | null;
  uninstall_command: string;
  expires_at: string;
  pin: string | null;
  warnings: string[];
};
type Enrollment = {
  id?: string;
  name: string;
  enrollment_token: string;
  expires_at: string;
  bootstrap: string;
  install?: InstallView;
};

export type Shown =
  { server: Pick<ServerView, "id" | "name">; mode: "install" | "bootstrap" } | { created: Enrollment };

function Countdown({ until }: { until: string }) {
  const tr = useTr();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return (
    <Badge tone={s > 0 ? "info" : "danger"}>
      {s > 0
        ? tr(`${Math.floor(s / 60)} 分 ${s % 60} 秒后过期`, `expires in ${Math.floor(s / 60)}m ${s % 60}s`)
        : tr("已过期", "expired")}
    </Badge>
  );
}

function InstallBody({ v }: { v: InstallView }) {
  const tr = useTr();
  return (
    <div className="space-y-3 text-body">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {tr("在服务器上以 root 执行（一次性）", "Run on the server as root (single use)")}
        </span>
        <Countdown until={v.expires_at} />
      </div>
      <div className="flex items-start gap-2">
        <Mono>{v.command}</Mono>
        <CopyButton text={v.command} />
      </div>
      {v.command_wget && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {tr("没有 curl？用 wget", "No curl? Use wget")}
          </summary>
          <div className="mt-2 flex items-start gap-2">
            <Mono>{v.command_wget}</Mono>
            <CopyButton text={v.command_wget} />
          </div>
        </details>
      )}
      {v.pin && (
        <p className="text-footnote break-all text-muted-foreground">
          {tr(`命令钉住了面板证书公钥：${v.pin}`, `The command pins the panel's key: ${v.pin}`)}
        </p>
      )}
      <WarningList warnings={v.warnings} />
      <details>
        <summary className="cursor-pointer text-muted-foreground">{tr("卸载命令", "Uninstall command")}</summary>
        <div className="mt-2 flex items-start gap-2">
          <Mono>{v.uninstall_command}</Mono>
          <CopyButton text={v.uninstall_command} />
        </div>
      </details>
    </div>
  );
}

function BootstrapBody({ e }: { e: Enrollment }) {
  const tr = useTr();
  return (
    <div className="space-y-2 text-body">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{tr("引导文件（含一次性注册令牌，不含私钥）", "Bootstrap file (a one-time token, no private key)")}</span>
        <Countdown until={e.expires_at} />
      </div>
      <pre className="max-h-48 overflow-auto rounded-md bg-window p-3 font-mono text-caption">{e.bootstrap}</pre>
      <div className="flex gap-2">
        <CopyButton text={e.bootstrap} />
        <Button size="sm" icon={Download} onClick={() => downloadText(`${e.name}-bootstrap.toml`, e.bootstrap)}>
          {tr("下载", "Download")}
        </Button>
      </div>
      <p className="text-footnote text-muted-foreground">
        {tr("在服务器上执行：akari-agent -config <文件>", "On the server: akari-agent -config <file>")}
      </p>
    </div>
  );
}

/**
 * Install material: a fresh install link / bootstrap token for an existing
 * server, or what a create returned. Shown once, so closing it by Esc, the
 * scrim or the × asks first; "完成" closes at once.
 */
export function InstallDialog({ shown: what, onClose }: { shown: Shown; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const created = "created" in what;
  const [data, setData] = useState<{ install?: InstallView; enrollment?: Enrollment } | null>(
    created ? { install: what.created.install, enrollment: what.created } : null,
  );
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  // A request issues a new token (the previous unused one is replaced): one per attempt.
  const issued = useRef(-1);
  useEffect(() => {
    if ("created" in what || issued.current === attempt) return;
    issued.current = attempt;
    const req =
      what.mode === "install"
        ? post<InstallView>(`/servers/${what.server.id}/install`, { origin: location.origin }).then((install) => ({
            install,
          }))
        : post<Enrollment>(`/servers/${what.server.id}/enroll-token`).then((enrollment) => ({ enrollment }));
    req.then(setData, setError);
  }, [what, attempt]);
  const name = "created" in what ? what.created.name : what.server.name;
  const bootstrapOnly = !("created" in what) && what.mode === "bootstrap";
  const askClose = async () => {
    if (!data) return onClose();
    const ok = await confirm({
      title: tr("关闭安装命令？", "Close the install command?"),
      description: tr(
        "它只显示这一次。关闭后若还没复制，需要重新生成（旧的未使用令牌随之作废）。",
        "It is shown only once. If you have not copied it, you will have to issue a new one (the unused one is replaced).",
      ),
      confirmLabel: tr("关闭", "Close"),
      tone: "warning",
    });
    if (ok) onClose();
  };
  return (
    <Dialog
      open
      size="lg"
      icon={Download}
      onClose={() => void askClose()}
      title={
        bootstrapOnly
          ? tr(`手动引导文件 · ${name}`, `Bootstrap file · ${name}`)
          : tr(`安装 agent · ${name}`, `Install the agent · ${name}`)
      }
      description={tr(
        "只显示这一次；关闭后可重新生成（旧的未使用令牌作废）。",
        "Shown once; you can issue a new one later (the unused one is replaced).",
      )}
      footer={
        <Button variant="primary" onClick={onClose}>
          {tr("完成", "Done")}
        </Button>
      }
    >
      {!data && !error && <LoadingBlock rows={4} />}
      {!!error && (
        <ErrorState
          compact
          error={error}
          onRetry={() => {
            setError(null);
            setAttempt((a) => a + 1);
          }}
        />
      )}
      {data?.install && <InstallBody v={data.install} />}
      {data?.enrollment &&
        (data.install ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-body text-muted-foreground">
              {tr("改用手动引导文件", "Use a bootstrap file instead")}
            </summary>
            <div className="mt-2">
              <BootstrapBody e={data.enrollment} />
            </div>
          </details>
        ) : (
          <BootstrapBody e={data.enrollment} />
        ))}
    </Dialog>
  );
}

export function CreateServerDialog({ onClose, onShown }: { onClose: () => void; onShown: (s: Shown) => void }) {
  const tr = useTr();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [install, setInstall] = useState(true);
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const nameError = tried && !name.trim() ? tr("请填写名称", "Enter a name") : undefined;
  const submit = async () => {
    setTried(true);
    if (!name.trim()) return;
    const r = await run(
      () =>
        post<Enrollment>("/servers", {
          name: name.trim(),
          tls_domain: domain.trim() || undefined,
          install: install ? { origin: location.origin } : undefined,
        }),
      { ok: tr("服务器已添加", "Server added") },
    );
    if (r) {
      onClose();
      onShown({ created: r });
    }
  };
  return (
    <Dialog
      open
      icon={Server}
      onClose={onClose}
      title={tr("添加服务器", "Add server")}
      description={tr(
        "一台机器一个 agent；之后在它上面添加节点。",
        "One agent per machine; add nodes on it afterwards.",
      )}
      onSubmit={submit}
      footer={
        <>
          <FixCount n={nameError ? 1 : 0} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={tr("名称（内部，唯一）", "Name (internal, unique)")} required error={nameError}>
          <Input value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        <Field
          label={tr("服务器域名（TLS，可选）", "Server domain (TLS, optional)")}
          hint={tr(
            "填写后 agent 自动申请证书；TLS 模板默认使用它。",
            "With it the agent obtains its certificate; TLS templates default to it.",
          )}
        >
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="node1.example.com" />
        </Field>
        <label className="flex min-h-9 items-center gap-2.5 text-body">
          <Checkbox
            checked={install}
            onChange={setInstall}
            label={tr("生成一行安装命令", "One-line install command")}
          />
          {tr("生成一行安装命令（否则只给引导文件）", "One-line install command (else a bootstrap file only)")}
        </label>
      </div>
    </Dialog>
  );
}

type DirectForm = { host: string; port: string; rate: string; tags: Chips; groups: string[] };

export function CreateNodeDialog({
  servers,
  groups,
  onClose,
  onShown,
}: {
  servers: ServerView[];
  groups: NodeGroup[];
  onClose: () => void;
  onShown: (s: Shown) => void;
}) {
  const tr = useTr();
  const { query } = useRoute();
  const [serverId, setServerId] = useState(query.get("server") ?? servers[0]?.id ?? "new");
  const server = servers.find((s) => s.id === serverId);
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [display, setDisplay] = useState("");
  const [visible, setVisible] = useState(true);
  const [domain, setDomain] = useState("");
  const [mode, setMode] = useState<"template" | "json">("template");
  const [tpl, setTpl] = useState<TemplateForm>(newTemplateForm());
  const [json, setJson] = useState('{\n  "protocol": "vless",\n  "port": 443\n}');
  const [direct, setDirect] = useState<DirectForm>({ host: "", port: "", rate: "1", tags: chips([]), groups: [] });
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const confirmFree = useConfirmFree();
  const nodeDomain = serverId === "new" ? domain : (server?.tls_domain ?? "");
  const spec = mode === "template" ? toSpec(tpl, tr, nodeDomain) : parseInbound(json, tr);
  const errors = {
    name: !name.trim() ? tr("请填写名称", "Enter a name") : undefined,
    inbound: typeof spec === "string" ? spec : undefined,
    port: num(direct.port, { ...PORT, optional: true }, tr)[1],
    rate:
      parseRate(direct.rate) === null
        ? tr(
            "请填写倍率：0–100，最多 3 位小数（留空不会当作 0）",
            "Enter a multiplier: 0–100, at most 3 decimals (empty is not 0)",
          )
        : undefined,
    tags: tagValues(direct.tags).length > 8 ? "tags" : undefined,
  };
  const count = tried ? Object.values(errors).filter(Boolean).length : 0;
  const submit = async () => {
    setTried(true);
    if (Object.values(errors).some(Boolean) || typeof spec === "string") return;
    const body: Record<string, unknown> = { name: name.trim(), region: region.trim() || undefined };
    if (serverId === "new") {
      body.tls_domain = domain.trim() || undefined;
      body.install = { origin: location.origin };
    } else body.server_id = serverId;
    if (mode === "template") body.template = spec;
    else body.inbound = spec;
    if (display.trim()) body.display_name = display.trim();
    if (!visible) body.visible = false;
    const rate = parseRate(direct.rate) ?? 1;
    if (rate === 0 && !(await confirmFree(tr("直连入口", "the direct entrance")))) return;
    const d: Record<string, unknown> = {};
    if (direct.host.trim()) d.connect_host = direct.host.trim();
    const [port] = num(direct.port, { ...PORT, optional: true }, tr);
    if (port !== null) d.connect_port = port;
    if (rate !== 1) d.rate = rate;
    if (direct.groups.length) d.group_ids = direct.groups;
    if (tagValues(direct.tags).length) d.tags = tagValues(direct.tags);
    if (Object.keys(d).length) body.direct = d;
    const r = await run(
      () => post<{ id: string; server_id: string; name: string } & Partial<Enrollment>>("/nodes", body),
      { ok: tr("节点已添加", "Node added") },
    );
    if (r) {
      onClose();
      if (r.enrollment_token && r.bootstrap && r.expires_at)
        onShown({
          created: {
            name: r.name,
            enrollment_token: r.enrollment_token,
            expires_at: r.expires_at,
            bootstrap: r.bootstrap,
            install: r.install,
          },
        });
    }
  };
  return (
    <Dialog
      open
      size="lg"
      icon={Layers}
      onClose={onClose}
      title={tr("添加落地节点", "Add a landing node")}
      description={tr(
        "一个节点一种协议；同一台服务器跑多种协议就建多个节点。",
        "One protocol per node; several protocols on a machine = several nodes.",
      )}
      onSubmit={submit}
      footer={
        <>
          <FixCount n={count} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("服务器", "Server")}>
            <Select value={serverId} onChange={(e) => setServerId(e.target.value)}>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              <option value="new">
                {tr("新服务器（同名，生成安装命令）", "A new server (same name, install command)")}
              </option>
            </Select>
          </Field>
          <Field
            label={tr("名称（内部，唯一）", "Name (internal, unique)")}
            required
            error={shown("", errors.name, tried)}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {serverId === "new" && (
            <Field label={tr("服务器域名（TLS，可选）", "Server domain (TLS, optional)")} className="sm:col-span-2">
              <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="node1.example.com" />
            </Field>
          )}
          <Field label={tr("地区（用户可见）", "Region (shown to users)")}>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} />
          </Field>
          <Field label={tr("显示名称（用户可见，可选）", "Display name (optional)")}>
            <Input value={display} onChange={(e) => setDisplay(e.target.value)} />
          </Field>
          <label className="flex min-h-9 items-center gap-2.5 text-body sm:col-span-2">
            <Switch checked={visible} onChange={setVisible} label={tr("对用户显示", "Shown to users")} />
            {tr("对用户显示", "Shown to users")}
          </label>
        </div>
        <SectionTitle
          actions={
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "template", label: tr("模板", "Template") },
                { value: "json", label: tr("高级 JSON", "Advanced JSON") },
              ]}
            />
          }
        >
          {tr("入站", "Inbound")}
        </SectionTitle>
        {mode === "template" ? (
          <TemplateFields form={tpl} onChange={setTpl} nodeDomain={nodeDomain} tried={tried} />
        ) : (
          <JsonInbound value={json} onChange={setJson} error={tried ? errors.inbound : undefined} />
        )}
        <SectionTitle>{tr("直连入口", "Direct entrance")}</SectionTitle>
        <DirectFields value={direct} onChange={setDirect} groups={groups} errors={errors} tried={tried} />
      </div>
    </Dialog>
  );
}

function DirectFields({
  value,
  onChange,
  groups,
  errors,
  tried,
}: {
  value: DirectForm;
  onChange: (v: DirectForm) => void;
  groups: NodeGroup[];
  errors: { port?: string; rate?: string };
  tried: boolean;
}) {
  const tr = useTr();
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Field label={tr("连接地址（留空 = 服务器域名）", "Dial host (empty = server domain)")} className="sm:col-span-2">
        <Input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value })} />
      </Field>
      <Field
        label={tr("连接端口（留空 = 入站端口）", "Dial port (empty = inbound's)")}
        error={shown(value.port, errors.port, tried)}
      >
        <Input inputMode="numeric" value={value.port} onChange={(e) => onChange({ ...value, port: e.target.value })} />
      </Field>
      <Field label={tr("倍率", "Multiplier")} error={shown(value.rate, errors.rate, tried)}>
        <Input inputMode="decimal" value={value.rate} onChange={(e) => onChange({ ...value, rate: e.target.value })} />
      </Field>
      <TagsField className="sm:col-span-2" value={value.tags} onChange={(v) => onChange({ ...value, tags: v })} />
      <div className="sm:col-span-3">
        <GroupPicker groups={groups} value={value.groups} onChange={(g) => onChange({ ...value, groups: g })} />
      </div>
    </div>
  );
}

type DomainCheck = {
  addresses: string[];
  expected: string[];
  matches: boolean | null;
  cloudflare: boolean;
  error: string | null;
};

const CAP: NumRule = { min: 1, max: 10_000_000, int: true, optional: true };

export function ServerEditDialog({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const tr = useTr();
  const errText = useErrText();
  const confirm = useConfirm();
  const [name, setName] = useState(server.name);
  const [domain, setDomain] = useState(server.tls_domain ?? "");
  const [cap, setCap] = useState(
    server.traffic_max_rate_bytes_per_sec ? String(Math.round(server.traffic_max_rate_bytes_per_sec / 125000)) : "",
  );
  const [check, setCheck] = useState<{ text: string; tone: "info" | "warning" | "danger" | "success" } | null>(null);
  const [checkRaw, setCheckRaw] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const [checking, setChecking] = useState(false);
  const nodeId = server.nodes[0]?.id;
  const [capV, capError] = num(cap, CAP, tr);
  const nameError = !name.trim() ? tr("请填写名称", "Enter a name") : undefined;
  const checkDomain = async () => {
    setChecking(true);
    setCheck({ text: tr("检查中…", "Checking…"), tone: "info" });
    setCheckRaw(null);
    try {
      const v = await post<DomainCheck>("/inbound-templates/check-domain", { domain: domain.trim(), node_id: nodeId });
      if (v.error) {
        setCheck({ text: tr("无法解析这个域名", "The domain does not resolve"), tone: "danger" });
        setCheckRaw(v.error);
      } else if (v.cloudflare)
        setCheck({
          text: tr(
            "解析到 Cloudflare（橙云）：自动证书与直连都会失败",
            "Resolves to Cloudflare (proxied): certificates and direct dialing fail",
          ),
          tone: "danger",
        });
      else if (v.matches === false)
        setCheck({
          text: tr(
            `域名未解析到本机 IP（${v.addresses.join(", ")} ≠ ${v.expected.join(", ")}）`,
            `Does not resolve to this server (${v.addresses.join(", ")} ≠ ${v.expected.join(", ")})`,
          ),
          tone: "warning",
        });
      else
        setCheck({
          text: tr(`解析正常：${v.addresses.join(", ")}`, `Resolves to ${v.addresses.join(", ")}`),
          tone: "success",
        });
    } catch (e) {
      setCheck({ text: errText(e), tone: "danger" });
    } finally {
      setChecking(false);
    }
  };
  const submit = async () => {
    setTried(true);
    if (nameError || capError) return;
    const body: Record<string, unknown> = {};
    if (name.trim() !== server.name) body.name = name.trim();
    if (domain.trim() !== (server.tls_domain ?? "")) body.tls_domain = domain.trim() || null;
    const capBytes = capV === null ? null : capV * 125000;
    if (capBytes !== server.traffic_max_rate_bytes_per_sec) body.traffic_max_rate_bytes_per_sec = capBytes;
    if (!Object.keys(body).length) return onClose();
    if ("tls_domain" in body) {
      const ok = await confirm({
        title: tr("修改服务器域名？", "Change the server domain?"),
        description: tr(
          "agent 会重建配置并断开在线连接；新域名的证书由 agent 自动申请。",
          "The agent rebuilds its configuration and drops live connections; it obtains the new domain's certificate itself.",
        ),
        tone: "warning",
      });
      if (!ok) return;
    }
    const r = await run(() => patch(`/servers/${server.id}`, body), { ok: tr("已保存", "Saved") });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      icon={Server}
      onClose={onClose}
      title={tr(`编辑服务器 ${server.name}`, `Edit ${server.name}`)}
      onSubmit={submit}
      footer={
        <>
          <FixCount n={tried ? [nameError, capError].filter(Boolean).length : 0} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={tr("名称", "Name")} required error={tried ? nameError : undefined}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field
          label={tr("服务器域名（TLS）", "Server domain (TLS)")}
          hint={tr(
            "修改会重建 agent 配置（断开连接）；留空 = 手动放置证书。",
            "A change rebuilds the agent's config (drops connections); empty = certificate files by hand.",
          )}
        >
          <div className="flex gap-2">
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} />
            <Button onClick={checkDomain} disabled={!domain.trim()} loading={checking} className="shrink-0">
              {tr("检查解析", "Check DNS")}
            </Button>
          </div>
        </Field>
        {check && (
          <div role="status">
            <Callout tone={check.tone}>
              {check.text}
              {checkRaw && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-footnote text-muted-foreground">
                    {tr("详细信息", "Details")}
                  </summary>
                  <p className="font-mono text-caption break-all">{checkRaw}</p>
                </details>
              )}
            </Callout>
          </div>
        )}
        <Field
          label={tr(
            "计费速率上限（上下行合计 Mbps，留空 = 默认）",
            "Billing rate cap (upload + download Mbps; empty = default)",
          )}
          error={shown(cap, capError, tried)}
          hint={tr(
            "这台服务器全部用户上行与下行之和的上限，超出部分不计费（防止 agent 被攻破后虚报）。按网卡带宽填写时请填带宽的 2 倍：1000 Mbps 全双工网卡填 2000，否则满载时会少计。默认 10000。",
            "Cap on the sum of all users' upload and download on this server; bytes above it are not billed (guards against a compromised agent over-reporting). If you size it by the NIC, enter twice its speed: 2000 for a 1000 Mbps full-duplex NIC, or a busy server is under-billed. Default 10000.",
          )}
        >
          <Input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="10000" />
        </Field>
      </div>
    </Dialog>
  );
}

const GiB = 1024 ** 3;
const QUOTA_GIB: NumRule = { min: 0, max: 1_000_000_000, above: true, optional: true };
const RESET_DAY: NumRule = { min: 1, max: 31, int: true, optional: true };

export function QuotaDialog({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const tr = useTr();
  const q = server.traffic_quota;
  const [mode, setMode] = useState<"both" | "up" | "down">(q.mode);
  const [gib, setGib] = useState(q.bytes ? String(+(q.bytes / GiB).toFixed(3)) : "");
  const [day, setDay] = useState(q.reset_day ? String(q.reset_day) : "1");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const [gibV, gibError] = num(gib, QUOTA_GIB, tr);
  const [dayV, dayError] = num(day, RESET_DAY, tr);
  const newBytes = gibV === null ? null : Math.round(gibV * GiB);
  const submit = async () => {
    setTried(true);
    if (gibError || dayError) return;
    const r = await run(
      () =>
        patch(`/servers/${server.id}`, {
          traffic_quota_bytes: newBytes,
          traffic_quota_mode: mode,
          traffic_quota_reset_day: dayV,
        }),
      { ok: tr("流量额度已保存", "Quota saved") },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      icon={Gauge}
      onClose={onClose}
      title={tr(`流量额度 · ${server.name}`, `Traffic quota · ${server.name}`)}
      description={tr(
        "按网卡流量计（与服务商账单一致）。超额后该服务器上所有节点下发空配置。",
        "Counted from the network interface (like the provider's bill). Over it every node on the server gets the empty state.",
      )}
      onSubmit={submit}
      footer={
        <>
          <FixCount n={tried ? [gibError, dayError].filter(Boolean).length : 0} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field group label={tr("计费方式", "What counts")}>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "both", label: tr("双向", "Both") },
              { value: "up", label: tr("仅上行", "Up only") },
              { value: "down", label: tr("仅下行", "Down only") },
            ]}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={tr("每周期额度（GiB，留空 = 不限）", "Quota per period (GiB; empty = none)")}
            error={shown(gib, gibError, tried)}
          >
            <Input inputMode="decimal" value={gib} onChange={(e) => setGib(e.target.value)} />
          </Field>
          <Field
            label={tr("每月重置日（1–31，留空 = 不重置）", "Monthly reset day (1–31; empty = never)")}
            error={shown(day, dayError, tried)}
            hint={tr("小月没有的日期按月末重置", "Short months reset on their last day")}
          >
            <Input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        </div>
        <KV
          items={[
            [tr("本周期已用", "Used this period"), bytes(q.used_bytes)],
            [tr("接收 / 发送", "Rx / tx"), `${bytes(q.rx_bytes)} / ${bytes(q.tx_bytes)}`],
            [tr("下次重置", "Next reset"), q.next_reset_at ? dateTime(q.next_reset_at) : tr("不重置", "never")],
          ]}
        />
        {q.exceeded_at && newBytes !== null && newBytes > q.used_bytes && (
          <Callout tone="success">
            {tr(
              "新额度高于已用：保存后立即恢复。",
              "The new quota is above the usage: the server is restored on save.",
            )}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}

export const ALERT_KINDS = [
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
] as const;

export function alertKindName(k: string, tr: Tr): string {
  return (
    (
      {
        offline: tr("服务器离线", "Server offline"),
        cpu: tr("CPU 过高", "High CPU"),
        memory: tr("内存过高", "High memory"),
        disk: tr("磁盘将满", "Disk filling up"),
        latency: tr("测速全部失败", "Every probe fails"),
        cert: tr("服务器证书即将到期", "Server certificate expiring"),
        agent_cert: tr("Agent 证书即将到期", "Agent certificate expiring"),
        last_error: tr("配置应用失败", "Apply failed"),
        entrance_down: tr("中转入口不可用", "Relay entrance down"),
        traffic_quota: tr("流量额度已用完", "Traffic quota used up"),
      } as Record<string, string>
    )[k] ?? k
  );
}

type Rules = {
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
const THRESHOLDS: [NumKey, NumRule][] = [
  ["offline_secs", { min: 30, max: 86_400, int: true, optional: true }],
  ["cpu_percent", { min: 1, max: 100, int: true, optional: true }],
  ["cpu_minutes", { min: 1, max: 60, int: true, optional: true }],
  ["mem_percent", { min: 1, max: 100, int: true, optional: true }],
  ["mem_minutes", { min: 1, max: 60, int: true, optional: true }],
  ["disk_percent", { min: 1, max: 100, int: true, optional: true }],
  ["cert_days", { min: 1, max: 90, int: true, optional: true }],
];

export function AlertRulesDialog({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["servers", server.id, "alert-rules"],
    queryFn: () => get<Rules>(`/servers/${server.id}/alert-rules`),
  });
  if (q.data) return <AlertRulesEditor server={server} rules={q.data} onClose={onClose} />;
  return (
    <Dialog
      open
      size="lg"
      icon={Bell}
      onClose={onClose}
      title={tr(`告警规则 · ${server.name}`, `Alert rules · ${server.name}`)}
      footer={<Button onClick={onClose}>{tr("关闭", "Close")}</Button>}
    >
      {q.isError ? <ErrorState compact error={q.error} onRetry={() => void q.refetch()} /> : <LoadingBlock rows={5} />}
    </Dialog>
  );
}

/** The loaded rules as strings while editing (an empty box is "use the global value", never NaN). */
function AlertRulesEditor({ server, rules, onClose }: { server: ServerView; rules: Rules; onClose: () => void }) {
  const tr = useTr();
  const [muted, setMuted] = useState(rules.muted);
  const [disabled, setDisabled] = useState<string[]>(rules.disabled);
  const [text, setText] = useState<Record<NumKey, string>>(
    () =>
      Object.fromEntries(THRESHOLDS.map(([k]) => [k, rules[k] === null ? "" : String(rules[k])])) as Record<
        NumKey,
        string
      >,
  );
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const label: Record<NumKey, string> = {
    offline_secs: tr("离线多少秒告警", "Offline seconds"),
    cpu_percent: tr("CPU %", "CPU %"),
    cpu_minutes: tr("CPU 持续分钟", "CPU minutes"),
    mem_percent: tr("内存 %", "Memory %"),
    mem_minutes: tr("内存持续分钟", "Memory minutes"),
    disk_percent: tr("磁盘 %", "Disk %"),
    cert_days: tr("证书剩余天数", "Certificate days"),
  };
  const parsed = THRESHOLDS.map(([k, rule]) => [k, ...num(text[k], rule, tr)] as const);
  const bad = parsed.filter(([, , e]) => e).length;
  const submit = async () => {
    setTried(true);
    if (bad) return;
    const body: Rules = { ...rules, muted, disabled };
    for (const [k, v] of parsed) body[k] = v;
    const r = await run(() => put(`/servers/${server.id}/alert-rules`, body), {
      ok: tr("告警规则已保存", "Alert rules saved"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="lg"
      icon={Bell}
      onClose={onClose}
      onSubmit={submit}
      title={tr(`告警规则 · ${server.name}`, `Alert rules · ${server.name}`)}
      description={tr("留空 = 使用全局设置（告警 → 告警设置）。", "Empty = the global value (Alerts → settings).")}
      footer={
        <>
          <FixCount n={tried ? bad : 0} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="flex min-h-9 items-center gap-2.5 text-body">
          <Switch checked={muted} onChange={setMuted} label={tr("静音", "Mute")} />
          {tr("静音此服务器的全部告警", "Mute every alert of this server")}
        </label>
        <fieldset>
          <legend className="mb-1.5 text-footnote font-medium text-muted-foreground">
            {tr("关闭的告警种类", "Kinds turned off")}
          </legend>
          <div className="flex flex-wrap gap-2">
            {ALERT_KINDS.map((k) => (
              <label
                key={k}
                className="flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-body ring-1 ring-border ring-inset"
              >
                <Checkbox
                  checked={disabled.includes(k)}
                  label={alertKindName(k, tr)}
                  onChange={(on) => setDisabled(on ? [...disabled, k] : disabled.filter((x) => x !== k))}
                />
                {alertKindName(k, tr)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {parsed.map(([k, , err]) => (
            <Field key={k} label={label[k]} error={shown(text[k], err, tried)}>
              <Input
                inputMode="numeric"
                value={text[k]}
                placeholder={tr("全局", "global")}
                onChange={(e) => setText({ ...text, [k]: e.target.value })}
              />
            </Field>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

type FullNode = {
  id: string;
  name: string;
  display_name: string | null;
  region: string | null;
  tags: string[];
  sort: number;
  visible: boolean;
  enabled: boolean;
  server_id: string;
  server_name: string;
  tls_domain: string | null;
  inbound: Record<string, unknown> | null;
  entrances: EntranceView[];
  warnings: string[];
};
type BlockStatus = {
  enabled: boolean;
  agent_supported: boolean;
  in_sync: boolean;
  error: string | null;
  days: { day: string; rule_id: number; name: string; hits: number }[];
};

/** A node: its display fields and inbound in one form, block rules and traffic on their own tab. */
export function NodeDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({ queryKey: ["nodes", "full", id], queryFn: () => get<FullNode>(`/nodes/${id}`) });
  useCrumb(q.data ? q.data.display_name || q.data.name : null);
  if (!q.data)
    return (
      <Dialog
        open
        size="lg"
        icon={Layers}
        onClose={onClose}
        title={tr("节点", "Node")}
        footer={<Button onClick={onClose}>{tr("关闭", "Close")}</Button>}
      >
        {q.isError ? (
          <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <LoadingBlock rows={6} />
        )}
      </Dialog>
    );
  return <NodeEditor key={q.data.id} n={q.data} onClose={onClose} />;
}

type NodeTab = "basic" | "inbound" | "traffic";
const SORT: NumRule = { min: -2_147_483_648, max: 2_147_483_647, int: true };

function NodeEditor({ n, onClose }: { n: FullNode; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const groups = useGroups();
  const plans = usePlanList();
  const [tab, setTab] = useState<NodeTab>("basic");
  const start = {
    name: n.name,
    display_name: n.display_name ?? "",
    region: n.region ?? "",
    sort: String(n.sort),
    visible: n.visible,
  };
  const [f, setF] = useState(start);
  const initialJson = JSON.stringify(n.inbound ?? {}, null, 2);
  const [mode, setMode] = useState<"view" | "template" | "json">("view");
  const [tpl, setTpl] = useState<TemplateForm>(newTemplateForm(String((n.inbound?.port as number | undefined) ?? 443)));
  const [json, setJson] = useState(initialJson);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useAction();
  const basicsChanged = JSON.stringify(f) !== JSON.stringify(start);
  const inboundEdited = mode === "template" || (mode === "json" && json !== initialJson);
  const nameError = !f.name.trim() ? tr("请填写名称", "Enter a name") : undefined;
  const [sortV, sortError] = num(f.sort, SORT, tr);
  const spec =
    mode === "template" ? toSpec(tpl, tr, n.tls_domain ?? "") : mode === "json" ? parseInbound(json, tr) : null;
  const inboundError = inboundEdited && typeof spec === "string" ? spec : undefined;
  const basicErrors = [nameError, sortError].filter(Boolean).length;
  const count = tried ? basicErrors + (inboundError ? 1 : 0) : 0;

  const save = async () => {
    setTried(true);
    setError(null);
    if (basicErrors) return setTab("basic");
    if (inboundError) return setTab("inbound");
    if (!basicsChanged && !inboundEdited) return onClose();
    let inbound: Record<string, unknown> | null = null;
    if (inboundEdited && spec && typeof spec !== "string") {
      if (mode === "template") {
        try {
          const r = await post<{ inbound: Record<string, unknown> }>("/inbound-templates/render", {
            template: spec,
            tls_domain: n.tls_domain ?? undefined,
          });
          inbound = r.inbound;
        } catch (e) {
          setTab("inbound");
          return setError(e);
        }
      } else inbound = spec;
      const before = n.inbound?.protocol;
      const after = inbound.protocol;
      if (n.inbound && String(before) !== String(after)) {
        const users =
          groups.data && plans.data
            ? holdersOf(
                n.entrances.map((e) => e.id),
                groups.data,
                plans.data,
              )
            : null;
        const ok = await confirm({
          title: tr(
            `把 ${n.name} 的协议从 ${String(before)} 换成 ${String(after)}？`,
            `Switch ${n.name} from ${String(before)} to ${String(after)}?`,
          ),
          description: tr(
            "协议变化会给这个节点的每个用户重新发放凭据：旧的订阅里的这条线路立即失效，用户刷新订阅后才能再连接。",
            "A new protocol issues new credentials to every user of this node: the line in old subscriptions stops working until users refresh their subscription.",
          ),
          impacts: [
            {
              label: tr("受影响的用户（按当前套餐估算）", "Users affected (estimated from current plans)"),
              value: users ?? tr("未知", "unknown"),
            },
            { label: tr("这个节点的入口", "Entrances of this node"), value: n.entrances.length },
          ],
          confirmLabel: tr("重新发放并保存", "Reissue and save"),
          tone: "danger",
        });
        if (!ok) return;
      }
    }
    const done = await run(
      async () => {
        if (basicsChanged)
          await patch(`/nodes/${n.id}`, {
            name: f.name.trim(),
            display_name: f.display_name.trim() || null,
            region: f.region.trim() || null,
            sort: sortV ?? 0,
            visible: f.visible,
          });
        if (inbound) await put(`/nodes/${n.id}/inbound`, { inbound });
        return true;
      },
      { ok: inbound ? tr("入站已保存，agent 将重建配置", "Inbound saved; the agent rebuilds") : tr("已保存", "Saved") },
    );
    if (done) onClose();
  };

  return (
    <Dialog
      open
      size="lg"
      icon={Layers}
      onClose={onClose}
      dirty={basicsChanged || inboundEdited}
      onSubmit={save}
      title={tr(`节点 · ${n.display_name || n.name}`, `Node · ${n.display_name || n.name}`)}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          {n.server_name}
          {n.inbound?.protocol ? <Badge tone="outline">{String(n.inbound.protocol)}</Badge> : null}
          {!n.enabled && <Badge>{tr("已停用", "Disabled")}</Badge>}
        </span>
      }
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={Activity}
          // Switching dialogs would drop unsaved edits without asking.
          disabled={basicsChanged || inboundEdited}
          onClick={() => navigate(`/nodes/${n.server_id}?tab=monitor`)}
        >
          <span className="max-sm:sr-only">{tr("服务器状态", "Server status")}</span>
        </Button>
      }
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          label={tr("节点", "Node")}
          tabs={[
            { value: "basic", label: tr("基本", "Basics") },
            { value: "inbound", label: tr("入站", "Inbound") },
            { value: "traffic", label: tr("审计与流量", "Rules and traffic") },
          ]}
        />
      }
      footer={
        <>
          <FixCount n={count} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <WarningList warnings={n.warnings} />
      {tab === "basic" && (
        <div className="mt-4 grid gap-4 first:mt-0 sm:grid-cols-2">
          <Field label={tr("名称（内部）", "Name (internal)")} required error={tried ? nameError : undefined}>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label={tr("显示名称", "Display name")}>
            <Input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
          </Field>
          <Field label={tr("地区", "Region")}>
            <Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} />
          </Field>
          <Field label={tr("排序", "Sort")} error={shown(f.sort, sortError, tried)}>
            <Input inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} />
          </Field>
          <label className="flex min-h-9 items-center gap-2.5 text-body sm:col-span-2">
            <Switch
              checked={f.visible}
              onChange={(v) => setF({ ...f, visible: v })}
              label={tr("对用户显示", "Shown to users")}
            />
            {tr(
              "对用户显示（隐藏的节点照常服务，只是不出现在订阅与门户里）",
              "Shown to users (a hidden node still serves; it is left out of subscriptions and the portal)",
            )}
          </label>
        </div>
      )}
      {tab === "inbound" && (
        <div className="mt-4 space-y-3 first:mt-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-footnote font-semibold text-muted-foreground">{tr("入站", "Inbound")}</span>
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "view", label: tr("查看", "View") },
                { value: "template", label: tr("从模板替换", "Replace from template") },
                { value: "json", label: tr("编辑 JSON", "Edit JSON") },
              ]}
            />
          </div>
          {mode === "view" && (
            <pre className="max-h-72 overflow-auto rounded-md bg-window p-3 font-mono text-caption">
              {n.inbound ? JSON.stringify(n.inbound, null, 2) : tr("（未配置）", "(none)")}
            </pre>
          )}
          {mode === "template" && (
            <TemplateFields form={tpl} onChange={setTpl} nodeDomain={n.tls_domain ?? ""} tried={tried} />
          )}
          {mode === "json" && <JsonInbound value={json} onChange={setJson} error={tried ? inboundError : undefined} />}
          {mode !== "view" && (
            <Callout tone="warning">
              {tr(
                "协议不变时用户保留凭据；协议变化会重新发放凭据（保存前会再确认，客户端需更新订阅）。保存后 agent 重建入站。",
                "Users keep their credentials when the protocol stays; a new protocol issues new ones (you confirm before it is saved; clients refresh the subscription). The agent rebuilds the inbound.",
              )}
            </Callout>
          )}
          <FormError error={error} />
        </div>
      )}
      {tab === "traffic" && (
        <div className="mt-4 first:mt-0">
          <BlockRulesStatus id={n.id} />
          <NodeTraffic id={n.id} />
        </div>
      )}
    </Dialog>
  );
}

function BlockRulesStatus({ id }: { id: string }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["nodes", id, "block-rules"],
    queryFn: () => get<BlockStatus>(`/nodes/${id}/block-rules`),
  });
  const d = q.data;
  const byRule = new Map<string, number>();
  for (const x of d?.days ?? []) byRule.set(x.name, (byRule.get(x.name) ?? 0) + x.hits);
  return (
    <>
      <SectionTitle>{tr("审计规则", "Block rules")}</SectionTitle>
      {q.isPending && <LoadingBlock rows={2} />}
      {q.isError && <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />}
      {d && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-body">
            <Badge tone={d.enabled ? "success" : "neutral"}>{d.enabled ? tr("已开启", "On") : tr("关闭", "Off")}</Badge>
            {!d.agent_supported && <Badge tone="warning">{tr("agent 不支持", "agent lacks support")}</Badge>}
            {d.enabled && (
              <Badge tone={d.in_sync ? "success" : "warning"}>
                {d.in_sync ? tr("已生效", "applied") : tr("等待 agent 应用", "waiting for the agent")}
              </Badge>
            )}
          </div>
          {d.error && (
            <details className="mt-2 text-body text-destructive">
              <summary className="cursor-pointer">
                {tr("agent 应用规则失败", "The agent failed to apply the rules")}
              </summary>
              <p className="font-mono text-caption break-all">{d.error}</p>
            </details>
          )}
          {byRule.size > 0 && (
            <ul className="mt-2 divide-y divide-separator rounded-lg text-body ring-1 ring-border ring-inset">
              {[...byRule].map(([name, hits]) => (
                <li key={name} className="flex justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate">{name}</span>
                  <span className="tnum shrink-0 text-muted-foreground">
                    {tr(`近 7 天拦截 ${hits} 次`, `${hits} blocked in 7 days`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function NodeTraffic({ id }: { id: string }) {
  const tr = useTr();
  const to = siteToday();
  const from = daysBefore(to, 29);
  const q = useQuery({
    queryKey: ["traffic", "node", id],
    queryFn: () =>
      get<{
        days: { day: string; up_bytes: number; down_bytes: number; billed_bytes: number }[];
        top_users: { user_id: string; email: string | null; billed_bytes: number }[];
      }>(`/nodes/${id}/traffic?from=${from}&to=${to}`),
  });
  const all: string[] = [];
  for (let i = 29; i >= 0; i--) all.push(daysBefore(to, i));
  const by = new Map((q.data?.days ?? []).map((r) => [r.day, r]));
  const times = all.map((d) => `${d}T12:00:00Z`);
  return (
    <>
      <SectionTitle>{tr("节点流量（近 30 天）", "Node traffic (30 days)")}</SectionTitle>
      {q.isError ? (
        <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
      ) : q.isPending ? (
        <LoadingBlock rows={4} />
      ) : (
        <>
          <TrendChart
            title={tr("每日流量", "Daily traffic")}
            times={times}
            {...timeLabels(times)}
            format={bytes}
            series={[
              { label: tr("下载", "Down"), values: all.map((d) => by.get(d)?.down_bytes ?? 0), slot: 1 },
              { label: tr("上传", "Up"), values: all.map((d) => by.get(d)?.up_bytes ?? 0), slot: 3 },
              { label: tr("计费", "Billed"), values: all.map((d) => by.get(d)?.billed_bytes ?? 0), slot: 4 },
            ]}
          />
          {q.data.top_users.length > 0 && (
            <>
              <div className="mt-3 mb-1 text-footnote font-medium text-muted-foreground">
                {tr("用量最高的用户", "Top users")}
              </div>
              <ul className="divide-y divide-separator rounded-lg text-body ring-1 ring-border ring-inset">
                {q.data.top_users.map((u) => (
                  <li key={u.user_id} className="flex justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 truncate">{u.email ?? tr("已删除的用户", "Deleted user")}</span>
                    <span className="tnum shrink-0 text-muted-foreground">{bytes(u.billed_bytes)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}

/**
 * Every dialog of the nodes area, mounted from the URL: `?new=server|node|relay`
 * (`&server=` preselects, `&for=<node>` the relay's node), `?node=<id>`,
 * `?entrance=<id>`, `?action=install|enroll` (on a server page).
 */
export function NodesDialogs({ serverId }: { serverId?: string }) {
  const { query } = useRoute();
  const servers = useServers();
  const groups = useGroups();
  const [shown, setShown] = useState<Shown | null>(null);
  const list = servers.data ?? [];
  const creating = query.get("new");
  const action = query.get("action");
  const server = serverId ? list.find((s) => s.id === serverId) : undefined;
  const nodeId = query.get("node");
  const entId = query.get("entrance");
  const forId = query.get("for");
  let ent: { e: EntranceView; n: ServerView["nodes"][number]; s: ServerView } | null = null;
  let forNode: ServerView["nodes"][number] | undefined;
  for (const s of list)
    for (const n of s.nodes) {
      if (n.id === forId) forNode = n;
      for (const e of n.entrances) if (e.id === entId) ent = { e, n, s };
    }
  return (
    <>
      {creating === "server" && <CreateServerDialog onClose={() => setQuery({ new: null })} onShown={setShown} />}
      {creating === "node" && servers.isSuccess && (
        <CreateNodeDialog
          servers={list}
          groups={groups.data ?? []}
          onClose={() => setQuery({ new: null, server: null })}
          onShown={setShown}
        />
      )}
      {creating === "relay" && servers.isSuccess && (
        <RelayDialog
          node={forNode}
          servers={forNode ? undefined : list}
          groups={groups.data ?? []}
          onClose={() => setQuery({ new: null, for: null })}
        />
      )}
      {server && (action === "install" || action === "enroll") && (
        <InstallDialog
          key={action}
          shown={{ server, mode: action === "install" ? "install" : "bootstrap" }}
          onClose={() => setQuery({ action: null })}
        />
      )}
      {shown && <InstallDialog shown={shown} onClose={() => setShown(null)} />}
      {nodeId && <NodeDialog id={nodeId} onClose={() => setQuery({ node: null, ntab: null })} />}
      {ent && (
        <EntranceDialog
          key={ent.e.id}
          entrance={ent.e}
          node={ent.n}
          server={ent.s}
          groups={groups.data ?? []}
          onClose={() => setQuery({ entrance: null, etab: null })}
        />
      )}
    </>
  );
}
