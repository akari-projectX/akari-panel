// 系统设置 → 节点：安装与证书 (SET-20), 测速与健康检查 (SET-21), 出站拦截规则
// (SET-22, formerly 审计规则; rule sets are created and edited in a dialog,
// switches and order go through the save bar) and 更新源与验签 (UPD-01's
// source and automatic check, the extra release keys of SET-09). Turning the
// panel TCP probe off and adding or removing release keys are confirmed on
// save.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { del, get, patch, post, put } from "../../shared/api";
import { dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Group } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Select, Switch, Textarea } from "../../shared/ui/form";
import { EmptyState } from "../../shared/ui/states";
import { settled, useAction } from "../data";
import { fresh, useSettings, type SettingsView } from "./settings-data";
import {
  DangerZone,
  FieldRow,
  InfoRow,
  Loaded,
  SwitchRow,
  intError,
  intOf,
  lines,
  urlError,
  useDraft,
  useSavePart,
} from "./settings-kit";

// ---------------------------------------------------------------------------
// 安装与证书
// ---------------------------------------------------------------------------

export function InstallSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <InstallForm d={d} />}</Loaded>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function InstallForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const o = d.node_ops;
  const f = useDraft({
    pin: o.install_tls_pin ?? "",
    fallback: o.install_fallback_url ?? "",
    noFallback: o.install_fallback_url === "",
    acmeUrl: o.acme_directory_url ?? "",
    acmeEmail: o.acme_email ?? "",
    remove: o.remove_mode.value ?? "",
  });
  const v = f.value!;
  const pinError =
    v.pin.trim() && !/^sha256\/\/[A-Za-z0-9+/=]{20,}$/.test(v.pin.trim())
      ? tr("格式为 sha256//<base64>", "Format: sha256//<base64>")
      : undefined;
  const fallbackError = v.noFallback ? undefined : urlError(v.fallback.replace("{arch}", "amd64"), tr);
  const acmeError = urlError(v.acmeUrl, tr);
  const emailError =
    v.acmeEmail.trim() && !EMAIL.test(v.acmeEmail.trim()) ? tr("邮箱格式不对", "Not an email address") : undefined;
  useSavePart({
    count: f.edited.length,
    errors: [pinError, fallbackError, acmeError, emailError].filter(Boolean).length,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/nodes", {
            version: cur.version,
            install_tls_pin: v.pin.trim() || null,
            install_fallback_url: v.noFallback ? null : v.fallback.trim() || null,
            install_fallback_disabled: v.noFallback,
            acme_directory_url: v.acmeUrl.trim() || null,
            acme_email: v.acmeEmail.trim() || null,
            remove_mode: v.remove || null,
          }),
        { ok: tr("安装与证书设置已保存", "Install settings saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("安装命令", "Install command")}
        footer={tr(
          `agent 连接面板的地址：${d.node.panel_addr ?? "（未设置节点通信域名）"}`,
          `Agents dial: ${d.node.panel_addr ?? "(no node domain set)"}`,
        )}
      >
        <FieldRow
          label={tr("安装命令公钥钉扎", "Install TLS pin")}
          description={tr(
            "面板证书不是公共 CA 签发时，安装命令用它校验面板（sha256//…）；留空 = 自动探测",
            "When the panel's certificate is not from a public CA the install command checks it with this pin (sha256//…); empty = probe",
          )}
          error={pinError}
          stack
        >
          {(a) => <Input {...a} className="font-mono" value={v.pin} onChange={(e) => f.set("pin", e.target.value)} />}
        </FieldRow>
        <SwitchRow
          label={tr("不使用备用下载", "No fallback download")}
          description={tr("面板下载失败时不再尝试备用地址", "Never try the fallback when the panel download fails")}
          checked={v.noFallback}
          onChange={(x) => f.set("noFallback", x)}
        />
        {!v.noFallback && (
          <FieldRow
            label={tr("备用下载地址", "Fallback download URL")}
            description={tr(
              `含 {arch}；留空 = 默认 ${o.install_fallback_default}`,
              `With {arch}; empty = ${o.install_fallback_default}`,
            )}
            error={fallbackError}
            stack
          >
            {(a) => (
              <Input
                {...a}
                className="font-mono"
                value={v.fallback}
                onChange={(e) => f.set("fallback", e.target.value)}
              />
            )}
          </FieldRow>
        )}
      </Group>
      <Group
        title={tr("节点证书（ACME）", "Node certificates (ACME)")}
        footer={tr(
          "设置了节点域名的节点由 agent 自己申请证书。",
          "Nodes with a node domain get their certificates by ACME on the agent.",
        )}
      >
        <FieldRow
          label={tr("ACME 目录", "ACME directory")}
          description={tr("留空 = Let's Encrypt", "Empty = Let's Encrypt")}
          error={acmeError}
        >
          {(a) => (
            <Input
              {...a}
              className="font-mono sm:w-72"
              value={v.acmeUrl}
              onChange={(e) => f.set("acmeUrl", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow label={tr("ACME 邮箱（可选）", "ACME email (optional)")} error={emailError}>
          {(a) => (
            <Input
              {...a}
              type="email"
              className="sm:w-72"
              value={v.acmeEmail}
              onChange={(e) => f.set("acmeEmail", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group title={tr("撤权", "Removing access")}>
        <FieldRow
          label={tr("撤权方式", "How access is removed")}
          description={tr(
            "按用户撤权：只断开被撤权用户（推荐）。重建：每次删除或更换凭据都重建节点配置，断开节点上的所有连接（只给不支持按用户撤权的旧环境用）。",
            "Per user: only the removed user is cut off (recommended). Rebuild: every removal or credential change rebuilds the node and drops every connection (only for old setups without per-user removal).",
          )}
        >
          {(a) => (
            <Select {...a} className="sm:w-48" value={v.remove} onChange={(e) => f.set("remove", e.target.value)}>
              <option value="">
                {tr(
                  `默认（${o.remove_mode.effective === "rebuild" ? "重建" : "按用户"}）`,
                  `Default (${o.remove_mode.effective === "rebuild" ? "rebuild" : "per user"})`,
                )}
              </option>
              <option value="gate">{tr("按用户撤权（推荐）", "Per user (recommended)")}</option>
              <option value="rebuild">{tr("重建", "Rebuild")}</option>
            </Select>
          )}
        </FieldRow>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// 测速与健康检查
// ---------------------------------------------------------------------------

export function ProbeSection() {
  const s = useSettings();
  return <Loaded q={s}>{(d) => <ProbeForm d={d} />}</Loaded>;
}

function ProbeForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const p = d.probe;
  const f = useDraft({
    interval: p.interval_secs.value === null ? "" : String(Math.round(p.interval_secs.value / 60)),
    tcp: p.panel_tcp.value === null ? "" : String(p.panel_tcp.value),
    urls: (p.urls.value ?? []).join("\n"),
  });
  const v = f.value!;
  const intervalError = f.isEdited("interval") ? intError(v.interval, 10, 10080, tr, true) : undefined;
  const urls = lines(v.urls);
  const urlsError =
    urls.length > 4 ? tr("最多 4 个地址", "At most 4 URLs") : urls.map((u) => urlError(u, tr, false)).find(Boolean);
  const tcpOn = (t: string) => (t === "" ? p.panel_tcp.default : t === "true");
  useSavePart({
    count: f.edited.length,
    errors: (intervalError ? 1 : 0) + (urlsError ? 1 : 0),
    discard: f.reset,
    save: async () => {
      if (p.panel_tcp.effective && !tcpOn(v.tcp)) {
        const ok = await confirm({
          title: tr("关闭面板 TCP 测速？", "Turn the panel TCP probe off?"),
          impact: tr(
            "中转入口不会再被自动检查和隐藏：连不通的中转入口会继续留在订阅里",
            "Relay entrances are no longer checked and hidden: an unreachable relay stays in subscriptions",
          ),
          tone: "warning",
          confirmLabel: tr("关闭并保存", "Turn off and save"),
        });
        if (!ok) return false;
      }
      const cur = fresh(qc, ["settings"], d);
      const minutes = intOf(v.interval);
      const r = await run(
        () =>
          put("/settings/probe", {
            version: cur.version,
            interval_secs: minutes === null ? null : minutes * 60,
            urls: urls.length ? urls : null,
            panel_tcp: v.tcp === "" ? null : v.tcp === "true",
          }),
        { ok: tr("测速设置已保存", "Probe settings saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("节点测速", "Node probes")}
        footer={tr(
          "agent 按间隔访问测速地址，结果显示在节点页与门户的节点列表。",
          "Agents fetch the probe URLs at the interval; results show on the nodes page and the portal.",
        )}
      >
        <FieldRow
          label={tr("测速间隔（分钟）", "Probe interval (minutes)")}
          description={tr(
            `10–10080 分钟；留空 = 默认 ${p.interval_secs.default / 60}`,
            `10–10080 minutes; empty = ${p.interval_secs.default / 60}`,
          )}
          error={intervalError}
        >
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="tnum text-right sm:w-24"
              placeholder={String(p.interval_secs.default / 60)}
              value={v.interval}
              onChange={(e) => f.set("interval", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("测速地址", "Probe URLs")}
          description={tr("1–4 个，每行一个；留空 = 默认", "1–4, one per line; empty = the default")}
          error={urlsError}
          stack
        >
          {(a) => (
            <Textarea
              {...a}
              rows={3}
              className="font-mono"
              placeholder={p.urls.default.join("\n")}
              value={v.urls}
              onChange={(e) => f.set("urls", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group
        title={tr("面板 TCP 测速", "Panel TCP probe")}
        footer={tr(
          "它同时决定中转入口的健康检查：连续失败的中转入口会从订阅中隐藏，恢复后自动放回。",
          "It also runs the relay entrance health checks: a relay that keeps failing is hidden from subscriptions and comes back once it answers.",
        )}
      >
        <FieldRow
          label={tr("面板 TCP 测速", "Panel TCP probe")}
          description={tr("面板定期 TCP 连接每个入口", "The panel opens a TCP connection to every entrance")}
        >
          {(a) => (
            <Select {...a} className="sm:w-44" value={v.tcp} onChange={(e) => f.set("tcp", e.target.value)}>
              <option value="">
                {tr(`默认（${p.panel_tcp.default ? "开" : "关"}）`, `Default (${p.panel_tcp.default ? "on" : "off"})`)}
              </option>
              <option value="true">{tr("开启", "On")}</option>
              <option value="false">{tr("关闭", "Off")}</option>
            </Select>
          )}
        </FieldRow>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// 出站拦截规则
// ---------------------------------------------------------------------------

type BlockRule = {
  id: number;
  kind: string;
  builtin_key: string | null;
  name: string;
  pattern: string | null;
  entries: number;
  enabled: boolean;
  sort: number;
  hits_7d: number;
};
type BlockRules = { lists_version: string; nodes_enabled: number; rules: BlockRule[] };

function kindName(k: string, tr: Tr) {
  return (
    (
      {
        domain: tr("域名", "Domains"),
        ip: "IP",
        protocol: tr("协议", "Protocols"),
        builtin: tr("内置", "Built-in"),
      } as Record<string, string>
    )[k] ?? tr("其他", "Other")
  );
}

export function BlockSection() {
  const q = useQuery({ queryKey: ["block-rules"], queryFn: () => get<BlockRules>("/block-rules") });
  return <Loaded q={q}>{(b) => <BlockList b={b} />}</Loaded>;
}

function BlockList({ b }: { b: BlockRules }) {
  const tr = useTr();
  const [run] = useAction();
  const [editing, setEditing] = useState<BlockRule | "new" | null>(null);
  const sorted = [...b.rules].sort((x, y) => x.sort - y.sort || x.id - y.id);
  const f = useDraft({
    order: sorted.map((r) => r.id),
    enabled: Object.fromEntries(sorted.map((r) => [String(r.id), r.enabled])) as Record<string, boolean>,
  });
  const v = f.value!;
  const byId = new Map(b.rules.map((r) => [r.id, r]));
  // A rule created meanwhile is appended; a deleted one dropped.
  const order = [
    ...v.order.filter((id) => byId.has(id)),
    ...sorted.map((r) => r.id).filter((id) => !v.order.includes(id)),
  ];
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const n = [...order];
    [n[i], n[j]] = [n[j], n[i]];
    f.set("order", n);
  };
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const r = await run(
        async () => {
          for (const [i, id] of order.entries()) {
            const rule = byId.get(id);
            if (!rule) continue;
            const body: Record<string, unknown> = {};
            const on = v.enabled[String(id)] ?? rule.enabled;
            if (on !== rule.enabled) body.enabled = on;
            if (f.isEdited("order") && rule.sort !== (i + 1) * 10) body.sort = (i + 1) * 10;
            if (Object.keys(body).length) await patch(`/block-rules/${id}`, body);
          }
          return true;
        },
        { ok: tr("拦截规则已保存", "Block rules saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("规则集", "Rule sets")}
        footer={tr(
          `只统计节点拦截次数，不记录用户访问明细。是否启用拦截在节点页按节点设置（默认关），现在 ${b.nodes_enabled} 个节点已开启。规则变化热更新，不断线。`,
          `Only per-node block counts, never user browsing. Blocking is switched per node on the nodes page (off by default); on for ${b.nodes_enabled} nodes. Changes apply live without dropping connections.`,
        )}
      >
        {order.map((id, i) => {
          const r = byId.get(id)!;
          const on = v.enabled[String(id)] ?? r.enabled;
          return (
            <div key={id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5" data-rule-set={r.name}>
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex flex-wrap items-center gap-1.5 text-body font-medium">
                  {r.name}
                  <Badge tone={r.builtin_key ? "primary" : "outline"}>
                    {r.builtin_key ? tr("内置", "Built-in") : kindName(r.kind, tr)}
                  </Badge>
                </div>
                <div className="text-footnote text-muted-foreground">
                  {tr(
                    `${r.entries} 条 · 近 7 天拦截 ${r.hits_7d} 次`,
                    `${r.entries} entries · ${r.hits_7d} blocked in 7 days`,
                  )}
                </div>
              </div>
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={ArrowUp}
                  aria-label={tr(`上移 ${r.name}`, `Move ${r.name} up`)}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon={ArrowDown}
                  aria-label={tr(`下移 ${r.name}`, `Move ${r.name} down`)}
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                />
              </div>
              {!r.builtin_key && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={tr(`编辑 ${r.name}`, `Edit ${r.name}`)}
                  onClick={() => setEditing(r)}
                >
                  {tr("编辑", "Edit")}
                </Button>
              )}
              <Switch
                label={r.name}
                checked={on}
                onChange={(x) => f.set("enabled", { ...v.enabled, [String(id)]: x })}
              />
            </div>
          );
        })}
        {order.length === 0 && (
          <EmptyState
            title={tr("还没有规则集", "No rule sets yet")}
            description={tr("新建一个自定义规则集开始拦截。", "Create a custom rule set to start blocking.")}
          />
        )}
        <div className="px-4 py-2.5">
          <Button size="sm" variant="soft" icon={Plus} onClick={() => setEditing("new")}>
            {tr("新建自定义规则", "New custom rule")}
          </Button>
        </div>
      </Group>
      <p className="px-1 text-footnote text-faint">
        {tr(`内置列表版本 ${b.lists_version}（v2fly，MIT）。`, `Built-in lists ${b.lists_version} (v2fly, MIT).`)}
      </p>
      {editing && <RuleDialog rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function RuleDialog({ rule, onClose }: { rule: BlockRule | null; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [kind, setKind] = useState(rule?.kind ?? "domain");
  const [name, setName] = useState(rule?.name ?? "");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [shown, setShown] = useState(false);
  const [run, busy] = useAction();
  const nameError = name.trim() ? undefined : tr("请填写名称", "Enter a name");
  const patternError = lines(pattern).length ? undefined : tr("至少一条", "At least one entry");
  const submit = async () => {
    setShown(true);
    if (nameError || patternError) return;
    const r = await run(
      () =>
        rule
          ? patch(`/block-rules/${rule.id}`, { name: name.trim(), pattern })
          : post("/block-rules", { kind, name: name.trim(), pattern }),
      { ok: tr("规则已保存", "Rule saved") },
    );
    if (r !== undefined) onClose();
  };
  const remove = async () => {
    if (!rule) return;
    const ok = await confirm({
      title: tr(`删除规则集 ${rule.name}？`, `Delete the rule set ${rule.name}?`),
      impact: tr(
        `开启拦截的节点不再拦截这 ${rule.entries} 条，近 7 天拦截 ${rule.hits_7d} 次`,
        `Nodes stop blocking its ${rule.entries} entries (${rule.hits_7d} blocks in 7 days)`,
      ),
      typeToConfirm: rule.name,
      confirmLabel: tr("删除", "Delete"),
      action: () => del(`/block-rules/${rule.id}`),
    });
    if (ok) {
      await settled();
      onClose();
    }
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={rule ? tr("编辑规则", "Edit rule") : tr("新建自定义规则", "New custom rule")}
      onSubmit={() => void submit()}
      footer={
        <>
          {rule && (
            <Button variant="destructive-soft" className="mr-auto" icon={Trash2} onClick={() => void remove()}>
              {tr("删除规则集", "Delete rule set")}
            </Button>
          )}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("名称", "Name")} error={shown ? nameError : undefined}>
            <Input data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={tr("类型", "Kind")}>
            <Select value={kind} disabled={!!rule} onChange={(e) => setKind(e.target.value)}>
              <option value="domain">
                {tr("域名（domain: / full: / keyword:）", "Domains (domain: / full: / keyword:)")}
              </option>
              <option value="ip">{tr("IP / 网段", "IPs / networks")}</option>
              <option value="protocol">{tr("协议（如 bittorrent）", "Protocols (e.g. bittorrent)")}</option>
            </Select>
          </Field>
        </div>
        <Field
          label={tr("内容（每行一条）", "Entries (one per line)")}
          hint={tr("最多 1000 行。", "Up to 1000 lines.")}
          error={shown ? patternError : undefined}
        >
          <Textarea rows={10} className="font-mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 更新源与验签
// ---------------------------------------------------------------------------

type UpdateStatus = {
  version: number;
  source_url: string | null;
  default_source_url: string;
  auto_check: boolean;
  next_auto_check_at: string | null;
  keys_configured: boolean;
};

export function UpdatesSection() {
  const q = useQuery({ queryKey: ["agent-updates"], queryFn: () => get<UpdateStatus>("/agent-updates") });
  const s = useSettings();
  return (
    <>
      <Loaded q={q} rows={3}>
        {(u) => <SourceForm u={u} />}
      </Loaded>
      <Loaded q={s} rows={3}>
        {(d) => <KeysForm d={d} />}
      </Loaded>
    </>
  );
}

function SourceForm({ u }: { u: UpdateStatus }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const f = useDraft({ source: u.source_url ?? "", auto: u.auto_check });
  const v = f.value!;
  const sourceError = urlError(v.source, tr);
  useSavePart({
    count: f.edited.length,
    errors: sourceError ? 1 : 0,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["agent-updates"], u);
      const r = await run(
        () =>
          put("/agent-updates/settings", {
            version: cur.version,
            source_url: v.source.trim() || null,
            auto_check: v.auto,
          }),
        { ok: tr("更新源设置已保存", "Update source saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <Group
      title={tr("发布源", "Release source")}
      footer={
        <>
          {tr("检查更新、上传与灰度在", "Checking, uploads and rollouts are on the")}{" "}
          <Link to="/updates" className="text-primary hover:underline">
            {tr("更新页", "Updates page")}
          </Link>
          {tr(
            "。自动检查只下载并校验新版本，从不自动开始灰度。",
            ". Automatic checks only download and verify; they never start a rollout.",
          )}
        </>
      }
    >
      <FieldRow
        label={tr("发布源（GitHub 最新发布 API，留空 = 官方）", "Source (GitHub latest-release API; empty = official)")}
        description={<span className="font-mono break-all">{u.default_source_url}</span>}
        error={sourceError}
        stack
      >
        {(a) => (
          <Input
            {...a}
            className="font-mono"
            placeholder={u.default_source_url}
            value={v.source}
            onChange={(e) => f.set("source", e.target.value)}
          />
        )}
      </FieldRow>
      <SwitchRow
        label={tr("自动检查（每 6 小时）", "Check automatically (every 6 h)")}
        description={
          u.auto_check && u.next_auto_check_at
            ? tr(`下次检查 ${dateTime(u.next_auto_check_at)}`, `Next check ${dateTime(u.next_auto_check_at)}`)
            : tr("默认关", "Off by default")
        }
        checked={v.auto}
        onChange={(x) => f.set("auto", x)}
      />
    </Group>
  );
}

/** A key line: "<base64> [label]". */
const keyParts = (line: string) => {
  const [key, ...rest] = line.trim().split(/\s+/);
  return { key, label: rest.join(" ") };
};

function KeysForm({ d }: { d: SettingsView }) {
  const tr = useTr();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [run] = useAction();
  const [adding, setAdding] = useState(false);
  const f = useDraft({ keys: d.security.extra_release_keys ?? [] });
  const keys = f.value!.keys;
  const official = d.security.release_keys.filter((k) => k.official);
  useSavePart({
    count: f.edited.length,
    errors: 0,
    discard: f.reset,
    save: async () => {
      const before = d.security.extra_release_keys ?? [];
      const added = keys.filter((k) => !before.includes(k)).length;
      const removed = before.filter((k) => !keys.includes(k)).length;
      const ok = await confirm({
        title: tr("修改信任的发布公钥？", "Change the trusted release keys?"),
        impacts: [
          { label: tr("新增", "Added"), value: added },
          { label: tr("删除", "Removed"), value: removed },
        ],
        description: tr(
          "面板用这些公钥（加上内置的官方公钥）校验 agent 发布；节点上的 agent 只信任编译进它的公钥。删除公钥后，用它签名的新发布不能再上传或检查。",
          "The panel verifies agent releases with these keys plus the built-in official ones; agents only trust the keys compiled into them. After a removal, new releases signed with it can no longer be uploaded or checked.",
        ),
        tone: "warning",
        confirmLabel: tr("确认保存", "Save"),
      });
      if (!ok) return false;
      const cur = fresh(qc, ["settings"], d);
      const r = await run(
        () =>
          put("/settings/security", {
            version: cur.version,
            audit_retention_days: cur.security.audit_retention_days.value,
            traffic_daily_retention_days: cur.security.traffic_daily_retention_days.value,
            cloudflare_ranges: cur.security.cloudflare_ranges,
            extra_release_keys: keys.length ? keys : null,
          }),
        { ok: tr("发布公钥已保存", "Release keys saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Group
        title={tr("内置的官方公钥", "Built-in official keys")}
        footer={tr("编译进面板，不能修改。", "Compiled into the panel; read only.")}
      >
        {official.map((k) => (
          <InfoRow key={k.id} label={k.label || tr("官方发布公钥", "Official release key")}>
            <Badge tone="primary">{tr("内置官方", "Official")}</Badge>
            <span className="font-mono text-footnote text-muted-foreground">{k.id}</span>
          </InfoRow>
        ))}
      </Group>
      <DangerZone>
        <div className="px-4 py-2.5">
          <div className="text-body font-medium">{tr("额外信任的发布公钥", "Extra trusted release keys")}</div>
          <div className="mt-0.5 text-footnote text-muted-foreground">
            {tr(
              "自建发布时加入你自己的签名公钥（最多 16 个）。增删在保存时确认。",
              "Add your own signing keys for self-built releases (up to 16). Confirmed on save.",
            )}
          </div>
        </div>
        {keys.map((line) => {
          const k = keyParts(line);
          return (
            <InfoRow
              key={line}
              label={<span className="font-mono text-footnote break-all">{k.key}</span>}
              description={k.label || undefined}
            >
              {!(d.security.extra_release_keys ?? []).includes(line) && (
                <Badge tone="info">{tr("未保存", "Unsaved")}</Badge>
              )}
              <Button
                size="icon-sm"
                variant="ghost"
                icon={Trash2}
                aria-label={tr(
                  `删除公钥 ${k.label || k.key.slice(0, 12)}`,
                  `Remove key ${k.label || k.key.slice(0, 12)}`,
                )}
                onClick={() =>
                  f.set(
                    "keys",
                    keys.filter((x) => x !== line),
                  )
                }
              />
            </InfoRow>
          );
        })}
        <div className="px-4 py-2.5">
          <Button size="sm" variant="soft" icon={Plus} disabled={keys.length >= 16} onClick={() => setAdding(true)}>
            {tr("添加公钥", "Add a key")}
          </Button>
        </div>
      </DangerZone>
      {adding && (
        <AddKey
          taken={keys.map((x) => keyParts(x).key)}
          onClose={() => setAdding(false)}
          onAdd={(line) => {
            f.set("keys", [...keys, line]);
            setAdding(false);
          }}
        />
      )}
    </>
  );
}

function AddKey({ taken, onClose, onAdd }: { taken: string[]; onClose: () => void; onAdd: (line: string) => void }) {
  const tr = useTr();
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [shown, setShown] = useState(false);
  const k = key.trim();
  const error = !/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(k)
    ? tr("请粘贴 base64 编码的 Ed25519 公钥", "Paste a base64 Ed25519 public key")
    : taken.includes(k)
      ? tr("这个公钥已经在列表里了", "Already listed")
      : undefined;
  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      title={tr("添加发布公钥", "Add a release key")}
      description={tr("添加后在保存栏保存才生效。", "It takes effect once saved in the save bar.")}
      onSubmit={() => {
        setShown(true);
        if (!error) onAdd(label.trim() ? `${k} ${label.trim().replace(/\s+/g, "-")}` : k);
      }}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary">
            {tr("添加", "Add")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={tr("公钥（base64）", "Key (base64)")} error={shown ? error : undefined}>
          <Input
            data-autofocus
            className="font-mono"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        <Field label={tr("标签（可选）", "Label (optional)")}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
