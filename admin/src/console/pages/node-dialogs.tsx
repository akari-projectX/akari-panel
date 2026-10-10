// Node and server forms (NOD-03…07, 09…14, 20): add server / node,
// install command and bootstrap file, server edit (TLS domain check),
// D5 quota, per-server alert rules, and the node drawer (basics, the
// inbound, block rules status, traffic).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { get, patch, post, put } from "../../shared/api";
import { bytes, dateTime, daysBefore, downloadText, siteToday } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { LineChart } from "../../shared/ui/line-chart";
import { Dialog, Drawer } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  Input,
  KV,
  Segmented,
  Select,
  Skeleton,
  Switch,
} from "../../shared/ui/primitives";
import { CopyButton, FormError, Mono, SectionTitle, useConfirmFree, useErrText, useRun } from "../kit";
import { parseRate } from "../rates";
import { setQuery, useRoute } from "../router";
import type { NodeGroup, ServerView } from "../types";
import { JsonInbound, TemplateFields, newTemplateForm, parseInbound, toSpec, type TemplateForm } from "./inbound-form";

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
    <div className="space-y-3 text-[13px]">
      <div className="flex items-center justify-between gap-2">
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
        <p className="text-xs text-muted-foreground">
          {tr(`命令钉住了面板证书公钥：${v.pin}`, `The command pins the panel's key: ${v.pin}`)}
        </p>
      )}
      {v.warnings.length > 0 && (
        <Callout tone="warning">
          <ul className="list-disc pl-4">
            {v.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Callout>
      )}
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
    <div className="space-y-2 text-[13px]">
      <div className="flex items-center justify-between">
        <span>{tr("引导文件（含一次性注册令牌，不含私钥）", "Bootstrap file (a one-time token, no private key)")}</span>
        <Countdown until={e.expires_at} />
      </div>
      <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px]">{e.bootstrap}</pre>
      <div className="flex gap-2">
        <CopyButton text={e.bootstrap} />
        <Button size="sm" icon="download" onClick={() => downloadText(`${e.name}-bootstrap.toml`, e.bootstrap)}>
          {tr("下载", "Download")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {tr("在服务器上执行：akari-agent -config <文件>", "On the server: akari-agent -config <file>")}
      </p>
    </div>
  );
}

/** Shows install material: a fresh install link / bootstrap token for an existing server, or what a create returned. */
export function InstallDialog({ shown, onClose }: { shown: Shown; onClose: () => void }) {
  const tr = useTr();
  const errText = useErrText();
  const [data, setData] = useState<{ install?: InstallView; enrollment?: Enrollment } | null>(
    "created" in shown ? { install: shown.created.install, enrollment: shown.created } : null,
  );
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);
  useEffect(() => {
    if ("created" in shown || started.current) return;
    started.current = true;
    const req =
      shown.mode === "install"
        ? post<InstallView>(`/servers/${shown.server.id}/install`, { origin: location.origin }).then((install) => ({
            install,
          }))
        : post<Enrollment>(`/servers/${shown.server.id}/enroll-token`).then((enrollment) => ({ enrollment }));
    req.then(setData, setError);
  }, [shown]);
  const name = "created" in shown ? shown.created.name : shown.server.name;
  const bootstrapOnly = !("created" in shown) && shown.mode === "bootstrap";
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={
        bootstrapOnly
          ? tr(`手动引导文件 · ${name}`, `Bootstrap file · ${name}`)
          : tr(`安装 agent · ${name}`, `Install the agent · ${name}`)
      }
      description={tr(
        "只显示这一次；关闭后可重新生成（旧的未使用令牌作废）。",
        "Shown once; you can issue a new one later (the unused one is replaced).",
      )}
      footer={<Button onClick={onClose}>{tr("完成", "Done")}</Button>}
    >
      {!data && !error && <Skeleton className="h-24" />}
      {!!error && <p className="text-[13px] text-destructive">{errText(error)}</p>}
      {data?.install && <InstallBody v={data.install} />}
      {data?.enrollment &&
        (data.install ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-[13px] text-muted-foreground">
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
  const [run, busy] = useRun();
  const submit = async () => {
    const r = await run(
      () =>
        post<Enrollment>("/servers", {
          name: name.trim(),
          tls_domain: domain.trim() || undefined,
          install: install ? { origin: location.origin } : undefined,
        }),
      { ok: tr("服务器已添加", "Server added"), invalidate: [["servers"]] },
    );
    if (r) {
      onClose();
      onShown({ created: r });
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("添加服务器", "Add server")}
      description={tr(
        "一台机器一个 agent；之后在它上面添加节点。",
        "One agent per machine; add nodes on it afterwards.",
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={tr("名称（内部，唯一）", "Name (internal, unique)")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
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
        <label className="flex items-center gap-2 text-[13px]">
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

type DirectForm = { host: string; port: string; rate: string; tags: string; groups: string[] };

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
  const [direct, setDirect] = useState<DirectForm>({ host: "", port: "", rate: "1", tags: "", groups: [] });
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const confirmFree = useConfirmFree();
  const submit = async () => {
    const body: Record<string, unknown> = { name: name.trim(), region: region.trim() || undefined };
    if (serverId === "new") {
      body.tls_domain = domain.trim() || undefined;
      body.install = { origin: location.origin };
    } else body.server_id = serverId;
    if (mode === "template") {
      const spec = toSpec(tpl, tr, serverId === "new" ? domain : (server?.tls_domain ?? ""));
      if (typeof spec === "string") return setError(new Error(spec));
      body.template = spec;
    } else {
      const ib = parseInbound(json, tr);
      if (typeof ib === "string") return setError(new Error(ib));
      body.inbound = ib;
    }
    if (display.trim()) body.display_name = display.trim();
    if (!visible) body.visible = false;
    const rate = parseRate(direct.rate);
    if (rate === null)
      return setError(
        new Error(
          tr(
            "请填写直连入口的倍率：0–100，最多 3 位小数（留空不会当作 0）",
            "Enter the direct entrance's multiplier: 0–100, at most 3 decimals (empty is not 0)",
          ),
        ),
      );
    if (rate === 0 && !(await confirmFree(tr("直连入口", "the direct entrance")))) return;
    const d: Record<string, unknown> = {};
    if (direct.host.trim()) d.connect_host = direct.host.trim();
    if (direct.port.trim()) d.connect_port = Number(direct.port);
    if (rate !== 1) d.rate = rate;
    if (direct.groups.length) d.group_ids = direct.groups;
    if (splitTags(direct.tags).length) d.tags = splitTags(direct.tags);
    if (Object.keys(d).length) body.direct = d;
    setError(null);
    const r = await run(
      () => post<{ id: string; server_id: string; name: string } & Partial<Enrollment>>("/nodes", body),
      {
        ok: tr("节点已添加", "Node added"),
        invalidate: [["servers"]],
      },
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
      wide
      onClose={onClose}
      title={tr("添加落地节点", "Add a landing node")}
      description={tr(
        "一个节点一种协议（D2）；同一台服务器跑多种协议就建多个节点。",
        "One protocol per node (D2); several protocols on a machine = several nodes.",
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
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
          <Field label={tr("名称（内部，唯一）", "Name (internal, unique)")}>
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
          <div className="flex items-end gap-2 pb-2 text-[13px]">
            <Switch checked={visible} onChange={setVisible} label={tr("对用户显示", "Shown to users")} />
            {tr("对用户显示", "Shown to users")}
          </div>
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
          <TemplateFields
            form={tpl}
            onChange={setTpl}
            nodeDomain={serverId === "new" ? domain : (server?.tls_domain ?? "")}
          />
        ) : (
          <JsonInbound value={json} onChange={setJson} />
        )}
        <SectionTitle>{tr("直连入口", "Direct entrance")}</SectionTitle>
        <DirectFields value={direct} onChange={setDirect} groups={groups} />
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function DirectFields({
  value,
  onChange,
  groups,
}: {
  value: DirectForm;
  onChange: (v: DirectForm) => void;
  groups: NodeGroup[];
}) {
  const tr = useTr();
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label={tr("连接地址（留空 = 服务器域名）", "Dial host (empty = server domain)")} className="sm:col-span-2">
        <Input value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value })} />
      </Field>
      <Field label={tr("连接端口（留空 = 入站端口）", "Dial port (empty = inbound's)")}>
        <Input inputMode="numeric" value={value.port} onChange={(e) => onChange({ ...value, port: e.target.value })} />
      </Field>
      <Field label={tr("倍率", "Multiplier")}>
        <Input inputMode="decimal" value={value.rate} onChange={(e) => onChange({ ...value, rate: e.target.value })} />
      </Field>
      <TagsField value={value.tags} onChange={(v) => onChange({ ...value, tags: v })} />
      <div className="sm:col-span-2">
        <GroupPicker groups={groups} value={value.groups} onChange={(g) => onChange({ ...value, groups: g })} />
      </div>
    </div>
  );
}

/** "IPLC, 原生" → ["IPLC", "原生"] (the panel trims and deduplicates). */
export function splitTags(v: string): string[] {
  return v
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function TagsField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const tr = useTr();
  return (
    <Field
      label={tr("标签（逗号分隔，用户可见）", "Tags (comma separated, shown to users)")}
      hint={tr(
        "显示在订阅线路名与门户线路列表里节点名之后，只属于这个入口（最多 8 个）。",
        "Shown after the node's name in subscriptions and the portal's line list; this entrance only (at most 8).",
      )}
    >
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="IPLC" />
    </Field>
  );
}

export function GroupPicker({
  groups,
  value,
  onChange,
}: {
  groups: NodeGroup[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const tr = useTr();
  return (
    <fieldset>
      <legend className="mb-1.5 text-[13px] font-medium">{tr("节点组", "Node groups")}</legend>
      {groups.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {tr("还没有节点组（在「套餐 → 节点组」创建）。", "No node groups yet (Plans → Node groups).")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <label
              key={g.id}
              className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[13px]"
            >
              <Checkbox
                checked={value.includes(g.id)}
                label={g.name}
                onChange={(on) => onChange(on ? [...value, g.id] : value.filter((x) => x !== g.id))}
              />
              {g.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

export function ServerEditDialog({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const tr = useTr();
  const errText = useErrText();
  const [name, setName] = useState(server.name);
  const [domain, setDomain] = useState(server.tls_domain ?? "");
  const [cap, setCap] = useState(
    server.traffic_max_rate_bytes_per_sec ? String(Math.round(server.traffic_max_rate_bytes_per_sec / 125000)) : "",
  );
  const [check, setCheck] = useState<string | null>(null);
  const [run, busy] = useRun();
  const nodeId = server.nodes[0]?.id;
  const checkDomain = async () => {
    setCheck(tr("检查中…", "Checking…"));
    try {
      const v = await post<{
        addresses: string[];
        expected: string[];
        matches: boolean | null;
        cloudflare: boolean;
        error: string | null;
      }>("/inbound-templates/check-domain", { domain: domain.trim(), node_id: nodeId });
      setCheck(
        v.error
          ? v.error
          : v.cloudflare
            ? tr(
                "解析到 Cloudflare（橙云）：自动证书与直连都会失败",
                "Resolves to Cloudflare (proxied): certificates and direct dialing fail",
              )
            : v.matches === false
              ? tr(
                  `域名未解析到本机 IP（${v.addresses.join(", ")} ≠ ${v.expected.join(", ")}）`,
                  `Does not resolve to this server (${v.addresses.join(", ")} ≠ ${v.expected.join(", ")})`,
                )
              : tr(`解析正常：${v.addresses.join(", ")}`, `Resolves to ${v.addresses.join(", ")}`),
      );
    } catch (e) {
      setCheck(errText(e));
    }
  };
  const submit = async () => {
    const body: Record<string, unknown> = {};
    if (name.trim() !== server.name) body.name = name.trim();
    if (domain.trim() !== (server.tls_domain ?? "")) body.tls_domain = domain.trim() || null;
    const capV = cap.trim() ? Number(cap) * 125000 : null;
    if (capV !== server.traffic_max_rate_bytes_per_sec) body.traffic_max_rate_bytes_per_sec = capV;
    if (!Object.keys(body).length) return onClose();
    const r = await run(() => patch(`/servers/${server.id}`, body), {
      ok: tr("已保存", "Saved"),
      invalidate: [["servers"]],
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr(`编辑服务器 ${server.name}`, `Edit ${server.name}`)}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={tr("名称", "Name")}>
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
            <Button onClick={checkDomain} disabled={!domain.trim()}>
              {tr("检查解析", "Check DNS")}
            </Button>
          </div>
        </Field>
        {check && (
          <p role="status" className="text-xs text-muted-foreground">
            {check}
          </p>
        )}
        <Field
          label={tr(
            "计费速率上限（上下行合计 Mbps，留空 = 默认）",
            "Billing rate cap (upload + download Mbps; empty = default)",
          )}
          hint={tr(
            "这台服务器全部用户上行与下行之和的上限，超出部分不计费（防止 agent 被攻破后虚报）。按网卡带宽填写时请填带宽的 2 倍：1000 Mbps 全双工网卡填 2000，否则满载时会少计。默认 10000。",
            "Cap on the sum of all users' upload and download on this server; bytes above it are not billed (guards against a compromised agent over-reporting). If you size it by the NIC, enter twice its speed: 2000 for a 1000 Mbps full-duplex NIC, or a busy server is under-billed. Default 10000.",
          )}
        >
          <Input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

export function QuotaDialog({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const tr = useTr();
  const q = server.traffic_quota;
  const GiB = 1024 ** 3;
  const [mode, setMode] = useState<"both" | "up" | "down">(q.mode);
  const [gib, setGib] = useState(q.bytes ? String(Math.round(q.bytes / GiB)) : "");
  const [day, setDay] = useState(q.reset_day ? String(q.reset_day) : "1");
  const [run, busy] = useRun();
  const newBytes = gib.trim() ? Number(gib) * GiB : null;
  const submit = async () => {
    const r = await run(
      () =>
        patch(`/servers/${server.id}`, {
          traffic_quota_bytes: newBytes,
          traffic_quota_mode: mode,
          traffic_quota_reset_day: day ? Number(day) : null,
        }),
      { ok: tr("流量额度已保存", "Quota saved"), invalidate: [["servers"]] },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr(`流量额度 · ${server.name}`, `Traffic quota · ${server.name}`)}
      description={tr(
        "按网卡流量计（与服务商账单一致）。超额后该服务器上所有节点下发空配置。",
        "Counted from the network interface (like the provider's bill). Over it every node on the server gets the empty state.",
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
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
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr("每周期额度（GiB，留空 = 不限）", "Quota per period (GiB; empty = none)")}>
            <Input inputMode="numeric" value={gib} onChange={(e) => setGib(e.target.value)} />
          </Field>
          <Field label={tr("每月重置日（1–31，留空 = 不重置）", "Monthly reset day (1–31; empty = never)")}>
            <Input inputMode="numeric" value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
        </div>
        <KV
          items={[
            [tr("本周期已用", "Used this period"), bytes(q.used_bytes)],
            [tr("接收 / 发送", "Rx / tx"), `${bytes(q.rx_bytes)} / ${bytes(q.tx_bytes)}`],
            [tr("下次重置", "Next reset"), dateTime(q.next_reset_at)],
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

const ALERT_KINDS = [
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
const NUM_KEYS = [
  "offline_secs",
  "cpu_percent",
  "cpu_minutes",
  "mem_percent",
  "mem_minutes",
  "disk_percent",
  "cert_days",
] as const;

export function AlertRulesDialog({ server, onClose }: { server: ServerView; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["servers", server.id, "alert-rules"],
    queryFn: () => get<Rules>(`/servers/${server.id}/alert-rules`),
  });
  const [form, setForm] = useState<Rules | null>(null);
  useEffect(() => {
    if (q.data && !form) setForm(q.data);
  }, [q.data, form]);
  const [run, busy] = useRun();
  const label: Record<(typeof NUM_KEYS)[number], string> = {
    offline_secs: tr("离线多少秒告警", "Offline seconds"),
    cpu_percent: tr("CPU %", "CPU %"),
    cpu_minutes: tr("CPU 持续分钟", "CPU minutes"),
    mem_percent: tr("内存 %", "Memory %"),
    mem_minutes: tr("内存持续分钟", "Memory minutes"),
    disk_percent: tr("磁盘 %", "Disk %"),
    cert_days: tr("证书剩余天数", "Certificate days"),
  };
  const submit = async () => {
    if (!form) return;
    const r = await run(() => put(`/servers/${server.id}/alert-rules`, form), {
      ok: tr("告警规则已保存", "Alert rules saved"),
      invalidate: [["servers"]],
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={tr(`告警规则 · ${server.name}`, `Alert rules · ${server.name}`)}
      description={tr("留空 = 使用全局设置（告警 → 告警设置）。", "Empty = the global value (Alerts → settings).")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!form}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      {!form ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-[13px]">
            <Switch checked={form.muted} onChange={(v) => setForm({ ...form, muted: v })} label={tr("静音", "Mute")} />
            {tr("静音此服务器的全部告警", "Mute every alert of this server")}
          </label>
          <fieldset>
            <legend className="mb-1.5 text-[13px] font-medium">{tr("关闭的告警种类", "Kinds turned off")}</legend>
            <div className="flex flex-wrap gap-2">
              {ALERT_KINDS.map((k) => (
                <label
                  key={k}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[13px]"
                >
                  <Checkbox
                    checked={form.disabled.includes(k)}
                    label={alertKindName(k, tr)}
                    onChange={(on) =>
                      setForm({ ...form, disabled: on ? [...form.disabled, k] : form.disabled.filter((x) => x !== k) })
                    }
                  />
                  {alertKindName(k, tr)}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-4">
            {NUM_KEYS.map((k) => (
              <Field key={k} label={label[k]}>
                <Input
                  inputMode="numeric"
                  value={form[k] ?? ""}
                  onChange={(e) => setForm({ ...form, [k]: e.target.value.trim() ? Number(e.target.value) : null })}
                />
              </Field>
            ))}
          </div>
        </div>
      )}
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
  warnings: string[];
};
type BlockStatus = {
  enabled: boolean;
  agent_supported: boolean;
  in_sync: boolean;
  error: string | null;
  days: { day: string; rule_id: number; name: string; hits: number }[];
};

export function NodeDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({ queryKey: ["nodes", "full", id], queryFn: () => get<FullNode>(`/nodes/${id}`) });
  const n = q.data;
  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-2xl"
      title={n ? n.display_name || n.name : tr("节点", "Node")}
      subtitle={n && `${n.server_name} · ${n.id}`}
    >
      {q.isPending && <Skeleton className="h-64" />}
      <FormError error={q.error} />
      {n && (
        <>
          {n.warnings.length > 0 && (
            <Callout tone="warning">
              <ul className="list-disc pl-4">
                {n.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Callout>
          )}
          <NodeBasics n={n} onSaved={() => void q.refetch()} />
          <NodeInbound n={n} onSaved={() => void q.refetch()} />
          <BlockRulesStatus id={id} />
          <NodeTraffic id={id} />
          <div className="mt-6">
            <Button size="sm" onClick={() => setQuery({ open: `server:${n.server_id}` })}>
              {tr("服务器状态", "Server status")}
            </Button>
          </div>
        </>
      )}
    </Drawer>
  );
}

function NodeBasics({ n, onSaved }: { n: FullNode; onSaved: () => void }) {
  const tr = useTr();
  const [f, setF] = useState({
    name: n.name,
    display_name: n.display_name ?? "",
    region: n.region ?? "",
    sort: String(n.sort),
    visible: n.visible,
  });
  const [run, busy] = useRun();
  const save = async () => {
    const r = await run(
      () =>
        patch(`/nodes/${n.id}`, {
          name: f.name.trim(),
          display_name: f.display_name.trim() || null,
          region: f.region.trim() || null,
          sort: Number(f.sort) || 0,
          visible: f.visible,
        }),
      { ok: tr("已保存", "Saved"), invalidate: [["servers"]] },
    );
    if (r !== undefined) onSaved();
  };
  return (
    <>
      <SectionTitle>{tr("展示", "Display")}</SectionTitle>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("名称（内部）", "Name (internal)")}>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={tr("显示名称", "Display name")}>
          <Input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
        </Field>
        <Field label={tr("地区", "Region")}>
          <Input value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })} />
        </Field>
        <Field label={tr("排序", "Sort")}>
          <Input inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} />
        </Field>
        <div className="flex items-end gap-2 pb-2 text-[13px]">
          <Switch
            checked={f.visible}
            onChange={(v) => setF({ ...f, visible: v })}
            label={tr("对用户显示", "Shown to users")}
          />
          {tr("对用户显示", "Shown to users")}
        </div>
      </div>
      <div className="mt-3">
        <Button size="sm" variant="primary" loading={busy} onClick={save}>
          {tr("保存展示设置", "Save display")}
        </Button>
      </div>
    </>
  );
}

function NodeInbound({ n, onSaved }: { n: FullNode; onSaved: () => void }) {
  const tr = useTr();
  const errText = useErrText();
  const [mode, setMode] = useState<"view" | "template" | "json">("view");
  const [tpl, setTpl] = useState<TemplateForm>(newTemplateForm(String((n.inbound?.port as number | undefined) ?? 443)));
  const [json, setJson] = useState(JSON.stringify(n.inbound ?? {}, null, 2));
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const save = async () => {
    setError(null);
    let inbound: Record<string, unknown>;
    if (mode === "template") {
      const spec = toSpec(tpl, tr, n.tls_domain ?? "");
      if (typeof spec === "string") return setError(new Error(spec));
      try {
        const r = await post<{ inbound: Record<string, unknown> }>("/inbound-templates/render", {
          template: spec,
          tls_domain: n.tls_domain ?? undefined,
        });
        inbound = r.inbound;
      } catch (e) {
        return setError(e);
      }
    } else {
      const v = parseInbound(json, tr);
      if (typeof v === "string") return setError(new Error(v));
      inbound = v;
    }
    const r = await run(() => put(`/nodes/${n.id}/inbound`, { inbound }), {
      ok: tr("入站已保存，agent 将重建配置", "Inbound saved; the agent rebuilds"),
      invalidate: [["servers"]],
    });
    if (r !== undefined) {
      setMode("view");
      onSaved();
    }
  };
  return (
    <>
      <SectionTitle
        actions={
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
        }
      >
        {tr("入站", "Inbound")}
      </SectionTitle>
      {mode === "view" && (
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-[11px]">
          {n.inbound ? JSON.stringify(n.inbound, null, 2) : tr("（未配置）", "(none)")}
        </pre>
      )}
      {mode === "template" && <TemplateFields form={tpl} onChange={setTpl} nodeDomain={n.tls_domain ?? ""} />}
      {mode === "json" && <JsonInbound value={json} onChange={setJson} />}
      {mode !== "view" && (
        <div className="mt-3 space-y-2">
          <Callout tone="warning">
            {tr(
              "协议不变时用户保留凭据；协议变化会重新发放凭据（客户端需更新订阅）。保存后 agent 重建入站。",
              "Users keep their credentials when the protocol stays; a new protocol issues new ones (clients refresh the subscription). The agent rebuilds the inbound.",
            )}
          </Callout>
          {!!error && <p className="text-[13px] text-destructive">{errText(error)}</p>}
          <Button size="sm" variant="primary" loading={busy} onClick={save}>
            {tr("保存入站", "Save inbound")}
          </Button>
        </div>
      )}
    </>
  );
}

function BlockRulesStatus({ id }: { id: string }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["nodes", id, "block-rules"],
    queryFn: () => get<BlockStatus>(`/nodes/${id}/block-rules`),
  });
  const d = q.data;
  if (!d) return null;
  const byRule = new Map<string, number>();
  for (const x of d.days) byRule.set(x.name, (byRule.get(x.name) ?? 0) + x.hits);
  return (
    <>
      <SectionTitle>{tr("审计规则", "Block rules")}</SectionTitle>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge tone={d.enabled ? "success" : "neutral"}>{d.enabled ? tr("已开启", "On") : tr("关闭", "Off")}</Badge>
        {!d.agent_supported && <Badge tone="warning">{tr("agent 不支持", "agent lacks support")}</Badge>}
        {d.enabled && (
          <Badge tone={d.in_sync ? "success" : "warning"}>
            {d.in_sync ? tr("已生效", "applied") : tr("等待 agent 应用", "waiting for the agent")}
          </Badge>
        )}
        {d.error && <span className="text-destructive">{d.error}</span>}
      </div>
      {byRule.size > 0 && (
        <ul className="mt-2 text-[13px]">
          {[...byRule].map(([name, hits]) => (
            <li key={name} className="flex justify-between">
              <span>{name}</span>
              <span className="tabular-nums text-muted-foreground">
                {tr(`近 7 天拦截 ${hits} 次`, `${hits} blocked in 7 days`)}
              </span>
            </li>
          ))}
        </ul>
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
  return (
    <>
      <SectionTitle>{tr("节点流量（近 30 天）", "Node traffic (30 days)")}</SectionTitle>
      <LineChart
        title={tr("每日流量", "Daily traffic")}
        times={all.map((d) => `${d}T12:00:00Z`)}
        format={bytes}
        series={[
          {
            label: tr("下载", "Down"),
            values: all.map((d) => by.get(d)?.down_bytes ?? 0),
            stroke: "stroke-sky-500",
            swatch: "bg-sky-500",
          },
          {
            label: tr("上传", "Up"),
            values: all.map((d) => by.get(d)?.up_bytes ?? 0),
            stroke: "stroke-emerald-500",
            swatch: "bg-emerald-500",
          },
          {
            label: tr("计费", "Billed"),
            values: all.map((d) => by.get(d)?.billed_bytes ?? 0),
            stroke: "stroke-amber-500",
            swatch: "bg-amber-500",
          },
        ]}
      />
      {(q.data?.top_users.length ?? 0) > 0 && (
        <>
          <div className="mb-1 mt-3 text-xs font-medium text-muted-foreground">{tr("用量最高的用户", "Top users")}</div>
          <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
            {q.data?.top_users.map((u) => (
              <li key={u.user_id} className="flex justify-between px-3 py-1.5">
                <span>{u.email ?? tr("已删除的用户", "Deleted user")}</span>
                <span className="tabular-nums text-muted-foreground">{bytes(u.billed_bytes)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
