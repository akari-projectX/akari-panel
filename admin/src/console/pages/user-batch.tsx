// Bulk work on users (USR-24…27), v2: the three-step batch wizard (pick an
// action → its parameters → the server's preview, then a background job),
// the 批量任务 popover in the page header (latest jobs with a three-colour
// progress bar; ?jobs=1 opens it), the job detail (?job=<id>: stats,
// progress, failed and skipped first, cancel while running, retry the
// failed ones as a new job) and the bulk delete of accounts (preview with
// a confirm token, typed confirmation).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  CalendarPlus,
  Check,
  ChevronLeft,
  CircleOff,
  Layers,
  ListChecks,
  Loader2,
  Mail,
  RefreshCcw,
  ShieldOff,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, get, post } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateTime, parseYuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Textarea } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { Popover } from "../../shared/ui/menu";
import { ErrorState, SkeletonRows } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { FixCount, StatStrip, Stepper } from "../components/kit";
import { RadioCards } from "../components/inputs";
import { useAction } from "../data";
import { FormError, useErrText } from "../kit";
import { useQS } from "../router";
import type { PlanView } from "../types";
import { EMPTY_TERM, TermFields, termBody, type TermForm } from "./term-fields";

export type UserFilter = {
  q?: string;
  status?: string;
  plan_id?: string;
  role?: string;
  never_used?: boolean;
  registered_before?: string;
  last_login_before?: string;
  /** Console views (expiring | usage80 | lapsed | unverified). */
  view?: string;
};
export type Selection = { ids: string[] } | { filter: UserFilter };

type Preview = { total: number; admins: number; sample: string[] };

export const BATCH_KINDS = [
  "extend_expiry",
  "reset_traffic",
  "ban",
  "unban",
  "set_plan",
  "cancel_plan",
  "add_balance",
  "send_email",
] as const;
export type Kind = (typeof BATCH_KINDS)[number];

const ICON: Record<Kind, LucideIcon> = {
  extend_expiry: CalendarPlus,
  reset_traffic: RefreshCcw,
  ban: Ban,
  unban: ShieldOff,
  set_plan: Layers,
  cancel_plan: CircleOff,
  add_balance: Wallet,
  send_email: Mail,
};

export function batchKindName(k: string, tr: Tr): string {
  switch (k) {
    case "extend_expiry":
      return tr("延长 N 天", "Extend N days");
    case "reset_traffic":
      return tr("重置套餐流量", "Reset plan traffic");
    case "ban":
    case "disable":
      return tr("封禁", "Ban");
    case "unban":
    case "enable":
      return tr("解除封禁", "Unban");
    case "set_plan":
      return tr("分配 / 更换套餐", "Assign / change plan");
    case "cancel_plan":
      return tr("取消套餐", "Cancel plan");
    case "add_balance":
      return tr("调整余额", "Adjust balance");
    case "send_email":
      return tr("发送邮件", "Send email");
    default:
      return tr("其他操作", "Other action");
  }
}

function kindDesc(k: Kind, tr: Tr): string {
  switch (k) {
    case "extend_expiry":
      return tr("到期日顺延；一次性套餐跳过", "Push the expiry out; one-time plans are skipped");
    case "reset_traffic":
      return tr("本周期已用清零，恢复超流量停用", "Used traffic to 0; over-quota accounts resume");
    case "ban":
      return tr("立即踢线，订阅停止服务", "Disconnect now; the subscription stops");
    case "unban":
      return tr("恢复订阅与登录", "Subscription and sign-in come back");
    case "set_plan":
      return tr("从现在开始，用量清零", "Starts now; usage resets");
    case "cancel_plan":
      return tr("立即停止服务，不退款", "Service stops now; no refund");
    case "add_balance":
      return tr("增加或扣减，写入余额明细", "Credit or debit, one ledger row each");
    case "send_email":
      return tr("进入发信队列，只发已验证邮箱", "Queued; verified addresses only");
  }
}

const BAN_REASONS = ["abuse", "sharing", "dispute", "tos", "other"] as const;
type BanReason = (typeof BAN_REASONS)[number];
function banReasonText(r: BanReason, tr: Tr): string {
  switch (r) {
    case "abuse":
      return tr("滥用", "Abuse");
    case "sharing":
      return tr("共享账号", "Account sharing");
    case "dispute":
      return tr("支付争议", "Payment dispute");
    case "tos":
      return tr("违反服务条款", "Terms of service violation");
    case "other":
      return tr("其他", "Other");
  }
}

type Step = 0 | 1 | 2;

export function BatchDialog({
  selection,
  label,
  count,
  initialKind,
  plans,
  onClose,
  onDone,
}: {
  selection: Selection;
  label: string;
  /** How many accounts the selection holds (as shown in the bar). */
  count: number;
  /** The action picked in the bulk bar: the wizard starts at its parameters. */
  initialKind?: Kind;
  plans: PlanView[];
  onClose: () => void;
  /** The job was created (its id). */
  onDone: (jobId?: string) => void;
}) {
  const tr = useTr();
  const [run, busy] = useAction();
  const [step, setStep] = useState<Step>(initialKind ? 1 : 0);
  const [kind, setKind] = useState<Kind>(initialKind ?? "extend_expiry");
  const [days, setDays] = useState("7");
  const [term, setTerm] = useState<TermForm>(EMPTY_TERM);
  const [amount, setAmount] = useState("");
  const [credit, setCredit] = useState<"credit" | "debit">("credit");
  const [banReason, setBanReason] = useState<BanReason>("abuse");
  const [reason, setReason] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [shown, setShown] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Field errors (live once the admin tried to go on, or typed).
  const errors: Partial<Record<"days" | "term" | "reason" | "amount" | "subject" | "body", string>> = {};
  let action: Record<string, unknown> = { kind };
  switch (kind) {
    case "extend_expiry": {
      const t = days.trim();
      if (!/^\d{1,4}$/.test(t) || Number(t) < 1 || Number(t) > 3650)
        errors.days = tr("请输入 1–3650 的整数", "Enter a whole number 1–3650");
      else action = { kind, days: Number(t) };
      break;
    }
    case "set_plan": {
      const b = termBody(term, tr);
      if (typeof b === "string") errors.term = b;
      else action = { kind, ...b };
      break;
    }
    case "ban": {
      const note = reason.trim();
      if (banReason === "other" && note.length < 2)
        errors.reason = tr("选了「其他」，请写明原因", "With 其他 (other), write the reason");
      const text =
        banReason === "other" ? note : note ? `${banReasonText(banReason, tr)}：${note}` : banReasonText(banReason, tr);
      action = { kind, reason: text.slice(0, 500) };
      break;
    }
    case "add_balance": {
      const c = parseYuan(amount);
      if (c === null || c <= 0)
        errors.amount = tr("请输入大于 0 的金额，最多两位小数", "Enter an amount > 0, 2 decimals at most");
      if (!reason.trim()) errors.reason = tr("请填写原因", "Enter a reason");
      if (c !== null && c > 0) action = { kind, amount_cents: credit === "credit" ? c : -c, reason: reason.trim() };
      break;
    }
    case "send_email":
      if (!subject.trim()) errors.subject = tr("请填写邮件标题", "Enter the subject");
      if (!body.trim()) errors.body = tr("请填写邮件正文", "Enter the body");
      action = { kind, subject: subject.trim(), body: body.trim() };
      break;
  }
  const nErr = Object.keys(errors).length;
  const err = (k: keyof typeof errors) => (shown ? errors[k] : undefined);

  const toPreview = async () => {
    setShown(true);
    if (nErr) return;
    setError(null);
    setPreviewing(true);
    try {
      setPreview(await post<Preview>("/users/batch/preview", { selection }));
      setStep(2);
    } catch (e) {
      setError(e);
    } finally {
      setPreviewing(false);
    }
  };

  const start = async () => {
    const r = await run(() => post<{ id: string }>("/users/batch", { selection, action }), {
      ok: tr("批量任务已创建", "Batch job created"),
      okDetail: tr("可在页头「批量任务」查看进度", "Follow it under 批量任务 in the header"),
    });
    if (r !== undefined) onDone(r?.id);
  };

  const danger = kind === "ban" || kind === "cancel_plan";
  const will = preview ? preview.total - preview.admins : 0;
  const summary = (): string => {
    switch (kind) {
      case "extend_expiry":
        return tr(`到期日顺延 ${days.trim()} 天`, `Expiry pushed out by ${days.trim()} days`);
      case "reset_traffic":
        return tr("本周期已用流量清零", "This period's used traffic goes to 0");
      case "ban":
        return tr(`封禁，原因「${String(action.reason ?? "")}」`, `Ban, reason "${String(action.reason ?? "")}"`);
      case "unban":
        return tr("解除封禁", "Unban");
      case "set_plan": {
        const p = plans.find((x) => x.id === term.planId);
        return tr(`分配「${p?.name ?? ""}」，从现在开始`, `Assign "${p?.name ?? ""}" from now`);
      }
      case "cancel_plan":
        return tr("取消套餐，剩余天数与流量作废", "Cancel the plan; the rest of the term and traffic is gone");
      case "add_balance":
        return `${credit === "credit" ? tr("增加", "Credit") : tr("扣减", "Debit")} ${amount.trim()} ${tr("元", "yuan")}（${reason.trim()}）`;
      case "send_email":
        return tr(`发送邮件「${subject.trim()}」`, `Send "${subject.trim()}"`);
    }
  };

  const Icon = ICON[kind];
  return (
    <Dialog
      open
      size="lg"
      icon={Icon}
      tone={danger ? "danger" : "default"}
      onClose={onClose}
      title={
        step === 0
          ? tr(`批量操作 ${count} 个用户`, `Bulk action on ${count} users`)
          : `${batchKindName(kind, tr)} · ${tr(`${count} 个用户`, `${count} users`)}`
      }
      description={label}
      tabs={
        <Stepper
          className="px-5"
          current={step}
          onJump={(i) => setStep(i as Step)}
          steps={[tr("选择操作", "Action"), tr("参数", "Parameters"), tr("预览并确认", "Preview")]}
        />
      }
      footer={
        <>
          {step > 0 && (
            <Button variant="ghost" icon={ChevronLeft} onClick={() => setStep((step - 1) as Step)}>
              {tr("上一步", "Back")}
            </Button>
          )}
          <span className="flex-1" />
          {step === 1 && shown && <FixCount n={nErr} />}
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          {step === 0 && (
            <Button variant="primary" onClick={() => setStep(1)}>
              {tr("下一步", "Next")}
            </Button>
          )}
          {step === 1 && (
            <Button
              variant="primary"
              loading={previewing}
              disabled={shown && nErr > 0}
              onClick={() => void toPreview()}
            >
              {tr("预览", "Preview")}
            </Button>
          )}
          {step === 2 && (
            <Button
              variant={danger ? "destructive" : "primary"}
              loading={busy}
              disabled={will <= 0}
              onClick={() => void start()}
            >
              {tr(`开始执行（${will} 人）`, `Start (${will} users)`)}
            </Button>
          )}
        </>
      }
    >
      {step === 0 && (
        <RadioCards
          cols={2}
          label={tr("操作", "Action")}
          value={kind}
          onChange={(k) => {
            setKind(k);
            setShown(false);
          }}
          items={BATCH_KINDS.map((k) => {
            const I = ICON[k];
            return { value: k, title: batchKindName(k, tr), desc: kindDesc(k, tr), icon: <I /> };
          })}
        />
      )}
      {step === 1 && (
        <div className="grid gap-4">
          {kind === "extend_expiry" && (
            <Field
              label={tr("延长天数", "Days")}
              error={err("days")}
              hint={tr(
                "每个用户的到期日各自顺延；一次性套餐与无套餐的账户会被跳过。",
                "Each expiry moves on its own; one-time and plan-less accounts are skipped.",
              )}
            >
              <div className="flex flex-wrap gap-2">
                {["3", "7", "30"].map((d) => (
                  <Button key={d} variant={days === d ? "soft" : "secondary"} onClick={() => setDays(d)}>
                    {tr(`${d} 天`, `${d} days`)}
                  </Button>
                ))}
                <Input
                  className="w-24"
                  inputMode="numeric"
                  aria-label={tr("天数", "Days")}
                  value={days}
                  onChange={(e) => {
                    setDays(e.target.value);
                    setShown(true);
                  }}
                />
              </div>
            </Field>
          )}
          {(kind === "reset_traffic" || kind === "unban" || kind === "cancel_plan") && (
            <p className="rounded-xl bg-window p-3 text-body text-muted-foreground ring-1 ring-border ring-inset">
              {kind === "reset_traffic" &&
                tr(
                  "没有参数。每个用户本周期的已用流量清零，因超流量停用的账户立即恢复；不改变到期日。没有套餐的账户会被跳过。",
                  "No parameters. Each user's used traffic goes to 0 and over-quota accounts resume; the expiry stays. Accounts without a plan are skipped.",
                )}
              {kind === "unban" &&
                tr(
                  "没有参数。订阅恢复，用户可以重新登录；未被封禁的用户会被跳过。",
                  "No parameters. Subscriptions come back and users can sign in; accounts that are not banned are skipped.",
                )}
              {kind === "cancel_plan" &&
                tr(
                  "没有参数。立即停止服务，剩余天数与流量作废，不自动退款。",
                  "No parameters. Service stops now; the rest of the term and traffic is gone, nothing is refunded.",
                )}
            </p>
          )}
          {kind === "ban" && (
            <>
              <RadioCards
                cols={3}
                label={tr("封禁原因", "Ban reason")}
                value={banReason}
                onChange={(r) => setBanReason(r)}
                items={BAN_REASONS.map((r) => ({ value: r, title: banReasonText(r, tr) }))}
              />
              <Field
                label={
                  banReason === "other"
                    ? tr("说明（必填，门户中对用户可见）", "Note (required, shown to the users)")
                    : tr("补充说明（可选，门户中对用户可见）", "Note (optional, shown to the users)")
                }
                error={err("reason")}
              >
                <Textarea rows={3} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </>
          )}
          {kind === "set_plan" && (
            <>
              <TermFields form={term} onChange={setTerm} plans={plans} />
              {err("term") && (
                <p role="alert" className="text-footnote text-destructive">
                  {err("term")}
                </p>
              )}
              <p className="text-footnote text-muted-foreground">
                {tr(
                  "从现在开始计算，原套餐剩余天数与流量不折算；不生成订单。",
                  "Starts now; the old plan's remaining time and traffic are not credited; no order is made.",
                )}
              </p>
            </>
          )}
          {kind === "add_balance" && (
            <>
              <Segmented
                value={credit}
                onChange={setCredit}
                options={[
                  { value: "credit", label: tr("增加", "Credit") },
                  { value: "debit", label: tr("扣减", "Debit") },
                ]}
              />
              <Field
                label={tr("每人金额（元）", "Amount each (yuan)")}
                error={err("amount")}
                hint={
                  credit === "debit"
                    ? tr(
                        "余额不足的用户会失败，不会扣成负数。",
                        "Users without enough balance fail; nobody goes negative.",
                      )
                    : undefined
                }
              >
                <Input
                  inputMode="decimal"
                  className="w-40"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field
                label={tr("原因（显示在用户的余额明细里）", "Reason (in the users' ledger)")}
                error={err("reason")}
              >
                <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </>
          )}
          {kind === "send_email" && (
            <>
              <Field label={tr("邮件标题", "Subject")} error={err("subject")}>
                <Input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />
              </Field>
              <Field
                label={tr("正文（纯文本，空行分段）", "Body (plain text)")}
                error={err("body")}
                hint={tr("只发给已验证的邮箱；按发信速率排队发送。", "Verified addresses only; sent at the mail rate.")}
              >
                <Textarea rows={6} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
              </Field>
            </>
          )}
          <FormError error={error} />
        </div>
      )}
      {step === 2 && preview && (
        <div className="grid gap-4">
          <StatStrip
            items={[
              { label: tr("选中", "Selected"), value: preview.total },
              { label: tr("将处理", "To process"), value: will, tone: danger ? "danger" : "primary" },
              { label: tr("跳过", "Skipped"), value: preview.admins },
            ]}
          />
          <div className="rounded-xl bg-window p-3 ring-1 ring-border ring-inset">
            <div className="text-footnote text-muted-foreground">{tr("操作", "Action")}</div>
            <div className="text-body font-semibold break-words">{summary()}</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <section>
              <h4 className="mb-1.5 text-footnote font-semibold text-muted-foreground">
                {tr("跳过的原因", "Skipped")}
              </h4>
              <ul className="divide-y divide-separator rounded-xl ring-1 ring-border ring-inset">
                <li className="flex justify-between px-3 py-2 text-body">
                  <span className="text-muted-foreground">{tr("管理员账户", "Admin accounts")}</span>
                  <span className="tnum font-medium">{tr(`${preview.admins} 人`, String(preview.admins))}</span>
                </li>
                <li className="px-3 py-2 text-footnote text-muted-foreground">
                  {tr(
                    "不适用的账户（如无套餐、未封禁）在执行时逐个跳过，结果见任务明细。",
                    "Accounts it does not apply to (no plan, not banned…) are skipped while it runs; see the job detail.",
                  )}
                </li>
              </ul>
            </section>
            <section>
              <h4 className="mb-1.5 text-footnote font-semibold text-muted-foreground">
                {tr(
                  `样例（前 ${Math.min(5, preview.sample.length)} 个）`,
                  `Sample (first ${Math.min(5, preview.sample.length)})`,
                )}
              </h4>
              <ul className="divide-y divide-separator rounded-xl ring-1 ring-border ring-inset">
                {preview.sample.slice(0, 5).map((e) => (
                  <li key={e} className="truncate px-3 py-2 text-body">
                    {e}
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <p className="text-footnote text-faint">
            {tr(
              "人数来自服务端预览；执行时会再次检查每个用户的状态。每个用户单独写入审计日志。",
              "Counts come from the server's preview; each user is checked again while it runs, and audited one by one.",
            )}
          </p>
        </div>
      )}
    </Dialog>
  );
}

type Job = {
  id: string;
  actor_label: string;
  action: string;
  params: Record<string, unknown>;
  selection: string;
  status: string;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
};
type Item = { user_id: string; user_label: string; user_email: string | null; status: string; detail: string | null };

const ACTIVE = ["pending", "running"];

/** The job's state in Chinese: done with failures is 部分失败. */
export function jobStatus(j: Pick<Job, "status" | "failed">, tr: Tr): [string, Tone] {
  switch (j.status) {
    case "pending":
      return [tr("排队中", "Queued"), "neutral"];
    case "running":
      return [tr("进行中", "Running"), "primary"];
    case "done":
      return j.failed ? [tr("部分失败", "Partly failed"), "warning"] : [tr("已完成", "Done"), "success"];
    case "cancelled":
      return [tr("已取消", "Cancelled"), "outline"];
    case "failed":
      return [tr("失败", "Failed"), "danger"];
    default:
      return [tr("未知", "Unknown"), "neutral"];
  }
}

function JobBadge({ job }: { job: Job }) {
  const tr = useTr();
  const [label, tone] = jobStatus(job, tr);
  return (
    <Badge tone={tone}>
      {job.status === "running" && <Loader2 className="animate-spin" aria-hidden="true" />}
      {job.status === "done" && !job.failed && <Check aria-hidden="true" />}
      {label}
    </Badge>
  );
}

function scopeText(j: Job, tr: Tr): string {
  return j.selection === "filter"
    ? tr(`按筛选 ${j.total} 人`, `filter, ${j.total} users`)
    : tr(`勾选 ${j.total} 人`, `${j.total} ticked`);
}

/** Done (green) / skipped (grey) / failed (red) along one bar. */
function JobProgress({ j }: { j: Job }) {
  const tr = useTr();
  const finished = j.done + j.failed + j.skipped;
  const of = (n: number) => (j.total ? (n / j.total) * 100 : 0);
  const pct = j.total ? Math.round((finished / j.total) * 100) : 100;
  return (
    <span className="flex items-center gap-2">
      <span
        role="progressbar"
        aria-label={tr("进度", "Progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-secondary"
      >
        <span className="absolute inset-y-0 left-0 bg-success" style={{ width: `${of(j.done)}%` }} />
        <span className="absolute inset-y-0 bg-faint" style={{ left: `${of(j.done)}%`, width: `${of(j.skipped)}%` }} />
        <span
          className="absolute inset-y-0 bg-destructive"
          style={{ left: `${of(j.done + j.skipped)}%`, width: `${Math.max(j.failed ? 1.5 : 0, of(j.failed))}%` }}
        />
      </span>
      <span className="tnum w-28 shrink-0 text-right text-footnote text-muted-foreground">
        {finished} / {j.total} · {pct}%
      </span>
    </span>
  );
}

function useJobs() {
  const qc = useQueryClient();
  const jobs = useQuery({
    queryKey: ["batch-jobs"],
    queryFn: () => get<Job[]>("/users/batch"),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => ACTIVE.includes(j.status)) ? 2000 : false),
  });
  // A job that finished changed accounts: refresh the list and the detail.
  const known = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!jobs.data) return;
    const before = known.current;
    known.current = new Map(jobs.data.map((j) => [j.id, j.status]));
    if (!before) return;
    const finished = jobs.data.some((j) => {
      const prev = before.get(j.id);
      return !ACTIVE.includes(j.status) && (prev === undefined || ACTIVE.includes(prev));
    });
    if (finished) {
      void qc.invalidateQueries({ queryKey: ["users"] });
      void qc.invalidateQueries({ queryKey: ["user"] });
      void qc.invalidateQueries({ queryKey: ["balance"] });
    }
  }, [jobs.data, qc]);
  return jobs;
}

/** Jobs listed in the header popover. */
const SHOWN = 10;

/** 批量任务 in the users page header: the latest jobs (?jobs=1 opens it). */
export function JobsButton() {
  const tr = useTr();
  const [query, patch] = useQS();
  const jobs = useJobs();
  const open = query.get("jobs") === "1";
  const running = (jobs.data ?? []).filter((j) => ACTIVE.includes(j.status)).length;
  return (
    <Popover
      open={open}
      onOpenChange={(o) => patch({ jobs: o ? "1" : null }, true)}
      label={tr("批量任务", "Batch jobs")}
      className="w-[min(380px,calc(100vw-24px))] p-0"
      trigger={
        <Button variant="outline" icon={running ? undefined : ListChecks}>
          {running > 0 && <Loader2 className="animate-spin text-primary" aria-hidden="true" />}
          {tr("批量任务", "Batch jobs")}
          {running > 0 && (
            <span className="tnum rounded-full bg-primary px-1.5 text-caption text-primary-foreground">{running}</span>
          )}
        </Button>
      }
    >
      <div className="flex items-center border-b border-separator px-3 py-2.5">
        <span className="flex-1 text-headline font-semibold">{tr("批量任务", "Batch jobs")}</span>
        <span className="text-footnote text-faint">{tr(`最近 ${SHOWN} 个`, `Latest ${SHOWN}`)}</span>
      </div>
      {jobs.isPending ? (
        <SkeletonRows rows={3} />
      ) : jobs.error ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} compact />
      ) : !jobs.data?.length ? (
        <p className="px-3 py-6 text-center text-body text-muted-foreground">
          {tr("还没有批量任务。勾选用户后即可批量处理。", "No batch jobs yet. Tick users to act on them together.")}
        </p>
      ) : (
        <ul className="max-h-[420px] divide-y divide-separator overflow-y-auto">
          {jobs.data.slice(0, SHOWN).map((j) => (
            <li key={j.id}>
              <button
                type="button"
                className="grid min-h-11 w-full gap-1.5 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => patch({ jobs: null, job: j.id })}
              >
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-body font-medium">{batchKindName(j.action, tr)}</span>
                  <JobBadge job={j} />
                </span>
                <JobProgress j={j} />
                <span className="truncate text-footnote text-faint">
                  {scopeText(j, tr)} · {j.actor_label} · {dateTime(j.created_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-separator px-3 py-2 text-footnote text-faint">
        {tr("任务结束后用户列表自动刷新。", "The user list refreshes when a job ends.")}
      </div>
    </Popover>
  );
}

function itemIcon(s: string): ReactNode {
  if (s === "failed") return <X className="size-3" aria-hidden="true" />;
  if (s === "done") return <Check className="size-3" aria-hidden="true" />;
  return <span className="text-caption">—</span>;
}

/** One job: stats, progress, items (failed and skipped first), cancel, retry the failed ones. */
export function JobDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const errText = useErrText();
  const [, patch] = useQS();
  const [run, busy] = useAction();
  const [retrying, setRetrying] = useState(false);
  const [all, setAll] = useState(false);
  const q = useQuery({
    queryKey: ["batch-jobs", id],
    queryFn: () => get<{ job: Job; items: Item[] }>(`/users/batch/${id}`),
    refetchInterval: (s) => (s.state.data && ACTIVE.includes(s.state.data.job.status) ? 2000 : false),
  });
  const job = q.data?.job;
  const live = !!job && ACTIVE.includes(job.status);
  // Failed items carry the error code; skipped ones the server's reason (Chinese).
  const itemText = (it: Item) =>
    it.status === "failed"
      ? it.detail
        ? errText(new ApiError(400, it.detail, { code: it.detail }))
        : tr("失败", "Failed")
      : it.status === "skipped"
        ? (it.detail ?? tr("跳过", "Skipped"))
        : it.status === "pending"
          ? tr("待执行", "Pending")
          : tr("成功", "Done");
  const items = (q.data?.items ?? []).filter((it) => all || it.status === "failed" || it.status === "skipped");
  const failedIds = (q.data?.items ?? []).filter((it) => it.status === "failed").map((it) => it.user_id);
  const retry = async () => {
    if (!job) return;
    setRetrying(true);
    try {
      const r = await run(
        () =>
          post<{ id: string }>("/users/batch", {
            selection: { ids: failedIds },
            action: { kind: job.action, ...job.params },
          }),
        { ok: tr(`已为失败的 ${failedIds.length} 个用户新建任务`, `New job for the ${failedIds.length} failed users`) },
      );
      if (r?.id) patch({ job: r.id });
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Dialog
      open
      size="lg"
      icon={job ? (ICON[job.action as Kind] ?? Layers) : Layers}
      onClose={onClose}
      title={
        job ? (
          <span className="flex flex-wrap items-center gap-2">
            {batchKindName(job.action, tr)}
            <JobBadge job={job} />
          </span>
        ) : (
          tr("批量任务", "Batch job")
        )
      }
      description={
        job &&
        `${scopeText(job, tr)} · ${job.actor_label} · ${tr("开始于", "started")} ${dateTime(job.created_at)}${
          job.finished_at ? ` · ${tr("结束于", "ended")} ${dateTime(job.finished_at)}` : ""
        }`
      }
      footer={
        <>
          {live && (
            <Button
              variant="destructive-soft"
              icon={X}
              loading={busy && !retrying}
              onClick={() =>
                void run(() => post(`/users/batch/${id}/cancel`), {
                  ok: tr("已取消剩余的账户", "The rest is cancelled"),
                  okDetail: tr(
                    "正在处理的这一批完成后停止；已完成的不回滚。",
                    "The running chunk finishes; done work stays.",
                  ),
                })
              }
            >
              {tr("取消任务", "Cancel job")}
            </Button>
          )}
          <span className="flex-1" />
          {job && !live && failedIds.length > 0 && (
            <Button variant="outline" icon={RefreshCcw} loading={retrying} onClick={() => void retry()}>
              {tr(`重试失败的 ${failedIds.length} 个`, `Retry the ${failedIds.length} failed`)}
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            {tr("完成", "Done")}
          </Button>
        </>
      }
    >
      {q.isPending ? (
        <SkeletonRows rows={5} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : (
        job && (
          <div className="grid gap-4">
            <StatStrip
              items={[
                { label: tr("总数", "Total"), value: job.total },
                { label: tr("成功", "Done"), value: job.done, tone: "success" },
                { label: tr("跳过", "Skipped"), value: job.skipped },
                { label: tr("失败", "Failed"), value: job.failed, tone: job.failed ? "danger" : undefined },
              ]}
            />
            <JobProgress j={job} />
            {live && (
              <p className="text-footnote text-muted-foreground">
                {tr(
                  "任务在后台分批执行；关闭此窗口不影响执行。",
                  "It runs in the background; closing this window does not stop it.",
                )}
              </p>
            )}
            {job.last_error && (
              <Callout
                tone="warning"
                title={tr("上一批执行出错，稍后自动重试", "The last chunk failed; it is retried")}
              >
                <details className="mt-1">
                  <summary className="cursor-default text-footnote text-muted-foreground">
                    {tr("错误详情", "Error details")}
                  </summary>
                  <p className="mt-1 font-mono text-caption break-words">{job.last_error}</p>
                </details>
              </Callout>
            )}
            <div className="flex items-center gap-2">
              <h3 className="flex-1 text-headline font-semibold">{tr("明细", "Items")}</h3>
              <Segmented
                size="sm"
                value={all ? "all" : "problem"}
                onChange={(v) => setAll(v === "all")}
                options={[
                  { value: "problem", label: tr("失败与跳过", "Failed and skipped") },
                  { value: "all", label: tr("全部", "All") },
                ]}
              />
            </div>
            {items.length === 0 ? (
              <p className="rounded-xl bg-window px-3 py-4 text-center text-body text-muted-foreground">
                {all ? tr("没有明细。", "No items.") : tr("没有失败或跳过的用户。", "Nothing failed or was skipped.")}
              </p>
            ) : (
              <ul className="divide-y divide-separator overflow-hidden rounded-xl ring-1 ring-border ring-inset">
                {items.map((it) => (
                  <li key={it.user_id} className="flex items-center gap-3 px-3 py-2">
                    <span
                      className={cn(
                        "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
                        it.status === "failed"
                          ? "bg-destructive-soft text-destructive"
                          : it.status === "done"
                            ? "bg-success-soft text-success"
                            : "bg-secondary text-muted-foreground",
                      )}
                    >
                      {itemIcon(it.status)}
                    </span>
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-body font-medium hover:text-primary hover:underline"
                      onClick={() => patch({ job: null, open: it.user_id, tab: null })}
                    >
                      {it.user_email ?? it.user_label}
                    </button>
                    <span
                      className={cn(
                        "max-w-[50%] text-right text-footnote",
                        it.status === "failed" ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {itemText(it)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-footnote text-faint">
              {tr("明细最多列出 500 条，失败与跳过在前。", "Up to 500 items are listed, failed and skipped first.")}
            </p>
          </div>
        )
      )}
    </Dialog>
  );
}

type DeletePreview = Preview & { deletable: number; anonymized: number; confirm_token: string };

/**
 * Bulk delete (D10): the server's preview (count, admins kept, anonymized,
 * sample, a confirm token bound to the selection) goes into the danger
 * confirmation, which asks for "删除 N 个账户" before it deletes.
 * Returns [start, busy]; `start` resolves true when accounts were deleted.
 */
export function useBulkDelete(): [(selection: Selection, label: string) => Promise<boolean>, boolean] {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const errText = useErrText();
  const [busy, setBusy] = useState(false);
  const start = async (selection: Selection, label: string): Promise<boolean> => {
    let p: DeletePreview;
    setBusy(true);
    try {
      p = await post<DeletePreview>("/users/delete/preview", { selection });
    } catch (e) {
      toast({ tone: "error", title: errText(e) });
      return false;
    } finally {
      setBusy(false);
    }
    if (p.deletable === 0) {
      toast({
        tone: "info",
        title: tr("没有可删除的账户", "Nothing to delete"),
        description: p.admins > 0 ? tr("管理员账户不会被删除。", "Admin accounts are never deleted.") : undefined,
      });
      return false;
    }
    let result: { deleted: number; anonymized: number; failed: number } | null = null;
    const ok = await confirm({
      title: tr(`永久删除 ${p.deletable} 个账户？`, `Delete ${p.deletable} accounts for good?`),
      description: tr(
        "与用户自助注销相同：个人数据删除；有财务记录的账户匿名化保留订单与流水。此操作不可撤销，每个账户单独写入审计日志。",
        "Same as a self-deletion: personal data is deleted; accounts with finance records are kept anonymized with their orders and ledger. This cannot be undone; each account is audited.",
      ),
      impacts: [
        {
          label: tr("将删除", "Deleted"),
          value: tr(`${p.deletable} 个`, String(p.deletable)),
        },
        {
          label: tr("管理员（不删除）", "Admins (kept)"),
          value: tr(`${p.admins} 个`, String(p.admins)),
        },
        {
          label: tr("匿名化保留（有财务记录）", "Kept anonymized (finance records)"),
          value: tr(`${p.anonymized} 个`, String(p.anonymized)),
        },
      ],
      details: (
        <div className="space-y-1 text-footnote text-muted-foreground">
          <p>{label}</p>
          {p.sample.length > 0 && (
            <p className="break-words">
              {tr("样例：", "Sample: ")}
              {p.sample.slice(0, 5).join("、")}
            </p>
          )}
        </div>
      ),
      typeToConfirm: tr(`删除 ${p.deletable} 个账户`, `delete ${p.deletable} accounts`),
      confirmLabel: tr("永久删除", "Delete for good"),
      action: async () => {
        result = await post<{ deleted: number; anonymized: number; failed: number }>("/users/delete", {
          selection,
          confirm_token: p.confirm_token,
        });
      },
    });
    const r = result as { deleted: number; anonymized: number; failed: number } | null;
    if (ok && r) toast({ tone: r.failed ? "error" : "success", title: deletedText(r, tr) });
    return ok;
  };
  return [start, busy];
}

/** Body text for a finished bulk delete (used by the toast). */
export function deletedText(r: { deleted: number; anonymized: number; failed: number }, tr: Tr): string {
  return tr(
    `已删除 ${r.deleted}，匿名化 ${r.anonymized}，失败 ${r.failed}`,
    `${r.deleted} deleted, ${r.anonymized} anonymized, ${r.failed} failed`,
  );
}
