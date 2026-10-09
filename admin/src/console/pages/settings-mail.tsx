// 系统设置 → 邮件 / 邮件模板 (SET-15…18): the transport (SMTP with 465
// implicit TLS / 587 STARTTLS, or the Resend API; secrets write-only), the
// sender and notices, the step-by-step test diagnosis (W31), a plain test
// mail, the outbox (dead letters, retry) and the mail templates (kind ×
// language, placeholders, sandboxed live preview, reset, test).
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { del, get, post, put, qs } from "../../shared/api";
import { dateTime } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  Field,
  Input,
  SecretInput,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Textarea,
} from "../../shared/ui/primitives";
import { DataTable, type Column } from "../../shared/ui/table";
import { FormError, useDebounced, useErrText, useRun } from "../kit";
import { setQuery, useRoute } from "../router";
import { useMe } from "../session";

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
type Outbox = {
  id: number;
  kind: string;
  to_addr: string;
  subject: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  retryable: boolean;
};

export function MailTab() {
  return (
    <div className="space-y-4">
      <MailCard />
      <Diagnose />
      <OutboxCard />
    </div>
  );
}

function MailCard() {
  const tr = useTr();
  const q = useQuery({ queryKey: ["settings", "mail"], queryFn: () => get<Mail>("/settings/mail") });
  const [f, setF] = useState<Mail | null>(null);
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const [run, busy] = useRun();
  if (!f) return q.error ? <FormError error={q.error} /> : <Skeleton className="h-64" />;
  const save = () =>
    run(
      () =>
        put<Mail>("/settings/mail", {
          version: f.version,
          enabled: f.enabled,
          provider: f.provider,
          host: f.host || null,
          port: Number(f.port),
          security: f.security,
          username: f.username || null,
          ...(password ? { password } : {}),
          ...(apiKey ? { api_key: apiKey } : {}),
          from_addr: f.from_addr || null,
          from_name: f.from_name || null,
          notify_order_paid: f.notify_order_paid,
          notify_expiry_days: Number(f.notify_expiry_days) || 0,
          notify_expired: f.notify_expired,
          notify_quota: f.notify_quota,
          notify_refund: f.notify_refund,
        }),
      { ok: tr("邮件设置已保存", "Mail settings saved"), invalidate: [["settings", "mail"]] },
    ).then((r) => {
      if (r) {
        setPassword("");
        setApiKey("");
      }
    });
  const smtp = f.provider === "smtp";
  return (
    <Card>
      <CardHeader title={tr("发信方式（W31）", "Mail transport (W31)")} />
      <CardBody className="space-y-3">
        <label className="flex items-center gap-2 text-[13px]">
          <Switch
            checked={f.enabled}
            onChange={(v) => setF({ ...f, enabled: v })}
            label={tr("启用邮件发送", "Mail sending on")}
          />
          {tr("启用邮件发送", "Mail sending on")}
        </label>
        <Segmented
          value={f.provider}
          onChange={(v) => setF({ ...f, provider: v })}
          options={f.providers.map((p) => ({
            value: p,
            label: p === "smtp" ? "SMTP" : p === "resend" ? "Resend API" : p,
          }))}
        />
        {smtp ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("SMTP 服务器", "SMTP host")}>
              <Input value={f.host ?? ""} onChange={(e) => setF({ ...f, host: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={tr("端口", "Port")}>
                <Input
                  inputMode="numeric"
                  value={f.port}
                  onChange={(e) => setF({ ...f, port: Number(e.target.value) || 0 })}
                />
              </Field>
              <Field label={tr("加密方式", "Security")}>
                <Select value={f.security} onChange={(e) => setF({ ...f, security: e.target.value })}>
                  <option value="tls">{tr("隐式 TLS（465）", "Implicit TLS (465)")}</option>
                  <option value="starttls">STARTTLS（587）</option>
                  <option value="none">{tr("不加密（仅本机/内网）", "None (local only)")}</option>
                </Select>
              </Field>
            </div>
            <Field label={tr("用户名", "User name")}>
              <Input
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                value={f.username ?? ""}
                onChange={(e) => setF({ ...f, username: e.target.value })}
              />
            </Field>
            <Field
              label={tr("密码（只写）", "Password (write-only)")}
              hint={f.password_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
            >
              <SecretInput value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
          </div>
        ) : (
          <Field
            label={tr("Resend API key（只写）", "Resend API key (write-only)")}
            hint={f.api_key_set ? tr("已保存；留空 = 不修改", "Saved; empty = keep") : undefined}
          >
            <SecretInput value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("发件地址", "From address")}>
            <Input value={f.from_addr ?? ""} onChange={(e) => setF({ ...f, from_addr: e.target.value })} />
          </Field>
          <Field label={tr("发件人名称", "From name")}>
            <Input value={f.from_name ?? ""} onChange={(e) => setF({ ...f, from_name: e.target.value })} />
          </Field>
        </div>
        <div className="space-y-2 border-t border-border pt-3 text-[13px]">
          <div className="font-medium">{tr("通知邮件", "Notices")}</div>
          {(
            [
              ["notify_order_paid", tr("付款回执", "Payment receipt")],
              ["notify_expired", tr("套餐已到期", "Plan expired")],
              ["notify_quota", tr("流量用到 80% / 100%", "Traffic at 80% / 100%")],
              ["notify_refund", tr("退款通知", "Refund notice")],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <Switch checked={f[k]} onChange={(v) => setF({ ...f, [k]: v })} label={label} />
              {label}
            </label>
          ))}
          <Field label={tr("到期前多少天提醒（0 = 不提醒）", "Expiry reminder days before (0 = off)")}>
            <Input
              className="w-32"
              inputMode="numeric"
              value={f.notify_expiry_days}
              onChange={(e) => setF({ ...f, notify_expiry_days: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>
        {f.warnings.length > 0 && (
          <Callout tone="warning">
            <ul className="list-disc pl-4">
              {f.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        )}
        <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
          {tr("保存", "Save")}
        </Button>
      </CardBody>
    </Card>
  );
}

function Diagnose() {
  const tr = useTr();
  const lang = useLang();
  const me = useMe();
  const errText = useErrText();
  const toast = useToast();
  const [to, setTo] = useState(me.email);
  const [report, setReport] = useState<{ ok: boolean; steps: Step[] } | null>(null);
  const [run, busy] = useRun();
  const steps: Record<string, [string, string]> = {
    config: ["配置", "Config"],
    dns: ["解析域名", "DNS"],
    tcp: ["连接端口", "TCP"],
    tls: ["TLS 握手", "TLS"],
    greeting: ["服务器问候", "Greeting"],
    auth: ["认证", "Auth"],
    send: ["发送", "Send"],
  };
  return (
    <Card>
      <CardHeader
        title={tr("测试发信", "Test mail")}
        description={tr(
          "用已保存的设置逐步检查并发一封测试邮件；失败的一步标红并说明可能原因。",
          "Checks the saved settings step by step and sends a test; a failing step is red with the likely cause.",
        )}
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Field label={tr("收件地址", "To")}>
            <Input type="email" className="w-72" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              void run(() => post<{ ok: boolean; steps: Step[] }>("/settings/mail/diagnose", { to }), {}).then(
                (r) => r && setReport(r),
              )
            }
          >
            {tr("诊断并发送", "Diagnose and send")}
          </Button>
          <Button
            onClick={async () => {
              try {
                await post("/settings/mail/test", { to });
                toast({ tone: "success", title: tr(`测试邮件已发出：${to}`, `Test mail sent to ${to}`) });
              } catch (e) {
                toast({ tone: "error", title: errText(e) });
              }
            }}
          >
            {tr("直接发送测试邮件", "Just send a test")}
          </Button>
        </div>
        {report && (
          <ol className="space-y-1.5" aria-label={tr("诊断结果", "Diagnosis")}>
            {report.steps.map((s) => (
              <li
                key={s.step}
                data-step={s.step}
                className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[13px] ${s.status === "fail" ? "border-destructive/40 bg-destructive-soft" : s.status === "warn" ? "border-warning/40 bg-warning-soft" : "border-border"}`}
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
                >
                  {s.status}
                </Badge>
                <span className="w-24 font-medium">
                  {lang === "en" ? (steps[s.step]?.[1] ?? s.step) : (steps[s.step]?.[0] ?? s.step)}
                </span>
                <span className="flex-1">{lang === "en" ? s.message.en : s.message.zh}</span>
                <span className="text-xs text-muted-foreground">{s.elapsed_ms} ms</span>
              </li>
            ))}
            <li>
              <Badge tone={report.ok ? "success" : "danger"}>
                {report.ok ? tr("测试邮件已被接受", "Accepted by the provider") : tr("未能发送", "Not sent")}
              </Badge>
            </li>
          </ol>
        )}
      </CardBody>
    </Card>
  );
}

function OutboxCard() {
  const tr = useTr();
  const { query } = useRoute();
  const status = query.get("outbox") ?? "dead";
  const [run] = useRun();
  const q = useInfiniteQuery({
    queryKey: ["outbox", status],
    queryFn: ({ pageParam }) => get<Outbox[]>(`/mail/outbox${qs({ status, before: pageParam, limit: 50 })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 50 ? last[49].id : undefined),
  });
  const rows = (q.data?.pages.flat() ?? []).map((o) => ({ ...o, id: String(o.id), raw: o.id }));
  const columns: Column<(typeof rows)[number]>[] = [
    { key: "subject", header: tr("主题", "Subject"), fixed: true, mobile: "title", cell: (o) => o.subject || o.kind },
    { key: "to", header: tr("收件人", "To"), cell: (o) => o.to_addr },
    { key: "kind", header: tr("种类", "Kind"), cell: (o) => o.kind },
    { key: "attempts", header: tr("尝试", "Attempts"), cell: (o) => o.attempts },
    {
      key: "error",
      header: tr("错误", "Error"),
      cell: (o) => <span className="text-muted-foreground">{o.last_error ?? ""}</span>,
    },
    { key: "created", header: tr("时间", "Time"), cell: (o) => dateTime(o.created_at) },
    {
      key: "retry",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      fixed: true,
      cell: (o) =>
        o.retryable ? (
          <Button
            size="sm"
            onClick={() =>
              void run(() => post(`/mail/outbox/${o.raw}/retry`), {
                ok: tr("已重新排队", "Requeued"),
                invalidate: [["outbox"], ["settings", "mail"]],
              })
            }
          >
            {tr("重试", "Retry")}
          </Button>
        ) : null,
    },
  ];
  return (
    <Card>
      <CardHeader
        title={tr("发件箱", "Outbox")}
        actions={
          <Segmented
            size="sm"
            value={status}
            onChange={(v) => setQuery({ outbox: v })}
            options={[
              { value: "dead", label: tr("失败", "Dead") },
              { value: "pending", label: tr("待发", "Pending") },
              { value: "sent", label: tr("已发", "Sent") },
            ]}
          />
        }
      />
      <DataTable
        label={tr("发件箱", "Outbox")}
        rows={rows}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        footer={
          q.hasNextPage ? (
            <Button size="sm" variant="ghost" onClick={() => void q.fetchNextPage()}>
              {tr("加载更早", "Load older")}
            </Button>
          ) : undefined
        }
      />
    </Card>
  );
}

type Template = {
  kind: string;
  label: string;
  locale: "zh" | "en";
  subject: string;
  body: string;
  default_subject: string;
  default_body: string;
  custom: boolean;
  version: number;
  placeholders: { name: string; description: string }[];
  required: string[];
};

export function TemplatesTab() {
  const tr = useTr();
  const me = useMe();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const list = useQuery({ queryKey: ["mail-templates"], queryFn: () => get<Template[]>("/settings/mail-templates") });
  const kinds = useMemo(() => {
    const m = new Map<string, { label: string; custom: boolean }>();
    for (const t of list.data ?? [])
      m.set(t.kind, { label: t.label, custom: (m.get(t.kind)?.custom ?? false) || t.custom });
    return [...m];
  }, [list.data]);
  const [kind, setKind] = useState("");
  const [locale, setLocale] = useState<"zh" | "en">("zh");
  const cur = list.data?.find((t) => t.kind === (kind || kinds[0]?.[0]) && t.locale === locale);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState(me.email);
  useEffect(() => {
    if (cur) {
      setSubject(cur.subject);
      setBody(cur.body);
    }
  }, [cur]);
  const ds = useDebounced(subject, 400);
  const db = useDebounced(body, 400);
  const preview = useQuery({
    queryKey: ["mail-template-preview", cur?.kind, locale, ds, db],
    queryFn: () =>
      post<{ subject: string; text: string; html: string }>("/settings/mail-templates/preview", {
        kind: cur?.kind,
        locale,
        subject: ds,
        body: db,
      }),
    enabled: !!cur && !!ds && !!db,
  });
  const [run, busy] = useRun();
  if (!list.data) return list.error ? <FormError error={list.error} /> : <Skeleton className="h-96" />;
  if (!cur) return null;
  const allowed = cur.placeholders.map((p) => p.name);
  const unknown = [...(subject + body).matchAll(/\{([a-z0-9_]+)\}/g)]
    .map((m) => m[1])
    .filter((n, i, a) => !allowed.includes(n) && a.indexOf(n) === i);
  const path = `/settings/mail-templates/${cur.kind}/${locale}`;
  return (
    <Card>
      <CardHeader
        title={tr("邮件模板", "Mail templates")}
        description={tr(
          "每种邮件中、英各一份，按收件人语言发送；正文空行分段，单独成段的链接占位符显示为按钮。",
          "One per kind and language (sent in the recipient's); blank lines split paragraphs; a link placeholder alone is a button.",
        )}
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <Field label={tr("邮件种类", "Kind")}>
            <Select value={cur.kind} onChange={(e) => setKind(e.target.value)} className="w-64">
              {kinds.map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                  {v.custom ? tr("（已自定义）", " (custom)") : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Segmented
            value={locale}
            onChange={setLocale}
            options={[
              { value: "zh", label: tr("中文", "Chinese") },
              { value: "en", label: tr("英文", "English") },
            ]}
          />
          {cur.custom && <Badge tone="primary">{tr("已自定义", "Custom")}</Badge>}
        </div>
        <Field label={tr("邮件主题", "Subject")}>
          <Input maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-1">
          {cur.placeholders.map((p) => (
            <Button
              key={p.name}
              size="sm"
              variant="ghost"
              title={p.description}
              onClick={() => setBody((b) => `${b}{${p.name}}`)}
            >
              {`{${p.name}}`}
              {cur.required.includes(p.name) ? " *" : ""}
            </Button>
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label={tr("邮件正文", "Body")}>
            <Textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
          <div>
            <div className="mb-1.5 text-[13px] font-medium">{tr("预览（示例数据）", "Preview (sample data)")}</div>
            {preview.data && <div className="mb-1 text-[13px] font-medium">{preview.data.subject}</div>}
            <iframe
              title={tr("邮件 HTML 预览", "Mail HTML preview")}
              sandbox=""
              srcDoc={preview.data?.html ?? ""}
              className="h-80 w-full rounded-md border border-border bg-white"
            />
            <FormError error={preview.error} />
          </div>
        </div>
        {unknown.length > 0 && (
          <Callout tone="danger">
            {tr(`未知占位符：${unknown.join(", ")}`, `Unknown placeholders: ${unknown.join(", ")}`)}
          </Callout>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <Button
            variant="primary"
            loading={busy}
            disabled={unknown.length > 0}
            onClick={() =>
              void run(() => put(path, { version: cur.version, subject, body }), {
                ok: tr("模板已保存", "Template saved"),
                invalidate: [["mail-templates"]],
              })
            }
          >
            {tr("保存", "Save")}
          </Button>
          {cur.custom && (
            <Button
              variant="destructive-soft"
              onClick={async () => {
                const ok = await confirm({
                  title: tr("恢复默认模板？", "Reset to the default?"),
                  description: tr("自定义的主题与正文会被删除。", "The custom subject and body are deleted."),
                  action: () => del(path),
                });
                if (ok)
                  void run(async () => undefined, { ok: tr("已恢复默认", "Reset"), invalidate: [["mail-templates"]] });
              }}
            >
              {tr("恢复默认", "Reset to default")}
            </Button>
          )}
          <Field
            label={tr(
              "测试收件地址（发送已保存的版本，使用示例数据）",
              "Test address (the saved version, sample data)",
            )}
            className="ml-auto"
          >
            <Input type="email" className="w-64" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button
            onClick={async () => {
              try {
                await post(`${path}/test`, { to });
                toast({ tone: "success", title: tr(`测试邮件已发出：${to}`, `Test mail sent to ${to}`) });
              } catch (e) {
                toast({ tone: "error", title: errText(e) });
              }
            }}
          >
            {tr("发送测试", "Send test")}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
