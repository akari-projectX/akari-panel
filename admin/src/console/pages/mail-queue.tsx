// 系统状态 → 邮件队列 (SET-17; v2 status-mail-*): the dead-letter notice
// (test mail + retry all), the outbox filtered 全部 / 失败 / 待发送 / 已发送
// (`?mail=`), one row per mail (kind in words, subject, recipient, time,
// attempts, the failure in words with the server's text folded away), a
// retry per dead letter (own spinner), older pages; and the step-by-step
// test mail (`?diagnose=1`): POST /settings/mail/diagnose with the saved
// settings, the failed step opened with its explanation.
import { useInfiniteQuery } from "@tanstack/react-query";
import { CheckCircle2, Clock, Mail, MailCheck, MailWarning, RotateCw, Settings, XCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { get, post, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateTime } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { AsyncButton, RawError, Steps, type StepState } from "../components/kit";
import { mailReason } from "../components/ops-bits";
import { useQS } from "../router";
import { useMe } from "../session";

type Outbox = {
  id: number;
  kind: string;
  to_addr: string;
  subject: string;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
  settled_at: string | null;
  retryable: boolean;
};
type Step = {
  step: string;
  status: "ok" | "warn" | "fail" | "skip";
  elapsed_ms: number;
  code: string;
  message: { zh: string; en: string };
};

const PAGE = 50;
type Filter = "all" | "dead" | "pending" | "sent";

/** Outbox kinds (`Template::outbox_kind`) → names. */
function mailKindName(k: string, tr: Tr): string {
  const names: Record<string, [string, string]> = {
    register_code: ["注册验证码", "Sign-up code"],
    register_exists: ["邮箱已注册提醒", "Already registered"],
    email_code: ["邮箱验证码", "Email code"],
    login_code: ["登录验证码", "Sign-in code"],
    password_reset: ["找回密码", "Password reset"],
    order_paid: ["支付回执", "Payment receipt"],
    expiry_soon: ["套餐即将到期", "Plan expiring"],
    expired: ["套餐已到期", "Plan expired"],
    quota_80: ["流量已用 80%", "80% traffic used"],
    quota_100: ["流量已用完", "Traffic used up"],
    test: ["测试邮件", "Test mail"],
    ticket_reply: ["工单回复", "Ticket reply"],
    ticket_new: ["新工单通知", "New ticket"],
    node_alert: ["节点告警", "Node alert"],
    admin_notice: ["管理员群发", "Admin notice"],
    announcement: ["公告", "Announcement"],
    refund: ["退款通知", "Refund notice"],
    security_notice: ["账号安全提醒", "Security alert"],
    account_banned: ["账号封禁通知", "Account banned"],
    account_unbanned: ["账号解封通知", "Account unbanned"],
    plan_changed: ["管理员变更套餐", "Plan changed by admin"],
    withdrawal_approved: ["提现已通过", "Withdrawal approved"],
    withdrawal_rejected: ["提现被拒绝", "Withdrawal rejected"],
    commission_credited: ["邀请返利入账", "Commission credited"],
  };
  const n = names[k];
  return n ? tr(n[0], n[1]) : k;
}

function RetryButton({ id }: { id: number }) {
  const tr = useTr();
  const [run] = useAction();
  return (
    <AsyncButton
      size="sm"
      variant="outline"
      icon={RotateCw}
      onClick={() => run(() => post(`/mail/outbox/${id}/retry`), { ok: tr("已重新排队", "Requeued") })}
    >
      {tr("重试", "Retry")}
    </AsyncButton>
  );
}

/** The mail tab (`?mail=all|dead|pending|sent`, `?diagnose=1` opens the test). */
export function MailQueue({ dead, pending }: { dead: number; pending: number }) {
  const tr = useTr();
  const lang = useLang();
  const toast = useToast();
  const [query, patch] = useQS();
  const [run] = useAction();
  const param = query.get("mail");
  const filter: Filter = param === "dead" || param === "pending" || param === "sent" ? param : "all";
  const q = useInfiniteQuery({
    queryKey: ["outbox", filter],
    queryFn: ({ pageParam }) => get<Outbox[]>(`/mail/outbox${qs({ status: filter, before: pageParam, limit: PAGE })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === PAGE ? last[PAGE - 1].id : undefined),
    refetchInterval: 15_000,
  });
  const rows = q.data?.pages.flat() ?? [];
  const retryAll = () =>
    run(
      async () => {
        const list = await get<Outbox[]>(`/mail/outbox${qs({ status: "dead", limit: 200 })}`);
        const ok = list.filter((m) => m.retryable);
        for (const m of ok) await post(`/mail/outbox/${m.id}/retry`);
        return ok.length;
      },
      { errorPrefix: tr("重试失败", "Retry failed") },
    ).then((n) => {
      if (n !== undefined) toast({ tone: "success", title: tr(`${n} 封邮件已重新排队`, `${n} mails requeued`) });
      return n;
    });
  const openTest = () => patch({ diagnose: "1" });
  return (
    <div className="grid gap-4">
      {dead > 0 && (
        <Card className="flex flex-wrap items-center gap-3 bg-destructive-soft/60 px-4 py-3 shadow-none ring-1 ring-destructive/15 ring-inset">
          <span className="inline-flex size-9 items-center justify-center rounded-[10px] bg-destructive text-white">
            <MailWarning className="size-[18px]" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1 max-sm:basis-[calc(100%-48px)]">
            <div className="text-callout font-semibold">
              {tr(`${dead} 封邮件已放弃发送`, `${dead} mails were given up`)}
            </div>
            <div className="text-footnote text-muted-foreground">
              {tr(
                "每封都重试了 8 次。先「测试发信」确认配置是否正常；如果正常，多半是收件地址本身的问题。",
                "Each was tried 8 times. Run a test mail to check the settings; if they are fine, the recipient is the likely cause.",
              )}
            </div>
          </div>
          <div className="flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
            <Button variant="primary" icon={MailCheck} onClick={openTest}>
              {tr("测试发信", "Test mail")}
            </Button>
            <AsyncButton variant="outline" done={tr("已重新排队", "Requeued")} onClick={retryAll}>
              {tr("全部重试", "Retry all")}
            </AsyncButton>
          </div>
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          label={tr("邮件队列", "Mail queue")}
          value={filter}
          onChange={(v) => patch({ mail: v === "all" ? null : v }, true)}
          options={[
            { value: "all", label: tr("全部", "All") },
            { value: "dead", label: tr("失败", "Failed"), count: dead || undefined },
            { value: "pending", label: tr("待发送", "Pending"), count: pending || undefined },
            { value: "sent", label: tr("已发送", "Sent") },
          ]}
        />
        {dead === 0 && (
          <Button size="sm" variant="outline" icon={MailCheck} onClick={openTest}>
            {tr("测试发信", "Test mail")}
          </Button>
        )}
        <span className="ml-auto text-footnote text-faint max-sm:hidden">
          {tr("所有邮件都经发件箱排队；正文发送后不保存", "All mail is queued here; bodies are not kept")}
        </span>
      </div>
      <Card className="overflow-hidden">
        {q.isPending ? (
          <SkeletonRows rows={6} height={60} />
        ) : q.isError && rows.length === 0 ? (
          <ErrorState
            title={tr("邮件队列加载失败", "The mail queue did not load")}
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        ) : rows.length === 0 ? (
          filter === "all" ? (
            <EmptyState
              icon={Mail}
              title={tr("队列是空的", "The queue is empty")}
              description={tr(
                "还没有发过邮件。注册、到期提醒、告警都会经过这里。",
                "No mail yet. Sign-ups, expiry reminders and alerts all pass through here.",
              )}
              action={
                <Button variant="outline" icon={MailCheck} onClick={openTest}>
                  {tr("测试发信", "Test mail")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={filter === "dead" ? CheckCircle2 : Mail}
              title={
                filter === "dead"
                  ? tr("没有发送失败的邮件", "No failed mail")
                  : filter === "pending"
                    ? tr("没有待发送的邮件", "Nothing waiting")
                    : tr("还没有已发送的邮件", "Nothing sent yet")
              }
              action={
                <Button variant="outline" onClick={() => patch({ mail: null }, true)}>
                  {tr("清除筛选", "Clear filter")}
                </Button>
              }
            />
          )
        ) : (
          <ul className="divide-y divide-separator" aria-label={tr("邮件", "Mail")}>
            {rows.map((m) => (
              <li key={m.id} data-row className="flex items-start gap-3 px-4 py-3">
                <span
                  className={cn(
                    "mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5",
                    m.status === "dead"
                      ? "bg-destructive-soft text-destructive"
                      : m.status === "pending"
                        ? "bg-info-soft text-info"
                        : "bg-success-soft text-success",
                  )}
                  role="img"
                  aria-label={
                    m.status === "dead"
                      ? tr("发送失败", "Failed")
                      : m.status === "pending"
                        ? tr("待发送", "Pending")
                        : tr("已发送", "Sent")
                  }
                >
                  {m.status === "dead" ? <XCircle /> : m.status === "pending" ? <Clock /> : <CheckCircle2 />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <Badge tone="outline">{mailKindName(m.kind, tr)}</Badge>
                    <span className="min-w-0 truncate text-body font-medium">
                      {m.subject || mailKindName(m.kind, tr)}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-footnote text-muted-foreground">
                    {tr(`发给 ${m.to_addr}`, `To ${m.to_addr}`)} · {dateTime(m.created_at)}
                    {m.status === "dead" &&
                      tr(` · 已试 ${m.attempts} 次，已放弃`, ` · ${m.attempts} attempts, given up`)}
                    {m.status === "pending" &&
                      tr(
                        ` · 已试 ${m.attempts} 次 · 下次 ${dateTime(m.next_attempt_at).slice(11, 16)}`,
                        ` · ${m.attempts} attempts · next ${dateTime(m.next_attempt_at).slice(11, 16)}`,
                      )}
                  </div>
                  {m.last_error && m.status !== "sent" && (
                    <RawError
                      className="mt-1.5"
                      message={
                        <span className={m.status === "dead" ? "text-destructive" : ""}>
                          {m.last_error === "expired before delivery"
                            ? tr("验证码或链接已过期，不再发送", "The code or link expired before delivery")
                            : mailReason(m.last_error, tr)}
                        </span>
                      }
                      raw={m.last_error}
                    />
                  )}
                </div>
                {m.status === "dead" && m.retryable && <RetryButton id={m.id} />}
                {m.status === "sent" && (
                  <span className="text-footnote text-success max-sm:hidden">
                    {tr("已交给对方服务器", "Accepted by the receiving server")}
                    {m.settled_at && ` · ${dateTime(m.settled_at).slice(11, 16)}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage && (
          <button
            type="button"
            onClick={() => void q.fetchNextPage()}
            disabled={q.isFetchingNextPage}
            className="flex h-10 w-full items-center justify-center gap-1.5 border-t border-separator text-body text-primary hover:bg-accent"
          >
            {q.isFetchingNextPage ? (
              <>
                <RotateCw className="size-3.5 animate-spin" aria-hidden="true" />
                {tr("加载中…", "Loading…")}
              </>
            ) : (
              tr("加载更早的邮件", "Load older mail")
            )}
          </button>
        )}
      </Card>
      {query.get("diagnose") && <TestMailDialog onClose={() => patch({ diagnose: null }, true)} lang={lang} />}
    </div>
  );
}

const STEPS: { step: string; zh: string; en: string }[] = [
  { step: "config", zh: "读取配置", en: "Read the settings" },
  { step: "dns", zh: "解析 DNS", en: "Resolve DNS" },
  { step: "tcp", zh: "连接 TCP", en: "Connect (TCP)" },
  { step: "tls", zh: "建立 TLS", en: "Set up TLS" },
  { step: "greeting", zh: "SMTP 问候", en: "SMTP greeting" },
  { step: "auth", zh: "登录认证", en: "Authenticate" },
  { step: "send", zh: "发送测试邮件", en: "Send the test mail" },
];

/** "测试发信": POST /settings/mail/diagnose with the saved settings, step by step. */
function TestMailDialog({ onClose, lang }: { onClose: () => void; lang: "zh" | "en" }) {
  const tr = useTr();
  const me = useMe();
  const [to, setTo] = useState(me.email);
  const [report, setReport] = useState<{ ok: boolean; steps: Step[] } | null>(null);
  const [run, busy] = useAction();
  const valid = /^[^\s@]+@[^\s@]+$/.test(to.trim());
  const submit = async () => {
    if (!valid || busy) return;
    setReport(null);
    const r = await run(() => post<{ ok: boolean; steps: Step[] }>("/settings/mail/diagnose", { to: to.trim() }));
    if (r) setReport(r);
  };
  const byStep = new Map((report?.steps ?? []).map((s) => [s.step, s]));
  // The server may name steps the list above does not know (another provider): show them too.
  const order = [
    ...STEPS.map((s) => s.step),
    ...(report?.steps ?? []).map((s) => s.step).filter((s) => !STEPS.some((x) => x.step === s)),
  ];
  const failed = report?.steps.find((s) => s.status === "fail");
  const failedAt = failed ? order.indexOf(failed.step) : -1;
  const msg = (s: Step) => (lang === "en" ? s.message.en : s.message.zh);
  const items = order
    .filter((k) => !report || byStep.has(k) || STEPS.some((x) => x.step === k))
    .map((k, i) => {
      const def = STEPS.find((x) => x.step === k);
      const label = <span data-step={k}>{def ? tr(def.zh, def.en) : k}</span>;
      const s = byStep.get(k);
      if (busy) return { label, state: (i === 0 ? "active" : "todo") as StepState };
      if (!report || !s)
        return {
          label,
          state: "todo" as StepState,
          detail:
            report && failedAt >= 0 && i > failedAt
              ? tr("前面的步骤失败，没有执行", "Not run: an earlier step failed")
              : undefined,
        };
      if (s.status === "fail")
        return {
          label,
          state: "failed" as StepState,
          ms: `${s.elapsed_ms} ms`,
          detail: (
            <div className="grid gap-1.5">
              <span className="text-destructive">{msg(s)}</span>
              <code className="block rounded bg-card/70 px-2 py-1 font-mono text-caption break-all text-muted-foreground">
                {s.code}
              </code>
              <Link to="/settings/mail" className="font-medium text-primary hover:underline">
                {tr("去 系统设置 → 发信 修改 →", "Open Settings → Mail →")}
              </Link>
            </div>
          ),
        };
      if (s.status === "skip") return { label, state: "todo" as StepState, detail: msg(s) || tr("已跳过", "Skipped") };
      return {
        label,
        state: "done" as StepState,
        ms: `${s.elapsed_ms} ms`,
        detail: s.status === "warn" ? <span className="text-warning">{msg(s)}</span> : msg(s) || undefined,
      };
    });
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      icon={MailCheck}
      title={tr("测试发信", "Test mail")}
      description={tr(
        "用已保存的发信配置逐步连接并发一封测试邮件，哪一步失败就停在哪一步。",
        "Connects step by step with the saved settings and sends a test mail; stops at the step that fails.",
      )}
      onSubmit={submit}
      dirty={false}
      footer={
        <>
          <Button variant="ghost" icon={Settings} className="mr-auto" asChild>
            <Link to="/settings/mail">{tr("发信设置", "Mail settings")}</Link>
          </Button>
          <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
          <Button type="submit" variant="primary" icon={RotateCw} loading={busy} disabled={!valid}>
            {busy
              ? tr("测试中…", "Testing…")
              : report
                ? tr("重新测试", "Test again")
                : tr("诊断并发送", "Diagnose and send")}
          </Button>
        </>
      }
    >
      <Field
        label={tr("收件地址", "To")}
        hint={tr("测试邮件只发给这个地址", "The test goes to this address only")}
        error={to.trim() && !valid ? tr("邮箱地址格式不对", "Not an email address") : undefined}
      >
        <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} data-autofocus />
      </Field>
      {report && failed && (
        <Banner
          tone="danger"
          icon={<XCircle />}
          title={tr(`第 ${failedAt + 1} 步失败：`, `Step ${failedAt + 1} failed:`)}
          className="mt-4"
        >
          {tr("邮件没有发出。", "The mail was not sent.")}
        </Banner>
      )}
      {report && report.ok && (
        <Banner tone="success" icon={<CheckCircle2 />} title={tr("全部通过：", "All passed:")} className="mt-4">
          {tr(
            `已投递给 ${to.trim()}，请到收件箱确认（可能在垃圾邮件里）。`,
            `Handed over for ${to.trim()}; check the inbox (maybe spam).`,
          )}
        </Banner>
      )}
      {(busy || report) && (
        <div className="mt-3" role="group" aria-label={tr("诊断结果", "Diagnosis")}>
          <Steps items={items} />
        </div>
      )}
    </Dialog>
  );
}
