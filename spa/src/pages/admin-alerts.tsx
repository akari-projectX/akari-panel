// W17 admin console: 告警中心 (Chinese only, R18). Firing alerts and
// history (ack), the thresholds and notification channels (Telegram bot,
// signed webhook, email via the SMTP outbox), the delivery log, and the
// per-node rule card used on the node page. Types mirror src/alerts/.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type FormEvent } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { adminBase, get, post, put } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDateTime } from "../lib/datetime";
import { navigate } from "../lib/router";

export type AlertKind = "offline" | "cpu" | "memory" | "disk" | "latency" | "cert" | "agent_cert" | "last_error";

export const KIND_ZH: Record<AlertKind, string> = {
  offline: "节点离线",
  cpu: "CPU 过高",
  memory: "内存过高",
  disk: "磁盘将满",
  latency: "测速全部失败",
  cert: "节点证书即将到期",
  agent_cert: "Agent 证书即将到期",
  last_error: "配置应用失败",
};
const KINDS = Object.keys(KIND_ZH) as AlertKind[];

export interface AlertRow {
  id: number;
  node_id: string;
  node_name: string;
  kind: AlertKind;
  status: "firing" | "resolved";
  fired_at: string;
  resolved_at: string | null;
  value: string;
  detail: string;
  notified: boolean;
  acked_at: string | null;
  acked_by: string | null;
}

export interface AlertList {
  alerts: AlertRow[];
  firing: number;
  firing_by_kind: Partial<Record<AlertKind, number>>;
}

export interface AlertSettings {
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
  eval_interval_secs: number;
}

export interface NotificationRow {
  id: number;
  alert_id: number | null;
  channel: "telegram" | "webhook" | "email";
  event: "firing" | "resolved";
  status: "pending" | "sent" | "dead";
  attempts: number;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  next_attempt_at: string;
  title: string | null;
}

export interface NodeAlertRules {
  muted: boolean;
  disabled: AlertKind[];
  offline_secs: number | null;
  cpu_percent: number | null;
  cpu_minutes: number | null;
  mem_percent: number | null;
  mem_minutes: number | null;
  disk_percent: number | null;
  cert_days: number | null;
}

const CHANNEL_ZH = { telegram: "Telegram", webhook: "Webhook", email: "邮件" } as const;

function fmt(s: string | null) {
  return fmtDateTime(s);
}

/** "" -> null (rule off / inherit); otherwise an integer (NaN -> error). */
export function numOrNull(s: string): number | null | "bad" {
  const v = s.trim();
  if (!v) return null;
  return /^\d+$/.test(v) ? Number(v) : "bad";
}

const str = (n: number | null | undefined) => (n == null ? "" : String(n));

/** A random webhook signing secret (32 hex characters, crypto RNG). */
export function randomSecret(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function AdminAlerts() {
  return (
    <div className="space-y-6">
      <AlertCenter />
      <p className="text-sm text-muted-foreground">
        阈值与通知通道在{" "}
        <a
          className="font-medium text-foreground underline"
          href={`${adminBase}/settings/alerts`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate(`${adminBase}/settings/alerts`);
          }}
        >
          系统设置 → 告警
        </a>
        。
      </p>
      <DeliveryLog />
    </div>
  );
}

function AlertCenter() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"" | "firing" | "resolved">("");
  const [kind, setKind] = useState("");
  const [older, setOlder] = useState<AlertRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const qs = new URLSearchParams();
  if (status) qs.set("status", status);
  if (kind) qs.set("kind", kind);
  const query = qs.toString();
  const list = useQuery({
    queryKey: ["alerts", query],
    queryFn: () => get<AlertList>(`/alerts${query ? `?${query}` : ""}`),
    refetchInterval: 10_000,
  });
  useEffect(() => setOlder([]), [query]);
  const rows = [...(list.data?.alerts ?? []), ...older.filter((o) => !list.data?.alerts.some((a) => a.id === o.id))];

  async function more() {
    const last = rows[rows.length - 1];
    if (!last) return;
    const p = new URLSearchParams(qs);
    p.set("before", String(Math.min(...rows.map((r) => r.id))));
    try {
      const next = await get<AlertList>(`/alerts?${p.toString()}`);
      setOlder((o) => [...o, ...next.alerts]);
    } catch (err) {
      setError(adminErrorText(err, "加载失败"));
    }
  }

  async function ack(a: AlertRow) {
    setError(null);
    try {
      await post(`/alerts/${a.id}/ack`, {});
      await queryClient.invalidateQueries({ queryKey: ["alerts"] });
    } catch (err) {
      setError(adminErrorText(err, "确认失败"));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>告警中心</h1>
        </CardTitle>
        <CardDescription>
          {list.data
            ? list.data.firing > 0
              ? `${list.data.firing} 条告警正在触发。`
              : "当前没有告警。"
            : "节点告警：离线、CPU/内存/磁盘、测速、证书到期、配置应用失败。"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="al-status">状态</Label>
            <select
              id="al-status"
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="">全部</option>
              <option value="firing">正在告警</option>
              <option value="resolved">已恢复</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="al-kind">类型</Label>
            <select
              id="al-kind"
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">全部</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_ZH[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {list.isPending ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : list.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {adminErrorText(list.error, "告警加载失败")}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有告警记录。</p>
        ) : (
          <Table label="告警列表">
            <TableHeader>
              <TableRow>
                <TableHead>状态</TableHead>
                <TableHead>节点</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>情况</TableHead>
                <TableHead>开始 / 恢复</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    {a.status === "firing" ? (
                      <Badge variant="destructive">告警中</Badge>
                    ) : (
                      <Badge variant="secondary">已恢复</Badge>
                    )}
                    {!a.notified && a.status === "firing" && (
                      <span className="ml-1 text-xs text-muted-foreground" title="静音节点、冷却期内或未配置通知通道">
                        未通知
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <a
                      className="underline"
                      href={`${adminBase}/nodes/${a.node_id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        navigate(`${adminBase}/nodes/${a.node_id}`);
                      }}
                    >
                      {a.node_name}
                    </a>
                  </TableCell>
                  <TableCell>{KIND_ZH[a.kind] ?? a.kind}</TableCell>
                  <TableCell className="max-w-sm">
                    {a.value}
                    {a.detail && <span className="block break-words text-xs text-muted-foreground">{a.detail}</span>}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmt(a.fired_at)}
                    {a.resolved_at && <span className="block">{fmt(a.resolved_at)}</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    {a.acked_at ? (
                      <span className="text-xs text-muted-foreground" title={fmt(a.acked_at)}>
                        {a.acked_by} 已确认
                      </span>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => void ack(a)}>
                        确认
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {rows.length >= 50 && (
          <Button variant="outline" size="sm" onClick={() => void more()}>
            加载更早的
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

interface Form {
  enabled: boolean;
  offline_secs: string;
  cpu_percent: string;
  cpu_minutes: string;
  mem_percent: string;
  mem_minutes: string;
  disk_percent: string;
  cert_days: string;
  latency_failures: boolean;
  last_error: boolean;
  cooldown_minutes: string;
  notify_resolved: boolean;
  telegram_enabled: boolean;
  telegram_chat_id: string;
  telegram_token: string;
  telegram_clear: boolean;
  telegram_api_url: string;
  webhook_enabled: boolean;
  webhook_url: string;
  webhook_secret: string;
  email_enabled: boolean;
  email_to: string;
}

function toForm(s: AlertSettings): Form {
  return {
    enabled: s.enabled,
    offline_secs: str(s.offline_secs),
    cpu_percent: str(s.cpu_percent),
    cpu_minutes: str(s.cpu_minutes),
    mem_percent: str(s.mem_percent),
    mem_minutes: str(s.mem_minutes),
    disk_percent: str(s.disk_percent),
    cert_days: str(s.cert_days),
    latency_failures: s.latency_failures,
    last_error: s.last_error,
    cooldown_minutes: str(s.cooldown_minutes),
    notify_resolved: s.notify_resolved,
    telegram_enabled: s.telegram_enabled,
    telegram_chat_id: s.telegram_chat_id ?? "",
    telegram_token: "",
    telegram_clear: false,
    telegram_api_url: s.telegram_api_url ?? "",
    webhook_enabled: s.webhook_enabled,
    webhook_url: s.webhook_url ?? "",
    webhook_secret: "",
    email_enabled: s.email_enabled,
    email_to: s.email_to.join(", "),
  };
}

/** The PUT body for a form, or an error message. */
export function toBody(f: Form, version: number): Record<string, unknown> | string {
  const nums: [keyof Form, string, boolean][] = [
    ["offline_secs", "离线判定", true],
    ["cpu_percent", "CPU 阈值", true],
    ["cpu_minutes", "CPU 持续分钟", false],
    ["mem_percent", "内存阈值", true],
    ["mem_minutes", "内存持续分钟", false],
    ["disk_percent", "磁盘阈值", true],
    ["cert_days", "证书提前天数", true],
    ["cooldown_minutes", "冷却时间", false],
  ];
  const body: Record<string, unknown> = { version };
  for (const [k, label, nullable] of nums) {
    const v = numOrNull(String(f[k]));
    if (v === "bad" || (v === null && !nullable)) return `${label}必须是整数${nullable ? "（留空表示关闭）" : ""}`;
    body[k] = v;
  }
  Object.assign(body, {
    enabled: f.enabled,
    latency_failures: f.latency_failures,
    last_error: f.last_error,
    notify_resolved: f.notify_resolved,
    telegram_enabled: f.telegram_enabled,
    telegram_chat_id: f.telegram_chat_id.trim() || null,
    telegram_api_url: f.telegram_api_url.trim() || null,
    webhook_enabled: f.webhook_enabled,
    webhook_url: f.webhook_url.trim() || null,
    email_enabled: f.email_enabled,
    email_to: f.email_to
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  });
  if (f.telegram_clear) body.telegram_token = null;
  else if (f.telegram_token.trim()) body.telegram_token = f.telegram_token.trim();
  if (f.webhook_secret.trim()) body.webhook_secret = f.webhook_secret.trim();
  return body;
}

function Check({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Num({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="numeric" className="w-32" value={value} onChange={(e) => onChange(e.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AlertSettingsCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["alert-settings"], queryFn: () => get<AlertSettings>("/alerts/settings") });
  const [form, setForm] = useState<Form | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (settings.data) setForm(toForm(settings.data));
  }, [settings.data]);

  if (settings.isPending || !form)
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">加载中…</CardContent>
      </Card>
    );
  if (settings.isError)
    return (
      <Card>
        <CardContent className="py-6">
          <p role="alert" className="text-sm text-destructive">
            {adminErrorText(settings.error, "告警设置加载失败")}
          </p>
        </CardContent>
      </Card>
    );
  const s = settings.data;
  const set =
    <K extends keyof Form>(k: K) =>
    (v: Form[K]) =>
      setForm({ ...form, [k]: v });

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const body = toBody(form, s.version);
    if (typeof body === "string") {
      setMsg({ ok: false, text: body });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const next = await put<AlertSettings>("/alerts/settings", body);
      queryClient.setQueryData(["alert-settings"], next);
      setMsg({ ok: true, text: "已保存。" });
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err, "保存失败") });
      await settings.refetch();
    } finally {
      setBusy(false);
    }
  }

  async function test(channel: "telegram" | "webhook" | "email") {
    setMsg(null);
    try {
      const r = await post<{ ok: boolean; error?: string }>("/alerts/test", { channel });
      setMsg(
        r.ok
          ? { ok: true, text: `${CHANNEL_ZH[channel]} 测试消息已发出（使用已保存的配置）。` }
          : { ok: false, text: `${CHANNEL_ZH[channel]} 测试失败：${r.error ?? "未知错误"}` },
      );
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err, "测试失败") });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>告警设置</h2>
        </CardTitle>
        <CardDescription>
          阈值留空表示关闭该项。每 {s.eval_interval_secs}{" "}
          秒评估一次（多实例时只有一个实例评估）；节点页可单独覆盖或静音。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={save}>
          <Check id="as-enabled" label="启用节点告警" checked={form.enabled} onChange={set("enabled")} />
          <fieldset className="grid gap-4 sm:grid-cols-4">
            <legend className="mb-2 text-sm font-medium">阈值</legend>
            <Num
              id="as-offline"
              label="离线超过（秒）"
              value={form.offline_secs}
              onChange={set("offline_secs")}
              hint="30–86400"
            />
            <Num id="as-cpu" label="CPU 高于（%）" value={form.cpu_percent} onChange={set("cpu_percent")} />
            <Num
              id="as-cpu-min"
              label="CPU 持续（分钟）"
              value={form.cpu_minutes}
              onChange={set("cpu_minutes")}
              hint="1–60"
            />
            <Num id="as-disk" label="磁盘高于（%）" value={form.disk_percent} onChange={set("disk_percent")} />
            <Num id="as-mem" label="内存高于（%）" value={form.mem_percent} onChange={set("mem_percent")} />
            <Num
              id="as-mem-min"
              label="内存持续（分钟）"
              value={form.mem_minutes}
              onChange={set("mem_minutes")}
              hint="1–60"
            />
            <Num
              id="as-cert"
              label="证书到期前（天）"
              value={form.cert_days}
              onChange={set("cert_days")}
              hint="节点证书与 Agent 证书"
            />
            <Num
              id="as-cool"
              label="重复告警冷却（分钟）"
              value={form.cooldown_minutes}
              onChange={set("cooldown_minutes")}
              hint="冷却期内反复触发只记录不通知"
            />
          </fieldset>
          <div className="flex flex-wrap gap-4">
            <Check
              id="as-latency"
              label="测速目标全部失败时告警"
              checked={form.latency_failures}
              onChange={set("latency_failures")}
            />
            <Check id="as-lasterr" label="配置应用失败时告警" checked={form.last_error} onChange={set("last_error")} />
            <Check
              id="as-resolved"
              label="恢复时也通知"
              checked={form.notify_resolved}
              onChange={set("notify_resolved")}
            />
          </div>

          <fieldset className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">Telegram 机器人</legend>
            <Check
              id="as-tg"
              label="通过 Telegram 通知"
              checked={form.telegram_enabled}
              onChange={set("telegram_enabled")}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="as-tg-chat">Chat ID</Label>
                <Input
                  id="as-tg-chat"
                  value={form.telegram_chat_id}
                  placeholder="-1001234567890 或 @频道名"
                  onChange={(e) => set("telegram_chat_id")(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="as-tg-token">Bot Token</Label>
                <Input
                  id="as-tg-token"
                  type="password"
                  autoComplete="off"
                  value={form.telegram_token}
                  placeholder={s.telegram_token_set ? "已设置（留空保持不变）" : "123456789:AA…（@BotFather）"}
                  onChange={(e) => set("telegram_token")(e.target.value)}
                />
                {s.telegram_token_set && (
                  <Check
                    id="as-tg-clear"
                    label="清除已保存的 Token"
                    checked={form.telegram_clear}
                    onChange={set("telegram_clear")}
                  />
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="as-tg-api">Telegram API 地址</Label>
              <Input
                id="as-tg-api"
                value={form.telegram_api_url}
                placeholder={`留空 = ${s.telegram_api_default}`}
                onChange={(e) => set("telegram_api_url")(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                面板所在网络无法访问 Telegram 时，填写自建 Bot API 服务器的 https 地址（只含域名与端口）。
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              面板只主动调用 Telegram sendMessage，不接收消息。Token 加密保存，不会再次显示。
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void test("telegram")}>
              发送测试
            </Button>
          </fieldset>

          <fieldset className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">Webhook</legend>
            <Check
              id="as-wh"
              label="通过 Webhook 通知"
              checked={form.webhook_enabled}
              onChange={set("webhook_enabled")}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="as-wh-url">URL</Label>
                <Input
                  id="as-wh-url"
                  value={form.webhook_url}
                  placeholder="https://hooks.example.com/akari"
                  onChange={(e) => set("webhook_url")(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="as-wh-secret">签名密钥</Label>
                <div className="flex gap-2">
                  <Input
                    id="as-wh-secret"
                    autoComplete="off"
                    value={form.webhook_secret}
                    placeholder={s.webhook_secret_set ? "已设置（留空保持不变）" : "16–128 个字符"}
                    onChange={(e) => set("webhook_secret")(e.target.value)}
                  />
                  <Button type="button" variant="outline" onClick={() => set("webhook_secret")(randomSecret())}>
                    随机生成
                  </Button>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              POST JSON；请求头 X-Akari-Signature = sha256=HMAC-SHA256(密钥, "时间戳.正文")，时间戳在
              X-Akari-Timestamp。保存后密钥不会再次显示。
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void test("webhook")}>
              发送测试
            </Button>
          </fieldset>

          <fieldset className="space-y-3 rounded-lg border border-border p-4">
            <legend className="px-1 text-sm font-medium">邮件</legend>
            {!s.email_available && (
              <p className="text-sm text-muted-foreground">邮件通知需要先配置 SMTP 发件（系统设置 → 邮件）。</p>
            )}
            <Check id="as-mail" label="通过邮件通知" checked={form.email_enabled} onChange={set("email_enabled")} />
            <div className="space-y-1">
              <Label htmlFor="as-mail-to">收件人（最多 5 个，逗号分隔）</Label>
              <Input id="as-mail-to" value={form.email_to} onChange={(e) => set("email_to")(e.target.value)} />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!s.email_available}
              onClick={() => void test("email")}
            >
              发送测试
            </Button>
          </fieldset>

          {msg && (
            <p
              role={msg.ok ? "status" : "alert"}
              className={`text-sm ${msg.ok ? "text-emerald-700" : "text-destructive"}`}
            >
              {msg.text}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            保存告警设置
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function DeliveryLog() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["alert-notifications"],
    queryFn: () => get<NotificationRow[]>("/alerts/notifications"),
    refetchInterval: 15_000,
  });

  async function retry(n: NotificationRow) {
    setError(null);
    try {
      await post(`/alerts/notifications/${n.id}/retry`, {});
      await queryClient.invalidateQueries({ queryKey: ["alert-notifications"] });
    } catch (err) {
      setError(adminErrorText(err, "重试失败"));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>通知记录</h2>
        </CardTitle>
        <CardDescription>最近 100 条。失败的会自动重试（间隔逐次加倍，最多 8 次），之后可手动重试。</CardDescription>
      </CardHeader>
      <CardContent>
        {error && (
          <p role="alert" className="mb-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {list.isPending ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : list.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {adminErrorText(list.error, "通知记录加载失败")}
          </p>
        ) : list.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有发出过通知。</p>
        ) : (
          <Table label="通知记录">
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>通道</TableHead>
                <TableHead>内容</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((n) => (
                <TableRow key={n.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmt(n.created_at)}</TableCell>
                  <TableCell>{CHANNEL_ZH[n.channel]}</TableCell>
                  <TableCell className="max-w-sm text-sm">{n.title ?? "—"}</TableCell>
                  <TableCell>
                    {n.status === "sent" ? (
                      <Badge variant="success">已发送</Badge>
                    ) : n.status === "dead" ? (
                      <Badge variant="destructive">失败</Badge>
                    ) : (
                      <Badge variant="outline">{n.attempts > 0 ? `重试中（${n.attempts}）` : "待发送"}</Badge>
                    )}
                    {n.last_error && (
                      <span className="block break-words text-xs text-muted-foreground">{n.last_error}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {n.status === "dead" && (
                      <Button variant="outline" size="sm" onClick={() => void retry(n)}>
                        重试
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** The node page's 告警规则 card: per-node overrides, disabled kinds, mute. */
export function NodeAlertRulesCard({ nodeId }: { nodeId: string }) {
  const queryClient = useQueryClient();
  const rules = useQuery({
    queryKey: ["node-alert-rules", nodeId],
    queryFn: () => get<NodeAlertRules>(`/nodes/${nodeId}/alert-rules`),
  });
  const [form, setForm] = useState<Record<string, string>>({});
  const [muted, setMuted] = useState(false);
  const [disabled, setDisabled] = useState<AlertKind[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const FIELDS: [keyof NodeAlertRules, string][] = [
    ["offline_secs", "离线超过（秒）"],
    ["cpu_percent", "CPU 高于（%）"],
    ["cpu_minutes", "CPU 持续（分钟）"],
    ["mem_percent", "内存高于（%）"],
    ["mem_minutes", "内存持续（分钟）"],
    ["disk_percent", "磁盘高于（%）"],
    ["cert_days", "证书到期前（天）"],
  ];
  useEffect(() => {
    if (!rules.data) return;
    setMuted(rules.data.muted);
    setDisabled(rules.data.disabled);
    setForm(Object.fromEntries(FIELDS.map(([k]) => [k, str(rules.data[k] as number | null)])));
    // FIELDS is constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { muted, disabled };
    for (const [k, label] of FIELDS) {
      const v = numOrNull(form[k] ?? "");
      if (v === "bad") {
        setMsg({ ok: false, text: `${label}必须是整数（留空表示沿用全局设置）` });
        return;
      }
      body[k] = v;
    }
    setMsg(null);
    try {
      await put(`/nodes/${nodeId}/alert-rules`, body);
      await queryClient.invalidateQueries({ queryKey: ["node-alert-rules", nodeId] });
      setMsg({ ok: true, text: "已保存。" });
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err, "保存失败") });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>告警规则</h2>
        </CardTitle>
        <CardDescription>留空沿用全局告警设置；静音后仍记录告警，但不发通知。</CardDescription>
      </CardHeader>
      <CardContent>
        {rules.isPending ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : rules.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {adminErrorText(rules.error, "告警规则加载失败")}
          </p>
        ) : (
          <form className="space-y-4" onSubmit={save}>
            <Check id={`nr-muted-${nodeId}`} label="静音此节点" checked={muted} onChange={setMuted} />
            <div className="grid gap-3 sm:grid-cols-4">
              {FIELDS.map(([k, label]) => (
                <Num
                  key={k}
                  id={`nr-${k}-${nodeId}`}
                  label={label}
                  value={form[k] ?? ""}
                  onChange={(v) => setForm((f) => ({ ...f, [k]: v }))}
                />
              ))}
            </div>
            <fieldset>
              <legend className="mb-1 text-sm font-medium">关闭以下告警</legend>
              <div className="flex flex-wrap gap-3">
                {KINDS.map((k) => (
                  <Check
                    key={k}
                    id={`nr-off-${k}-${nodeId}`}
                    label={KIND_ZH[k]}
                    checked={disabled.includes(k)}
                    onChange={(v) => setDisabled((d) => (v ? [...d, k] : d.filter((x) => x !== k)))}
                  />
                ))}
              </div>
            </fieldset>
            {msg && (
              <p
                role={msg.ok ? "status" : "alert"}
                className={`text-sm ${msg.ok ? "text-emerald-700" : "text-destructive"}`}
              >
                {msg.text}
              </p>
            )}
            <Button type="submit" size="sm">
              保存告警规则
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
