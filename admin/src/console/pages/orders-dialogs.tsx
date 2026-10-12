// New manual order (ORD-07, three steps: user → plan and term → confirm;
// the server prices it, nothing here can change the amount) and the CSV
// export (ORD-08: quick ranges, dates checked in place, server refusals
// shown in the dialog — never a JSON page).
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Download, FilePlus2, Gift, LoaderCircle, Search, UserRoundX } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { get, post, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { errorText } from "../../shared/errors";
import { dateOnly, daysBefore, siteTimeZone, siteToday, yuan } from "../../shared/format";
import { useLang, useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Select, Switch, Textarea } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { ErrorState, SkeletonRows } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { ChoiceChip } from "../components/inputs";
import { Avatar, FixCount, Stepper } from "../components/kit";
import { useDebounced } from "../kit";
import { periodLabel } from "../terms";
import type { PlanPrice } from "../types";
import { downloadFile } from "./download";
import { VIAS, viaText } from "./orders";
import { findUsers, type UserRow } from "./users";

type PriceRow = { plan_id: string; plan_name: string; plan_enabled: boolean; on_sale: boolean; prices: PlanPrice[] };

export function ManualOrderDialog({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const [step, setStep] = useState(0);
  const [term, setTerm] = useState("");
  const dq = useDebounced(term.trim(), 300);
  const [user, setUser] = useState<UserRow | null>(null);
  const found = useQuery({
    queryKey: ["users", "find", dq],
    queryFn: () => findUsers(dq),
    enabled: dq.length >= 2,
  });
  const prices = useQuery({ queryKey: ["plan-prices"], queryFn: () => get<{ plans: PriceRow[] }>("/plan-prices") });
  const [planId, setPlanId] = useState("");
  const [period, setPeriod] = useState("");
  const [gift, setGift] = useState(false);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const plans = (prices.data?.plans ?? []).filter((p) => p.plan_enabled && p.prices.length > 0);
  const plan = plans.find((p) => p.plan_id === planId);
  const price = plan?.prices.find((pp) => pp.period === period);
  const searching = dq.length >= 2 && (term.trim() !== dq || found.isFetching);
  const candidates = (found.data ?? []).filter((u) => u.role === "user" && !u.erased);
  const reasonErr = reason.trim() ? null : tr("请写明原因（会记入审计日志）", "Give a reason (it is audited)");
  const kind = !user || !plan ? "" : user.plan_id === plan.plan_id ? "renew" : user.plan_id ? "switch" : "new";
  const kindText = {
    "": "",
    renew: tr("续费", "renewal"),
    switch: tr("换套餐，按服务端规则折算", "switch, credited by the server's rules"),
    new: tr("新购", "new"),
  }[kind];
  const next = async () => {
    if (step === 0) {
      if (user) setStep(1);
      else setTried(true);
      return;
    }
    if (step === 1) {
      if (plan && price) setStep(2);
      return;
    }
    setTried(true);
    if (reasonErr || !user || !plan || !price) return;
    const r = await run(
      () => post("/orders/manual", { user_id: user.id, plan_id: plan.plan_id, period, gift, reason: reason.trim() }),
      { ok: tr("人工订单已创建并开通", "Manual order created and fulfilled") },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      icon={FilePlus2}
      title={tr("新建人工订单", "New manual order")}
      description={tr(
        "给用户直接开通套餐：线下收款、补偿或赠送",
        "Grant a plan directly: offline payment, compensation or a gift",
      )}
      tabs={
        <Stepper
          className="px-4 sm:px-5"
          steps={[tr("选择用户", "User"), tr("套餐与周期", "Plan and term"), tr("确认", "Confirm")]}
          current={step}
          onJump={(i) => {
            setTried(false);
            setStep(i);
          }}
        />
      }
      onSubmit={() => void next()}
      footer={
        <>
          {step > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                setTried(false);
                setStep(step - 1);
              }}
            >
              {tr("上一步", "Back")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {step === 2 && tried && reasonErr && <FixCount n={1} />}
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={(step === 0 && !user) || (step === 1 && !price)}
            >
              {step < 2
                ? tr("下一步", "Next")
                : gift
                  ? tr("赠送并开通", "Gift and fulfil")
                  : tr("创建订单并开通", "Create and fulfil")}
            </Button>
          </div>
        </>
      }
    >
      {step === 0 && (
        <div className="grid gap-3">
          <Field
            label={tr("用户邮箱", "User email")}
            hint={tr("输入邮箱开头至少 2 个字符", "Type at least 2 characters of the address")}
            error={tried && !user ? tr("请选择一个用户", "Choose a user") : undefined}
          >
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
                aria-hidden="true"
              />
              <Input
                data-autofocus
                value={term}
                onChange={(e) => {
                  setTerm(e.target.value);
                  setUser(null);
                }}
                placeholder="user@example.com"
                autoComplete="off"
                className="pl-8"
              />
              {searching && (
                <LoaderCircle
                  className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-faint"
                  aria-hidden="true"
                />
              )}
            </div>
          </Field>
          <div aria-live="polite">
            {searching ? (
              <p className="flex items-center gap-2 px-1 py-3 text-body text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                {tr(`正在查找「${term.trim()}」…`, `Looking for “${term.trim()}”…`)}
              </p>
            ) : found.isError ? (
              <ErrorState compact error={found.error} onRetry={() => void found.refetch()} />
            ) : dq.length >= 2 && candidates.length === 0 ? (
              <div className="flex items-start gap-3 rounded-xl bg-window p-3 ring-1 ring-border ring-inset">
                <UserRoundX className="mt-0.5 size-5 text-faint" aria-hidden="true" />
                <div className="text-body">
                  <div className="font-medium">
                    {tr(`没有邮箱以「${dq}」开头的用户`, `No user whose email starts with “${dq}”`)}
                  </div>
                  <div className="mt-0.5 text-footnote text-muted-foreground">
                    {tr(
                      "检查拼写；人工订单只能给已注册的用户开（管理员账户不能有套餐），可以先到 ",
                      "Check the spelling; only registered users (not admins) can get one. Create the user on the ",
                    )}
                    <Link to="/users?new=1" className="text-primary hover:underline">
                      {tr("用户", "Users")}
                    </Link>
                    {tr(" 页创建。", " page first.")}
                  </div>
                </div>
              </div>
            ) : (
              candidates.length > 0 && (
                <ul
                  role="listbox"
                  aria-label={tr("找到的用户", "Users found")}
                  className="divide-y divide-separator overflow-hidden rounded-xl ring-1 ring-border ring-inset"
                >
                  {candidates.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={u.id === user?.id}
                        onClick={() => setUser(u)}
                        className={cn(
                          "flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                          u.id === user?.id && "bg-primary-soft/60",
                        )}
                      >
                        <Avatar name={u.email} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body font-medium">{u.email}</span>
                          <span className="block truncate text-footnote text-muted-foreground">
                            {u.plan_name
                              ? `${u.plan_name} · ${
                                  u.expires_at
                                    ? tr(`到期 ${dateOnly(u.expires_at)}`, `expires ${dateOnly(u.expires_at)}`)
                                    : tr("到期 不限", "expires never")
                                }`
                              : tr("当前无套餐", "No plan")}
                            {tr(" · 余额 ", " · balance ")}
                            {yuan(u.balance_cents)}
                          </span>
                        </span>
                        {u.id === user?.id && <Badge tone="primary">{tr("已选", "Chosen")}</Badge>}
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        </div>
      )}

      {step === 1 && user && (
        <div className="grid gap-4">
          <div className="flex items-center gap-2.5 rounded-lg bg-window px-3 py-2 text-body ring-1 ring-border ring-inset">
            <Avatar name={user.email} size={22} />
            <span className="min-w-0 flex-1 truncate">{user.email}</span>
            <span className="text-footnote text-muted-foreground">{user.plan_name ?? tr("无套餐", "No plan")}</span>
          </div>
          {prices.isPending ? (
            <SkeletonRows rows={3} height={44} avatar={false} />
          ) : prices.isError ? (
            <ErrorState compact error={prices.error} onRetry={() => void prices.refetch()} />
          ) : plans.length === 0 ? (
            <p className="text-body text-muted-foreground">
              {tr("没有已定价的启用套餐。先到 ", "No enabled plan has prices. Set prices on the ")}
              <Link to="/plans" className="text-primary hover:underline">
                {tr("套餐", "Plans")}
              </Link>
              {tr(" 页定价。", " page first.")}
            </p>
          ) : (
            <Field group label={tr("套餐", "Plan")}>
              <div role="radiogroup" aria-label={tr("套餐", "Plan")} className="grid gap-2 sm:grid-cols-2">
                {plans.map((p) => (
                  <ChoiceChip
                    key={p.plan_id}
                    on={p.plan_id === planId}
                    onClick={() => {
                      setPlanId(p.plan_id);
                      setPeriod(p.prices[0]?.period ?? "");
                    }}
                    title={p.plan_name}
                    sub={
                      p.on_sale
                        ? tr("在售", "On sale")
                        : tr("未上架（人工订单不受限）", "Off sale (manual orders allowed)")
                    }
                  />
                ))}
              </div>
            </Field>
          )}
          {plan && (
            <Field group label={tr("周期", "Term")} hint={tr("只列出已定价的周期", "Only priced terms")}>
              <div role="radiogroup" aria-label={tr("周期", "Term")} className="flex flex-wrap gap-2">
                {plan.prices.map((pp) => (
                  <ChoiceChip
                    key={pp.period}
                    on={pp.period === period}
                    onClick={() => setPeriod(pp.period)}
                    title={periodLabel(pp.period, tr, pp.days)}
                    sub={yuan(pp.price_cents)}
                    className="min-w-24"
                  />
                ))}
              </div>
            </Field>
          )}
          {plan && price && (
            <div className="flex items-baseline justify-between gap-3 rounded-xl bg-primary-soft/60 px-4 py-3">
              <span className="text-body">
                {tr("预计成交价", "Expected price")}
                <span className="ml-1.5 text-footnote text-muted-foreground">{kindText}</span>
              </span>
              <span className="tnum text-title3 font-semibold" data-testid="manual-price">
                {yuan(price.price_cents)}
              </span>
            </div>
          )}
        </div>
      )}

      {step === 2 && user && plan && price && (
        <div className="grid gap-4">
          <div className="flex min-h-12 items-center gap-3 rounded-xl bg-window px-3 py-2 ring-1 ring-border ring-inset">
            <Gift className="size-5 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium">{tr("赠送", "Gift")}</span>
              <span className="block text-footnote text-muted-foreground">
                {tr("成交价记为 ¥0，不计入收入，订单标记「赠送」", "Recorded at ¥0, not revenue, marked “gift”")}
              </span>
            </span>
            <Switch checked={gift} onChange={setGift} label={tr("赠送", "Gift")} />
          </div>
          <Field
            label={tr("原因", "Reason")}
            required
            error={tried ? (reasonErr ?? undefined) : undefined}
            hint={
              gift
                ? tr("例如：推广合作赠送 1 个月", "e.g. a month for a partner")
                : tr("例如：微信转账 ¥128，已核对流水", "e.g. bank transfer, checked")
            }
          >
            <Textarea data-autofocus value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <div className="rounded-xl bg-window p-3.5 text-body leading-6 ring-1 ring-border ring-inset">
            {tr("将为 ", "Will ")}
            <b className="font-semibold">{user.email}</b>
            {kind === "renew" ? tr(" 续费 ", " renew ") : tr(" 开通 ", " get ")}
            <b className="font-semibold">
              {plan.plan_name} · {periodLabel(price.period, tr, price.days)}
            </b>
            {tr("，", ", ")}
            {gift ? (
              <>
                {tr("记为", "recorded as a ")}
                <b className="font-semibold text-primary">{tr("赠送", "gift")}</b>
                {tr("（¥0）", " (¥0)")}
              </>
            ) : (
              <>
                {tr("记为", "recorded as ")}
                <b className="font-semibold">
                  {tr("人工收款 ", "a manual payment of ")}
                  <span data-testid="manual-price">{yuan(price.price_cents)}</span>
                </b>
              </>
            )}
            {tr("，立即生效。", ", effective now.")}
            {reason.trim() && (
              <div className="mt-1 text-footnote text-muted-foreground">
                {tr("原因：", "Reason: ")}
                {reason.trim()}
              </div>
            )}
            <div className="mt-1 text-footnote text-faint">
              {tr(
                "金额由服务端按套餐价格计算（换套餐时扣减原套餐的剩余价值），这里不能改价。",
                "The server prices it (a switch credits the old plan's remainder); it cannot be changed here.",
              )}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

const MAX_EXPORT_DAYS = 366;

/** Whole days from `a` to `b` (YYYY-MM-DD). */
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const lang = useLang();
  const toast = useToast();
  const today = siteToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const lastMonthEnd = daysBefore(monthStart, 1);
  const quick: [string, string, string][] = [
    [tr("本月", "This month"), monthStart, today],
    [tr("上月", "Last month"), `${lastMonthEnd.slice(0, 8)}01`, lastMonthEnd],
    [tr("近 30 天", "Last 30 days"), daysBefore(today, 29), today],
    [tr("今年", "This year"), `${today.slice(0, 4)}-01-01`, today],
  ];
  const [from, setFrom] = useState(daysBefore(today, 29));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState("");
  const [via, setVia] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const span = from && to ? daysBetween(from, to) : 0;
  const fromErr = !from ? tr("请选择开始日期", "Choose the start") : null;
  const toErr = !to
    ? tr("请选择结束日期", "Choose the end")
    : from && span < 0
      ? tr("结束日期不能早于开始日期", "The end is before the start")
      : span + 1 > MAX_EXPORT_DAYS
        ? tr(`范围 ${span + 1} 天，最多 ${MAX_EXPORT_DAYS} 天`, `${span + 1} days; at most ${MAX_EXPORT_DAYS}`)
        : null;
  const errs = [fromErr, toErr].filter(Boolean).length;
  const download = async () => {
    if (errs || busy) return;
    setBusy(true);
    setError(null);
    const name = `akari-orders-${from}_${to}.csv`;
    try {
      await downloadFile(`/orders/export.csv${qs({ from, to, status, via })}`, name);
      toast({ tone: "success", title: tr(`已开始下载 ${name}`, `Downloading ${name}`) });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const set = (f: (v: string) => void) => (v: string) => {
    f(v);
    setError(null);
  };
  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      icon={Download}
      title={tr("导出订单 CSV", "Export orders (CSV)")}
      description={tr(
        `按站点时区（${siteTimeZone()}）的下单日期导出，导出会写入审计日志`,
        `By order day in the site time zone (${siteTimeZone()}); the export is audited`,
      )}
      onSubmit={() => void download()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <FixCount n={errs} />
            <Button type="submit" variant="primary" icon={Download} loading={busy} disabled={!!errs}>
              {tr("导出", "Export")}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid gap-4">
        {!!error && (
          <Banner tone="danger" icon={<CircleAlert />} title={tr("导出失败", "Export failed")}>
            {errorText(error, lang)}
          </Banner>
        )}
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr("快捷范围", "Quick ranges")}>
          {quick.map(([l, f, t]) => (
            <Button
              key={l}
              size="sm"
              variant={from === f && to === t ? "soft" : "secondary"}
              aria-pressed={from === f && to === t}
              onClick={() => {
                setFrom(f);
                setTo(t);
                setError(null);
              }}
            >
              {l}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr("开始", "From")} error={fromErr ?? undefined}>
            <Input type="date" value={from} onChange={(e) => set(setFrom)(e.target.value)} />
          </Field>
          <Field
            label={tr("结束", "To")}
            error={toErr ?? undefined}
            hint={!toErr && from ? tr(`共 ${span + 1} 天`, `${span + 1} days`) : undefined}
          >
            <Input type="date" value={to} onChange={(e) => set(setTo)(e.target.value)} />
          </Field>
        </div>
        <Field group label={tr("状态", "Status")}>
          <div className="max-w-full overflow-x-auto">
            <Segmented
              label={tr("状态", "Status")}
              value={status}
              onChange={set(setStatus)}
              options={[
                { value: "", label: tr("全部", "All") },
                { value: "paid", label: tr("已付款", "Paid") },
                { value: "pending", label: tr("待支付", "Pending") },
                { value: "expired", label: tr("已过期", "Expired") },
                { value: "cancelled", label: tr("已取消", "Cancelled") },
              ]}
            />
          </div>
        </Field>
        <Field label={tr("付款方式", "Paid via")}>
          <Select value={via} onChange={(e) => set(setVia)(e.target.value)}>
            <option value="">{tr("全部方式", "Any method")}</option>
            {VIAS.map((v) => (
              <option key={v} value={v}>
                {viaText(v, tr)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
