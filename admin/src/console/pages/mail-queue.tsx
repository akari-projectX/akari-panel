// 系统状态 → 邮件队列 (SET-17, moved from the mail settings: dead letters
// and retries are operations, not settings): the outbox by status (failed /
// pending / sent, `?mail=` in the URL), older pages, a retry per dead
// letter (own busy each), and the step-by-step test mail (the dead-letter
// notice's "测试发信" runs it here instead of only linking away).
import { useInfiniteQuery } from "@tanstack/react-query";
import { CircleCheck, Inbox, MailWarning, RotateCw, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { get, post, qs } from "../../shared/api";
import { dateTime } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader } from "../../shared/ui/card";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented } from "../../shared/ui/form";
import { EmptyState } from "../../shared/ui/states";
import { DataTable, type Column } from "../../shared/ui/table";
import { useAction } from "../data";
import { setQuery, useRoute } from "../router";
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
export type MailStatus = "dead" | "pending" | "sent";

/** Outbox kinds (`Template::outbox_kind`) → names. */
export function mailKindName(k: string, tr: Tr): string {
  const names: Record<string, [string, string]> = {
    register_code: ["注册验证码", "Sign-up code"],
    register_exists: ["邮箱已注册提醒", "Already registered"],
    email_code: ["邮箱验证码", "Email code"],
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
  };
  const n = names[k];
  return n ? tr(n[0], n[1]) : k;
}

function mailStatus(s: string, tr: Tr): [string, Tone] {
  if (s === "dead") return [tr("发送失败", "Failed"), "danger"];
  if (s === "pending") return [tr("待发送", "Pending"), "info"];
  if (s === "sent") return [tr("已发送", "Sent"), "success"];
  return [s, "neutral"];
}

function RetryButton({ id }: { id: number }) {
  const tr = useTr();
  const [run, busy] = useAction();
  return (
    <Button
      size="sm"
      variant="outline"
      icon={RotateCw}
      loading={busy}
      onClick={(e) => {
        e.stopPropagation();
        void run(() => post(`/mail/outbox/${id}/retry`), { ok: tr("已重新排队", "Requeued") });
      }}
    >
      {tr("重试", "Retry")}
    </Button>
  );
}

/** The mail queue card (`?mail=dead|pending|sent`; a link with ?mail scrolls here). */
export function MailQueue({ deadCount, onTest }: { deadCount: number; onTest: () => void }) {
  const tr = useTr();
  const { query } = useRoute();
  const param = query.get("mail");
  const status: MailStatus = param === "pending" || param === "sent" ? param : "dead";
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (param) ref.current?.scrollIntoView({ block: "start" });
    // Only on arrival with ?mail (not on every filter change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const q = useInfiniteQuery({
    queryKey: ["outbox", status],
    queryFn: ({ pageParam }) => get<Outbox[]>(`/mail/outbox${qs({ status, before: pageParam, limit: PAGE })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === PAGE ? last[PAGE - 1].id : undefined),
    refetchInterval: 15_000,
  });
  const rows = (q.data?.pages.flat() ?? []).map((o) => ({ ...o, id: String(o.id), raw: o.id }));
  const columns: Column<(typeof rows)[number]>[] = [
    {
      key: "subject",
      header: tr("主题", "Subject"),
      fixed: true,
      mobile: "title",
      cell: (o) => <span className="break-words">{o.subject || mailKindName(o.kind, tr)}</span>,
    },
    { key: "to", header: tr("收件人", "To"), cell: (o) => <span className="break-all">{o.to_addr}</span> },
    { key: "kind", header: tr("种类", "Kind"), cell: (o) => mailKindName(o.kind, tr) },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (o) => {
        const [t, tone] = mailStatus(o.status, tr);
        return <Badge tone={tone}>{t}</Badge>;
      },
    },
    { key: "attempts", header: tr("尝试次数", "Attempts"), align: "right", cell: (o) => o.attempts },
    {
      key: "error",
      header: tr("最后错误（服务器原文）", "Last error (server's words)"),
      cell: (o) =>
        o.last_error ? (
          <span className="line-clamp-2 max-w-md text-footnote break-words text-muted-foreground" title={o.last_error}>
            {o.last_error}
          </span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    { key: "created", header: tr("时间", "Time"), cell: (o) => dateTime(o.created_at) },
    {
      key: "retry",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      fixed: true,
      cell: (o) => (o.retryable ? <RetryButton id={o.raw} /> : null),
    },
  ];
  const empty =
    status === "dead" ? (
      <EmptyState
        icon={CircleCheck}
        title={tr("没有发送失败的邮件", "No failed mail")}
        description={tr("重试 8 次仍失败的邮件会出现在这里。", "Mail that failed 8 attempts shows up here.")}
      />
    ) : (
      <EmptyState
        icon={Inbox}
        title={
          status === "pending"
            ? tr("没有待发送的邮件", "Nothing waiting")
            : tr("还没有已发送的邮件", "Nothing sent yet")
        }
      />
    );
  return (
    <div ref={ref} id="mail-queue" className="scroll-mt-20">
      <Card>
        <CardHeader
          title={tr("邮件队列", "Mail queue")}
          description={tr(
            "所有邮件都经发件箱排队发送；失败的邮件可在这里重试。正文不保存。",
            "All mail goes through the outbox; failed mail can be retried here. Bodies are not kept.",
          )}
          actions={
            <Button size="sm" variant="outline" icon={Send} onClick={onTest}>
              {tr("测试发信", "Test mail")}
            </Button>
          }
        />
        <div className="px-4 pb-3">
          <Segmented
            size="sm"
            label={tr("邮件队列", "Mail queue")}
            value={status}
            onChange={(v) => setQuery({ mail: v })}
            options={[
              { value: "dead", label: tr("发送失败", "Failed"), count: deadCount || undefined },
              { value: "pending", label: tr("待发送", "Pending") },
              { value: "sent", label: tr("已发送", "Sent") },
            ]}
          />
        </div>
        <div className="border-t border-separator">
          <DataTable
            label={tr("邮件队列", "Mail queue")}
            storageKey="outbox"
            rows={rows}
            columns={columns}
            loading={q.isPending}
            error={q.error}
            onRetry={() => void q.refetch()}
            empty={empty}
            footer={
              q.hasNextPage ? (
                <Button size="sm" variant="ghost" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                  {tr("加载更早", "Load older")}
                </Button>
              ) : undefined
            }
          />
        </div>
      </Card>
    </div>
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
const STEP_STATUS: Record<Step["status"], [string, string, Tone]> = {
  ok: ["通过", "OK", "success"],
  warn: ["注意", "Warning", "warning"],
  fail: ["失败", "Failed", "danger"],
  skip: ["跳过", "Skipped", "neutral"],
};

/** "测试发信": POST /settings/mail/diagnose with the saved settings, step by step. */
export function TestMailDialog({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const lang = useLang();
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
  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      icon={MailWarning}
      title={tr("测试发信", "Test mail")}
      description={tr(
        "用已保存的发信设置逐步检查并发一封测试邮件。",
        "Checks the saved mail settings step by step and sends a test.",
      )}
      onSubmit={submit}
      dirty={false}
      footer={
        <>
          <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
          <Button type="submit" variant="primary" icon={Send} loading={busy} disabled={!valid}>
            {tr("诊断并发送", "Diagnose and send")}
          </Button>
        </>
      }
    >
      <Field
        label={tr("收件地址", "To")}
        error={to.trim() && !valid ? tr("邮箱地址格式不对", "Not an email address") : undefined}
      >
        <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} data-autofocus />
      </Field>
      {report && (
        <ol className="mt-4 grid gap-1.5" aria-label={tr("诊断结果", "Diagnosis")}>
          {report.steps.map((s) => {
            const [zh, en, tone] = STEP_STATUS[s.status] ?? ["?", "?", "neutral"];
            return (
              <li
                key={s.step}
                data-step={s.step}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-window px-3 py-2 text-body"
              >
                <Badge tone={tone}>{tr(zh, en)}</Badge>
                <span className="font-medium">{tr(...(STEPS[s.step] ?? [s.step, s.step]))}</span>
                <span className="min-w-0 flex-1 basis-48">{lang === "en" ? s.message.en : s.message.zh}</span>
                <span className="tnum text-footnote text-muted-foreground">{s.elapsed_ms} ms</span>
              </li>
            );
          })}
          <li className="pt-1">
            <Badge tone={report.ok ? "success" : "danger"}>
              {report.ok ? tr("测试邮件已被接受", "Accepted by the provider") : tr("未能发送", "Not sent")}
            </Badge>
          </li>
        </ol>
      )}
    </Dialog>
  );
}
