// 运营工具（后台，仅中文）：用户批量操作（任务进度、可取消）、CSV 导出、
// 人工订单（赠送或线下收款，走唯一的付款路径）、批量生成优惠码。
// 金额：界面是元，提交前按文本换算为整数分（parseYuan）；人工订单不提交
// 金额（服务端按套餐该周期的价格计算）。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { Dialog } from "../components/dialog";
import { ErrorText } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { ApiError, apiBase, get, post, type PlanView, type UserPage } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { TERM_KINDS, termBody, termDays, termKindZh, type TermKind } from "../lib/admin-terms";
import {
  PERIOD_KINDS,
  parseYuan,
  periodKindZh,
  periodZh,
  sortPrices,
  yuan,
  type PeriodKind,
  type Prices,
} from "../lib/billing";
import { datetimeInputIso, fmtDateTime, TZ_LABEL } from "../lib/datetime";

const selectCls =
  "h-9 rounded-lg border border-border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/** The download URL of an export (`path` relative to /api/v1, e.g. "/users/export.csv"). */
export function exportHref(path: string, params: Record<string, string | undefined> = {}): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const qs = p.toString();
  return `${apiBase}${path}${qs ? `?${qs}` : ""}`;
}

/** A download link styled as a small outline button (the browser sends the session cookie). */
export function ExportLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      download
      className="inline-flex h-8 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Batch user actions
// ---------------------------------------------------------------------------

export type BatchKind =
  "extend_expiry" | "reset_traffic" | "ban" | "unban" | "set_plan" | "cancel_plan" | "add_balance" | "send_email";

export const BATCH_KINDS: { id: BatchKind; label: string }[] = [
  { id: "extend_expiry", label: "延长 N 天" },
  { id: "reset_traffic", label: "重置套餐流量" },
  { id: "ban", label: "封禁" },
  { id: "unban", label: "解除封禁" },
  { id: "set_plan", label: "分配 / 更换套餐" },
  { id: "cancel_plan", label: "取消套餐" },
  { id: "add_balance", label: "调整余额" },
  { id: "send_email", label: "发送邮件" },
];

export const BATCH_ZH: Record<BatchKind, string> = Object.fromEntries(
  BATCH_KINDS.map((k) => [k.id, k.label]),
) as Record<BatchKind, string>;

/** Which users a batch targets: explicit ids or the list's current filter. */
export type BatchSelection =
  { ids: string[] } | { filter: { q?: string; plan_id?: string; status?: string; role?: string } };

export interface BatchForm {
  kind: BatchKind;
  days: string;
  planId: string;
  term: TermKind;
  termDays: string;
  amount: string;
  credit: boolean;
  reason: string;
  subject: string;
  body: string;
}

export const EMPTY_BATCH: BatchForm = {
  kind: "extend_expiry",
  days: "30",
  planId: "",
  term: "month",
  termDays: "",
  amount: "",
  credit: true,
  reason: "",
  subject: "",
  body: "",
};

/** The request's `action` for the form, or a Chinese error. */
export function batchAction(f: BatchForm): Record<string, unknown> | string {
  switch (f.kind) {
    case "extend_expiry": {
      if (!/^\d{1,4}$/.test(f.days.trim())) return "天数须为 1–3650 的整数";
      const d = Number(f.days);
      if (d < 1 || d > 3650) return "天数须为 1–3650 的整数";
      return { kind: f.kind, days: d };
    }
    case "set_plan": {
      if (!f.planId) return "请选择套餐";
      const term = termBody(f.term, f.termDays);
      if (typeof term === "string") return term;
      return { kind: f.kind, plan_id: f.planId, ...term };
    }
    case "ban":
      if (!f.reason.trim()) return "请填写封禁原因（会显示给用户）";
      return { kind: f.kind, reason: f.reason.trim() };
    case "add_balance": {
      const cents = parseYuan(f.amount);
      if (cents == null || cents <= 0) return "金额无效（元，最多两位小数）";
      if (!f.reason.trim()) return "请填写原因";
      return { kind: f.kind, amount_cents: f.credit ? cents : -cents, reason: f.reason.trim() };
    }
    case "send_email":
      if (!f.subject.trim()) return "请填写邮件标题";
      if (!f.body.trim()) return "请填写邮件正文";
      return { kind: f.kind, subject: f.subject.trim(), body: f.body.trim() };
    default:
      return { kind: f.kind };
  }
}

/** One sentence describing the action, for the confirmation. */
export function batchSummary(a: Record<string, unknown>, plans: PlanView[]): string {
  const kind = a.kind as BatchKind;
  switch (kind) {
    case "extend_expiry":
      return `套餐到期时间延长 ${String(a.days)} 天（从当前到期时间与现在中较晚者算起；无套餐、一次性套餐、无到期时间的用户跳过）`;
    case "set_plan":
      return `分配套餐「${plans.find((p) => p.id === a.plan_id)?.name ?? "?"}」，时长 ${periodZh(
        a.period as PeriodKind,
        (a.days as number | undefined) ?? null,
      )}（替换现有套餐，已用流量清零）`;
    case "ban":
      return `封禁并立即踢下线，原因：${String(a.reason)}`;
    case "add_balance": {
      const c = a.amount_cents as number;
      return `${c > 0 ? "增加" : "扣减"}余额 ¥${yuan(Math.abs(c))}（每人一条明细，余额不足的扣减会失败）`;
    }
    case "send_email":
      return `发送邮件「${String(a.subject)}」（只发给已验证邮箱，按发送速率排队）`;
    default:
      return BATCH_ZH[kind];
  }
}

interface Preview {
  total: number;
  admins: number;
  sample: string[];
}

export interface BatchJob {
  id: string;
  actor_label: string;
  action: BatchKind;
  params: Record<string, unknown>;
  selection: "ids" | "filter";
  status: "pending" | "running" | "done" | "cancelled" | "failed";
  total: number;
  done: number;
  failed: number;
  skipped: number;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
}

interface BatchItem {
  user_id: string;
  user_label: string;
  user_email: string | null;
  status: "pending" | "done" | "failed" | "skipped";
  detail: string | null;
}

export const JOB_STATUS_ZH: Record<BatchJob["status"], string> = {
  pending: "排队中",
  running: "进行中",
  done: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

/**
 * The batch dialog: choose an action, preview how many users it targets,
 * confirm, create the job (it runs in the background; progress below).
 */
export function BatchDialog({
  selection,
  selectionLabel,
  plans,
  onClose,
  onCreated,
}: {
  selection: BatchSelection;
  selectionLabel: string;
  plans: PlanView[];
  onClose: () => void;
  onCreated: (job: BatchJob) => void;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [f, setF] = useState<BatchForm>({ ...EMPTY_BATCH, planId: plans.find((p) => p.enabled)?.id ?? "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ["batch-preview", selection],
    queryFn: () => post<Preview>("/users/batch/preview", { selection }),
  });
  const set = <K extends keyof BatchForm>(k: K, v: BatchForm[K]) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const action = batchAction(f);
    if (typeof action === "string") return setError(action);
    const p = preview.data;
    if (!p) return setError("正在统计目标用户，请稍候");
    const users = p.total - p.admins;
    if (users <= 0) return setError("没有可操作的用户（管理员账户会被跳过）");
    const ok = await confirm({
      title: `对 ${users} 个用户执行「${BATCH_ZH[f.kind]}」？`,
      message: `${batchSummary(action, plans)}。${p.admins > 0 ? `另有 ${p.admins} 个管理员账户会被跳过。` : ""}任务在后台逐批执行、每个用户单独记审计，可在下方查看进度或取消。`,
      confirmLabel: "开始执行",
      destructive: ["ban", "cancel_plan", "set_plan"].includes(f.kind) || (f.kind === "add_balance" && !f.credit),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const job = await post<BatchJob>("/users/batch", { selection, action });
      await queryClient.invalidateQueries({ queryKey: ["batch-jobs"] });
      onCreated(job);
    } catch (err) {
      setError(adminErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="批量操作" description={selectionLabel} onClose={onClose} className="sm:max-w-xl">
      <form className="space-y-4" onSubmit={submit} aria-label="批量操作">
        <p role="status" className="text-sm text-muted-foreground">
          {preview.isPending
            ? "正在统计…"
            : preview.isError
              ? adminErrorText(preview.error)
              : `将作用于 ${preview.data.total} 个账户${preview.data.admins ? `（其中 ${preview.data.admins} 个管理员会被跳过）` : ""}${
                  preview.data.sample.length
                    ? `：${preview.data.sample.join("、")}${preview.data.total > preview.data.sample.length ? " 等" : ""}`
                    : ""
                }`}
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="batch-kind">操作</Label>
          <select
            id="batch-kind"
            className={`${selectCls} w-full`}
            value={f.kind}
            onChange={(e) => set("kind", e.target.value as BatchKind)}
          >
            {BATCH_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </div>
        {f.kind === "extend_expiry" && (
          <div className="space-y-1.5">
            <Label htmlFor="batch-days">延长天数</Label>
            <Input id="batch-days" className="w-32" value={f.days} onChange={(e) => set("days", e.target.value)} />
          </div>
        )}
        {f.kind === "set_plan" && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="batch-plan">套餐</Label>
              <select
                id="batch-plan"
                className={selectCls}
                value={f.planId}
                onChange={(e) => set("planId", e.target.value)}
              >
                <option value="">请选择</option>
                {plans
                  .filter((p) => p.enabled)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="batch-term">时长</Label>
              <select
                id="batch-term"
                className={selectCls}
                value={f.term}
                onChange={(e) => set("term", e.target.value as TermKind)}
              >
                {TERM_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {termKindZh(k)}
                  </option>
                ))}
              </select>
            </div>
            {termDays(f.term) !== "none" && (
              <div className="space-y-1.5">
                <Label htmlFor="batch-term-days">天数{termDays(f.term) === "optional" ? "（可选）" : ""}</Label>
                <Input
                  id="batch-term-days"
                  className="w-28"
                  value={f.termDays}
                  onChange={(e) => set("termDays", e.target.value)}
                />
              </div>
            )}
          </div>
        )}
        {f.kind === "ban" && (
          <div className="space-y-1.5">
            <Label htmlFor="batch-ban-reason">封禁原因（门户中对用户可见）</Label>
            <Input
              id="batch-ban-reason"
              maxLength={500}
              value={f.reason}
              onChange={(e) => set("reason", e.target.value)}
            />
          </div>
        )}
        {f.kind === "add_balance" && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="batch-dir">方向</Label>
              <select
                id="batch-dir"
                className={selectCls}
                value={f.credit ? "credit" : "debit"}
                onChange={(e) => set("credit", e.target.value === "credit")}
              >
                <option value="credit">增加</option>
                <option value="debit">扣减</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="batch-amount">每人金额（元）</Label>
              <Input
                id="batch-amount"
                className="w-32"
                value={f.amount}
                onChange={(e) => set("amount", e.target.value)}
              />
            </div>
            <div className="min-w-48 flex-1 space-y-1.5">
              <Label htmlFor="batch-reason">原因（写入每条明细）</Label>
              <Input id="batch-reason" value={f.reason} onChange={(e) => set("reason", e.target.value)} />
            </div>
          </div>
        )}
        {f.kind === "send_email" && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="batch-subject">邮件标题</Label>
              <Input
                id="batch-subject"
                maxLength={120}
                value={f.subject}
                onChange={(e) => set("subject", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="batch-body">正文（纯文本，空行分段）</Label>
              <textarea
                id="batch-body"
                rows={6}
                maxLength={5000}
                className="w-full rounded-lg border border-border bg-card p-2 text-sm"
                value={f.body}
                onChange={(e) => set("body", e.target.value)}
              />
            </div>
          </div>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy || preview.isPending}>
            预览并执行
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const ITEM_ZH: Record<BatchItem["status"], string> = {
  pending: "待处理",
  done: "完成",
  failed: "失败",
  skipped: "跳过",
};

/** Recent batch jobs with progress (refreshes while one is open). */
export function BatchJobsCard() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: ["batch-jobs"],
    queryFn: () => get<BatchJob[]>("/users/batch"),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((j) => j.status === "pending" || j.status === "running") ? 2000 : false,
  });
  const detail = useQuery({
    queryKey: ["batch-jobs", open],
    queryFn: () => get<{ job: BatchJob; items: BatchItem[] }>(`/users/batch/${open}`),
    enabled: open != null,
  });
  const rows = jobs.data ?? [];
  if (rows.length === 0) return null;

  async function cancel(j: BatchJob) {
    if (
      !(await confirm({
        title: "取消这个批量任务？",
        message: "已处理的用户不会回滚；尚未处理的用户将被跳过。",
        confirmLabel: "取消任务",
        destructive: true,
      }))
    )
      return;
    setError(null);
    try {
      await post(`/users/batch/${j.id}/cancel`, {});
      await queryClient.invalidateQueries({ queryKey: ["batch-jobs"] });
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>批量任务</h2>
        </CardTitle>
        <CardDescription>后台逐批执行，中断后自动续跑，每个用户只处理一次。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ErrorText>{error}</ErrorText>
        <Table label="批量任务">
          <TableHeader>
            <TableRow>
              <TableHead>创建时间</TableHead>
              <TableHead>操作</TableHead>
              <TableHead>操作人</TableHead>
              <TableHead>进度</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((j) => {
              const handled = j.done + j.failed + j.skipped;
              const pct = j.total ? Math.round((handled * 100) / j.total) : 100;
              return (
                <TableRow key={j.id}>
                  <TableCell className="whitespace-nowrap">{fmtDateTime(j.created_at)}</TableCell>
                  <TableCell>{BATCH_ZH[j.action] ?? j.action}</TableCell>
                  <TableCell>{j.actor_label}</TableCell>
                  <TableCell className="min-w-48">
                    <div
                      role="progressbar"
                      aria-label="进度"
                      aria-valuemin={0}
                      aria-valuemax={j.total}
                      aria-valuenow={handled}
                      className="h-2 w-full overflow-hidden rounded bg-muted"
                    >
                      <div className="h-2 bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {handled}/{j.total}：成功 {j.done}，失败 {j.failed}，跳过 {j.skipped}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={j.status === "done" ? "success" : j.status === "running" ? "default" : "secondary"}>
                      {JOB_STATUS_ZH[j.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap text-right">
                    <Button size="sm" variant="outline" onClick={() => setOpen(open === j.id ? null : j.id)}>
                      {open === j.id ? "收起" : "明细"}
                    </Button>
                    {(j.status === "pending" || j.status === "running") && (
                      <Button size="sm" variant="ghost" onClick={() => void cancel(j)}>
                        取消
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {open && detail.data && (
          <section aria-label="任务明细" className="space-y-2">
            <h3 className="text-sm font-medium">任务明细（失败与跳过在前，最多 500 条）</h3>
            <ul className="max-h-64 space-y-0.5 overflow-auto text-sm">
              {detail.data.items.map((i) => (
                <li key={i.user_id}>
                  <span className="font-medium">{i.user_email ?? i.user_label}</span>：{ITEM_ZH[i.status]}
                  {i.detail && <span className="text-muted-foreground">（{adminDetail(i.detail)}）</span>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

/** An item's detail: an error code (mapped) or a Chinese reason. */
function adminDetail(d: string): string {
  if (/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(d)) {
    return adminErrorText(new ApiError(409, d, { code: d }));
  }
  return d;
}

// ---------------------------------------------------------------------------
// Manual orders
// ---------------------------------------------------------------------------

export interface ManualForm {
  userId: string;
  planId: string;
  period: string; // "<kind>" or "<kind>:<days>"
  gift: boolean;
  reason: string;
}

/** The POST /orders/manual body (never an amount), or a Chinese error. */
export function manualOrderBody(f: ManualForm): Record<string, unknown> | string {
  if (!f.userId) return "请先找到用户";
  if (!f.planId || !f.period) return "请选择套餐与周期";
  if (!f.reason.trim()) return "请填写原因";
  const [period] = f.period.split(":");
  return { user_id: f.userId, plan_id: f.planId, period, gift: f.gift, reason: f.reason.trim() };
}

export function ManualOrderDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const prices = useQuery({ queryKey: ["plan-prices"], queryFn: () => get<Prices>("/plan-prices") });
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<{ id: string; email: string } | null>(null);
  const [f, setF] = useState<ManualForm>({ userId: "", planId: "", period: "", gift: false, reason: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const plans = (prices.data?.plans ?? []).filter((p) => p.prices.length > 0);
  const plan = plans.find((p) => p.plan_id === f.planId);
  const price = plan ? sortPrices(plan.prices).find((x) => x.period === f.period.split(":")[0]) : undefined;

  async function lookup() {
    setError(null);
    setFound(null);
    try {
      const page = await get<UserPage>(`/users?q=${encodeURIComponent(email.trim())}&role=user&limit=5`);
      const exact = page.users.find((u) => u.email === email.trim().toLowerCase());
      if (!exact) return setError("没有找到这个用户（只支持普通用户的邮箱）");
      setFound({ id: exact.id, email: exact.email });
      setF((x) => ({ ...x, userId: exact.id }));
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = manualOrderBody(f);
    if (typeof body === "string") return setError(body);
    const cents = price?.price_cents ?? 0;
    const ok = await confirm({
      title: f.gift ? `赠送「${plan?.plan_name}」给 ${found?.email}？` : `为 ${found?.email} 记录一笔人工收款？`,
      message: f.gift
        ? `订单金额 ¥0（原价 ¥${yuan(cents)}，不计入营收），立即开通。`
        : `订单金额按当前价格 ¥${yuan(cents)} 计，标记为「人工」并计入营收，立即开通。请确认已线下收款。`,
      confirmLabel: f.gift ? "赠送" : "确认收款",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await post<{ id: string }>("/orders/manual", body);
      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      onCreated(r.id);
    } catch (err) {
      setError(adminErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="新建人工订单"
      description="赠送或记录线下收款。金额由服务端按套餐当前价格计算，经同一付款路径开通，并写审计。"
      onClose={onClose}
      className="sm:max-w-lg"
    >
      <form className="space-y-4" onSubmit={submit} aria-label="新建人工订单">
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="mo-email">用户邮箱</Label>
            <Input id="mo-email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button type="button" variant="outline" onClick={() => void lookup()} disabled={!email.trim()}>
            查找
          </Button>
        </div>
        {found && <p className="text-sm">用户：{found.email}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="mo-plan">套餐</Label>
            <select
              id="mo-plan"
              className={selectCls}
              value={f.planId}
              onChange={(e) => setF((x) => ({ ...x, planId: e.target.value, period: "" }))}
            >
              <option value="">请选择</option>
              {plans.map((p) => (
                <option key={p.plan_id} value={p.plan_id}>
                  {p.plan_name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mo-period">周期</Label>
            <select
              id="mo-period"
              className={selectCls}
              value={f.period}
              onChange={(e) => setF((x) => ({ ...x, period: e.target.value }))}
              disabled={!plan}
            >
              <option value="">请选择</option>
              {plan &&
                sortPrices(plan.prices).map((x) => (
                  <option key={x.period} value={x.period}>
                    {periodZh(x.period, x.days)} · ¥{yuan(x.price_cents)}
                  </option>
                ))}
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.gift} onChange={(e) => setF((x) => ({ ...x, gift: e.target.checked }))} />
          赠送（金额 ¥0，不计入营收）
        </label>
        <div className="space-y-1.5">
          <Label htmlFor="mo-reason">原因（必填，写入订单与审计）</Label>
          <Input
            id="mo-reason"
            maxLength={200}
            value={f.reason}
            onChange={(e) => setF((x) => ({ ...x, reason: e.target.value }))}
          />
        </div>
        {price && (
          <p className="text-sm text-muted-foreground">
            订单金额：¥{f.gift ? "0.00" : yuan(price.price_cents)}
            {f.gift && `（原价 ¥${yuan(price.price_cents)} 赠送）`}
          </p>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy}>
            创建并开通
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Batch coupons
// ---------------------------------------------------------------------------

export interface CouponBatch {
  id: string;
  name: string;
  prefix: string;
  count: number;
  template: {
    kind: "percent" | "fixed";
    value: number;
    max_uses: number | null;
    ends_at: string | null;
  };
  actor_label: string;
  created_at: string;
  revoked_at: string | null;
  codes: number;
  used: number;
  redeemed: number;
}

export interface CouponBatchForm {
  name: string;
  prefix: string;
  count: string;
  length: string;
  kind: "percent" | "fixed";
  value: string;
  min: string;
  periods: PeriodKind[];
  planIds: string[];
  starts: string;
  ends: string;
  maxUses: string;
  perUser: string;
  newOnly: boolean;
}

export const EMPTY_COUPON_BATCH: CouponBatchForm = {
  name: "",
  prefix: "",
  count: "100",
  length: "10",
  kind: "percent",
  value: "",
  min: "",
  periods: [],
  planIds: [],
  starts: "",
  ends: "",
  maxUses: "1",
  perUser: "",
  newOnly: false,
};

/** The POST /coupon-batches body, or a Chinese error. */
export function couponBatchBody(f: CouponBatchForm): Record<string, unknown> | string {
  if (!/^[A-Za-z0-9_-]{0,16}$/.test(f.prefix.trim())) return "前缀最多 16 个字符（字母、数字、- 或 _）";
  if (!/^\d{1,4}$/.test(f.count.trim()) || Number(f.count) < 1 || Number(f.count) > 5000) return "数量须为 1–5000";
  if (!/^\d{1,2}$/.test(f.length.trim()) || Number(f.length) < 6 || Number(f.length) > 16)
    return "随机部分长度须为 6–16";
  let value: number | null;
  if (f.kind === "percent") {
    value = /^\d{1,3}$/.test(f.value.trim()) ? Number(f.value) : null;
    if (value == null || value < 1 || value > 100) return "折扣百分比须为 1–100 的整数";
  } else {
    value = parseYuan(f.value);
    if (value == null) return "减免金额无效（元，最多两位小数）";
  }
  const min = f.min.trim() ? parseYuan(f.min) : 0;
  if (min == null) return "最低消费无效（元，最多两位小数）";
  for (const [label, s] of [
    ["每码次数", f.maxUses],
    ["每人次数", f.perUser],
  ] as const) {
    if (s.trim() && !/^[1-9]\d{0,8}$/.test(s.trim())) return `${label}须为正整数或留空（不限）`;
  }
  return {
    name: f.name.trim(),
    prefix: f.prefix.trim(),
    count: Number(f.count),
    length: Number(f.length),
    kind: f.kind,
    value,
    min_amount_cents: min,
    plan_ids: f.planIds.length ? f.planIds : null,
    periods: f.periods.length ? f.periods : null,
    starts_at: datetimeInputIso(f.starts),
    ends_at: datetimeInputIso(f.ends),
    max_uses: f.maxUses.trim() ? Number(f.maxUses) : null,
    per_user_limit: f.perUser.trim() ? Number(f.perUser) : null,
    new_users_only: f.newOnly,
  };
}

export function CouponBatchesCard() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const batches = useQuery({ queryKey: ["coupon-batches"], queryFn: () => get<CouponBatch[]>("/coupon-batches") });
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const [f, setF] = useState<CouponBatchForm>(EMPTY_COUPON_BATCH);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const set = <K extends keyof CouponBatchForm>(k: K, v: CouponBatchForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(null);
    setError(null);
    const body = couponBatchBody(f);
    if (typeof body === "string") return setError(body);
    try {
      const r = await post<{ id: string; count: number }>("/coupon-batches", body);
      setSaved(`已生成 ${r.count} 个优惠码，可在下表导出 CSV。`);
      setCreating(false);
      await queryClient.invalidateQueries({ queryKey: ["coupon-batches"] });
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function revoke(b: CouponBatch) {
    if (
      !(await confirm({
        title: `作废批次「${b.name || b.prefix || b.id.slice(0, 8)}」？`,
        message: `停用该批次的全部 ${b.codes} 个优惠码，之后不能再使用（已被待付款订单预占的不受影响）。此操作不能撤销。`,
        confirmLabel: "作废",
        destructive: true,
      }))
    )
      return;
    setListError(null);
    try {
      await post(`/coupon-batches/${b.id}/revoke`, {});
      await queryClient.invalidateQueries({ queryKey: ["coupon-batches"] });
    } catch (err) {
      setListError(adminErrorText(err));
    }
  }

  const rows = batches.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>优惠码批次</h2>
        </CardTitle>
        <CardDescription>
          按同一模板生成一批随机优惠码（不含易混淆的 0/O/1/I），每个码默认只能用一次。生成后导出 CSV
          发放；作废批次即停用全部码。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {creating && (
          <Dialog open title="批量生成优惠码" onClose={() => setCreating(false)} className="sm:max-w-3xl">
            <form className="space-y-3" onSubmit={submit} aria-label="批量生成优惠码">
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="cb-name">批次名称</Label>
                  <Input id="cb-name" className="w-40" value={f.name} onChange={(e) => set("name", e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-prefix">前缀（可选）</Label>
                  <Input
                    id="cb-prefix"
                    className="w-28"
                    value={f.prefix}
                    onChange={(e) => set("prefix", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-count">数量（1–5000）</Label>
                  <Input
                    id="cb-count"
                    className="w-24"
                    value={f.count}
                    onChange={(e) => set("count", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-length">随机长度（6–16）</Label>
                  <Input
                    id="cb-length"
                    className="w-20"
                    value={f.length}
                    onChange={(e) => set("length", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-kind">优惠类型</Label>
                  <select
                    id="cb-kind"
                    className={selectCls}
                    value={f.kind}
                    onChange={(e) => set("kind", e.target.value as "percent" | "fixed")}
                  >
                    <option value="percent">按比例减免（%）</option>
                    <option value="fixed">固定金额减免（元）</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-value">{f.kind === "percent" ? "减免百分比" : "减免金额（元）"}</Label>
                  <Input
                    id="cb-value"
                    className="w-24"
                    value={f.value}
                    onChange={(e) => set("value", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-min">最低消费（元）</Label>
                  <Input id="cb-min" className="w-24" value={f.min} onChange={(e) => set("min", e.target.value)} />
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="space-y-1">
                  <Label htmlFor="cb-starts">生效时间（{TZ_LABEL}）</Label>
                  <Input
                    id="cb-starts"
                    type="datetime-local"
                    value={f.starts}
                    onChange={(e) => set("starts", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-ends">失效时间（{TZ_LABEL}）</Label>
                  <Input
                    id="cb-ends"
                    type="datetime-local"
                    value={f.ends}
                    onChange={(e) => set("ends", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-max">每码次数（空 = 不限）</Label>
                  <Input
                    id="cb-max"
                    className="w-24"
                    value={f.maxUses}
                    onChange={(e) => set("maxUses", e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="cb-per">每人次数（空 = 不限）</Label>
                  <Input
                    id="cb-per"
                    className="w-24"
                    value={f.perUser}
                    onChange={(e) => set("perUser", e.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={f.newOnly} onChange={(e) => set("newOnly", e.target.checked)} />
                  仅限新用户
                </label>
              </div>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">适用套餐（都不选 = 全部）</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {(plans.data ?? []).map((p) => (
                    <label key={p.id} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={f.planIds.includes(p.id)}
                        onChange={() => set("planIds", toggle(f.planIds, p.id))}
                      />
                      {p.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="space-y-1">
                <legend className="text-sm font-medium">适用周期（都不选 = 全部）</legend>
                <div className="flex flex-wrap gap-3 text-sm">
                  {PERIOD_KINDS.map((k) => (
                    <label key={k} className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={f.periods.includes(k)}
                        onChange={() => set("periods", toggle(f.periods, k))}
                      />
                      {periodKindZh(k)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <ErrorText>{error}</ErrorText>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                  取消
                </Button>
                <Button type="submit">生成</Button>
              </div>
            </form>
          </Dialog>
        )}
        <Button onClick={() => setCreating(true)}>批量生成优惠码</Button>
        <ErrorText>{listError}</ErrorText>
        {saved && (
          <p role="status" className="text-sm text-emerald-700">
            {saved}
          </p>
        )}
        {rows.length > 0 && (
          <Table label="优惠码批次">
            <TableHeader>
              <TableRow>
                <TableHead>创建时间</TableHead>
                <TableHead>批次</TableHead>
                <TableHead>优惠</TableHead>
                <TableHead>码数</TableHead>
                <TableHead>已用 / 已兑现</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="whitespace-nowrap">{fmtDateTime(b.created_at)}</TableCell>
                  <TableCell>
                    {b.name || "—"}
                    {b.prefix && <span className="ml-1 font-mono text-xs text-muted-foreground">{b.prefix}…</span>}
                  </TableCell>
                  <TableCell>
                    {b.template.kind === "percent" ? `减 ${b.template.value}%` : `减 ¥${yuan(b.template.value)}`}
                    <span className="ml-1 text-xs text-muted-foreground">每码 {b.template.max_uses ?? "不限"} 次</span>
                  </TableCell>
                  <TableCell>{b.codes}</TableCell>
                  <TableCell>
                    {b.used} / {b.redeemed}
                  </TableCell>
                  <TableCell>
                    <Badge variant={b.revoked_at ? "secondary" : "default"}>{b.revoked_at ? "已作废" : "有效"}</Badge>
                  </TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap text-right">
                    <ExportLink href={exportHref(`/coupon-batches/${b.id}/export.csv`)}>导出 CSV</ExportLink>
                    {!b.revoked_at && (
                      <Button size="sm" variant="ghost" onClick={() => void revoke(b)}>
                        作废
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

// ---------------------------------------------------------------------------
// Orders export
// ---------------------------------------------------------------------------

/** Order export controls: UTC date range + status + manual only. */
export function OrdersExport() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("");
  const [via, setVia] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="导出订单">
      <div className="space-y-1">
        <Label htmlFor="ox-from">下单日期从（UTC）</Label>
        <Input id="ox-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ox-to">到</Label>
        <Input id="ox-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="ox-status">状态</Label>
        <select id="ox-status" className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部</option>
          <option value="paid">已付款</option>
          <option value="pending">待付款</option>
          <option value="expired">已过期</option>
          <option value="cancelled">已取消</option>
        </select>
      </div>
      <label className="flex h-9 items-center gap-1.5 text-sm">
        <input type="checkbox" checked={via === "manual"} onChange={(e) => setVia(e.target.checked ? "manual" : "")} />
        仅人工订单
      </label>
      <ExportLink href={exportHref("/orders/export.csv", { from, to, status, via })}>导出订单 CSV</ExportLink>
      <span className="text-xs text-muted-foreground">不填日期 = 最近 30 天；最长 366 天。</span>
    </div>
  );
}
