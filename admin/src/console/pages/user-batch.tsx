// Bulk work on users (USR-24…27): the batch dialog (preview → confirm →
// background job), the job list with progress / details / cancel, and the
// D10 bulk delete (preview with a confirm token, typed confirmation).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, get, post } from "../../shared/api";
import { dateTime, parseYuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Dialog, Drawer, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Field,
  Input,
  Progress,
  Segmented,
  Select,
  Textarea,
} from "../../shared/ui/primitives";
import { FormError, useErrText, useRun } from "../kit";
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
type Kind = (typeof BATCH_KINDS)[number];

export function batchKindName(k: string, tr: Tr): string {
  switch (k) {
    case "extend_expiry":
      return tr("延长 N 天", "Extend N days");
    case "reset_traffic":
      return tr("重置套餐流量", "Reset plan traffic");
    case "ban":
      return tr("封禁", "Ban");
    case "unban":
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
      return k;
  }
}

export function BatchDialog({
  selection,
  label,
  plans,
  onClose,
  onDone,
}: {
  selection: Selection;
  label: string;
  plans: PlanView[];
  onClose: () => void;
  onDone: () => void;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run, busy] = useRun();
  const [kind, setKind] = useState<Kind>("extend_expiry");
  const [days, setDays] = useState("30");
  const [term, setTerm] = useState<TermForm>(EMPTY_TERM);
  const [amount, setAmount] = useState("");
  const [credit, setCredit] = useState<"credit" | "debit">("credit");
  const [reason, setReason] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<unknown>(null);

  const action = (): Record<string, unknown> | string => {
    switch (kind) {
      case "extend_expiry": {
        const n = Number(days);
        if (!/^\d{1,4}$/.test(days.trim()) || n < 1 || n > 3650)
          return tr("天数须为 1–3650 的整数", "Days must be 1–3650");
        return { kind, days: n };
      }
      case "set_plan": {
        const b = termBody(term, tr);
        return typeof b === "string" ? b : { kind, ...b };
      }
      case "ban":
        return reason.trim()
          ? { kind, reason: reason.trim() }
          : tr("请填写封禁原因（会显示给用户）", "Enter the reason (shown to the users)");
      case "add_balance": {
        const c = parseYuan(amount);
        if (c === null || c <= 0) return tr("金额无效（元，最多两位小数）", "Invalid amount (yuan, 2 decimals)");
        if (!reason.trim()) return tr("请填写原因", "Enter a reason");
        return { kind, amount_cents: credit === "credit" ? c : -c, reason: reason.trim() };
      }
      case "send_email":
        if (!subject.trim()) return tr("请填写邮件标题", "Enter the subject");
        if (!body.trim()) return tr("请填写邮件正文", "Enter the body");
        return { kind, subject: subject.trim(), body: body.trim() };
      default:
        return { kind };
    }
  };

  const submit = async () => {
    const a = action();
    if (typeof a === "string") return setError(new Error(a));
    setError(null);
    let p: Preview;
    try {
      p = await post<Preview>("/users/batch/preview", { selection });
    } catch (e) {
      return setError(e);
    }
    const ok = await confirm({
      title: tr(
        `对 ${p.total} 个账户执行「${batchKindName(kind, tr)}」？`,
        `Run "${batchKindName(kind, tr)}" on ${p.total} accounts?`,
      ),
      tone: kind === "ban" || kind === "cancel_plan" ? "danger" : "warning",
      impact: tr(`影响 ${p.total - p.admins} 个账户`, `${p.total - p.admins} accounts affected`),
      details: (
        <div className="space-y-2 text-[13px] text-muted-foreground">
          {p.admins > 0 && (
            <p>{tr(`其中 ${p.admins} 个管理员账户会被跳过。`, `${p.admins} admin accounts are skipped.`)}</p>
          )}
          {p.sample.length > 0 && (
            <p>
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
      invalidate: [["batch-jobs"], ["users"]],
    });
    if (r !== undefined) onDone();
  };

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={tr("批量操作", "Bulk action")}
      description={label}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("预览并确认", "Preview and confirm")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={tr("操作", "Action")}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
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
            hint={tr(
              "只延长周期套餐；一次性套餐与无套餐的账户会被跳过。",
              "Periodic subscriptions only; one-time and plan-less accounts are skipped.",
            )}
          >
            <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        )}
        {kind === "set_plan" && <TermFields form={term} onChange={setTerm} plans={plans} />}
        {(kind === "ban" || kind === "add_balance") && (
          <Field
            label={
              kind === "ban"
                ? tr("封禁原因（门户中对用户可见）", "Reason (shown to the users)")
                : tr("原因（写入每条明细）", "Reason (on every ledger row)")
            }
          >
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
        )}
        {kind === "add_balance" && (
          <div className="flex flex-wrap items-end gap-3">
            <Segmented
              value={credit}
              onChange={setCredit}
              options={[
                { value: "credit", label: tr("增加", "Credit") },
                { value: "debit", label: tr("扣减", "Debit") },
              ]}
            />
            <Field label={tr("每人金额（元）", "Amount each (yuan)")} className="flex-1">
              <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
        )}
        {kind === "send_email" && (
          <>
            <Field label={tr("邮件标题", "Subject")}>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
            </Field>
            <Field
              label={tr("正文（纯文本，空行分段）", "Body (plain text)")}
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

function jobTone(s: string) {
  return s === "done" ? "success" : s === "failed" ? "danger" : s === "cancelled" ? "neutral" : "info";
}

export function BatchJobs() {
  const tr = useTr();
  const [open, setOpen] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: ["batch-jobs"],
    queryFn: () => get<Job[]>("/users/batch"),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((j) => j.status === "pending" || j.status === "running") ? 2000 : false,
  });
  if (!jobs.data?.length) return null;
  return (
    <Card>
      <CardHeader title={tr("批量任务", "Batch jobs")} description={tr("最近 50 个", "The latest 50")} />
      <ul className="divide-y divide-border">
        {jobs.data.slice(0, 10).map((j) => {
          const finished = j.done + j.failed + j.skipped;
          return (
            <li key={j.id}>
              <button
                type="button"
                className="flex w-full flex-wrap items-center gap-3 px-4 py-2.5 text-left text-[13px] hover:bg-subtle sm:px-5"
                onClick={() => setOpen(j.id)}
              >
                <span className="font-medium">{batchKindName(j.action, tr)}</span>
                <Badge tone={jobTone(j.status)}>{j.status}</Badge>
                <span className="text-xs text-muted-foreground">{dateTime(j.created_at)}</span>
                <span className="ml-auto flex min-w-48 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                  <Progress value={j.total ? (finished / j.total) * 100 : 100} className="w-24" />
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
      {open && <JobDrawer id={open} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function JobDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const errText = useErrText();
  const [run, busy] = useRun();
  const q = useQuery({
    queryKey: ["batch-jobs", id],
    queryFn: () => get<{ job: Job; items: Item[] }>(`/users/batch/${id}`),
    refetchInterval: (s) => (s.state.data && ["pending", "running"].includes(s.state.data.job.status) ? 2000 : false),
  });
  const job = q.data?.job;
  // Failed items carry the error code; skipped ones the server's reason.
  const itemText = (it: Item) =>
    it.detail && it.status === "failed"
      ? errText(new ApiError(400, it.detail, { code: it.detail }))
      : (it.detail ?? "");
  return (
    <Drawer
      open
      onClose={onClose}
      title={job ? batchKindName(job.action, tr) : tr("批量任务", "Batch job")}
      subtitle={job && `${job.status} · ${dateTime(job.created_at)} · ${job.actor_label}`}
      footer={
        job && ["pending", "running"].includes(job.status) ? (
          <Button
            variant="destructive-soft"
            loading={busy}
            onClick={() =>
              void run(() => post(`/users/batch/${id}/cancel`), {
                ok: tr("已取消剩余的账户", "The rest is cancelled"),
                invalidate: [["batch-jobs"]],
              })
            }
          >
            {tr("取消任务", "Cancel job")}
          </Button>
        ) : undefined
      }
    >
      {job && (
        <div className="space-y-3 text-[13px]">
          <p>
            {tr(
              `共 ${job.total}，完成 ${job.done}，失败 ${job.failed}，跳过 ${job.skipped}`,
              `${job.total} total, ${job.done} done, ${job.failed} failed, ${job.skipped} skipped`,
            )}
          </p>
          {job.last_error && <Callout tone="danger">{job.last_error}</Callout>}
          <h3 className="text-xs font-semibold text-muted-foreground">
            {tr("明细（失败与跳过在前，最多 500 条）", "Items (failed and skipped first, up to 500)")}
          </h3>
          <ul className="divide-y divide-border rounded-md border border-border">
            {q.data?.items.map((it) => (
              <li key={it.user_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-medium">{it.user_email ?? it.user_label}</span>
                <Badge tone={it.status === "done" ? "success" : it.status === "failed" ? "danger" : "neutral"}>
                  {it.status}
                </Badge>
                <span className="w-full text-xs text-muted-foreground">{itemText(it)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Drawer>
  );
}

type DeletePreview = Preview & { deletable: number; anonymized: number; confirm_token: string };

export function BulkDeleteDialog({
  selection,
  label,
  onClose,
  onDone,
}: {
  selection: Selection;
  label: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const [run, busy] = useRun();
  const [typed, setTyped] = useState("");
  const p = useQuery({
    queryKey: ["delete-preview", selection],
    queryFn: () => post<DeletePreview>("/users/delete/preview", { selection }),
    gcTime: 0,
  });
  const phrase = p.data ? tr(`删除 ${p.data.deletable} 个账户`, `delete ${p.data.deletable} accounts`) : "";
  const submit = async () => {
    if (!p.data || typed.trim() !== phrase) return;
    const r = await run(
      () =>
        post<{ deleted: number; anonymized: number; failed: number }>("/users/delete", {
          selection,
          confirm_token: p.data.confirm_token,
        }),
      { invalidate: [["users"], ["dashboard"]] },
    );
    if (r) toast({ tone: r.failed ? "error" : "success", title: deletedText(r, tr) });
    if (r) onDone();
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      tone="danger"
      icon="trash"
      title={tr("批量删除账户", "Delete accounts")}
      description={label}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            type="submit"
            variant="destructive"
            disabled={!p.data || p.data.deletable === 0 || typed.trim() !== phrase}
            loading={busy}
          >
            {tr("永久删除", "Delete for good")}
          </Button>
        </>
      }
    >
      {p.isPending && <p className="text-[13px] text-muted-foreground">{tr("正在计算影响…", "Counting…")}</p>}
      <FormError error={p.error} />
      {p.data && (
        <div className="space-y-3 text-[13px]">
          <div className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm font-medium text-destructive">
            {tr(`将永久删除 ${p.data.deletable} 个账户`, `${p.data.deletable} accounts will be deleted for good`)}
          </div>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>
              {tr(
                "删除方式与用户自助注销相同：个人数据删除；有财务记录的账户匿名化保留。",
                "Same as a self-deletion: personal data is deleted; accounts with finance records are kept anonymized.",
              )}
            </li>
            {p.data.anonymized > 0 && (
              <li>
                {tr(
                  `其中 ${p.data.anonymized} 个有财务记录，将匿名化保留。`,
                  `${p.data.anonymized} have finance records and are kept anonymized.`,
                )}
              </li>
            )}
            {p.data.admins > 0 && (
              <li>
                {tr(`${p.data.admins} 个管理员账户不会被删除。`, `${p.data.admins} admin accounts are never deleted.`)}
              </li>
            )}
            {p.data.sample.length > 0 && (
              <li>
                {tr("例如：", "For example: ")}
                {p.data.sample.join(", ")}
              </li>
            )}
            <li>{tr("每个账户单独写审计。", "Each account is audited.")}</li>
          </ul>
          <label className="block space-y-1.5">
            <span className="text-muted-foreground">
              {tr("二次确认：请输入", "Second confirmation: type")}{" "}
              <code className="rounded bg-muted px-1 font-mono text-foreground">{phrase}</code>
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label={tr("确认文字", "Confirmation text")}
            />
          </label>
        </div>
      )}
    </Dialog>
  );
}

/** Body text for a finished bulk delete (used by the toast). */
export function deletedText(r: { deleted: number; anonymized: number; failed: number }, tr: Tr): string {
  return tr(
    `已删除 ${r.deleted}，匿名化 ${r.anonymized}，失败 ${r.failed}`,
    `${r.deleted} deleted, ${r.anonymized} anonymized, ${r.failed} failed`,
  );
}
