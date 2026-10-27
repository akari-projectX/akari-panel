// The user detail's sub-dialogs (v2 users-dialogs / users-create): change or
// assign a plan, ban, set a password, adjust the balance (also used by the
// finance page), send one mail, extend N days, and the new-user dialog.
// They stack over the detail; Esc closes only the topmost layer. Every write
// goes through the API client, so the list and the detail refetch by
// themselves (data.ts).
import { useQuery } from "@tanstack/react-query";
import {
  Ban,
  CircleAlert,
  KeyRound,
  Layers,
  Lock,
  Mail,
  Plus,
  ShieldCheck,
  UserPlus,
  UserRound,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { get, patch, post, put } from "../../shared/api";
import { bytes, dateOnly, parseYuan, siteToday, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Select, SwitchField, Textarea } from "../../shared/ui/form";
import { Popover } from "../../shared/ui/menu";
import { cn } from "../../shared/cn";
import { useAction } from "../data";
import { CopyButton, Mono } from "../kit";
import { useMe } from "../session";
import { periodLabel, resetLabel, TERMS } from "../terms";
import type { PlanView } from "../types";
import type { UserRow } from "../pages/users";
import { AffixInput, generatePassword, PasswordField, RadioCards } from "./inputs";
import { FixCount, ImpactList } from "./kit";

export type Subscription = {
  user_plan_id: string;
  plan_id: string;
  plan_name: string;
  period: string;
  period_days: number | null;
  starts_at: string;
  expires_at: string | null;
  traffic_used_bytes: number;
  traffic_total_bytes: number | null;
  reset_period: string;
  last_reset_at: string | null;
  next_reset_at: string | null;
  timezone: string;
  speed_limit_mbps: number | null;
  status: "active" | "expired" | "over_quota" | "banned";
};
type BanInfo = {
  reason: string | null;
  banned_at: string | null;
  banned_by_id: string | null;
  banned_by_email: string | null;
};
/** `GET /users/{id}`: the list row + the subscription and the ban. */
export type Detail = UserRow & {
  subscription: Subscription | null;
  ban: BanInfo | null;
  /** The inviter's current address (null = none or gone). */
  inviter_email?: string | null;
  /** The last site day with traffic (null = never). */
  last_traffic_day?: string | null;
};
export type Ledger = { balance_cents: number; withdrawable_cents: number; entries: unknown[] };

/** Absolute subscription URL (the server may answer a root-relative one). */
export function absoluteUrl(u: string): string {
  return u.startsWith("/") ? `${location.origin}${u}` : u;
}

// ---- dates -----------------------------------------------------------------

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `day` + n days (YYYY-MM-DD). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return ymd(d);
}

/** `day` + n calendar months, clamped to the month's end (as akari_period_end). */
function addMonths(day: string, n: number): string {
  const [y, m, dd] = day.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return ymd(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(dd, last))));
}

const MONTHS: Record<string, number> = {
  month: 1,
  quarter: 3,
  half_year: 6,
  year: 12,
  two_year: 24,
  three_year: 36,
};

/** End day of a term started on `from` (null = no expiry, undefined = unknown). */
function termEnd(from: string, period: string, days: number | null): string | null | undefined {
  if (MONTHS[period]) return addMonths(from, MONTHS[period]);
  if (period === "days") return days ? addDays(from, days) : undefined;
  if (period === "onetime") return days ? addDays(from, days) : null;
  return undefined;
}

/** Days text check: 1–3650 whole days (empty allowed where `optional`). */
function daysError(raw: string, tr: Tr, optional = false): string | null {
  const t = raw.trim();
  if (!t) return optional ? null : tr("请输入天数", "Enter the days");
  const n = Number(t);
  if (!/^\d{1,4}$/.test(t) || n < 1 || n > 3650) return tr("请输入 1–3650 的整数", "A whole number 1–3650");
  return null;
}

/** The terms offered for a plan: its priced periods (no reset pack), then custom days. */
function termOptions(p: PlanView | undefined): string[] {
  const priced = (p?.prices ?? []).map((x) => x.period).filter((x) => x !== "reset" && x !== "days");
  const list = TERMS.filter((t) => priced.includes(t));
  if (list.length === 0) list.push("month");
  return [...list, "days"];
}

function quotaText(b: number | null, tr: Tr): string {
  return b === null ? tr("不限流量", "unlimited") : bytes(b);
}

// ---- change / assign plan --------------------------------------------------

export function ChangePlanDialog({
  id,
  email,
  plans,
  current,
  onClose,
}: {
  id: string;
  email: string;
  plans: PlanView[];
  current: Subscription | null;
  onClose: () => void;
}) {
  const tr = useTr();
  const offered = plans.filter((p) => p.enabled || p.id === current?.plan_id);
  const firstOther = offered.find((p) => p.id !== current?.plan_id) ?? offered[0];
  const [planId, setPlanId] = useState(firstOther?.id ?? "");
  const plan = offered.find((p) => p.id === planId);
  const [period, setPeriod] = useState(termOptions(plan)[0]);
  const [days, setDays] = useState("30");
  const [run, busy] = useAction();
  const today = siteToday();
  const dErr = period === "days" ? daysError(days, tr) : period === "onetime" ? daysError(days, tr, true) : null;
  const n = [!planId ? "plan" : null, dErr].filter(Boolean).length;
  const end = dErr ? undefined : termEnd(today, period, days.trim() ? Number(days) : null);
  const left = current?.expires_at
    ? Math.max(0, Math.ceil((Date.parse(current.expires_at) - Date.now()) / 86_400_000))
    : null;
  const leftBytes =
    current && current.traffic_total_bytes !== null
      ? Math.max(0, current.traffic_total_bytes - current.traffic_used_bytes)
      : null;
  const submit = async () => {
    if (n || !plan) return;
    const body: Record<string, unknown> = { plan_id: plan.id, period };
    if ((period === "days" || period === "onetime") && days.trim()) body.days = Number(days);
    const r = await run(() => put(`/users/${id}/plan`, body), {
      ok: current ? tr("套餐已更换", "Plan changed") : tr("套餐已分配", "Plan assigned"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="lg"
      icon={Layers}
      onClose={onClose}
      title={current ? tr("更换套餐", "Change plan") : tr("分配套餐", "Assign a plan")}
      description={tr(
        `${email} · 不生成订单；需要收费请让用户在门户下单`,
        `${email} · no order is made; to charge, let the user order in the portal`,
      )}
      onSubmit={submit}
      footer={
        <>
          <FixCount n={n} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={n > 0}>
            {current ? tr("确认更换", "Change") : tr("确认分配", "Assign")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {offered.length === 0 ? (
          <p className="text-body text-muted-foreground">
            {tr("还没有可分配的套餐，请先在「套餐」页创建。", "No plan to assign yet; create one on the plans page.")}
          </p>
        ) : (
          <Field label={tr("套餐", "Plan")} group>
            <RadioCards
              cols={3}
              label={tr("套餐", "Plan")}
              value={planId}
              onChange={(v) => {
                setPlanId(v);
                setPeriod(termOptions(offered.find((p) => p.id === v))[0]);
              }}
              items={offered.map((p) => ({
                value: p.id,
                title: (
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{p.name}</span>
                    {p.id === current?.plan_id && (
                      <span className="shrink-0 rounded-full bg-secondary px-1.5 text-caption font-medium text-muted-foreground">
                        {tr("当前", "Current")}
                      </span>
                    )}
                  </span>
                ),
                desc: `${quotaText(p.traffic_quota_bytes, tr)} · ${resetLabel(p.period, tr)}${
                  p.speed_limit_mbps ? tr(` · 限速 ${p.speed_limit_mbps} Mbps`, ` · ${p.speed_limit_mbps} Mbps`) : ""
                }`,
              }))}
            />
          </Field>
        )}
        {plan && (
          <div className="grid gap-2">
            <Field label={tr("周期", "Term")} group>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  label={tr("周期", "Term")}
                  value={period}
                  onChange={setPeriod}
                  options={termOptions(plan).map((x) => ({
                    value: x,
                    label: x === "days" ? tr("自定义天数", "Custom days") : periodLabel(x, tr),
                  }))}
                />
              </div>
            </Field>
            {(period === "days" || period === "onetime") && (
              <Field
                label={
                  period === "onetime" ? tr("天数（留空 = 永久）", "Days (empty = no expiry)") : tr("天数", "Days")
                }
                error={dErr}
                className="max-w-48"
              >
                <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
              </Field>
            )}
          </div>
        )}
        {plan && (
          <div className="grid gap-3 rounded-xl bg-window p-3 ring-1 ring-border ring-inset sm:grid-cols-2">
            <div className="min-w-0">
              <div className="text-footnote text-muted-foreground">{tr("现在", "Now")}</div>
              <div className="truncate text-body font-medium">
                {current
                  ? `${current.plan_name} · ${periodLabel(current.period, tr, current.period_days)}`
                  : tr("无套餐", "No plan")}
              </div>
              <div className="tnum text-footnote text-muted-foreground">
                {current
                  ? `${tr(`已用 ${bytes(current.traffic_used_bytes)}`, `${bytes(current.traffic_used_bytes)} used`)} · ${
                      current.expires_at
                        ? tr(`${dateOnly(current.expires_at)} 到期`, `expires ${dateOnly(current.expires_at)}`)
                        : tr("不过期", "no expiry")
                    }`
                  : "—"}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-footnote text-muted-foreground">{tr("确认后", "After")}</div>
              <div className="truncate text-body font-medium text-primary">
                {plan.name} ·{" "}
                {period === "days"
                  ? tr(`${days.trim() || "?"} 天`, `${days.trim() || "?"} days`)
                  : periodLabel(period, tr, days.trim() ? Number(days) : null)}
              </div>
              <div className="tnum text-footnote text-muted-foreground">
                {end === undefined
                  ? tr(`${today} 开始`, `Starts ${today}`)
                  : end === null
                    ? tr(`${today} 开始，不过期`, `Starts ${today}, no expiry`)
                    : tr(`${today} 开始 → ${end} 到期`, `${today} → expires ${end}`)}
                {" · "}
                {tr(
                  `流量 0 / ${quotaText(plan.traffic_quota_bytes, tr)}`,
                  `traffic 0 / ${quotaText(plan.traffic_quota_bytes, tr)}`,
                )}
              </div>
            </div>
          </div>
        )}
        {current && (
          <p className="flex items-start gap-1.5 text-footnote text-warning">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {left !== null && leftBytes !== null
              ? tr(
                  `从现在开始重新计算：原套餐剩余的 ${left} 天和 ${bytes(leftBytes)} 流量不折算。`,
                  `Starts over now: the remaining ${left} days and ${bytes(leftBytes)} of the old plan are not credited.`,
                )
              : left !== null
                ? tr(
                    `从现在开始重新计算：原套餐剩余的 ${left} 天不折算。`,
                    `Starts over now: the remaining ${left} days of the old plan are not credited.`,
                  )
                : leftBytes !== null
                  ? tr(
                      `从现在开始重新计算：原套餐剩余的时间和 ${bytes(leftBytes)} 流量不折算。`,
                      `Starts over now: the remaining time and ${bytes(leftBytes)} of the old plan are not credited.`,
                    )
                  : tr(
                      "从现在开始重新计算：原套餐剩余的时间不折算。",
                      "Starts over now: the remaining time of the old plan is not credited.",
                    )}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ---- extend N days ---------------------------------------------------------

export function ExtendPopover({ id, sub }: { id: string; sub: Subscription }) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [n, setN] = useState("7");
  const [run, busy] = useAction();
  const err = daysError(n, tr);
  const today = siteToday();
  const base = sub.expires_at && dateOnly(sub.expires_at) > today ? dateOnly(sub.expires_at) : today;
  const go = async () => {
    if (err) return;
    const r = await run(() => patch(`/users/${id}/plan`, { extend_days: Number(n) }), {
      ok: tr(`已延长 ${n} 天`, `Extended by ${n} days`),
    });
    if (r !== undefined) setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      label={tr("延长到期日", "Extend the expiry")}
      className="w-72 p-3"
      trigger={
        <Button size="sm" variant="ghost" icon={Plus}>
          {tr("延长 N 天", "Extend N days")}
        </Button>
      }
    >
      <div className="grid gap-2" data-nodirty>
        <div className="text-body font-semibold">{tr("延长到期日", "Extend the expiry")}</div>
        <div className="flex gap-1.5">
          {["7", "30", "90"].map((d) => (
            <Button key={d} size="sm" variant={n === d ? "soft" : "secondary"} onClick={() => setN(d)}>
              {tr(`${d} 天`, `${d} d`)}
            </Button>
          ))}
        </div>
        <Field label={tr("延长天数", "Days")} error={err}>
          <Input
            inputMode="numeric"
            value={n}
            onChange={(e) => setN(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void go();
              }
            }}
          />
        </Field>
        {!err && (
          <p className="tnum text-footnote text-muted-foreground">
            {tr(`到期日 ${base} → ${addDays(base, Number(n))}`, `Expiry ${base} → ${addDays(base, Number(n))}`)}
          </p>
        )}
        <Button size="sm" variant="primary" disabled={!!err} loading={busy} onClick={() => void go()}>
          {tr("延长", "Extend")}
        </Button>
      </div>
    </Popover>
  );
}

// ---- ban -------------------------------------------------------------------

export function BanDialog({ id, email, onClose }: { id: string; email: string; onClose: () => void }) {
  const tr = useTr();
  const reasons = [
    {
      value: "abuse",
      title: tr("滥用", "Abuse"),
      desc: tr("大量 BT / 扫描 / 攻击流量", "BT, scanning or attack traffic"),
    },
    {
      value: "share",
      title: tr("共享账号", "Account sharing"),
      desc: tr("多人或转售使用同一账号", "Shared or resold"),
    },
    { value: "payment", title: tr("支付争议", "Payment dispute"), desc: tr("拒付、盗刷", "Chargeback, fraud") },
    { value: "tos", title: tr("违反服务条款", "Terms violation"), desc: tr("其他违规行为", "Other violations") },
    { value: "other", title: tr("其他", "Other"), desc: tr("必须填写说明", "A note is required") },
  ];
  const [reason, setReason] = useState("share");
  const [note, setNote] = useState("");
  const [run, busy] = useAction();
  const missing = reason === "other" && !note.trim();
  const title = reasons.find((r) => r.value === reason)!.title;
  const text = reason === "other" ? note.trim() : [title, note.trim()].filter(Boolean).join(tr("：", ": "));
  const submit = async () => {
    if (missing || !text) return;
    const r = await run(() => post(`/users/${id}/ban`, { reason: text.slice(0, 500) }), {
      ok: tr("已封禁，已踢下线", "Banned and signed out"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      tone="danger"
      icon={Ban}
      onClose={onClose}
      title={tr(`封禁 ${email}`, `Ban ${email}`)}
      description={tr("原因对用户可见：登录后会看到这句话。", "The reason is shown to the user after signing in.")}
      onSubmit={submit}
      footer={
        <>
          {missing && (
            <span role="status" className="text-footnote font-medium text-destructive">
              {tr("选了「其他」，请先写说明", "“Other” needs a note first")}
            </span>
          )}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="destructive" loading={busy} disabled={missing}>
            {tr("封禁并踢下线", "Ban and sign out")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={tr("原因", "Reason")} group required>
          <RadioCards cols={2} label={tr("原因", "Reason")} value={reason} onChange={setReason} items={reasons} />
        </Field>
        <Field
          label={reason === "other" ? tr("说明（必填）", "Note (required)") : tr("补充说明（可选）", "Note (optional)")}
          error={missing ? tr("请写明为什么封禁；用户会看到这段话", "Say why; the user sees this text") : undefined}
          hint={tr(`用户将看到：${text || "—"}`, `The user sees: ${text || "—"}`)}
        >
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={400}
            placeholder={tr("例如：工单 #2291 多次警告无效", "e.g. warned several times in ticket #2291")}
          />
        </Field>
        <ImpactList
          items={[
            { label: tr("登录会话与代理连接", "Sessions and proxy connections"), value: tr("立即断开", "Cut now") },
            { label: tr("订阅链接", "Subscription link"), value: tr("返回 404，直到解封", "404 until unbanned") },
            { label: tr("套餐与余额", "Plan and balance"), value: tr("保留，不退款", "Kept, no refund") },
            { label: tr("审计日志", "Audit log"), value: tr("记录原因与操作人", "Reason and admin recorded") },
          ]}
        />
      </div>
    </Dialog>
  );
}

// ---- password ----------------------------------------------------------------

export function PasswordDialog({ id, email, onClose }: { id: string; email: string; onClose: () => void }) {
  const tr = useTr();
  const [pw, setPw] = useState(generatePassword);
  const [run, busy] = useAction();
  const err =
    pw.length < 8
      ? tr(`密码至少 8 位（现在 ${pw.length} 位）`, `At least 8 characters (now ${pw.length})`)
      : pw.length > 128
        ? tr("最多 128 位", "At most 128 characters")
        : null;
  const submit = async () => {
    if (err) return;
    const r = await run(() => patch(`/users/${id}`, { password: pw }), {
      ok: tr("密码已修改，该账户的会话已结束", "Password set; the account's sessions ended"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="sm"
      icon={KeyRound}
      onClose={onClose}
      title={tr("设置新密码", "Set a new password")}
      description={tr(`${email} · 设置后该账户的全部会话立即结束`, `${email} · every session of the account ends`)}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!!err}>
            {tr("设置并踢下线", "Set and sign out")}
          </Button>
        </>
      }
    >
      <PasswordField label={tr("新密码", "New password")} value={pw} onChange={setPw} error={err} />
    </Dialog>
  );
}

// ---- balance -----------------------------------------------------------------

/**
 * Credit or debit a balance with a reason (shown to the user); previews the
 * resulting balance. `balanceCents` when the caller knows it, else it is read.
 */
export function AdjustBalanceDialog({
  id,
  email,
  balanceCents,
  onClose,
  onDone,
}: {
  id: string;
  email: string;
  balanceCents?: number;
  onClose: () => void;
  onDone?: () => void;
}) {
  const tr = useTr();
  const [dir, setDir] = useState<"credit" | "debit">("credit");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [run, busy] = useAction();
  const current = useQuery({
    queryKey: ["balance", id, "summary"],
    queryFn: () => get<Ledger>(`/users/${id}/balance?limit=1`),
    enabled: balanceCents === undefined,
  });
  const before = balanceCents ?? current.data?.balance_cents;
  const c = amount.trim() ? parseYuan(amount) : null;
  const signed = c === null ? null : dir === "credit" ? c : -c;
  const after = before !== undefined && signed !== null ? before + signed : null;
  const amountError = !amount.trim()
    ? touched
      ? tr("请填写金额", "Enter an amount")
      : null
    : c === null || c <= 0
      ? tr("请输入大于 0 的金额，最多两位小数", "An amount above 0, at most 2 decimals")
      : after !== null && after < 0
        ? tr(`扣减后余额不能为负（当前 ${yuan(before)}）`, `The balance cannot go below 0 (now ${yuan(before)})`)
        : null;
  const reasonError = touched && !reason.trim() ? tr("请填写原因", "Enter a reason") : null;
  const n = [amountError, reasonError].filter(Boolean).length;
  const submit = async () => {
    setTouched(true);
    if (
      n ||
      !amount.trim() ||
      !reason.trim() ||
      signed === null ||
      (after !== null && after < 0) ||
      c === null ||
      c <= 0
    )
      return;
    const r = await run(() => post(`/users/${id}/balance`, { amount_cents: signed, reason: reason.trim() }), {
      ok: tr("余额已调整", "Balance adjusted"),
    });
    if (r !== undefined) {
      onDone?.();
      onClose();
    }
  };
  return (
    <Dialog
      open
      size="sm"
      icon={Wallet}
      onClose={onClose}
      title={tr("人工调整余额", "Adjust balance")}
      description={email}
      onSubmit={submit}
      footer={
        <>
          <FixCount n={n} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={n > 0}>
            {tr("确认调整", "Adjust")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Segmented
          label={tr("调整方向", "Direction")}
          value={dir}
          onChange={setDir}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          options={[
            { value: "credit", label: tr("增加", "Credit") },
            { value: "debit", label: tr("扣减", "Debit") },
          ]}
        />
        <Field label={tr("金额（元）", "Amount (yuan)")} required error={amountError}>
          <AffixInput prefix="¥" value={amount} onChange={(e) => setAmount(e.target.value)} data-autofocus />
        </Field>
        <Field
          label={tr("原因（必填，写入审计）", "Reason (required, audited)")}
          error={reasonError}
          hint={tr("用户在余额明细里能看到", "The user sees it in the balance ledger")}
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
        <div className="flex items-center justify-between rounded-xl bg-window px-3 py-2.5 ring-1 ring-border ring-inset">
          <span className="text-body text-muted-foreground">{tr("调整后余额", "Balance after")}</span>
          <span className="tnum text-body">
            {before === undefined ? (
              current.error ? (
                tr("读取失败", "Unavailable")
              ) : (
                "…"
              )
            ) : (
              <>
                <span className="text-muted-foreground">{yuan(before)}</span>
                {" → "}
                <span
                  className={cn(
                    "text-headline font-semibold",
                    after === null || amountError ? "text-faint" : signed! < 0 ? "text-foreground" : "text-success",
                  )}
                >
                  {after === null || amountError ? "—" : yuan(after)}
                </span>
              </>
            )}
          </span>
        </div>
        <p className="text-footnote text-faint">
          {tr(
            "人工调整进入「余额」，不计入「可提现」。",
            "Adjustments go to the balance, not to the withdrawable part.",
          )}
        </p>
      </div>
    </Dialog>
  );
}

// ---- send one mail (a one-user batch job) -------------------------------------

export function SendMailDialog({ id, email, onClose }: { id: string; email: string; onClose: () => void }) {
  const tr = useTr();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [touched, setTouched] = useState(false);
  const [run, busy] = useAction();
  const sErr = touched && !subject.trim() ? tr("请填写邮件标题", "Enter the subject") : null;
  const bErr = touched && !body.trim() ? tr("请填写邮件正文", "Enter the body") : null;
  const n = [sErr, bErr].filter(Boolean).length;
  const submit = async () => {
    setTouched(true);
    if (!subject.trim() || !body.trim()) return;
    const r = await run(
      () =>
        post("/users/batch", {
          selection: { ids: [id] },
          action: { kind: "send_email", subject: subject.trim(), body: body.trim() },
        }),
      { ok: tr("邮件已加入发送队列", "Mail queued") },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      icon={Mail}
      onClose={onClose}
      title={tr("发送邮件", "Send mail")}
      description={tr(`${email} · 经发件箱发送，写入审计`, `${email} · sent through the outbox, audited`)}
      onSubmit={submit}
      footer={
        <>
          <FixCount n={n} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={n > 0}>
            {tr("发送", "Send")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={tr("标题", "Subject")} required error={sErr}>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} data-autofocus />
        </Field>
        <Field label={tr("正文（纯文本）", "Body (plain text)")} required error={bErr}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} className="min-h-40" />
        </Field>
      </div>
    </Dialog>
  );
}

// ---- new user ------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function CreateUserDialog({ plans, onClose }: { plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const me = useMe();
  const live = plans.filter((p) => p.enabled);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(generatePassword);
  const [role, setRole] = useState<"user" | "admin">("user");
  const [withPlan, setWithPlan] = useState(live.length > 0);
  const [planId, setPlanId] = useState(live[0]?.id ?? "");
  const plan = live.find((p) => p.id === planId);
  const [period, setPeriod] = useState(termOptions(plan)[0]);
  const [days, setDays] = useState("30");
  const [touched, setTouched] = useState({ email: false, submit: false });
  const [created, setCreated] = useState<{ email: string; sub_url: string | null } | null>(null);
  const [run, busy] = useAction();
  const planOn = role === "user" && withPlan;
  const errs = {
    email: !email.trim()
      ? tr("请填写邮箱", "Enter the email")
      : !EMAIL_RE.test(email.trim())
        ? tr("邮箱格式不正确，例如 name@example.com", "Not an email address, e.g. name@example.com")
        : null,
    password:
      password.length < 8
        ? tr(`密码至少 8 位（现在 ${password.length} 位）`, `At least 8 characters (now ${password.length})`)
        : password.length > 128
          ? tr("最多 128 位", "At most 128 characters")
          : null,
    plan: planOn && !plan ? tr("请选择套餐", "Choose a plan") : null,
    days: planOn && period === "days" ? daysError(days, tr) : null,
  };
  const n = Object.values(errs).filter(Boolean).length;
  const today = siteToday();
  const end =
    planOn && plan && !errs.days ? termEnd(today, period, period === "days" ? Number(days) : null) : undefined;
  const submit = async () => {
    setTouched({ email: true, submit: true });
    if (n) return;
    const body: Record<string, unknown> = { email: email.trim(), password, role };
    if (planOn && plan) body.plan = { plan_id: plan.id, period, ...(period === "days" ? { days: Number(days) } : {}) };
    const r = await run(() => post<{ email: string; sub_url: string | null }>("/users", body), {
      ok: tr("用户已创建", "User created"),
    });
    if (r) setCreated(r);
  };
  if (created)
    return (
      <Dialog
        open
        icon={UserPlus}
        onClose={onClose}
        title={tr("用户已创建", "User created")}
        description={created.email}
        footer={
          <Button variant="primary" onClick={onClose}>
            {tr("完成", "Done")}
          </Button>
        }
      >
        {created.sub_url ? (
          <div className="space-y-2">
            <p className="text-footnote text-muted-foreground">{tr("订阅链接", "Subscription link")}</p>
            <div className="flex items-start gap-2">
              <Mono>{absoluteUrl(created.sub_url)}</Mono>
              <CopyButton text={absoluteUrl(created.sub_url)} />
            </div>
          </div>
        ) : (
          <p className="text-body text-muted-foreground">
            {tr("之后可在用户详情里查看订阅链接。", "The subscription link is in the user's detail.")}
          </p>
        )}
      </Dialog>
    );
  return (
    <Dialog
      open
      icon={UserPlus}
      onClose={onClose}
      title={tr("新建用户", "New user")}
      description={tr(
        "管理员创建的邮箱视为已验证；不会发送欢迎邮件。",
        "Addresses created by an admin count as verified; no welcome mail is sent.",
      )}
      onSubmit={submit}
      footer={
        <>
          {touched.submit && <FixCount n={n} />}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={touched.submit && n > 0}>
            {tr("创建用户", "Create user")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={tr("邮箱", "Email")} required error={touched.email ? errs.email : undefined}>
          <Input
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => email && setTouched((t) => ({ ...t, email: true }))}
            data-autofocus
          />
        </Field>
        <PasswordField value={password} onChange={setPassword} error={touched.submit ? errs.password : undefined} />
        <Field label={tr("角色", "Role")} group>
          <RadioCards
            cols={2}
            label={tr("角色", "Role")}
            value={role}
            onChange={setRole}
            items={[
              {
                value: "user",
                title: tr("普通用户", "User"),
                desc: tr("可购买和使用套餐", "Buys and uses plans"),
                icon: <UserRound />,
              },
              {
                value: "admin",
                title: tr("管理员", "Admin"),
                desc: tr("可进入后台；不能持有套餐", "Console access; cannot hold a plan"),
                icon: me.is_owner ? <ShieldCheck /> : <Lock />,
                disabled: me.is_owner ? undefined : tr("只有所有者可以创建管理员", "Only the owner creates admins"),
              },
            ]}
          />
        </Field>
        {role === "user" && (
          <div className="rounded-xl bg-window p-3 ring-1 ring-border ring-inset">
            <SwitchField
              checked={withPlan}
              onChange={setWithPlan}
              disabled={live.length === 0}
              label={tr("同时分配套餐", "Assign a plan now")}
              description={
                live.length === 0
                  ? tr("还没有启用的套餐。", "No enabled plan yet.")
                  : tr("从现在开始计算周期，不生成订单", "Starts now; no order is made")
              }
            />
            {withPlan && live.length > 0 && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label={tr("套餐", "Plan")} error={touched.submit ? errs.plan : undefined}>
                  <Select
                    value={planId}
                    onChange={(e) => {
                      setPlanId(e.target.value);
                      setPeriod(termOptions(live.find((p) => p.id === e.target.value))[0]);
                    }}
                  >
                    {live.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {quotaText(p.traffic_quota_bytes, tr)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="flex min-w-0 gap-2">
                  <Field label={tr("周期", "Term")} className="min-w-0 flex-1">
                    <Select value={period} onChange={(e) => setPeriod(e.target.value)}>
                      {termOptions(plan).map((x) => (
                        <option key={x} value={x}>
                          {x === "days" ? tr("自定义天数", "Custom days") : periodLabel(x, tr)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {period === "days" && (
                    <Field label={tr("天数", "Days")} error={errs.days} className="w-24">
                      <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
                    </Field>
                  )}
                </div>
                {plan && end !== undefined && (
                  <p className="text-footnote text-muted-foreground sm:col-span-2">
                    {end === null
                      ? tr(`${today} 开始，不过期，`, `Starts ${today}, no expiry, `)
                      : tr(`${today} 开始 → `, `Starts ${today} → `)}
                    {end !== null && <span className="tnum font-medium text-foreground">{end}</span>}
                    {end !== null && tr(" 到期，", " expiry, ")}
                    {tr(
                      `${quotaText(plan.traffic_quota_bytes, tr)} 流量。`,
                      `${quotaText(plan.traffic_quota_bytes, tr)} traffic.`,
                    )}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
