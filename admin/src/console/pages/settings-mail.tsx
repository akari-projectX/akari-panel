// 系统设置 → 通知 (v2): 发信通道 (SET-15 transport: a status strip — provider,
// mails in the last 24 hours, failures linked to the mail queue — and
// "测试发信", the step-by-step diagnosis of SET-16 in a dialog, also opened by
// `?diagnose=1`; SMTP / Resend as radio cards, the sender, links to the
// templates and the notices), 通知种类 (the notice switches of SET-15, each
// with its mails in the last 30 days and a link to its template) and
// 告警通道与阈值 (ALR-03/04: thresholds written as sentences, empty = off; the
// Telegram, signed webhook and mail channels as cards; tests always use the
// saved configuration and report per channel). The template editor (SET-18)
// is its own page (/settings/templates); the outbox (SET-17) is on
// 系统状态 → 邮件队列.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bell,
  Mail as MailIcon,
  MailOpen,
  Send,
  Server,
  Shuffle,
  Stethoscope,
  Webhook,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, Group, Tile } from "../../shared/ui/card";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, SecretInput, Segmented, Switch } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { useErrText } from "../kit";
import { useMe } from "../session";
import { RadioCards, UnitInput } from "../components/inputs";
import { RawError } from "../components/kit";
import { fresh } from "./settings-data";
import type { MailS } from "./settings-overview";
import {
  FieldRow,
  Loaded,
  OwnerOnly,
  Panel,
  SRow,
  SwitchRow,
  Warnings,
  intError,
  intOf,
  numText,
  urlError,
  useDraft,
  useSavePart,
} from "../components/settings-kit";

type Mail = MailS & {
  version: number;
  providers: string[];
  host: string | null;
  port: number;
  security: string;
  username: string | null;
  password_set: boolean;
  api_key_set: boolean;
  from_addr: string | null;
  from_name: string | null;
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
    notify_ban: m.notify_ban,
    notify_plan_change: m.notify_plan_change,
    notify_withdrawal: m.notify_withdrawal,
    notify_commission: m.notify_commission,
  };
}

function useMail() {
  return useQuery({ queryKey: ["settings", "mail"], queryFn: () => get<Mail>("/settings/mail") });
}

const fmt = (n: number | undefined) => (n === undefined ? "—" : n.toLocaleString());

// ---------------------------------------------------------------------------
// 发信通道
// ---------------------------------------------------------------------------

export function MailSection() {
  const q = useMail();
  const [sp, setSp] = useSearchParams();
  const diag = sp.get("diagnose") === "1";
  const setDiag = (on: boolean) =>
    setSp(
      (p) => {
        const n = new URLSearchParams(p);
        if (on) n.set("diagnose", "1");
        else n.delete("diagnose");
        return n;
      },
      { replace: !on },
    );
  return (
    <>
      <Loaded q={q}>{(m) => <TransportForm m={m} onDiagnose={() => setDiag(true)} />}</Loaded>
      <DiagnoseDialog open={diag} onClose={() => setDiag(false)} />
    </>
  );
}

function StatusStrip({ m, onDiagnose }: { m: Mail; onDiagnose: () => void }) {
  const tr = useTr();
  const failed = m.dead_24h ?? 0;
  const tone = !m.enabled ? "neutral" : failed ? "warning" : "success";
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
      <div className="flex items-center gap-2.5">
        <Badge tone={tone} dot>
          {!m.enabled ? tr("未启用", "Off") : failed ? tr("部分失败", "Some failed") : tr("正常", "Healthy")}
        </Badge>
        <span className="text-body font-medium">{m.provider === "resend" ? "Resend" : "SMTP"}</span>
      </div>
      <div className="text-footnote">
        <span className="text-faint">{tr("24 小时发送 ", "Sent in 24 h ")}</span>
        <b className="tabular-nums">{fmt(m.sent_24h)}</b>
      </div>
      <div className="text-footnote">
        <span className="text-faint">{tr("失败 ", "Failed ")}</span>
        <Link
          to="/status?mail=dead"
          className={cn(
            "font-semibold tabular-nums hover:underline",
            failed ? "text-warning" : "text-muted-foreground",
          )}
          aria-label={tr(`近 24 小时 ${failed} 封失败，打开邮件队列`, `${failed} failed in 24 h, open the mail queue`)}
        >
          {fmt(m.dead_24h)}
        </Link>
      </div>
      {m.pending > 0 && (
        <div className="text-footnote">
          <span className="text-faint">{tr("待发送 ", "Queued ")}</span>
          <b className="tabular-nums">{fmt(m.pending)}</b>
        </div>
      )}
      <div className="flex-1" />
      <Button variant="primary" size="sm" icon={Stethoscope} onClick={onDiagnose}>
        {tr("测试发信", "Test mail")}
      </Button>
    </Card>
  );
}

function TransportForm({ m, onDiagnose }: { m: Mail; onDiagnose: () => void }) {
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
      ? tr(
          "需要完整的邮箱地址，域名需与发信服务验证过的一致",
          "Enter a full address on a domain the provider has verified",
        )
      : v.enabled && !v.from_addr.trim()
        ? tr("启用发信需要发件地址", "Sending needs a from address")
        : undefined;
  const shown = (e: string | undefined) => (f.edited.length ? e : undefined);
  const errors = [portError, shown(hostError), shown(fromError)].filter(Boolean).length;
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
      f.saved();
      return true;
    },
  });
  const tpl = useQuery({
    queryKey: ["mail-templates"],
    queryFn: () => get<{ kind: string; custom: boolean }[]>("/settings/mail-templates"),
  }).data;
  const kinds = tpl ? new Set(tpl.map((t) => t.kind)).size : undefined;
  const custom = tpl ? new Set(tpl.filter((t) => t.custom).map((t) => t.kind)).size : undefined;
  const notices = [
    m.notify_order_paid,
    m.notify_expiry_days > 0,
    m.notify_expired,
    m.notify_quota,
    m.notify_refund,
    m.notify_ban,
    m.notify_plan_change,
    m.notify_withdrawal,
    m.notify_commission,
  ];
  return (
    <>
      <StatusStrip m={m} onDiagnose={onDiagnose} />
      <Warnings items={m.warnings} />
      <OwnerOnly what={tr("发信设置", "the mail settings")}>
        <Group>
          <SwitchRow
            label={tr("启用邮件发送", "Mail sending on")}
            description={tr(
              "关闭时验证码、找回密码与通知邮件都不发送",
              "When off no codes, resets or notices are sent",
            )}
            checked={v.enabled}
            onChange={(x) => f.set("enabled", x)}
            changed={f.isEdited("enabled")}
          />
        </Group>
        <Panel title={tr("发信方式", "Transport")}>
          <RadioCards
            label={tr("发信方式", "Transport")}
            value={v.provider}
            onChange={(x) => f.set("provider", x)}
            cols={2}
            items={m.providers.map((p) =>
              p === "smtp"
                ? {
                    value: p,
                    title: "SMTP",
                    desc: tr(
                      "任何邮箱服务商；需要主机、端口与账号",
                      "Any mail provider; needs a host, port and account",
                    ),
                    icon: <Server />,
                  }
                : p === "resend"
                  ? {
                      value: p,
                      title: "Resend",
                      desc: tr("HTTP API，只需一个 API key", "An HTTP API; only an API key"),
                      icon: <Send />,
                    }
                  : { value: p, title: p },
            )}
          />
        </Panel>
        {smtp ? (
          <Group title="SMTP" footer={tr("密码只写不读。", "The password is write-only.")}>
            <FieldRow label={tr("SMTP 服务器", "SMTP host")} error={shown(hostError)} changed={f.isEdited("host")}>
              {(a) => (
                <Input
                  {...a}
                  className="font-mono text-footnote sm:w-64"
                  value={v.host}
                  onChange={(e) => f.set("host", e.target.value)}
                />
              )}
            </FieldRow>
            <FieldRow
              label={tr("端口", "Port")}
              description={tr("1–65535", "1–65535")}
              error={portError}
              changed={f.isEdited("port")}
            >
              {(a) => (
                <UnitInput
                  {...a}
                  invalid={!!portError}
                  value={v.port}
                  onChange={(e) => f.set("port", e.target.value)}
                />
              )}
            </FieldRow>
            <SRow label={tr("加密方式", "Security")} changed={f.isEdited("security")} wide>
              <Segmented
                label={tr("加密方式", "Security")}
                value={v.security}
                onChange={(x) => f.set("security", x)}
                options={[
                  { value: "tls", label: tr("隐式 TLS（465）", "Implicit TLS (465)") },
                  { value: "starttls", label: tr("STARTTLS（587）", "STARTTLS (587)") },
                  { value: "none", label: tr("不加密", "None") },
                ]}
              />
            </SRow>
            <FieldRow label={tr("用户名", "User name")} changed={f.isEdited("username")}>
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
              description={m.password_set ? tr("已设置 · 留空表示不修改", "Set · empty = keep") : undefined}
              changed={f.isEdited("password")}
            >
              {(a) => (
                <SecretInput
                  {...a}
                  className="sm:w-64"
                  placeholder={m.password_set ? tr("••••••••（已设置）", "•••••••• (set)") : undefined}
                  value={v.password}
                  onChange={(e) => f.set("password", e.target.value)}
                />
              )}
            </FieldRow>
          </Group>
        ) : (
          <Group
            title="Resend"
            footer={tr(
              "在 resend.com › API Keys 创建，只需要「发送」权限。",
              "Create one at resend.com › API Keys; sending access is enough.",
            )}
          >
            <FieldRow
              label={tr("Resend API key（只写）", "Resend API key (write-only)")}
              description={m.api_key_set ? tr("已设置 · 留空表示不修改", "Set · empty = keep") : undefined}
              changed={f.isEdited("api_key")}
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
          </Group>
        )}
        <Group title={tr("发件人", "Sender")}>
          <FieldRow label={tr("发件地址", "From address")} error={shown(fromError)} changed={f.isEdited("from_addr")}>
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
          <FieldRow
            label={tr("发件人名称", "From name")}
            description={tr("收件箱里显示的名字；留空 = 站点名称", "Shown in inboxes; empty = the site name")}
            changed={f.isEdited("from_name")}
          >
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
        <div className="grid gap-3 sm:grid-cols-2">
          <EntryCard
            to="/settings/templates"
            tint="#0891b2"
            icon={<MailOpen />}
            title={tr("邮件模板", "Mail templates")}
            sub={
              kinds === undefined
                ? "…"
                : tr(`${kinds} 种 · ${custom} 种已自定义`, `${kinds} kinds · ${custom} customised`)
            }
          />
          <EntryCard
            to="/settings/notices"
            tint="#f59e0b"
            icon={<Bell />}
            title={tr("通知种类", "Notices")}
            sub={tr(
              `${notices.filter(Boolean).length} / ${notices.length} 开启`,
              `${notices.filter(Boolean).length} of ${notices.length} on`,
            )}
          />
        </div>
      </OwnerOnly>
    </>
  );
}

function EntryCard({
  to,
  tint,
  icon,
  title,
  sub,
}: {
  to: string;
  tint: string;
  icon: ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <Link
      to={to}
      className="group flex min-h-11 items-center gap-3 rounded-xl bg-card p-3.5 shadow-card transition-shadow hover:shadow-raised"
    >
      <Tile color={tint} size={30}>
        {icon}
      </Tile>
      <div className="min-w-0 flex-1">
        <div className="text-body font-semibold">{title}</div>
        <div className="text-footnote text-muted-foreground">{sub}</div>
      </div>
      <ArrowRight className="size-4 text-faint" aria-hidden="true" />
    </Link>
  );
}

const STEPS: Record<string, [string, string]> = {
  config: ["读取配置", "Config"],
  dns: ["DNS 解析", "DNS"],
  tcp: ["TCP 连接", "TCP"],
  tls: ["TLS 握手", "TLS"],
  greeting: ["问候", "Greeting"],
  auth: ["认证", "Auth"],
  send: ["发送", "Send"],
};

/** 测试发信: the step-by-step diagnosis on the saved configuration, or a plain test mail. */
function DiagnoseDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
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
  const total = report?.steps.reduce((n, s) => n + s.elapsed_ms, 0);
  const valid = EMAIL.test(to.trim());
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      icon={Stethoscope}
      title={tr("测试发信", "Test mail")}
      description={tr(
        "用已保存的配置逐步检查，并给你发一封测试邮件。有未保存的修改时，先保存再测试。",
        "Checks the saved configuration step by step and sends you a test. Save your changes first.",
      )}
      footer={
        <>
          {total !== undefined && (
            <span className="text-footnote text-faint max-sm:hidden">
              {tr(`耗时 ${(total / 1000).toFixed(1)} 秒`, `${(total / 1000).toFixed(1)} s`)}
            </span>
          )}
          <div className="flex-1" />
          <Button
            variant="outline"
            loading={sending}
            disabled={!valid}
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
          <Button
            variant="primary"
            icon={Stethoscope}
            loading={diagBusy}
            disabled={!valid}
            onClick={() =>
              void runDiag(() =>
                post<{ ok: boolean; steps: Step[] }>("/settings/mail/diagnose", { to: to.trim() }),
              ).then((r) => r && setReport(r))
            }
          >
            {report ? tr("重新诊断", "Diagnose again") : tr("诊断并发送", "Diagnose and send")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={tr("收件地址", "To")}>
          <Input data-nodirty type="email" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {report && (
          <ol className="grid gap-0.5" aria-label={tr("诊断结果", "Diagnosis")}>
            {report.steps.map((s, i) => (
              <li
                key={s.step}
                data-step={s.step}
                className={cn(
                  "rounded-lg px-2.5 py-2",
                  s.status === "fail" && "bg-destructive-soft",
                  s.status === "warn" && "bg-warning-soft",
                )}
              >
                <div className="flex flex-wrap items-center gap-2.5 text-body">
                  <span
                    className={cn(
                      "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-caption font-semibold",
                      s.status === "ok" && "bg-success text-white",
                      s.status === "fail" && "bg-destructive text-white",
                      s.status === "warn" && "bg-warning text-white",
                      s.status === "skip" && "bg-secondary text-faint",
                    )}
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1 font-medium">{tr(...(STEPS[s.step] ?? [s.step, s.step]))}</span>
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
                  <span className="text-footnote text-faint tabular-nums">{s.elapsed_ms} ms</span>
                </div>
                <div className="mt-1 pl-7.5 text-footnote text-muted-foreground">
                  {lang === "en" ? s.message.en : s.message.zh}
                </div>
              </li>
            ))}
            <li className="px-2.5 pt-1">
              <Badge tone={report.ok ? "success" : "danger"}>
                {report.ok ? tr("测试邮件已被接受", "Accepted by the provider") : tr("未能发送", "Not sent")}
              </Badge>
            </li>
          </ol>
        )}
      </div>
    </Dialog>
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
    expiry: m.notify_expiry_days > 0,
    notify_expired: m.notify_expired,
    notify_quota: m.notify_quota,
    notify_refund: m.notify_refund,
    notify_ban: m.notify_ban,
    notify_plan_change: m.notify_plan_change,
    notify_withdrawal: m.notify_withdrawal,
    notify_commission: m.notify_commission,
    days: String(m.notify_expiry_days || 3),
  });
  const v = f.value!;
  const daysError = v.expiry && f.isEdited("days") ? intError(v.days, 1, 30, tr) : undefined;
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
              notify_ban: v.notify_ban,
              notify_plan_change: v.notify_plan_change,
              notify_withdrawal: v.notify_withdrawal,
              notify_commission: v.notify_commission,
              notify_expiry_days: v.expiry ? (intOf(v.days) ?? 0) : 0,
            }),
          ),
        { ok: tr("通知设置已保存", "Notice settings saved") },
      );
      if (r === undefined) return false;
      f.saved();
      return true;
    },
  });
  const sent = (...kinds: string[]) => kinds.reduce((n, k) => n + (m.sent_30d?.[k] ?? 0), 0);
  const failed = m.dead_24h ?? 0;
  const row = (
    key:
      | "notify_order_paid"
      | "expiry"
      | "notify_expired"
      | "notify_quota"
      | "notify_refund"
      | "notify_ban"
      | "notify_plan_change"
      | "notify_withdrawal"
      | "notify_commission",
    label: string,
    when: string,
    kinds: string[],
  ) => (
    <SRow
      label={label}
      description={
        <>
          {when} · {tr("近 30 天", "30 days:")} <span className="tabular-nums">{sent(...kinds).toLocaleString()}</span>{" "}
          {tr("封", "sent")} ·{" "}
          <Link to={`/settings/templates?kind=${kinds[0]}`} className="text-primary hover:underline">
            {tr("模板", "Template")}
          </Link>
        </>
      }
      changed={f.isEdited(key)}
    >
      <Switch label={label} checked={v[key]} onChange={(x) => f.set(key, x)} />
    </SRow>
  );
  return (
    <OwnerOnly what={tr("邮件通知", "the mail notices")}>
      {!m.enabled ? (
        <Banner
          tone="warning"
          icon={<MailIcon />}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/mail">{tr("发信通道", "Mail transport")}</Link>
            </Button>
          }
        >
          {tr(
            "邮件发送未启用：下面的通知暂时都不会发出。",
            "Mail sending is off: none of these notices go out for now.",
          )}
        </Banner>
      ) : (
        failed > 0 && (
          <Banner
            tone="warning"
            icon={<MailIcon />}
            action={
              <Button asChild size="sm" variant="outline">
                <Link to="/settings/mail?diagnose=1">{tr("诊断发信", "Diagnose")}</Link>
              </Button>
            }
          >
            {tr(
              `发信通道近 24 小时有 ${failed} 封失败，部分通知可能没有送达。`,
              `${failed} mails failed in the last 24 hours; some notices may not have arrived.`,
            )}
          </Banner>
        )
      )}
      <Group
        title={tr("发给用户的邮件", "Mail to users")}
        footer={tr(
          "只发给已验证的邮箱，按收件人的语言。验证码、重置密码等账户安全邮件总是发送，不能关闭。",
          "Only to verified addresses, in the recipient's language. Codes, password resets and other account mail always go out.",
        )}
      >
        {row("notify_order_paid", tr("付款回执", "Payment receipt"), tr("订单支付成功后", "After a payment"), [
          "order_paid",
        ])}
        {row("expiry", tr("到期前提醒", "Expiry reminder"), tr("订阅到期前 N 天", "N days before expiry"), [
          "expiry_soon",
        ])}
        {v.expiry && (
          <FieldRow
            className="bg-window/50 pl-8"
            label={tr("到期前多少天提醒", "Expiry reminder (days before)")}
            description={tr("1–30 天", "1–30 days")}
            error={daysError}
            changed={f.isEdited("days")}
          >
            {(a) => (
              <UnitInput
                {...a}
                unit={tr("天", "d")}
                invalid={!!daysError}
                value={v.days}
                onChange={(e) => f.set("days", e.target.value)}
              />
            )}
          </FieldRow>
        )}
        {row("notify_expired", tr("套餐已到期", "Plan expired"), tr("订阅到期当天", "On the expiry day"), ["expired"])}
        {row(
          "notify_quota",
          tr("流量用到 80% / 100%", "Traffic at 80% / 100%"),
          tr("每个周期各一次", "Once each per period"),
          ["quota_80", "quota_100"],
        )}
        {row("notify_refund", tr("退款通知", "Refund notice"), tr("退款完成后", "After a refund"), ["refund"])}
        {row(
          "notify_ban",
          tr("封禁 / 解封通知", "Ban / unban notice"),
          tr("管理员封禁或解封账号后", "After an admin bans or unbans an account"),
          ["account_banned", "account_unbanned"],
        )}
        {row(
          "notify_plan_change",
          tr("管理员变更套餐", "Plan changed by an admin"),
          tr(
            "管理员分配、续期、延长、取消套餐或重置流量后",
            "After an admin assigns, renews, extends, cancels or resets traffic",
          ),
          ["plan_changed"],
        )}
        {row(
          "notify_withdrawal",
          tr("提现结果", "Withdrawal decision"),
          tr("管理员通过或拒绝提现后", "After an admin approves or rejects"),
          ["withdrawal_approved", "withdrawal_rejected"],
        )}
        {row(
          "notify_commission",
          tr("邀请返利入账", "Commission credited"),
          tr("返利冻结期满记入余额时", "When a commission is credited"),
          ["commission_credited"],
        )}
      </Group>
    </OwnerOnly>
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
type Channel = "telegram" | "webhook" | "email";
type TestResult = { channel: Channel; ok: boolean | null; message?: string; raw?: string };

function AlertsForm({ s }: { s: AlertSettings }) {
  const tr = useTr();
  const errText = useErrText();
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
  const bad = recipients.find((x) => !EMAIL.test(x));
  const emailsError =
    recipients.length > 5
      ? tr("最多 5 个收件人", "At most 5 recipients")
      : bad
        ? tr(`「${bad}」不是邮箱地址`, `"${bad}" is not an email address`)
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
      f.saved();
      return true;
    },
  });
  /** A number input of a sentence ("CPU 超过 [90]% 持续 [5] 分钟"), named by `label`. */
  const num = (k: Num, label: string, unit: string, disabled?: boolean) => {
    const blank = RANGES[k][2];
    return (
      <UnitInput
        aria-label={label}
        unit={unit}
        placeholder={blank ? tr("关闭", "Off") : undefined}
        invalid={!!numError(k)}
        disabled={disabled}
        className="w-24"
        value={v[k]}
        onChange={(e) => f.set(k, e.target.value)}
      />
    );
  };
  const sentence = (
    k: Num,
    label: string,
    unit: string,
    aria: string,
    pair?: { k: Num; aria: string; unit: string },
  ) => (
    <SRow
      label={label}
      description={
        !v[k].trim()
          ? tr("已关闭", "Off")
          : tr(`${RANGES[k][0]}–${RANGES[k][1]}；留空 = 关闭`, `${RANGES[k][0]}–${RANGES[k][1]}; empty = off`)
      }
      changed={f.isEdited(k) || (!!pair && f.isEdited(pair.k))}
      error={numError(k) ?? (pair ? numError(pair.k) : undefined)}
      wide
    >
      {num(k, aria, unit)}
      {pair && (
        <>
          <span className="text-footnote text-muted-foreground">{tr("持续", "for")}</span>
          {num(pair.k, pair.aria, pair.unit, !v[k].trim())}
        </>
      )}
    </SRow>
  );
  const randomSecret = () => {
    const b = new Uint8Array(24);
    crypto.getRandomValues(b);
    f.set("secret", Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""));
  };
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [testing, setTesting] = useState(false);
  const enabled: Record<Channel, boolean> = {
    telegram: s.telegram_enabled,
    webhook: s.webhook_enabled,
    email: s.email_enabled && s.email_available,
  };
  const testAll = async () => {
    setTesting(true);
    try {
      const out: TestResult[] = [];
      for (const channel of ["telegram", "webhook", "email"] as Channel[]) {
        if (!enabled[channel]) {
          out.push({ channel, ok: null });
          continue;
        }
        try {
          const r = await post<{ ok: boolean; error?: string }>("/alerts/test", { channel });
          out.push({
            channel,
            ok: r.ok,
            message: tr(
              "通道没有接受这条消息，检查地址、凭据与接收端。",
              "The channel refused it: check the address, credentials and receiver.",
            ),
            raw: r.error,
          });
        } catch (e) {
          out.push({ channel, ok: false, message: errText(e) });
        }
      }
      setResults(out);
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <Group
        title={tr("阈值", "Thresholds")}
        footer={tr(
          "留空 = 不告警。每 30 秒评估一次；同一台服务器同一种告警在冷却时间内只通知一次；服务器可以单独覆盖或关闭（节点 → 服务器 → 告警规则）。",
          "Empty = no alert. Evaluated every 30 s; one notice per server and kind within the cooldown; a server may override or switch them off (Nodes → server → alert rules).",
        )}
      >
        <SwitchRow
          label={tr("启用告警", "Alerts on")}
          checked={v.enabled}
          onChange={(x) => f.set("enabled", x)}
          changed={f.isEdited("enabled")}
        />
        {sentence(
          "offline_secs",
          tr("离线超过", "Offline for"),
          tr("秒", "s"),
          tr("离线多少秒告警", "Offline seconds"),
        )}
        {sentence("cpu_percent", tr("CPU 超过", "CPU above"), "%", tr("CPU 超过 %", "CPU above %"), {
          k: "cpu_minutes",
          aria: tr("CPU 持续分钟", "CPU minutes"),
          unit: tr("分钟", "min"),
        })}
        {sentence("mem_percent", tr("内存超过", "Memory above"), "%", tr("内存超过 %", "Memory above %"), {
          k: "mem_minutes",
          aria: tr("内存持续分钟", "Memory minutes"),
          unit: tr("分钟", "min"),
        })}
        {sentence("disk_percent", tr("磁盘超过", "Disk above"), "%", tr("磁盘超过 %", "Disk above %"))}
        {sentence(
          "cert_days",
          tr("证书剩余少于", "Certificate days below"),
          tr("天", "d"),
          tr("证书剩余少于天数", "Certificate days below"),
        )}
        <SwitchRow
          label={tr("测速全部失败", "Every probe fails")}
          checked={v.latency_failures}
          onChange={(x) => f.set("latency_failures", x)}
          changed={f.isEdited("latency_failures")}
        />
        <SwitchRow
          label={tr("配置应用失败", "Apply failed")}
          checked={v.last_error}
          onChange={(x) => f.set("last_error", x)}
          changed={f.isEdited("last_error")}
        />
        <SRow
          label={tr("冷却", "Cooldown")}
          description={tr("0–1440 分钟", "0–1440 minutes")}
          changed={f.isEdited("cooldown_minutes")}
          error={numError("cooldown_minutes")}
        >
          {num("cooldown_minutes", tr("冷却（分钟）", "Cooldown (minutes)"), tr("分钟", "min"))}
        </SRow>
        <SwitchRow
          label={tr("恢复时也通知", "Notify on recovery")}
          checked={v.notify_resolved}
          onChange={(x) => f.set("notify_resolved", x)}
          changed={f.isEdited("notify_resolved")}
        />
      </Group>
      <Panel
        title={tr("通道", "Channels")}
        action={
          <Button
            size="sm"
            variant="outline"
            icon={Send}
            loading={testing}
            className="-mb-1"
            onClick={() => void testAll()}
          >
            {tr("发送测试", "Send a test")}
          </Button>
        }
        footer={tr(
          "测试使用已保存的配置：有未保存的修改时，先保存再测试。",
          "Tests use the saved configuration: save your changes first.",
        )}
      >
        <div className="grid gap-3 xl:grid-cols-3">
          <ChannelCard
            icon={<Send />}
            tint="#229ED9"
            name="Telegram"
            on={v.telegram_enabled}
            setOn={(x) => f.set("telegram_enabled", x)}
            changed={f.isEdited("telegram_enabled") || f.isEdited("chat") || f.isEdited("token") || f.isEdited("api")}
            channel="telegram"
            testable={enabled.telegram}
          >
            <Field
              label={tr("Bot token（只写）", "Bot token (write-only)")}
              hint={s.telegram_token_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
            >
              <SecretInput value={v.token} onChange={(e) => f.set("token", e.target.value)} />
            </Field>
            <Field label="Chat ID">
              <Input
                className="font-mono text-footnote"
                value={v.chat}
                onChange={(e) => f.set("chat", e.target.value)}
              />
            </Field>
            <Field
              label={tr("Telegram API 地址", "Telegram API URL")}
              hint={tr(
                `自建 Bot API 时填写；留空 = ${s.telegram_api_default}`,
                `For a self-hosted Bot API; empty = ${s.telegram_api_default}`,
              )}
              error={apiError}
            >
              <Input
                className="font-mono text-footnote"
                placeholder={s.telegram_api_default}
                value={v.api}
                onChange={(e) => f.set("api", e.target.value)}
              />
            </Field>
          </ChannelCard>
          <ChannelCard
            icon={<Webhook />}
            tint="#7c3aed"
            name="Webhook"
            title={tr("签名 Webhook", "Signed webhook")}
            on={v.webhook_enabled}
            setOn={(x) => f.set("webhook_enabled", x)}
            changed={f.isEdited("webhook_enabled") || f.isEdited("webhook_url") || f.isEdited("secret")}
            channel="webhook"
            testable={enabled.webhook}
          >
            <Field label={tr("Webhook 地址", "Webhook URL")} error={hookError}>
              <Input
                className="font-mono text-footnote"
                value={v.webhook_url}
                onChange={(e) => f.set("webhook_url", e.target.value)}
              />
            </Field>
            <Field
              label={tr("签名密钥（只写）", "Signing secret (write-only)")}
              hint={
                v.secret
                  ? tr(
                      "新密钥只显示这一次，保存前复制到接收端",
                      "Shown this once: copy it to the receiver before saving",
                    )
                  : s.webhook_secret_set
                    ? tr("已保存；留空 = 不修改", "Saved; empty = keep")
                    : undefined
              }
            >
              <div className="flex gap-2">
                <SecretInput
                  className="min-w-0 flex-1"
                  value={v.secret}
                  onChange={(e) => f.set("secret", e.target.value)}
                />
                <Button icon={Shuffle} variant="outline" onClick={randomSecret}>
                  {tr("随机生成", "Random")}
                </Button>
              </div>
            </Field>
            <p className="text-caption text-faint">
              {tr(
                '请求头 X-Akari-Signature: sha256=HMAC(密钥, "<时间戳>.<正文>")',
                'Header X-Akari-Signature: sha256=HMAC(secret, "<ts>.<body>")',
              )}
            </p>
          </ChannelCard>
          <ChannelCard
            icon={<MailIcon />}
            tint="#0ea5e9"
            name={tr("邮件", "Email")}
            title={tr("告警邮件", "Alert mail")}
            on={v.email_enabled}
            setOn={(x) => f.set("email_enabled", x)}
            changed={f.isEdited("email_enabled") || f.isEdited("emails")}
            channel="email"
            testable={enabled.email}
            note={
              s.email_available
                ? undefined
                : tr("邮件发送未配置（发信通道）", "Mail is not configured (Mail transport)")
            }
          >
            <Field
              label={tr("收件人（最多 5 个，逗号分隔）", "Recipients (up to 5, comma separated)")}
              hint={tr("通过发信通道发送", "Sent through the mail transport")}
              error={emailsError}
            >
              <Input value={v.emails} onChange={(e) => f.set("emails", e.target.value)} />
            </Field>
          </ChannelCard>
        </div>
      </Panel>
      <TestResults results={results} onClose={() => setResults(null)} />
    </>
  );
}

function ChannelCard({
  icon,
  tint,
  name,
  title,
  on,
  setOn,
  changed,
  channel,
  testable,
  note,
  children,
}: {
  icon: ReactNode;
  tint: string;
  /** The switch's and the test's name ("Webhook"). */
  name: string;
  title?: string;
  on: boolean;
  setOn: (x: boolean) => void;
  changed?: boolean;
  channel: Channel;
  testable: boolean;
  note?: string;
  children: ReactNode;
}) {
  const tr = useTr();
  return (
    <Card className="relative grid content-start gap-3 p-4">
      {changed && (
        <span className="absolute top-4 left-0 h-6 w-[3px] rounded-r-full bg-primary" data-changed>
          <span className="sr-only">{tr("已修改", "Edited")}</span>
        </span>
      )}
      <div className="flex items-center gap-2.5">
        <Tile color={tint} size={28}>
          {icon}
        </Tile>
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold">{title ?? name}</div>
          <div className="text-caption text-faint">{note ?? (on ? tr("已启用", "On") : tr("未启用", "Off"))}</div>
        </div>
        <Switch label={name} checked={on} onChange={setOn} />
      </div>
      <div className={cn("grid gap-3", !on && "opacity-55")}>{children}</div>
      <TestButton channel={channel} name={name} disabled={!testable} />
    </Card>
  );
}

/** A channel test: always the saved configuration; its own busy state. */
function TestButton({ channel, name, disabled }: { channel: Channel; name: string; disabled: boolean }) {
  const tr = useTr();
  const toast = useToast();
  const errText = useErrText();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 text-caption text-faint">
      <Button
        size="sm"
        variant="ghost"
        icon={Send}
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
        {tr("单独测试", "Test this")}
      </Button>
      <span>
        {disabled
          ? tr("保存并启用后才能测试", "Save it enabled to test")
          : tr("测试使用已保存的配置", "The test uses the saved configuration")}
      </span>
    </div>
  );
}

function TestResults({ results, onClose }: { results: TestResult[] | null; onClose: () => void }) {
  const tr = useTr();
  const names: Record<Channel, string> = {
    telegram: "Telegram",
    webhook: tr("签名 Webhook", "Signed webhook"),
    email: tr("告警邮件", "Alert mail"),
  };
  return (
    <Dialog
      open={!!results}
      onClose={onClose}
      size="md"
      icon={Send}
      tone="danger"
      title={tr("告警测试结果", "Alert test results")}
      description={tr(
        "用已保存的配置向各通道发了一条测试告警。",
        "A test alert went to each channel with the saved configuration.",
      )}
      footer={
        <>
          <div className="flex-1" />
          <Button variant="primary" onClick={onClose}>
            {tr("知道了", "Got it")}
          </Button>
        </>
      }
    >
      <div className="grid gap-2">
        {results?.map((r) => (
          <div
            key={r.channel}
            className={cn(
              "flex gap-3 rounded-lg p-3",
              r.ok === false ? "bg-destructive-soft" : "bg-window ring-1 ring-border ring-inset",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-body font-semibold">
                {names[r.channel]}
                {r.ok === true ? (
                  <Badge tone="success">{tr("已送达", "Delivered")}</Badge>
                ) : r.ok === false ? (
                  <Badge tone="danger">{tr("失败", "Failed")}</Badge>
                ) : (
                  <Badge tone="outline">{tr("未启用，跳过", "Off, skipped")}</Badge>
                )}
              </div>
              {r.ok === false && <RawError className="mt-1" message={r.message} raw={r.raw ?? ""} />}
              {r.ok === null && (
                <div className="mt-1 text-footnote text-muted-foreground">
                  {tr("启用并保存后才会发送。", "Sent once it is on and saved.")}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}
