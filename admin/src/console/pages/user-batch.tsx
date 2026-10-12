// Bulk work on users (USR-24…27): the batch dialog (preview → confirm →
// background job), the job list with progress / details / cancel, and the
// bulk delete of never-used accounts (preview with a confirm token, typed
// confirmation in the shared danger confirmation).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, get, post } from "../../shared/api";
import { dateTime, parseYuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { FormError, useErrText } from "../kit";
import { useAction } from "../data";
import type { PlanView } from "../types";
import { EMPTY_TERM, TermFields, termBody, type TermForm } from "./term-fields";
import { ChevronDown, Layers } from "lucide-react";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Select, Textarea } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { Meter } from "../../shared/ui/meter";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";

export type UserFilter = {
  q?: string;
  status?: string;
  plan_id?: string;
  role?: string;
  never_used?: boolean;
  registered_before?: string;
  last_login_before?: string;
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

type Errors = Partial<Record<"days" | "term" | "reason" | "amount" | "subject" | "body", string>>;

export function BatchDialog({
  selection,
  label,
  initialKind,
  plans,
  onClose,
  onDone,
}: {
  selection: Selection;
  label: string;
  /** The action picked in the bulk bar (default: extend). */
  initialKind?: Kind;
  plans: PlanView[];
  onClose: () => void;
  onDone: () => void;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run, busy] = useAction();
  const [previewing, setPreviewing] = useState(false);
  const [kind, setKind] = useState<Kind>(initialKind ?? "extend_expiry");
  const [days, setDays] = useState("30");
  const [term, setTerm] = useState<TermForm>(EMPTY_TERM);
  const [amount, setAmount] = useState("");
  const [credit, setCredit] = useState<"credit" | "debit">("credit");
  const [reason, setReason] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<unknown>(null);

  /** The action body, or the field errors. */
  const action = (): Record<string, unknown> | Errors => {
    switch (kind) {
      case "extend_expiry": {
        const n = Number(days.trim());
        if (!/^\d{1,4}$/.test(days.trim()) || n < 1 || n > 3650)
          return { days: tr("天数须为 1–3650 的整数", "Days must be a whole number 1–3650") };
        return { kind, days: n };
      }
      case "set_plan": {
        const b = termBody(term, tr);
        return typeof b === "string" ? { term: b } : { kind, ...b };
      }
      case "ban":
        return reason.trim()
          ? { kind, reason: reason.trim() }
          : { reason: tr("请填写封禁原因（会显示给用户）", "Enter the reason (shown to the users)") };
      case "add_balance": {
        const e: Errors = {};
        const c = parseYuan(amount);
        if (c === null || c <= 0) e.amount = tr("金额无效（元，最多两位小数）", "Invalid amount (yuan, 2 decimals)");
        if (!reason.trim()) e.reason = tr("请填写原因", "Enter a reason");
        if (e.amount || e.reason || c === null) return e;
        return { kind, amount_cents: credit === "credit" ? c : -c, reason: reason.trim() };
      }
      case "send_email": {
        const e: Errors = {};
        if (!subject.trim()) e.subject = tr("请填写邮件标题", "Enter the subject");
        if (!body.trim()) e.body = tr("请填写邮件正文", "Enter the body");
        if (e.subject || e.body) return e;
        return { kind, subject: subject.trim(), body: body.trim() };
      }
      default:
        return { kind };
    }
  };

  const submit = async () => {
    const a = action();
    if (!("kind" in a)) return setErrors(a as Errors);
    setErrors({});
    setError(null);
    let p: Preview;
    setPreviewing(true);
    try {
      p = await post<Preview>("/users/batch/preview", { selection });
    } catch (e) {
      return setError(e);
    } finally {
      setPreviewing(false);
    }
    const ok = await confirm({
      title: tr(
        `对 ${p.total} 个账户执行「${batchKindName(kind, tr)}」？`,
        `Run "${batchKindName(kind, tr)}" on ${p.total} accounts?`,
      ),
      tone: kind === "ban" || kind === "cancel_plan" ? "danger" : "warning",
      impact: tr(`影响 ${p.total - p.admins} 个账户`, `${p.total - p.admins} accounts affected`),
      details: (
        <div className="space-y-2 text-body text-muted-foreground">
          {p.admins > 0 && (
            <p>{tr(`其中 ${p.admins} 个管理员账户会被跳过。`, `${p.admins} admin accounts are skipped.`)}</p>
          )}
          {p.sample.length > 0 && (
            <p className="break-words">
              {tr("例如：", "For example: ")}
              {p.sample.join(", ")}
            </p>
          )}
          <p>
            {tr(
              "任务在后台逐个执行，每个账户单独写审计。",
              "The job runs in the background, one audited change per account.",
            )}
          </p>
        </div>
      ),
      typeToConfirm: p.total > 20 ? String(p.total) : undefined,
      confirmLabel: tr("开始执行", "Start"),
    });
    if (!ok) return;
    const r = await run(() => post("/users/batch", { selection, action: a }), {
      ok: tr("批量任务已创建", "Batch job created"),
    });
    if (r !== undefined) onDone();
  };

  return (
    <Dialog
      open
      size="lg"
      icon={Layers}
      onClose={onClose}
      title={tr("批量操作", "Bulk action")}
      description={label}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy || previewing}>
            {tr("预览并确认", "Preview and confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={tr("操作", "Action")}>
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setErrors({});
            }}
          >
            {BATCH_KINDS.map((k) => (
              <option key={k} value={k}>
                {batchKindName(k, tr)}
              </option>
            ))}
          </Select>
        </Field>
        {kind === "extend_expiry" && (
          <Field
            label={tr("延长天数", "Days")}
            error={errors.days}
            hint={tr(
              "只延长周期套餐；一次性套餐与无套餐的账户会被跳过。",
              "Periodic subscriptions only; one-time and plan-less accounts are skipped.",
            )}
          >
            <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        )}
        {kind === "set_plan" && (
          <>
            <TermFields form={term} onChange={setTerm} plans={plans} />
            {errors.term && (
              <p role="alert" className="text-footnote text-destructive">
                {errors.term}
              </p>
            )}
          </>
        )}
        {(kind === "ban" || kind === "add_balance") && (
          <Field
            label={
              kind === "ban"
                ? tr("封禁原因（门户中对用户可见）", "Reason (shown to the users)")
                : tr("原因（写入每条明细）", "Reason (on every ledger row)")
            }
            error={errors.reason}
          >
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        )}
        {kind === "add_balance" && (
          <div className="flex flex-wrap items-start gap-3">
            <Field label={tr("方向", "Direction")} group>
              <Segmented
                value={credit}
                onChange={setCredit}
                options={[
                  { value: "credit", label: tr("增加", "Credit") },
                  { value: "debit", label: tr("扣减", "Debit") },
                ]}
              />
            </Field>
            <Field label={tr("每人金额（元）", "Amount each (yuan)")} className="min-w-40 flex-1" error={errors.amount}>
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
        )}
        {kind === "send_email" && (
          <>
            <Field label={tr("邮件标题", "Subject")} error={errors.subject}>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
            </Field>
            <Field
              label={tr("正文（纯文本，空行分段）", "Body (plain text)")}
              error={errors.body}
              hint={tr("只发给已验证的邮箱。", "Verified addresses only.")}
            >
              <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
            </Field>
          </>
        )}
        <FormError error={error} />
      </div>
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

export function jobStatus(s: string, tr: Tr): [string, Tone] {
  switch (s) {
    case "pending":
      return [tr("排队中", "Queued"), "info"];
    case "running":
      return [tr("执行中", "Running"), "info"];
    case "done":
      return [tr("已完成", "Done"), "success"];
    case "cancelled":
      return [tr("已取消", "Cancelled"), "neutral"];
    case "failed":
      return [tr("失败", "Failed"), "danger"];
    default:
      return [tr("未知", "Unknown"), "neutral"];
  }
}

function itemStatus(s: string, tr: Tr): [string, Tone] {
  switch (s) {
    case "pending":
      return [tr("待执行", "Pending"), "info"];
    case "done":
      return [tr("完成", "Done"), "success"];
    case "failed":
      return [tr("失败", "Failed"), "danger"];
    case "skipped":
      return [tr("跳过", "Skipped"), "neutral"];
    default:
      return [tr("未知", "Unknown"), "neutral"];
  }
}

/** Jobs shown before "show all" (the server keeps the latest 50). */
const FIRST = 10;

export function BatchJobs() {
  const tr = useTr();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const jobs = useQuery({
    queryKey: ["batch-jobs"],
    queryFn: () => get<Job[]>("/users/batch"),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => ACTIVE.includes(j.status)) ? 2000 : false),
  });
  // A job that finished (seen running before, or new and already done)
  // changed accounts: refresh the user list and the open detail.
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
  if (!jobs.data?.length) return null;
  const shown = all ? jobs.data : jobs.data.slice(0, FIRST);
  return (
    <Card>
      <CardHeader
        title={tr("批量任务", "Batch jobs")}
        description={
          shown.length < jobs.data.length
            ? tr(`最近 ${shown.length} 个，共 ${jobs.data.length} 个`, `Latest ${shown.length} of ${jobs.data.length}`)
            : tr(`最近 ${shown.length} 个`, `Latest ${shown.length}`)
        }
      />
      <ul className="divide-y divide-separator">
        {shown.map((j) => {
          const finished = j.done + j.failed + j.skipped;
          const [label, tone] = jobStatus(j.status, tr);
          return (
            <li key={j.id}>
              <button
                type="button"
                className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-left text-body hover:bg-accent focus-visible:bg-accent focus-visible:outline-none sm:px-5"
                onClick={() => setOpen(j.id)}
              >
                <span className="font-medium">{batchKindName(j.action, tr)}</span>
                <Badge tone={tone} dot>
                  {label}
                </Badge>
                <span className="text-footnote text-muted-foreground">{dateTime(j.created_at)}</span>
                <span className="tnum flex w-full items-center gap-2 text-footnote text-muted-foreground sm:ml-auto sm:w-auto">
                  <Meter value={j.total ? (finished / j.total) * 100 : 100} tone="primary" className="w-24 shrink-0" />
                  {tr(
                    `${finished}/${j.total} · 失败 ${j.failed} · 跳过 ${j.skipped}`,
                    `${finished}/${j.total} · ${j.failed} failed · ${j.skipped} skipped`,
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {jobs.data.length > FIRST && (
        <div className="border-t border-separator px-4 py-2 sm:px-5">
          <Button size="sm" variant="ghost" icon={ChevronDown} onClick={() => setAll(!all)}>
            {all ? tr("收起", "Show fewer") : tr(`显示全部 ${jobs.data.length} 个`, `Show all ${jobs.data.length}`)}
          </Button>
        </div>
      )}
      {open && <JobDialog id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function JobDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const errText = useErrText();
  const [run, busy] = useAction();
  const q = useQuery({
    queryKey: ["batch-jobs", id],
    queryFn: () => get<{ job: Job; items: Item[] }>(`/users/batch/${id}`),
    refetchInterval: (s) => (s.state.data && ACTIVE.includes(s.state.data.job.status) ? 2000 : false),
  });
  const job = q.data?.job;
  // Failed items carry the error code; skipped ones the server's reason (Chinese).
  const itemText = (it: Item) =>
    it.detail && it.status === "failed"
      ? errText(new ApiError(400, it.detail, { code: it.detail }))
      : (it.detail ?? "");
  const status = job ? jobStatus(job.status, tr) : null;
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={job ? batchKindName(job.action, tr) : tr("批量任务", "Batch job")}
      description={job && status && `${status[0]} · ${dateTime(job.created_at)} · ${job.actor_label}`}
      footer={
        <>
          {job && ACTIVE.includes(job.status) && (
            <Button
              variant="destructive-soft"
              className="mr-auto"
              loading={busy}
              onClick={() =>
                void run(() => post(`/users/batch/${id}/cancel`), {
                  ok: tr("已取消剩余的账户", "The rest is cancelled"),
                })
              }
            >
              {tr("取消任务", "Cancel job")}
            </Button>
          )}
          <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
        </>
      }
    >
      {q.isPending ? (
        <LoadingBlock rows={5} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} compact />
      ) : (
        job && (
          <div className="space-y-3 text-body">
            <p className="tnum">
              {tr(
                `共 ${job.total}，完成 ${job.done}，失败 ${job.failed}，跳过 ${job.skipped}`,
                `${job.total} total, ${job.done} done, ${job.failed} failed, ${job.skipped} skipped`,
              )}
            </p>
            <Meter
              value={job.total ? ((job.done + job.failed + job.skipped) / job.total) * 100 : 100}
              tone="primary"
              label={tr("进度", "Progress")}
            />
            {job.last_error && (
              <Callout
                tone="warning"
                title={tr("上一块执行出错，稍后自动重试", "The last chunk failed; it is retried")}
              >
                <details className="mt-1">
                  <summary className="cursor-default text-footnote text-muted-foreground">
                    {tr("错误详情", "Error details")}
                  </summary>
                  <p className="mt-1 font-mono text-caption break-words">{job.last_error}</p>
                </details>
              </Callout>
            )}
            <h3 className="text-footnote font-semibold text-muted-foreground">
              {tr("明细（失败与跳过在前，最多 500 条）", "Items (failed and skipped first, up to 500)")}
            </h3>
            {q.data.items.length === 0 ? (
              <p className="text-muted-foreground">{tr("没有明细。", "No items.")}</p>
            ) : (
              <ul className="divide-y divide-separator rounded-lg ring-1 ring-border ring-inset">
                {q.data.items.map((it) => {
                  const [label, tone] = itemStatus(it.status, tr);
                  return (
                    <li key={it.user_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                      <span className="min-w-0 font-medium break-all">{it.user_email ?? it.user_label}</span>
                      <Badge tone={tone}>{label}</Badge>
                      {itemText(it) && (
                        <span className="w-full text-footnote text-muted-foreground">{itemText(it)}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
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
          label: tr("将删除（含匿名化保留）", "Deleted (incl. kept anonymized)"),
          value: tr(`${p.deletable} 个`, String(p.deletable)),
        },
        {
          label: tr("匿名化保留（有财务记录）", "Kept anonymized (finance records)"),
          value: tr(`${p.anonymized} 个`, String(p.anonymized)),
        },
        ...(p.admins > 0
          ? [{ label: tr("管理员（不删除）", "Admins (kept)"), value: tr(`${p.admins} 个`, String(p.admins)) }]
          : []),
      ],
      details: (
        <div className="space-y-1 text-footnote text-muted-foreground">
          <p>{label}</p>
          {p.sample.length > 0 && (
            <p className="break-words">
              {tr("例如：", "For example: ")}
              {p.sample.join(", ")}
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
