// 系统设置 → 通知：发信通道 (SET-15 transport, SET-16 step-by-step test),
// 邮件模板 (SET-18: the full-width editor is its own page,
// /settings/mail-templates; this section links there), 通知种类 (the notice
// switches of SET-15: "what is sent" apart from "how") and 告警通道与阈值
// (ALR-03/04, moved here from the alerts page). The outbox (SET-17) moved to
// 系统状态 → 邮件队列. Tests always use the saved configuration.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, MailOpen, Shuffle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { get, post, put } from "../../shared/api";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Group } from "../../shared/ui/card";
import { Input, SecretInput, Segmented, Select } from "../../shared/ui/form";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { useErrText } from "../kit";
import { useMe } from "../session";
import { fresh } from "./settings-data";
import {
  FieldRow,
  InfoRow,
  Loaded,
  SwitchRow,
  Warnings,
  intError,
  intOf,
  numText,
  urlError,
  useDraft,
  useSavePart,
} from "./settings-kit";

type Mail = {
  version: number;
  enabled: boolean;
  provider: string;
  providers: string[];
  host: string | null;
  port: number;
  security: string;
  username: string | null;
  password_set: boolean;
  api_key_set: boolean;
  from_addr: string | null;
  from_name: string | null;
  notify_order_paid: boolean;
  notify_expiry_days: number;
  notify_expired: boolean;
  notify_quota: boolean;
  notify_refund: boolean;
  dead_letters: number;
  pending: number;
  warnings: string[];
};
type Step = {
  step: string;
  status: "ok" | "warn" | "fail" | "skip";
  elapsed_ms: number;
  code: string;
  message: { zh: string; en: string };
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The full PUT body of /settings/mail: `m` = the saved values with this part's edits on top. */
function mailBody(m: Mail, secrets: { password?: string; api_key?: string } = {}) {
  return {
    version: m.version,
    enabled: m.enabled,
    provider: m.provider,
    host: m.host || null,
    port: m.port,
    security: m.security,
    username: m.username || null,
    ...(secrets.password ? { password: secrets.password } : {}),
    ...(secrets.api_key ? { api_key: secrets.api_key } : {}),
    from_addr: m.from_addr || null,
    from_name: m.from_name || null,
    notify_order_paid: m.notify_order_paid,
    notify_expiry_days: m.notify_expiry_days,
    notify_expired: m.notify_expired,
    notify_quota: m.notify_quota,
    notify_refund: m.notify_refund,
  };
}

function useMail() {
  return useQuery({ queryKey: ["settings", "mail"], queryFn: () => get<Mail>("/settings/mail") });
}

// ---------------------------------------------------------------------------
// 发信通道
// ---------------------------------------------------------------------------

export function MailSection() {
  const q = useMail();
  return (
    <>
      <Loaded q={q}>{(m) => <TransportForm m={m} />}</Loaded>
      <Diagnose />
    </>
  );
}

function TransportForm({ m }: { m: Mail }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const f = useDraft({
    enabled: m.enabled,
    provider: m.provider,
    host: m.host ?? "",
    port: String(m.port),
    security: m.security,
    username: m.username ?? "",
    password: "",
    api_key: "",
    from_addr: m.from_addr ?? "",
    from_name: m.from_name ?? "",
  });
  const v = f.value!;
  const smtp = v.provider === "smtp";
  const portError = smtp && f.isEdited("port") ? intError(v.port, 1, 65535, tr) : undefined;
  const hostError =
    smtp && v.enabled && !v.host.trim() ? tr("启用 SMTP 发信需要服务器地址", "SMTP needs a host") : undefined;
  const fromError =
    v.from_addr.trim() && !EMAIL.test(v.from_addr.trim())
      ? tr("邮箱格式不对", "Not an email address")
      : v.enabled && !v.from_addr.trim()
        ? tr("启用发信需要发件地址", "Sending needs a from address")
        : undefined;
  const errors = [portError, f.edited.length ? hostError : undefined, f.edited.length ? fromError : undefined].filter(
    Boolean,
  ).length;
  useSavePart({
    count: f.edited.length,
    errors,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings", "mail"], m);
      const r = await run(
        () =>
          put<Mail>(
            "/settings/mail",
            mailBody(
              {
                ...cur,
                enabled: v.enabled,
                provider: v.provider,
                host: v.host.trim(),
                port: intOf(v.port) ?? cur.port,
                security: v.security,
                username: v.username.trim(),
                from_addr: v.from_addr.trim(),
                from_name: v.from_name.trim(),
              },
              { password: v.password, api_key: v.api_key.trim() },
            ),
          ),
        { ok: tr("发信设置已保存", "Mail settings saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      <Warnings items={m.warnings} />
      <Group title={tr("发信方式", "Transport")}>
        <SwitchRow
          label={tr("启用邮件发送", "Mail sending on")}
          description={tr("关闭时验证码、找回密码与通知邮件都不发送", "When off no codes, resets or notices are sent")}
          checked={v.enabled}
          onChange={(x) => f.set("enabled", x)}
        />
        <InfoRow label={tr("服务商", "Provider")}>
          <Segmented
            label={tr("服务商", "Provider")}
            value={v.provider}
            onChange={(x) => f.set("provider", x)}
            options={m.providers.map((p) => ({
              value: p,
              label: p === "smtp" ? "SMTP" : p === "resend" ? "Resend API" : p,
            }))}
          />
        </InfoRow>
        {smtp ? (
          <>
            <FieldRow label={tr("SMTP 服务器", "SMTP host")} error={f.edited.length ? hostError : undefined}>
              {(a) => (
                <Input
                  {...a}
                  className="font-mono sm:w-64"
                  value={v.host}
                  onChange={(e) => f.set("host", e.target.value)}
                />
              )}
            </FieldRow>
            <FieldRow label={tr("端口", "Port")} description={tr("1–65535", "1–65535")} error={portError}>
              {(a) => (
                <Input
                  {...a}
                  inputMode="numeric"
                  className="tnum text-right sm:w-24"
                  value={v.port}
                  onChange={(e) => f.set("port", e.target.value)}
                />
              )}
            </FieldRow>
            <FieldRow label={tr("加密方式", "Security")}>
              {(a) => (
                <Select
                  {...a}
                  className="sm:w-56"
                  value={v.security}
                  onChange={(e) => f.set("security", e.target.value)}
                >
                  <option value="tls">{tr("隐式 TLS（465）", "Implicit TLS (465)")}</option>
                  <option value="starttls">STARTTLS（587）</option>
                  <option value="none">{tr("不加密（仅本机或内网）", "None (local only)")}</option>
                </Select>
              )}
            </FieldRow>
            <FieldRow label={tr("用户名", "User name")}>
              {(a) => (
                <Input
                  {...a}
                  className="sm:w-64"
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  value={v.username}
                  onChange={(e) => f.set("username", e.target.value)}
                />
              )}
            </FieldRow>
            <FieldRow
              label={tr("密码（只写）", "Password (write-only)")}
              description={m.password_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
            >
              {(a) => (
                <SecretInput
                  {...a}
                  className="sm:w-64"
                  value={v.password}
                  onChange={(e) => f.set("password", e.target.value)}
                />
              )}
            </FieldRow>
          </>
        ) : (
          <FieldRow
            label={tr("Resend API key（只写）", "Resend API key (write-only)")}
            description={m.api_key_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
          >
            {(a) => (
              <SecretInput
                {...a}
                className="sm:w-64"
                value={v.api_key}
                onChange={(e) => f.set("api_key", e.target.value)}
              />
            )}
          </FieldRow>
        )}
      </Group>
      <Group title={tr("发件人", "Sender")}>
        <FieldRow label={tr("发件地址", "From address")} error={f.edited.length ? fromError : undefined}>
          {(a) => (
            <Input
              {...a}
              type="email"
              className="sm:w-64"
              value={v.from_addr}
              onChange={(e) => f.set("from_addr", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow label={tr("发件人名称", "From name")} description={tr("留空 = 站点名称", "Empty = the site name")}>
          {(a) => (
            <Input
              {...a}
              className="sm:w-64"
              value={v.from_name}
              onChange={(e) => f.set("from_name", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
    </>
  );
}

const STEPS: Record<string, [string, string]> = {
  config: ["配置", "Config"],
  dns: ["解析域名", "DNS"],
  tcp: ["连接端口", "TCP"],
  tls: ["TLS 握手", "TLS"],
  greeting: ["服务器问候", "Greeting"],
  auth: ["认证", "Auth"],
  send: ["发送", "Send"],
};

function Diagnose() {
  const tr = useTr();
  const lang = useLang();
  const me = useMe();
  const toast = useToast();
  const errText = useErrText();
  const [to, setTo] = useState(me.email);
  const [report, setReport] = useState<{ ok: boolean; steps: Step[] } | null>(null);
  const [runDiag, diagBusy] = useAction();
  const [sending, setSending] = useState(false);
  const statusText = (s: Step["status"]) =>
    ({ ok: tr("通过", "OK"), warn: tr("注意", "Warning"), fail: tr("失败", "Failed"), skip: tr("跳过", "Skipped") })[s];
  return (
    <Group
      title={tr("测试发信", "Test mail")}
      footer={tr(
        "测试使用已保存的配置：先保存上面的修改再测试。诊断逐步检查并发一封测试邮件，失败的一步标红并说明可能原因。",
        "Tests use the saved configuration: save the changes above first. The diagnosis checks step by step and sends a test; a failing step is red with the likely cause.",
      )}
    >
      <FieldRow label={tr("收件地址", "To")}>
        {(a) => (
          <Input
            {...a}
            data-nodirty
            type="email"
            className="sm:w-64"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        )}
      </FieldRow>
      <div className="flex flex-wrap gap-2 px-4 py-2.5">
        <Button
          variant="primary"
          size="sm"
          loading={diagBusy}
          disabled={!EMAIL.test(to.trim())}
          onClick={() =>
            void runDiag(() => post<{ ok: boolean; steps: Step[] }>("/settings/mail/diagnose", { to: to.trim() })).then(
              (r) => r && setReport(r),
            )
          }
        >
          {tr("诊断并发送", "Diagnose and send")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          loading={sending}
          disabled={!EMAIL.test(to.trim())}
          onClick={async () => {
            setSending(true);
            try {
              await post("/settings/mail/test", { to: to.trim() });
              toast({ tone: "success", title: tr(`测试邮件已发出：${to.trim()}`, `Test mail sent to ${to.trim()}`) });
            } catch (e) {
              toast({ tone: "error", title: errText(e) });
            } finally {
              setSending(false);
            }
          }}
        >
          {tr("直接发送测试邮件", "Just send a test")}
        </Button>
      </div>
      {report && (
        <ol className="grid gap-1.5 px-4 py-2.5" aria-label={tr("诊断结果", "Diagnosis")}>
          {report.steps.map((s) => (
            <li
              key={s.step}
              data-step={s.step}
              className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-body ring-1 ring-inset ${s.status === "fail" ? "bg-destructive-soft ring-destructive/30" : s.status === "warn" ? "bg-warning-soft ring-warning/30" : "ring-border"}`}
            >
              <Badge
                tone={
                  s.status === "ok"
                    ? "success"
                    : s.status === "fail"
                      ? "danger"
                      : s.status === "warn"
                        ? "warning"
                        : "neutral"
                }
                data-status={s.status}
              >
                {statusText(s.status)}
              </Badge>
              <span className="w-24 font-medium">{tr(...(STEPS[s.step] ?? [s.step, s.step]))}</span>
              <span className="min-w-0 flex-1">{lang === "en" ? s.message.en : s.message.zh}</span>
              <span className="tnum text-footnote text-muted-foreground">{s.elapsed_ms} ms</span>
            </li>
          ))}
          <li>
            <Badge tone={report.ok ? "success" : "danger"}>
              {report.ok ? tr("测试邮件已被接受", "Accepted by the provider") : tr("未能发送", "Not sent")}
            </Badge>
          </li>
        </ol>
      )}
    </Group>
  );
}

// ---------------------------------------------------------------------------
// 邮件模板 (the editor is its own page)
// ---------------------------------------------------------------------------

type TemplateRow = { kind: string; custom: boolean };

export function TemplatesSection() {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["mail-templates"],
    queryFn: () => get<TemplateRow[]>("/settings/mail-templates"),
  });
  const kinds = new Set((q.data ?? []).map((t) => t.kind)).size;
  const custom = new Set((q.data ?? []).filter((t) => t.custom).map((t) => t.kind)).size;
  return (
    <Group
      title={tr("模板编辑器", "Template editor")}
      footer={tr(
        "每种邮件中、英各一份，按收件人的语言发送。编辑器有占位符检查、实时预览（桌面与手机宽度、浅色与深色）与测试发送。",
        "One per kind and language, sent in the recipient's. The editor checks placeholders, previews live (desktop and phone width, light and dark) and sends tests.",
      )}
    >
      <InfoRow
        label={tr("邮件模板", "Mail templates")}
        description={
          q.data
            ? tr(`${kinds} 种邮件 · ${custom} 种已自定义`, `${kinds} kinds · ${custom} customised`)
            : tr("自定义每种邮件的主题、正文与 HTML 源码", "Customise every mail's subject, body and HTML source")
        }
      >
        <Button asChild variant="primary" size="sm">
          <Link to="/settings/mail-templates">
            <MailOpen aria-hidden="true" />
            {tr("打开模板编辑器", "Open the template editor")}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      </InfoRow>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// 通知种类
// ---------------------------------------------------------------------------

export function NoticesSection() {
  const q = useMail();
  return <Loaded q={q}>{(m) => <NoticesForm m={m} />}</Loaded>;
}

function NoticesForm({ m }: { m: Mail }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const f = useDraft({
    notify_order_paid: m.notify_order_paid,
    notify_expired: m.notify_expired,
    notify_quota: m.notify_quota,
    notify_refund: m.notify_refund,
    days: String(m.notify_expiry_days),
  });
  const v = f.value!;
  const daysError = f.isEdited("days") ? intError(v.days, 0, 30, tr) : undefined;
  useSavePart({
    count: f.edited.length,
    errors: daysError ? 1 : 0,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["settings", "mail"], m);
      const r = await run(
        () =>
          put(
            "/settings/mail",
            mailBody({
              ...cur,
              notify_order_paid: v.notify_order_paid,
              notify_expired: v.notify_expired,
              notify_quota: v.notify_quota,
              notify_refund: v.notify_refund,
              notify_expiry_days: intOf(v.days) ?? 0,
            }),
          ),
        { ok: tr("通知设置已保存", "Notice settings saved") },
      );
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  return (
    <>
      {!m.enabled && (
        <Warnings
          items={[
            tr(
              "邮件发送未启用（发信通道）：下面的通知暂时都不会发出。",
              "Mail sending is off (Mail transport): none of these notices go out for now.",
            ),
          ]}
        />
      )}
      <Group
        title={tr("订单", "Orders")}
        footer={tr("只发给已验证的邮箱，按收件人的语言。", "Only to verified addresses, in the recipient's language.")}
      >
        <SwitchRow
          label={tr("付款回执", "Payment receipt")}
          checked={v.notify_order_paid}
          onChange={(x) => f.set("notify_order_paid", x)}
        />
        <SwitchRow
          label={tr("退款通知", "Refund notice")}
          checked={v.notify_refund}
          onChange={(x) => f.set("notify_refund", x)}
        />
      </Group>
      <Group title={tr("套餐", "Plans")}>
        <FieldRow
          label={tr("到期前多少天提醒", "Expiry reminder (days before)")}
          description={tr("0–30 天，0 = 不提醒", "0–30 days, 0 = off")}
          error={daysError}
        >
          {(a) => (
            <Input
              {...a}
              inputMode="numeric"
              className="tnum text-right sm:w-24"
              value={v.days}
              onChange={(e) => f.set("days", e.target.value)}
            />
          )}
        </FieldRow>
        <SwitchRow
          label={tr("套餐已到期", "Plan expired")}
          checked={v.notify_expired}
          onChange={(x) => f.set("notify_expired", x)}
        />
        <SwitchRow
          label={tr("流量用到 80% / 100%", "Traffic at 80% / 100%")}
          checked={v.notify_quota}
          onChange={(x) => f.set("notify_quota", x)}
        />
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// 告警通道与阈值
// ---------------------------------------------------------------------------

type AlertSettings = {
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

export function AlertsSection() {
  const q = useQuery({ queryKey: ["alerts", "settings"], queryFn: () => get<AlertSettings>("/alerts/settings") });
  return <Loaded q={q}>{(s) => <AlertsForm s={s} />}</Loaded>;
}

type Num =
  | "offline_secs"
  | "cpu_percent"
  | "cpu_minutes"
  | "mem_percent"
  | "mem_minutes"
  | "disk_percent"
  | "cert_days"
  | "cooldown_minutes";
const RANGES: Record<Num, [number, number, boolean]> = {
  offline_secs: [30, 86400, true],
  cpu_percent: [1, 100, true],
  cpu_minutes: [1, 60, false],
  mem_percent: [1, 100, true],
  mem_minutes: [1, 60, false],
  disk_percent: [1, 100, true],
  cert_days: [1, 90, true],
  cooldown_minutes: [0, 1440, false],
};

function AlertsForm({ s }: { s: AlertSettings }) {
  const tr = useTr();
  const qc = useQueryClient();
  const [run] = useAction();
  const f = useDraft({
    enabled: s.enabled,
    offline_secs: numText(s.offline_secs),
    cpu_percent: numText(s.cpu_percent),
    cpu_minutes: numText(s.cpu_minutes),
    mem_percent: numText(s.mem_percent),
    mem_minutes: numText(s.mem_minutes),
    disk_percent: numText(s.disk_percent),
    cert_days: numText(s.cert_days),
    cooldown_minutes: numText(s.cooldown_minutes),
    latency_failures: s.latency_failures,
    last_error: s.last_error,
    notify_resolved: s.notify_resolved,
    telegram_enabled: s.telegram_enabled,
    token: "",
    chat: s.telegram_chat_id ?? "",
    api: s.telegram_api_url ?? "",
    webhook_enabled: s.webhook_enabled,
    webhook_url: s.webhook_url ?? "",
    secret: "",
    email_enabled: s.email_enabled,
    emails: s.email_to.join(", "),
  });
  const v = f.value!;
  const numError = (k: Num) =>
    f.isEdited(k) ? intError(v[k], RANGES[k][0], RANGES[k][1], tr, RANGES[k][2]) : undefined;
  const nums = Object.keys(RANGES) as Num[];
  const apiError = urlError(v.api, tr);
  const hookError =
    v.webhook_enabled && !v.webhook_url.trim()
      ? tr("启用 Webhook 需要地址", "The webhook needs a URL")
      : urlError(v.webhook_url, tr);
  const recipients = v.emails.split(/[\s,]+/).filter(Boolean);
  const emailsError =
    recipients.length > 5
      ? tr("最多 5 个收件人", "At most 5 recipients")
      : recipients.find((x) => !EMAIL.test(x))
        ? tr(
            `「${recipients.find((x) => !EMAIL.test(x))}」不是邮箱地址`,
            `"${recipients.find((x) => !EMAIL.test(x))}" is not an email address`,
          )
        : undefined;
  const errors = nums.filter((k) => numError(k)).length + [apiError, hookError, emailsError].filter(Boolean).length;
  useSavePart({
    count: f.edited.length,
    errors,
    discard: f.reset,
    save: async () => {
      const cur = fresh(qc, ["alerts", "settings"], s);
      const body: Record<string, unknown> = {
        version: cur.version,
        enabled: v.enabled,
        offline_secs: intOf(v.offline_secs),
        cpu_percent: intOf(v.cpu_percent),
        cpu_minutes: intOf(v.cpu_minutes),
        mem_percent: intOf(v.mem_percent),
        mem_minutes: intOf(v.mem_minutes),
        disk_percent: intOf(v.disk_percent),
        cert_days: intOf(v.cert_days),
        latency_failures: v.latency_failures,
        last_error: v.last_error,
        cooldown_minutes: intOf(v.cooldown_minutes),
        notify_resolved: v.notify_resolved,
        telegram_enabled: v.telegram_enabled,
        telegram_chat_id: v.chat.trim() || null,
        telegram_api_url: v.api.trim() || null,
        webhook_enabled: v.webhook_enabled,
        webhook_url: v.webhook_url.trim() || null,
        email_enabled: v.email_enabled,
        email_to: recipients,
      };
      if (v.token.trim()) body.telegram_token = v.token.trim();
      if (v.secret.trim()) body.webhook_secret = v.secret.trim();
      const r = await run(() => put<AlertSettings>("/alerts/settings", body), {
        ok: tr("告警设置已保存", "Alert settings saved"),
      });
      if (r === undefined) return false;
      f.reset();
      return true;
    },
  });
  const num = (k: Num, label: string, unit: string) => {
    const [min, max, blank] = RANGES[k];
    return (
      <FieldRow
        label={label}
        description={
          blank
            ? tr(`${min}–${max} ${unit}，留空 = 关闭`, `${min}–${max} ${unit}, empty = off`)
            : `${min}–${max} ${unit}`
        }
        error={numError(k)}
      >
        {(a) => (
          <Input
            {...a}
            inputMode="numeric"
            className="tnum text-right sm:w-24"
            value={v[k]}
            onChange={(e) => f.set(k, e.target.value)}
          />
        )}
      </FieldRow>
    );
  };
  const randomSecret = () => {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    f.set("secret", Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
  };
  return (
    <>
      <Group
        title={tr("规则", "Rules")}
        footer={tr(
          "每 30 秒评估一次；服务器可以单独覆盖或关闭（节点页 → 服务器 → 告警规则）。",
          "Evaluated every 30 s; a server may override or switch them off (Nodes → server → alert rules).",
        )}
      >
        <SwitchRow label={tr("启用告警", "Alerts on")} checked={v.enabled} onChange={(x) => f.set("enabled", x)} />
        {num("offline_secs", tr("离线多少秒告警", "Offline seconds"), tr("秒", "s"))}
        {num("cpu_percent", tr("CPU 超过 %", "CPU above %"), "%")}
        {num("cpu_minutes", tr("CPU 持续分钟", "CPU minutes"), tr("分钟", "min"))}
        {num("mem_percent", tr("内存超过 %", "Memory above %"), "%")}
        {num("mem_minutes", tr("内存持续分钟", "Memory minutes"), tr("分钟", "min"))}
        {num("disk_percent", tr("磁盘超过 %", "Disk above %"), "%")}
        {num("cert_days", tr("证书剩余少于天数", "Certificate days below"), tr("天", "days"))}
        <SwitchRow
          label={tr("测速全部失败", "Every probe fails")}
          checked={v.latency_failures}
          onChange={(x) => f.set("latency_failures", x)}
        />
        <SwitchRow
          label={tr("配置应用失败", "Apply failed")}
          checked={v.last_error}
          onChange={(x) => f.set("last_error", x)}
        />
      </Group>
      <Group title={tr("通知方式", "Delivery")}>
        {num("cooldown_minutes", tr("冷却（分钟）", "Cooldown (minutes)"), tr("分钟", "min"))}
        <SwitchRow
          label={tr("恢复时也通知", "Notify on recovery")}
          checked={v.notify_resolved}
          onChange={(x) => f.set("notify_resolved", x)}
        />
      </Group>
      <Group title="Telegram" footer={<TestButton channel="telegram" disabled={!s.telegram_enabled} />}>
        <SwitchRow
          label={tr("启用 Telegram 通知", "Telegram notifications")}
          name="Telegram"
          checked={v.telegram_enabled}
          onChange={(x) => f.set("telegram_enabled", x)}
        />
        <FieldRow
          label={tr("Bot token（只写）", "Bot token (write-only)")}
          description={s.telegram_token_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
        >
          {(a) => (
            <SecretInput {...a} className="sm:w-64" value={v.token} onChange={(e) => f.set("token", e.target.value)} />
          )}
        </FieldRow>
        <FieldRow label="Chat ID">
          {(a) => (
            <Input
              {...a}
              className="font-mono sm:w-64"
              value={v.chat}
              onChange={(e) => f.set("chat", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("Telegram API 地址", "Telegram API URL")}
          description={tr(
            `自建 Bot API 时填写；留空 = ${s.telegram_api_default}`,
            `For a self-hosted Bot API; empty = ${s.telegram_api_default}`,
          )}
          error={apiError}
        >
          {(a) => (
            <Input
              {...a}
              className="font-mono sm:w-64"
              placeholder={s.telegram_api_default}
              value={v.api}
              onChange={(e) => f.set("api", e.target.value)}
            />
          )}
        </FieldRow>
      </Group>
      <Group
        title={tr("签名 Webhook", "Signed webhook")}
        footer={<TestButton channel="webhook" disabled={!s.webhook_enabled} />}
      >
        <SwitchRow
          label={tr("启用 Webhook", "Webhook on")}
          name="Webhook"
          description={tr(
            '请求头 X-Akari-Signature: sha256=HMAC(密钥, "<时间戳>.<正文>")',
            'Header X-Akari-Signature: sha256=HMAC(secret, "<ts>.<body>")',
          )}
          checked={v.webhook_enabled}
          onChange={(x) => f.set("webhook_enabled", x)}
        />
        <FieldRow label={tr("Webhook 地址", "Webhook URL")} error={hookError}>
          {(a) => (
            <Input
              {...a}
              className="font-mono sm:w-72"
              value={v.webhook_url}
              onChange={(e) => f.set("webhook_url", e.target.value)}
            />
          )}
        </FieldRow>
        <FieldRow
          label={tr("签名密钥（只写）", "Signing secret (write-only)")}
          description={s.webhook_secret_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
        >
          {(a) => (
            <div className="flex gap-2">
              <SecretInput
                {...a}
                className="sm:w-52"
                value={v.secret}
                onChange={(e) => f.set("secret", e.target.value)}
              />
              <Button icon={Shuffle} onClick={randomSecret}>
                {tr("随机生成", "Random")}
              </Button>
            </div>
          )}
        </FieldRow>
      </Group>
      <Group
        title={tr("邮件", "Email")}
        footer={<TestButton channel="email" disabled={!s.email_enabled || !s.email_available} />}
      >
        <SwitchRow
          label={tr("启用邮件告警", "Email alerts on")}
          description={
            s.email_available ? undefined : tr("邮件发送未配置（发信通道）", "Mail is not configured (Mail transport)")
          }
          checked={v.email_enabled}
          onChange={(x) => f.set("email_enabled", x)}
        />
        <FieldRow
          label={tr("收件人（最多 5 个，逗号分隔）", "Recipients (up to 5, comma separated)")}
          error={emailsError}
          stack
        >
          {(a) => <Input {...a} value={v.emails} onChange={(e) => f.set("emails", e.target.value)} />}
        </FieldRow>
      </Group>
    </>
  );
}

/** A channel test: always the saved configuration; its own busy state. */
function TestButton({ channel, disabled }: { channel: "telegram" | "webhook" | "email"; disabled: boolean }) {
  const tr = useTr();
  const toast = useToast();
  const errText = useErrText();
  const [busy, setBusy] = useState(false);
  const name = { telegram: "Telegram", webhook: "Webhook", email: tr("邮件", "Email") }[channel];
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        loading={busy}
        disabled={disabled}
        aria-label={tr(`发送测试（${name}）`, `Send a test (${name})`)}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await post<{ ok: boolean; error?: string }>("/alerts/test", { channel });
            toast(
              r.ok
                ? { tone: "success", title: tr(`测试消息已发送（${name}）`, `Test message sent (${name})`) }
                : { tone: "error", title: tr(`测试失败（${name}）`, `Test failed (${name})`), description: r.error },
            );
          } catch (e) {
            toast({ tone: "error", title: errText(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        {tr("发送测试", "Send test")}
      </Button>
      <span>
        {disabled
          ? tr("保存并启用后才能测试", "Save it enabled to test")
          : tr("测试使用已保存的配置", "The test uses the saved configuration")}
      </span>
    </span>
  );
}
