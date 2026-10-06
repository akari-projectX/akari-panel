// 告警 (ALR-*): the alert center (filters, firing counts, acknowledge,
// older pages), the settings (thresholds; Telegram, signed webhook, email;
// write-only secrets), test per channel, delivery log with retry.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { get, post, put, qs } from "../../shared/api";
import { ago, dateTime } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  Tabs,
} from "../../shared/ui/primitives";
import { DataTable, type Column } from "../../shared/ui/table";
import { FormError, useErrText, useRun } from "../kit";
import { navigate, setQuery, useRoute } from "../router";
import { alertKindName } from "./node-dialogs";
import { useServers } from "./nodes";

type Alert = {
  id: number;
  server_id: string;
  server_name: string;
  kind: string;
  status: string;
  fired_at: string;
  resolved_at: string | null;
  value: string;
  detail: string;
  notified: boolean;
  acked_at: string | null;
  acked_by: string | null;
};
type Notification = {
  id: number;
  alert_id: number | null;
  channel: string;
  event: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  title: string | null;
};
type Settings = {
  version: number;
  enabled: boolean;
  offline_secs: number | null;
  cpu_percent: number | null;
  cpu_minutes: number;
  mem_percent: number | null;
  mem_minutes: number;
  disk_percent: number | null;
  cert_days: number | null;
  latency_failures: boolean;
  last_error: boolean;
  cooldown_minutes: number;
  notify_resolved: boolean;
  telegram_enabled: boolean;
  telegram_chat_id: string | null;
  telegram_token_set: boolean;
  telegram_api_url: string | null;
  telegram_api_default: string;
  webhook_enabled: boolean;
  webhook_url: string | null;
  webhook_secret_set: boolean;
  email_enabled: boolean;
  email_to: string[];
  email_available: boolean;
};

const KINDS = [
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
];

export function AlertsPage() {
  const tr = useTr();
  const { sub } = useRoute();
  const tab = ["settings", "notifications"].includes(sub[0]) ? sub[0] : "alerts";
  return (
    <>
      <PageHeader title={tr("告警", "Alerts")} />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={(v) => navigate(v === "alerts" ? "/alerts" : `/alerts/${v}`)}
          tabs={[
            { value: "alerts", label: tr("告警中心", "Alert center") },
            { value: "settings", label: tr("告警设置", "Settings") },
            { value: "notifications", label: tr("通知记录", "Deliveries") },
          ]}
        />
      </div>
      {tab === "alerts" && <AlertList />}
      {tab === "settings" && <AlertSettings />}
      {tab === "notifications" && <Deliveries />}
    </>
  );
}

function AlertList() {
  const tr = useTr();
  const lang = useLang();
  const { query } = useRoute();
  const status = query.get("status") ?? "";
  const kind = query.get("kind") ?? "";
  const server = query.get("server") ?? "";
  const servers = useServers();
  const [run] = useRun();
  const q = useInfiniteQuery({
    queryKey: ["alerts", status, kind, server],
    queryFn: ({ pageParam }) =>
      get<{ alerts: Alert[]; firing: number; firing_by_kind: Record<string, number> }>(
        `/alerts${qs({ status, kind, server, before: pageParam, limit: 50 })}`,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.alerts.length === 50 ? last.alerts[49].id : undefined),
    refetchInterval: 30_000,
  });
  const rows = (q.data?.pages.flatMap((p) => p.alerts) ?? []).map((a) => ({ ...a, id: String(a.id), raw: a.id }));
  const head = q.data?.pages[0];
  const columns: Column<(typeof rows)[number]>[] = [
    { key: "kind", header: tr("类型", "Kind"), fixed: true, mobile: "title", cell: (a) => alertKindName(a.kind, tr) },
    { key: "server", header: tr("服务器", "Server"), cell: (a) => a.server_name },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (a) => (
        <Badge tone={a.status === "firing" ? "danger" : "success"}>
          {a.status === "firing" ? tr("正在告警", "Firing") : tr("已恢复", "Resolved")}
        </Badge>
      ),
    },
    {
      key: "detail",
      header: tr("详情", "Detail"),
      cell: (a) => <span className="text-muted-foreground">{a.detail || a.value}</span>,
    },
    { key: "fired", header: tr("触发", "Fired"), cell: (a) => `${dateTime(a.fired_at)} (${ago(a.fired_at, lang)})` },
    { key: "resolved", header: tr("恢复", "Resolved"), optional: true, cell: (a) => dateTime(a.resolved_at) },
    {
      key: "ack",
      header: tr("确认", "Ack"),
      fixed: true,
      cell: (a) =>
        a.acked_at ? (
          <span className="text-xs text-muted-foreground">{a.acked_by}</span>
        ) : (
          <Button
            size="sm"
            onClick={(e) => (
              e.stopPropagation(),
              void run(() => post(`/alerts/${a.raw}/ack`), {
                ok: tr("已确认", "Acknowledged"),
                invalidate: [["alerts"], ["admin-badges"]],
              })
            )}
          >
            {tr("确认", "Acknowledge")}
          </Button>
        ),
    },
  ];
  return (
    <>
      {head && head.firing > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {Object.entries(head.firing_by_kind).map(([k, n]) => (
            <Badge key={k} tone="danger">
              {alertKindName(k, tr)} · {n}
            </Badge>
          ))}
        </div>
      )}
      <DataTable
        label={tr("告警", "Alerts")}
        storageKey="alerts"
        rows={rows}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        onRowClick={(a) => navigate(`/nodes?open=server:${a.server_id}`)}
        toolbar={
          <>
            <Select
              aria-label={tr("状态", "Status")}
              className="w-32 [&_select]:h-8"
              value={status}
              onChange={(e) => setQuery({ status: e.target.value || null })}
            >
              <option value="">{tr("全部", "All")}</option>
              <option value="firing">{tr("正在告警", "Firing")}</option>
              <option value="resolved">{tr("已恢复", "Resolved")}</option>
            </Select>
            <Select
              aria-label={tr("类型", "Kind")}
              className="w-40 [&_select]:h-8"
              value={kind}
              onChange={(e) => setQuery({ kind: e.target.value || null })}
            >
              <option value="">{tr("全部类型", "Any kind")}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {alertKindName(k, tr)}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("服务器", "Server")}
              className="w-40 [&_select]:h-8"
              value={server}
              onChange={(e) => setQuery({ server: e.target.value || null })}
            >
              <option value="">{tr("全部服务器", "Any server")}</option>
              {(servers.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </>
        }
        footer={
          q.hasNextPage ? (
            <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
              {tr("加载更早", "Load older")}
            </Button>
          ) : (
            <span />
          )
        }
      />
    </>
  );
}

function AlertSettings() {
  const tr = useTr();
  const errText = useErrText();
  const toast = useToast();
  const q = useQuery({ queryKey: ["alerts", "settings"], queryFn: () => get<Settings>("/alerts/settings") });
  const [f, setF] = useState<Settings | null>(null);
  const [token, setToken] = useState("");
  const [secret, setSecret] = useState("");
  const [emails, setEmails] = useState("");
  useEffect(() => {
    if (q.data && !f) {
      setF(q.data);
      setEmails(q.data.email_to.join(", "));
    }
  }, [q.data, f]);
  const [run, busy] = useRun();
  if (!f) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-64" />;
  const num = (v: string) => (v.trim() ? Number(v) : null);
  const save = async () => {
    const body: Record<string, unknown> = {
      version: f.version,
      enabled: f.enabled,
      offline_secs: f.offline_secs,
      cpu_percent: f.cpu_percent,
      cpu_minutes: f.cpu_minutes,
      mem_percent: f.mem_percent,
      mem_minutes: f.mem_minutes,
      disk_percent: f.disk_percent,
      cert_days: f.cert_days,
      latency_failures: f.latency_failures,
      last_error: f.last_error,
      cooldown_minutes: f.cooldown_minutes,
      notify_resolved: f.notify_resolved,
      telegram_enabled: f.telegram_enabled,
      telegram_chat_id: f.telegram_chat_id || null,
      telegram_api_url: f.telegram_api_url || null,
      webhook_enabled: f.webhook_enabled,
      webhook_url: f.webhook_url || null,
      email_enabled: f.email_enabled,
      email_to: emails.split(/[\s,]+/).filter(Boolean),
    };
    if (token.trim()) body.telegram_token = token.trim();
    if (secret.trim()) body.webhook_secret = secret.trim();
    const r = await run(() => put<Settings>("/alerts/settings", body), {
      ok: tr("告警设置已保存", "Alert settings saved"),
      invalidate: [["alerts", "settings"]],
    });
    if (r) {
      setF(r);
      setToken("");
      setSecret("");
    }
  };
  const test = async (channel: string) => {
    try {
      const r = await post<{ ok: boolean; error?: string }>("/alerts/test", { channel });
      toast(
        r.ok
          ? { tone: "success", title: tr("测试消息已发送", "Test message sent") }
          : { tone: "error", title: r.error ?? tr("发送失败", "Failed") },
      );
    } catch (e) {
      toast({ tone: "error", title: errText(e) });
    }
  };
  const randomSecret = () => {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    setSecret(Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
  };
  const numField = (
    k: "offline_secs" | "cpu_percent" | "mem_percent" | "disk_percent" | "cert_days",
    label: string,
  ) => (
    <Field label={label} hint={tr("留空 = 关闭", "empty = off")}>
      <Input inputMode="numeric" value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: num(e.target.value) })} />
    </Field>
  );
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={tr("告警规则", "Rules")}
          description={tr(
            `每 ${30} 秒评估一次；服务器可单独覆盖（节点页 → 告警规则）。`,
            "Evaluated every 30 s; servers may override (Nodes → alert rules).",
          )}
        />
        <CardBody>
          <label className="mb-3 flex items-center gap-2 text-[13px]">
            <Switch
              checked={f.enabled}
              onChange={(v) => setF({ ...f, enabled: v })}
              label={tr("启用告警", "Alerts on")}
            />
            {tr("启用告警", "Alerts on")}
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            {numField("offline_secs", tr("离线多少秒告警", "Offline seconds"))}
            {numField("cpu_percent", tr("CPU 超过 %", "CPU above %"))}
            <Field label={tr("CPU 持续分钟", "CPU minutes")}>
              <Input
                inputMode="numeric"
                value={f.cpu_minutes}
                onChange={(e) => setF({ ...f, cpu_minutes: Number(e.target.value) || 0 })}
              />
            </Field>
            {numField("mem_percent", tr("内存超过 %", "Memory above %"))}
            <Field label={tr("内存持续分钟", "Memory minutes")}>
              <Input
                inputMode="numeric"
                value={f.mem_minutes}
                onChange={(e) => setF({ ...f, mem_minutes: Number(e.target.value) || 0 })}
              />
            </Field>
            {numField("disk_percent", tr("磁盘超过 %", "Disk above %"))}
            {numField("cert_days", tr("证书剩余少于天数", "Certificate days below"))}
            <Field label={tr("冷却（分钟）", "Cooldown (minutes)")}>
              <Input
                inputMode="numeric"
                value={f.cooldown_minutes}
                onChange={(e) => setF({ ...f, cooldown_minutes: Number(e.target.value) || 0 })}
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-[13px]">
            <label className="flex items-center gap-2">
              <Switch
                checked={f.latency_failures}
                onChange={(v) => setF({ ...f, latency_failures: v })}
                label={tr("测速全部失败", "Every probe fails")}
              />
              {tr("测速全部失败", "Every probe fails")}
            </label>
            <label className="flex items-center gap-2">
              <Switch
                checked={f.last_error}
                onChange={(v) => setF({ ...f, last_error: v })}
                label={tr("配置应用失败", "Apply failed")}
              />
              {tr("配置应用失败", "Apply failed")}
            </label>
            <label className="flex items-center gap-2">
              <Switch
                checked={f.notify_resolved}
                onChange={(v) => setF({ ...f, notify_resolved: v })}
                label={tr("恢复时也通知", "Notify on recovery")}
              />
              {tr("恢复时也通知", "Notify on recovery")}
            </label>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title="Telegram"
          actions={
            <Button size="sm" onClick={() => void test("telegram")}>
              {tr("发送测试", "Send test")}
            </Button>
          }
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
              <Switch
                checked={f.telegram_enabled}
                onChange={(v) => setF({ ...f, telegram_enabled: v })}
                label="Telegram"
              />
              {tr("启用 Telegram 通知", "Telegram notifications")}
            </label>
            <Field
              label={tr("Bot token（只写）", "Bot token (write-only)")}
              hint={f.telegram_token_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
            >
              <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
            <Field label="Chat ID">
              <Input
                value={f.telegram_chat_id ?? ""}
                onChange={(e) => setF({ ...f, telegram_chat_id: e.target.value })}
              />
            </Field>
            <Field
              label={tr("Telegram API 地址（留空 = 默认）", "Telegram API URL (empty = default)")}
              className="sm:col-span-2"
            >
              <Input
                value={f.telegram_api_url ?? ""}
                placeholder={f.telegram_api_default}
                onChange={(e) => setF({ ...f, telegram_api_url: e.target.value })}
              />
            </Field>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title={tr("签名 Webhook", "Signed webhook")}
          actions={
            <Button size="sm" onClick={() => void test("webhook")}>
              {tr("发送测试", "Send test")}
            </Button>
          }
        />
        <CardBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
              <Switch
                checked={f.webhook_enabled}
                onChange={(v) => setF({ ...f, webhook_enabled: v })}
                label="Webhook"
              />
              {tr("启用 Webhook", "Webhook on")}
            </label>
            <Field label="URL">
              <Input value={f.webhook_url ?? ""} onChange={(e) => setF({ ...f, webhook_url: e.target.value })} />
            </Field>
            <Field
              label={tr("签名密钥（只写）", "Signing secret (write-only)")}
              hint={f.webhook_secret_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
            >
              <div className="flex gap-2">
                <Input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
                <Button onClick={randomSecret}>{tr("随机生成", "Random")}</Button>
              </div>
            </Field>
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader
          title={tr("邮件", "Email")}
          actions={
            <Button size="sm" onClick={() => void test("email")} disabled={!f.email_available}>
              {tr("发送测试", "Send test")}
            </Button>
          }
        />
        <CardBody>
          <label className="mb-3 flex items-center gap-2 text-[13px]">
            <Switch
              checked={f.email_enabled}
              onChange={(v) => setF({ ...f, email_enabled: v })}
              label={tr("邮件告警", "Email alerts")}
            />
            {tr("启用邮件告警", "Email alerts on")}
            {!f.email_available && (
              <span className="text-xs text-warning">{tr("（邮件发送未配置）", "(mail not configured)")}</span>
            )}
          </label>
          <Field label={tr("收件人（最多 5 个，逗号分隔）", "Recipients (up to 5, comma separated)")}>
            <Input value={emails} onChange={(e) => setEmails(e.target.value)} />
          </Field>
        </CardBody>
      </Card>
      <Button variant="primary" loading={busy} onClick={save}>
        {tr("保存告警设置", "Save alert settings")}
      </Button>
    </div>
  );
}

function Deliveries() {
  const tr = useTr();
  const [run] = useRun();
  const q = useQuery({
    queryKey: ["alerts", "notifications"],
    queryFn: () => get<Notification[]>("/alerts/notifications"),
  });
  const rows = (q.data ?? []).map((n) => ({ ...n, id: String(n.id), raw: n.id }));
  const columns: Column<(typeof rows)[number]>[] = [
    { key: "title", header: tr("标题", "Title"), fixed: true, mobile: "title", cell: (n) => n.title ?? n.event },
    { key: "channel", header: tr("通道", "Channel"), cell: (n) => n.channel },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (n) => (
        <Badge tone={n.status === "sent" ? "success" : n.status === "dead" ? "danger" : "info"}>{n.status}</Badge>
      ),
    },
    { key: "attempts", header: tr("尝试", "Attempts"), cell: (n) => n.attempts },
    {
      key: "error",
      header: tr("错误", "Error"),
      cell: (n) => <span className="text-muted-foreground">{n.last_error ?? ""}</span>,
    },
    { key: "created", header: tr("时间", "Time"), cell: (n) => dateTime(n.created_at) },
    {
      key: "retry",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      fixed: true,
      cell: (n) =>
        n.status === "dead" ? (
          <Button
            size="sm"
            onClick={() =>
              void run(() => post(`/alerts/notifications/${n.raw}/retry`), {
                ok: tr("已重新排队", "Requeued"),
                invalidate: [["alerts", "notifications"]],
              })
            }
          >
            {tr("重试", "Retry")}
          </Button>
        ) : null,
    },
  ];
  return (
    <DataTable
      label={tr("通知记录", "Deliveries")}
      rows={rows}
      columns={columns}
      loading={q.isPending}
      error={q.error}
      onRetry={() => void q.refetch()}
    />
  );
}
