// 系统设置: 节点通信与测速 (SET-20/21), 审计规则 (SET-22, W29), 账号清理
// (SET-23, D10) and 品牌 (SET-24).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { del, get, patch, post, put, putBinary } from "../../shared/api";
import { prefixBase } from "../../shared/base";
import { dateTime, daysBefore, siteToday } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Dialog, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from "../../shared/ui/primitives";
import { FormError, useErrText, useRun } from "../kit";
import { navigate } from "../router";
import { useSettings } from "./settings";

export function NodesTab() {
  const tr = useTr();
  const s = useSettings();
  const d = s.data;
  const [ops, setOps] = useState<{
    pin: string;
    fallback: string;
    noFallback: boolean;
    acmeUrl: string;
    acmeEmail: string;
    remove: string;
  } | null>(null);
  const [probe, setProbe] = useState<{ interval: string; urls: string; tcp: string } | null>(null);
  useEffect(() => {
    if (d && !ops)
      setOps({
        pin: d.node_ops.install_tls_pin ?? "",
        fallback: d.node_ops.install_fallback_url ?? "",
        noFallback: d.node_ops.install_fallback_url === "",
        acmeUrl: d.node_ops.acme_directory_url ?? "",
        acmeEmail: d.node_ops.acme_email ?? "",
        remove: d.node_ops.remove_mode.value ?? "",
      });
    if (d && !probe)
      setProbe({
        interval: d.probe.interval_secs.value === null ? "" : String(d.probe.interval_secs.value / 60),
        urls: (d.probe.urls.value ?? []).join("\n"),
        tcp: d.probe.panel_tcp.value === null ? "" : String(d.probe.panel_tcp.value),
      });
  }, [d, ops, probe]);
  const [run, busy] = useRun();
  if (!d || !ops || !probe) return <Skeleton className="h-96" />;
  const saveOps = () =>
    run(
      () =>
        put("/settings/nodes", {
          version: d.version,
          install_tls_pin: ops.pin.trim() || null,
          install_fallback_url: ops.noFallback ? null : ops.fallback.trim() || null,
          install_fallback_disabled: ops.noFallback,
          acme_directory_url: ops.acmeUrl.trim() || null,
          acme_email: ops.acmeEmail.trim() || null,
          remove_mode: ops.remove || null,
        }),
      { ok: tr("节点通信设置已保存", "Node settings saved"), invalidate: [["settings"]] },
    ).then((r) => r !== undefined && setOps(null));
  const saveProbe = () =>
    run(
      () =>
        put("/settings/probe", {
          version: d.version,
          interval_secs: probe.interval.trim() ? Math.round(Number(probe.interval) * 60) : null,
          urls: probe.urls
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean).length
            ? probe.urls
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)
            : null,
          panel_tcp: probe.tcp === "" ? null : probe.tcp === "true",
        }),
      { ok: tr("测速设置已保存", "Probe settings saved"), invalidate: [["settings"]] },
    ).then((r) => r !== undefined && setProbe(null));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={tr("安装命令与节点证书", "Install command and node certificates")}
          description={tr(
            `agent 连接面板：${d.node.panel_addr ?? tr("（未设置节点通信域名）", "(no node domain)")}`,
            `Agents dial: ${d.node.panel_addr ?? "(no node domain)"}`,
          )}
        />
        <CardBody className="space-y-3">
          <Field
            label={tr("安装命令公钥钉扎（sha256//…，留空 = 自动探测）", "Install TLS pin (sha256//…; empty = probe)")}
          >
            <Input value={ops.pin} onChange={(e) => setOps({ ...ops, pin: e.target.value })} />
          </Field>
          <Field
            label={tr(
              `备用下载地址（含 {arch}；留空 = 默认 ${d.node_ops.install_fallback_default}）`,
              `Fallback download URL (with {arch}; empty = ${d.node_ops.install_fallback_default})`,
            )}
          >
            <Input
              value={ops.fallback}
              disabled={ops.noFallback}
              onChange={(e) => setOps({ ...ops, fallback: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 text-[13px]">
            <Switch
              checked={ops.noFallback}
              onChange={(v) => setOps({ ...ops, noFallback: v })}
              label={tr("不使用备用下载", "No fallback download")}
            />
            {tr("不使用备用下载", "No fallback download")}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("ACME 目录（留空 = Let's Encrypt）", "ACME directory (empty = Let's Encrypt)")}>
              <Input value={ops.acmeUrl} onChange={(e) => setOps({ ...ops, acmeUrl: e.target.value })} />
            </Field>
            <Field label={tr("ACME 邮箱（可选）", "ACME email (optional)")}>
              <Input value={ops.acmeEmail} onChange={(e) => setOps({ ...ops, acmeEmail: e.target.value })} />
            </Field>
          </div>
          <Field label={tr("撤权方式", "How access is removed")}>
            <Select value={ops.remove} onChange={(e) => setOps({ ...ops, remove: e.target.value })}>
              <option value="">
                {tr(
                  `默认（${d.node_ops.remove_mode.effective === "rebuild" ? "重建" : "按用户"}）`,
                  `Default (${d.node_ops.remove_mode.effective})`,
                )}
              </option>
              <option value="gate">{tr("按用户撤权（推荐）", "Per user (recommended)")}</option>
              <option value="rebuild">
                {tr("重建（每次删除 / 更换凭据都断开节点上所有连接）", "Rebuild (every removal drops all connections)")}
              </option>
            </Select>
          </Field>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void saveOps()}>
            {tr("保存", "Save")}
          </Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={tr("延迟测试", "Latency probes")} />
        <CardBody className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={tr(
                `测速间隔（分钟，留空 = 默认 ${d.probe.interval_secs.default / 60}）`,
                `Interval (minutes; empty = ${d.probe.interval_secs.default / 60})`,
              )}
            >
              <Input
                inputMode="numeric"
                value={probe.interval}
                onChange={(e) => setProbe({ ...probe, interval: e.target.value })}
              />
            </Field>
            <Field label={tr("面板 TCP 测速（也决定中转入口探测）", "Panel TCP probe (also relay health checks)")}>
              <Select value={probe.tcp} onChange={(e) => setProbe({ ...probe, tcp: e.target.value })}>
                <option value="">
                  {tr(
                    `默认（${d.probe.panel_tcp.default ? "开" : "关"}）`,
                    `Default (${d.probe.panel_tcp.default ? "on" : "off"})`,
                  )}
                </option>
                <option value="true">{tr("开启", "On")}</option>
                <option value="false">{tr("关闭", "Off")}</option>
              </Select>
            </Field>
          </div>
          <Field
            label={tr("测速地址（1–4 个，每行一个，留空 = 默认）", "Probe URLs (1–4, one per line; empty = default)")}
          >
            <Textarea
              rows={3}
              value={probe.urls}
              placeholder={d.probe.urls.default.join("\n")}
              onChange={(e) => setProbe({ ...probe, urls: e.target.value })}
            />
          </Field>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void saveProbe()}>
            {tr("保存", "Save")}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}

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

function kindName(k: string, tr: Tr) {
  return (
    (
      {
        domain: tr("域名", "Domains"),
        ip: "IP",
        protocol: tr("协议", "Protocols"),
        builtin: tr("内置", "Built-in"),
      } as Record<string, string>
    )[k] ?? k
  );
}

export function BlockRulesTab() {
  const tr = useTr();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["block-rules"],
    queryFn: () => get<{ lists_version: string; nodes_enabled: number; rules: BlockRule[] }>("/block-rules"),
  });
  const [editing, setEditing] = useState<BlockRule | "new" | null>(null);
  const [run] = useRun();
  if (!q.data) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-64" />;
  return (
    <Card>
      <CardHeader
        title={tr("审计规则（W29）", "Block rules (W29)")}
        description={tr(
          `只统计节点拦截次数，不记录用户访问明细。按节点开关（节点页），默认关；${q.data.nodes_enabled} 个节点已开启。规则变化热更新，不断线。`,
          `Only per-node block counts, never user browsing. Per-node switch (Nodes page), off by default; on for ${q.data.nodes_enabled} nodes. Rule edits apply live.`,
        )}
        actions={
          <Button size="sm" icon="plus" onClick={() => setEditing("new")}>
            {tr("新建自定义规则", "New custom rule")}
          </Button>
        }
      />
      <ul className="divide-y divide-border">
        {q.data.rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px] sm:px-5">
            <Switch
              checked={r.enabled}
              label={r.name}
              onChange={(v) =>
                void run(() => patch(`/block-rules/${r.id}`, { enabled: v }), {
                  ok: tr("已保存", "Saved"),
                  invalidate: [["block-rules"]],
                })
              }
            />
            <span className="font-medium">{r.name}</span>
            <Badge tone={r.builtin_key ? "primary" : "outline"}>
              {r.builtin_key ? tr("内置", "Built-in") : kindName(r.kind, tr)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {tr(
                `${r.entries} 条 · 近 7 天拦截 ${r.hits_7d} 次`,
                `${r.entries} entries · ${r.hits_7d} blocked in 7 days`,
              )}
            </span>
            {!r.builtin_key && (
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                  {tr("编辑", "Edit")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive-soft"
                  onClick={async () => {
                    const ok = await confirm({
                      title: tr(`删除规则 ${r.name}？`, `Delete ${r.name}?`),
                      action: () => del(`/block-rules/${r.id}`),
                    });
                    if (ok)
                      void run(async () => undefined, { ok: tr("已删除", "Deleted"), invalidate: [["block-rules"]] });
                  }}
                >
                  {tr("删除", "Delete")}
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {editing && <RuleDialog rule={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function RuleDialog({ rule, onClose }: { rule: BlockRule | null; onClose: () => void }) {
  const tr = useTr();
  const [kind, setKind] = useState(rule?.kind ?? "domain");
  const [name, setName] = useState(rule?.name ?? "");
  const [pattern, setPattern] = useState(rule?.pattern ?? "");
  const [run, busy] = useRun();
  const submit = async () => {
    const r = await run(
      () =>
        rule ? patch(`/block-rules/${rule.id}`, { name, pattern }) : post("/block-rules", { kind, name, pattern }),
      { ok: tr("规则已保存", "Rule saved"), invalidate: [["block-rules"]] },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={rule ? tr("编辑规则", "Edit rule") : tr("新建自定义规则", "New custom rule")}
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("名称", "Name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
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
        <Field label={tr("内容（每行一条）", "Entries (one per line)")}>
          <Textarea rows={8} value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

type Cleanup = {
  version: number;
  auto: boolean;
  after_days: number;
  warn: boolean;
  warn_days: number;
  last_run_at: string | null;
  last_deleted: number;
  last_warned: number;
  due_warn: number;
  due_delete: number;
};

export function CleanupTab() {
  const tr = useTr();
  const q = useQuery({ queryKey: ["settings", "cleanup"], queryFn: () => get<Cleanup>("/settings/cleanup") });
  const [f, setF] = useState<Cleanup | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const [run, busy] = useRun();
  if (!f) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-48" />;
  const before = daysBefore(siteToday(), f.after_days);
  return (
    <Card>
      <CardHeader
        title={tr("账号清理（D10）", "Account cleanup (D10)")}
        description={tr(
          "“从未使用”：注册超过 N 天，从没有过套餐、付款、流量、余额与工单；管理员与有财务记录的账号永远不算。删除方式与自助注销相同。",
          '"Never used": signed up more than N days ago, never a plan, payment, traffic, balance or ticket; admins and accounts with finance records never count. Deleted like a self-deletion.',
        )}
      />
      <CardBody className="space-y-3 text-[13px]">
        <Callout tone="info">
          {tr(`现在有 ${q.data?.due_delete ?? 0} 个账号符合删除条件`, `${q.data?.due_delete ?? 0} accounts match now`)}
          {f.warn
            ? tr(`，${q.data?.due_warn ?? 0} 个将收到提醒`, `, ${q.data?.due_warn ?? 0} will be warned`)
            : ""}。{" "}
          <button
            type="button"
            className="text-primary underline"
            onClick={() => navigate(`/users?never_used=1&registered_before=${before}&last_login_before=${before}`)}
          >
            {tr("在用户列表中查看", "Show in the user list")}
          </button>
        </Callout>
        <label className="flex items-center gap-2">
          <Switch
            checked={f.auto}
            onChange={(v) => setF({ ...f, auto: v })}
            label={tr("自动清理", "Automatic cleanup")}
          />
          {tr("自动清理（每小时，默认关）", "Automatic cleanup (hourly, off by default)")}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("注册超过 N 天", "Signed up more than N days ago")}>
            <Input
              inputMode="numeric"
              value={f.after_days}
              onChange={(e) => setF({ ...f, after_days: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label={tr("提醒后等待天数", "Days after the warning")}>
            <Input
              inputMode="numeric"
              value={f.warn_days}
              disabled={!f.warn}
              onChange={(e) => setF({ ...f, warn_days: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2">
          <Switch
            checked={f.warn}
            onChange={(v) => setF({ ...f, warn: v })}
            label={tr("删除前发邮件提醒", "Warn by mail first")}
          />
          {tr("删除前发邮件提醒（用户登录一次即保留）", "Warn by mail first (signing in once keeps the account)")}
        </label>
        <p className="text-xs text-muted-foreground">
          {tr(
            `上次运行 ${dateTime(f.last_run_at)}：删除 ${f.last_deleted}，提醒 ${f.last_warned}`,
            `Last run ${dateTime(f.last_run_at)}: ${f.last_deleted} deleted, ${f.last_warned} warned`,
          )}
        </p>
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={() =>
            void run(
              () =>
                put("/settings/cleanup", {
                  version: f.version,
                  auto: f.auto,
                  after_days: f.after_days,
                  warn: f.warn,
                  warn_days: f.warn_days,
                }),
              { ok: tr("清理设置已保存", "Cleanup settings saved"), invalidate: [["settings", "cleanup"]] },
            )
          }
        >
          {tr("保存", "Save")}
        </Button>
      </CardBody>
    </Card>
  );
}

type Branding = {
  version: number;
  logo_url: string | null;
  favicon_url: string | null;
  footer_text: string | null;
  footer_links: { label: string; url: string }[];
  tos_url: string | null;
  privacy_url: string | null;
  client_downloads: { platform: string; label: string | null; url: string }[];
};
const PLATFORMS = ["windows", "macos", "linux", "android", "ios", "harmony", "other"];

export function BrandingTab() {
  const tr = useTr();
  const toast = useToast();
  const errText = useErrText();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["settings", "branding"], queryFn: () => get<Branding>("/settings/branding") });
  const [f, setF] = useState<Branding | null>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const [run, busy] = useRun();
  if (!f) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-64" />;
  const image = (name: "logo" | "favicon", url: string | null, label: string) => (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-24 text-[13px] font-medium">{label}</span>
      {url ? (
        <img
          src={`${prefixBase}/${url}`}
          alt={label}
          className="h-10 w-10 rounded border border-border object-contain"
        />
      ) : (
        <span className="text-xs text-muted-foreground">{tr("未设置", "none")}</span>
      )}
      <input
        type="file"
        accept="image/png"
        aria-label={tr(`上传${label}（PNG）`, `Upload ${label} (PNG)`)}
        className="text-xs"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            await putBinary(`/settings/branding/${name}`, file, "image/png");
            toast({ tone: "success", title: tr("已上传", "Uploaded") });
            void q.refetch();
          } catch (err) {
            toast({ tone: "error", title: errText(err) });
          }
        }}
      />
      {url && (
        <Button
          size="sm"
          variant="destructive-soft"
          onClick={async () => {
            const ok = await confirm({
              title: tr(`删除${label}？`, `Remove the ${label}?`),
              action: () => del(`/settings/branding/${name}`),
            });
            if (ok) void q.refetch();
          }}
        >
          {tr("删除", "Remove")}
        </Button>
      )}
    </div>
  );
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={tr("Logo 与网站图标", "Logo and favicon")} description={tr("仅 PNG。", "PNG only.")} />
        <CardBody className="space-y-3">
          {image("logo", f.logo_url, tr("Logo", "logo"))}
          {image("favicon", f.favicon_url, tr("网站图标", "favicon"))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={tr("页脚与链接", "Footer and links")} />
        <CardBody className="space-y-3">
          <Field label={tr("页脚文字", "Footer text")}>
            <Input value={f.footer_text ?? ""} onChange={(e) => setF({ ...f, footer_text: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("服务条款链接（留空 = 门户条款页）", "Terms link (empty = the portal's page)")}>
              <Input value={f.tos_url ?? ""} onChange={(e) => setF({ ...f, tos_url: e.target.value })} />
            </Field>
            <Field label={tr("隐私政策链接（留空 = 门户隐私页）", "Privacy link (empty = the portal's page)")}>
              <Input value={f.privacy_url ?? ""} onChange={(e) => setF({ ...f, privacy_url: e.target.value })} />
            </Field>
          </div>
          <div className="space-y-2">
            <div className="text-[13px] font-medium">{tr("页脚链接", "Footer links")}</div>
            {f.footer_links.map((l, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <Input
                  aria-label={tr("文字", "Label")}
                  className="h-8 w-40"
                  value={l.label}
                  onChange={(e) =>
                    setF({
                      ...f,
                      footer_links: f.footer_links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                    })
                  }
                />
                <Input
                  aria-label="URL"
                  className="h-8 w-72"
                  value={l.url}
                  onChange={(e) =>
                    setF({
                      ...f,
                      footer_links: f.footer_links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                    })
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={tr("删除", "Remove")}
                  onClick={() => setF({ ...f, footer_links: f.footer_links.filter((_, j) => j !== i) })}
                />
              </div>
            ))}
            <Button
              size="sm"
              icon="plus"
              onClick={() => setF({ ...f, footer_links: [...f.footer_links, { label: "", url: "" }] })}
            >
              {tr("添加链接", "Add link")}
            </Button>
          </div>
          <div className="space-y-2">
            <div className="text-[13px] font-medium">{tr("客户端下载链接", "Client downloads")}</div>
            {f.client_downloads.map((l, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <Select
                  aria-label={tr("平台", "Platform")}
                  className="w-32 [&_select]:h-8"
                  value={l.platform}
                  onChange={(e) =>
                    setF({
                      ...f,
                      client_downloads: f.client_downloads.map((x, j) =>
                        j === i ? { ...x, platform: e.target.value } : x,
                      ),
                    })
                  }
                >
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
                <Input
                  aria-label={tr("名称（可选）", "Label (optional)")}
                  className="h-8 w-40"
                  value={l.label ?? ""}
                  onChange={(e) =>
                    setF({
                      ...f,
                      client_downloads: f.client_downloads.map((x, j) =>
                        j === i ? { ...x, label: e.target.value || null } : x,
                      ),
                    })
                  }
                />
                <Input
                  aria-label="URL"
                  className="h-8 w-72"
                  value={l.url}
                  onChange={(e) =>
                    setF({
                      ...f,
                      client_downloads: f.client_downloads.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                    })
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={tr("删除", "Remove")}
                  onClick={() => setF({ ...f, client_downloads: f.client_downloads.filter((_, j) => j !== i) })}
                />
              </div>
            ))}
            <Button
              size="sm"
              icon="plus"
              onClick={() =>
                setF({ ...f, client_downloads: [...f.client_downloads, { platform: "windows", label: null, url: "" }] })
              }
            >
              {tr("添加下载", "Add download")}
            </Button>
          </div>
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            onClick={() =>
              void run(
                () =>
                  put("/settings/branding", {
                    version: f.version,
                    footer_text: f.footer_text || null,
                    footer_links: f.footer_links,
                    tos_url: f.tos_url || null,
                    privacy_url: f.privacy_url || null,
                    client_downloads: f.client_downloads,
                  }),
                { ok: tr("品牌设置已保存", "Branding saved"), invalidate: [["settings", "branding"]] },
              )
            }
          >
            {tr("保存", "Save")}
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
