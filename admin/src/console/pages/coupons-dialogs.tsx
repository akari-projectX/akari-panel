// Coupon dialogs (CPN-02..05, v2 §3): new coupon (lg, form left, sticky
// ticket preview right), coupon detail (lg, tabs 使用情况 / 设置; footer
// delete · disable/enable · save), the code-batch generator (md) and the
// row actions shared by the list and the detail (disable/enable = small
// confirm, delete / void a batch = danger confirm with the impact and the
// name typed). Numbers stay raw strings and are checked with numErr: "abc",
// "0" or "30元" are field errors, never "unlimited".
import { useQuery } from "@tanstack/react-query";
import { Dices, Layers3, Lock, Power, PowerOff, Ticket, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { del, get, patch, post } from "../../shared/api";
import { dateOnly, dateTime, endOfDay, fromLocalInput, siteToday, yuan } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Switch } from "../../shared/ui/form";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import {
  CouponTicket,
  MAX_LIMIT,
  MAX_PRICE_YUAN,
  MultiChips,
  batchLabel,
  daysBetween,
  discountLabel,
  mdOf,
  randomCode,
  ruleParts,
  windowText,
  type Batch,
  type Coupon,
  type Redemption,
} from "../components/commerce-coupons";
import { AffixInput, numErr } from "../components/inputs";
import { Avatar, FixCount, StatStrip } from "../components/kit";
import { CouponStatus, couponState } from "../components/status";
import { useQS } from "../router";
import { useCrumb } from "../session";
import { PERIODS, periodLabel } from "../terms";
import type { PlanView } from "../types";

const num = (n: number) => n.toLocaleString("en");
const CODE_RE = /^[A-Z0-9_-]{3,32}$/;
const PREFIX_RE = /^[A-Z0-9_-]{0,16}$/;
const yuanToCents = (s: string) => Math.round(Number(s.trim()) * 100);

/* ---------- Row actions ---------- */

export function useCouponActions() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const toggle = async (c: Coupon) => {
    const off = c.enabled;
    const ok = await confirm({
      title: off ? tr(`停用 ${c.code}？`, `Disable ${c.code}?`) : tr(`启用 ${c.code}？`, `Enable ${c.code}?`),
      description: off
        ? tr(
            "停用后用户输入这个代码会提示「优惠券不可用」；已经用它下的订单不受影响。随时可以再启用。",
            "Users entering it are told it is unavailable; orders already placed stay. You can enable it again.",
          )
        : couponState({ ...c, enabled: true }) === "live"
          ? tr("启用后用户立即可以使用。", "Users can apply it right away.")
          : tr("启用后，到开始日期或在有效期内用户才能使用。", "Users can apply it once it is in its window."),
      impact: tr(
        `已用 ${num(c.used)} 次 · 近 7 天 +${c.redeemed_7d}`,
        `${num(c.used)} uses · +${c.redeemed_7d} in 7 days`,
      ),
      tone: off ? "warning" : "default",
      confirmLabel: off ? tr("停用", "Disable") : tr("启用", "Enable"),
      action: () => patch(`/coupons/${c.id}`, { enabled: !off }),
    });
    if (ok) toast({ tone: "success", title: off ? tr("已停用", "Disabled") : tr("已启用", "Enabled") });
    return ok;
  };
  const remove = async (c: Coupon) => {
    const ok = await confirm({
      title: tr(`删除优惠券 ${c.code}？`, `Delete the coupon ${c.code}?`),
      description: tr(
        "删除后用户再输入这个代码会提示无效。只有从未被使用过的优惠券可以删除。不能撤销。",
        "Users entering it are told it is invalid. Only never-used coupons can be deleted. This cannot be undone.",
      ),
      impacts: [
        { label: tr("已使用次数", "Uses"), value: num(c.used) },
        { label: tr("状态", "Status"), value: <CouponStatus state={couponState(c)} /> },
      ],
      typeToConfirm: c.code,
      confirmLabel: tr("删除优惠券", "Delete coupon"),
      action: () => del(`/coupons/${c.id}`),
    });
    if (ok) toast({ tone: "success", title: tr(`已删除 ${c.code}`, `Deleted ${c.code}`) });
    return ok;
  };
  return { toggle, remove };
}

export function useBatchActions() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const revoke = async (b: Batch) => {
    const label = batchLabel(b, tr);
    const ok = await confirm({
      title: tr(`作废批次「${label}」？`, `Void the batch "${label}"?`),
      description: tr(
        "整批码立即停用，用户不能再使用；已经下的订单不受影响。不能撤销。",
        "Every code stops working now; orders already placed stay. This cannot be undone.",
      ),
      impacts: [
        {
          label: tr("立即失效", "Stop working"),
          value: tr(`${num(b.codes - b.codes_used)} 个`, num(b.codes - b.codes_used)),
        },
        {
          label: tr("已使用（不受影响）", "Used (unaffected)"),
          value: tr(`${num(b.codes_used)} 个`, num(b.codes_used)),
        },
      ],
      typeToConfirm: label,
      confirmLabel: tr("作废整批", "Void batch"),
      action: () => post(`/coupon-batches/${b.id}/revoke`),
    });
    if (ok) toast({ tone: "success", title: tr("已作废", "Voided") });
    return ok;
  };
  return { revoke };
}

/* ---------- Small pieces ---------- */

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex min-h-11 items-center gap-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium">{label}</span>
        {hint && <span className="block text-footnote text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function KindValue({
  kind,
  value,
  error,
  onKind,
  onValue,
}: {
  kind: "percent" | "fixed";
  value: string;
  error?: string;
  onKind: (k: "percent" | "fixed") => void;
  onValue: (v: string) => void;
}) {
  const tr = useTr();
  const v = error ? null : kind === "percent" ? Number(value) : yuanToCents(value);
  return (
    <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
      <Field group label={tr("优惠方式", "Kind")}>
        <Segmented
          label={tr("优惠方式", "Kind")}
          value={kind}
          onChange={onKind}
          options={[
            { value: "percent", label: tr("按比例", "Percent") },
            { value: "fixed", label: tr("固定金额", "Fixed") },
          ]}
        />
      </Field>
      <Field
        label={kind === "percent" ? tr("减免比例", "Percent off") : tr("减免金额", "Amount off")}
        required
        error={error}
        hint={v != null ? `= ${discountLabel(kind, v, tr)}` : undefined}
      >
        <AffixInput
          prefix={kind === "fixed" ? "¥" : undefined}
          suffix={kind === "percent" ? "%" : undefined}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          className="sm:w-40"
        />
      </Field>
    </div>
  );
}

const valueErr = (kind: "percent" | "fixed", value: string, tr: ReturnType<typeof useTr>) =>
  kind === "percent"
    ? numErr(value, tr, { int: true, min: 1, max: 100 })
    : numErr(value, tr, { money: true, min: 0.01, max: MAX_PRICE_YUAN });

/* ---------- New coupon ---------- */

type Draft = {
  code: string;
  name: string;
  kind: "percent" | "fixed";
  value: string;
  plans: string[];
  periods: string[];
  min: string;
  starts: string;
  ends: string;
  max: string;
  per: string;
  newOnly: boolean;
  enabled: boolean;
};

export function CouponEditor({
  coupons,
  plans,
  onClose,
}: {
  coupons: Coupon[];
  plans: PlanView[];
  onClose: () => void;
}) {
  const tr = useTr();
  const today = siteToday();
  const [f, setF] = useState<Draft>({
    code: "",
    name: "",
    kind: "percent",
    value: "",
    plans: [],
    periods: [],
    min: "",
    starts: today,
    ends: "",
    max: "",
    per: "",
    newOnly: false,
    enabled: true,
  });
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setF((p) => ({ ...p, [k]: v }));
  const code = f.code.trim();
  const e = {
    code: !code
      ? tr("必填", "Required")
      : !CODE_RE.test(code)
        ? tr("3–32 位大写字母、数字、- 或 _", "3–32 of A–Z, 0–9, - or _")
        : coupons.some((c) => c.code.toUpperCase() === code)
          ? tr("这个代码已存在，换一个或点骰子随机生成", "This code exists; pick another or roll the dice")
          : undefined,
    name: f.name.trim() ? undefined : tr("必填，用户结账时看到", "Required; buyers see it at checkout"),
    value: valueErr(f.kind, f.value, tr),
    min: numErr(f.min, tr, { money: true, allowEmpty: true, max: MAX_PRICE_YUAN }),
    ends:
      f.ends && f.starts && daysBetween(f.starts, f.ends) < 0
        ? tr("结束日期早于开始日期", "Ends before it starts")
        : undefined,
    max: numErr(f.max, tr, { int: true, min: 1, max: MAX_LIMIT, allowEmpty: true }),
    per: numErr(f.per, tr, { int: true, min: 1, max: MAX_LIMIT, allowEmpty: true }),
  };
  const errs = Object.values(e).filter(Boolean).length;
  const show = (k: keyof typeof e) => (tried ? e[k] : undefined);
  const value = e.value ? null : f.kind === "percent" ? Number(f.value) : yuanToCents(f.value);
  const minCents = e.min || !f.min.trim() ? 0 : yuanToCents(f.min);
  const rules = ruleParts(
    {
      kind: f.kind,
      value: value ?? 0,
      min_amount_cents: minCents,
      plan_ids: f.plans.length ? f.plans : null,
      periods: f.periods.length ? f.periods : null,
      new_users_only: f.newOnly,
    },
    plans,
    tr,
  );
  if (value == null)
    rules[0] = (f.newOnly ? tr("新用户首单 ", "New customers: ") : "") + tr("（优惠待填）", "(discount?)");
  const perText =
    e.per || !f.per.trim() ? tr("每人不限次", "no per-user limit") : tr(`每人 ${f.per} 次`, `${f.per} per user`);
  const submit = async () => {
    setTried(true);
    if (errs) return;
    const r = await run(
      () =>
        post("/coupons", {
          code,
          name: f.name.trim(),
          kind: f.kind,
          value,
          plan_ids: f.plans.length ? f.plans : undefined,
          periods: f.periods.length ? f.periods : undefined,
          min_amount_cents: minCents,
          starts_at: f.starts && f.starts > today ? fromLocalInput(`${f.starts}T00:00`) : undefined,
          ends_at: f.ends ? endOfDay(f.ends) : undefined,
          max_uses: f.max.trim() ? Number(f.max.trim()) : undefined,
          per_user_limit: f.per.trim() ? Number(f.per.trim()) : undefined,
          new_users_only: f.newOnly,
          enabled: f.enabled,
        }),
      { ok: tr(`已创建 ${code}`, `Created ${code}`) },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      icon={Ticket}
      title={tr("新建优惠券", "New coupon")}
      description={tr("用户在结账时输入代码享受折扣", "Buyers enter the code at checkout for a discount")}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {tried && <FixCount n={errs} />}
            <Button type="submit" variant="primary" loading={busy}>
              {tr("创建优惠券", "Create coupon")}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_280px]">
        <div className="grid min-w-0 content-start gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={tr("代码", "Code")}
              required
              error={show("code")}
              hint={tr("自动转为大写", "Upper-cased as you type")}
            >
              <div className="flex gap-1.5">
                <Input
                  data-autofocus
                  value={f.code}
                  onChange={(ev) => set("code", ev.target.value.toUpperCase())}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono tracking-wide"
                />
                <Button
                  variant="secondary"
                  size="icon"
                  icon={Dices}
                  aria-label={tr("随机生成", "Random code")}
                  title={tr("随机生成", "Random code")}
                  onClick={() => set("code", randomCode(8))}
                />
              </div>
            </Field>
            <Field label={tr("名称", "Name")} required error={show("name")}>
              <Input
                value={f.name}
                maxLength={100}
                onChange={(ev) => set("name", ev.target.value)}
                placeholder={tr("秋季促销", "Autumn sale")}
              />
            </Field>
          </div>
          <KindValue
            kind={f.kind}
            value={f.value}
            error={show("value") ?? (f.value.trim() ? e.value : undefined)}
            onKind={(k) => set("kind", k)}
            onValue={(v) => set("value", v)}
          />
          <Field group label={tr("适用套餐", "Plans")}>
            <MultiChips
              label={tr("适用套餐", "Plans")}
              all={tr("全部套餐", "Every plan")}
              value={f.plans}
              onChange={(v) => set("plans", v)}
              items={plans.map((p) => ({ value: p.id, label: p.name }))}
            />
          </Field>
          <Field group label={tr("适用周期", "Terms")}>
            <MultiChips
              label={tr("适用周期", "Terms")}
              all={tr("全部周期", "Every term")}
              value={f.periods}
              onChange={(v) => set("periods", v)}
              items={PERIODS.map((p) => ({ value: p as string, label: periodLabel(p, tr) }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={tr("最低消费", "Minimum")} error={show("min")} hint={tr("留空 = 无门槛", "Empty = none")}>
              <AffixInput prefix="¥" value={f.min} onChange={(ev) => set("min", ev.target.value)} />
            </Field>
            <Field label={tr("开始", "Starts")} hint={tr("站点时区的当天 0 点", "Midnight, site time zone")}>
              <Input type="date" value={f.starts} onChange={(ev) => set("starts", ev.target.value)} />
            </Field>
            <Field label={tr("结束", "Ends")} error={show("ends")} hint={tr("留空 = 长期有效", "Empty = no end")}>
              <Input type="date" value={f.ends} onChange={(ev) => set("ends", ev.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("总次数", "Total uses")} error={show("max")} hint={tr("留空 = 不限", "Empty = unlimited")}>
              <AffixInput
                suffix={tr("次", "uses")}
                inputMode="numeric"
                value={f.max}
                onChange={(ev) => set("max", ev.target.value)}
                placeholder={tr("不限", "unlimited")}
              />
            </Field>
            <Field label={tr("每人次数", "Per user")} error={show("per")} hint={tr("留空 = 不限", "Empty = unlimited")}>
              <AffixInput
                suffix={tr("次", "uses")}
                inputMode="numeric"
                value={f.per}
                onChange={(ev) => set("per", ev.target.value)}
                placeholder={tr("不限", "unlimited")}
              />
            </Field>
          </div>
          <div className="divide-y divide-separator border-t border-separator">
            <SwitchRow
              label={tr("仅限新用户", "New customers only")}
              hint={tr("只有从未付款过的用户能用（首单）", "Only users who never paid (first order)")}
              checked={f.newOnly}
              onChange={(v) => set("newOnly", v)}
            />
            <SwitchRow
              label={tr("创建后立即启用", "Enable when created")}
              hint={tr("关闭则先存为停用，不可使用", "Off = saved disabled, not usable yet")}
              checked={f.enabled}
              onChange={(v) => set("enabled", v)}
            />
          </div>
        </div>
        <aside className="min-w-0 md:sticky md:top-0 md:self-start">
          <div className="mb-2 text-footnote font-semibold text-muted-foreground">
            {tr("用户看到的样子", "What buyers see")}
          </div>
          <CouponTicket
            code={f.code}
            name={f.name}
            kind={f.kind}
            value={value}
            rules={rules}
            valid={!e.code}
            window={
              f.ends
                ? `${mdOf(f.starts || today, tr)} – ${mdOf(f.ends, tr)}`
                : tr(`${mdOf(f.starts || today, tr)} 起长期有效`, `from ${mdOf(f.starts || today, tr)}`)
            }
            uses={perText}
          />
          <div className="mt-3 rounded-xl bg-window p-3 text-body leading-6 ring-1 ring-border ring-inset">
            <div className="text-footnote font-semibold text-muted-foreground">{tr("规则", "Rules")}</div>
            {rules.join(" · ")}
            <div className="text-footnote text-muted-foreground">
              {e.max || !f.max.trim()
                ? tr("总次数不限", "No total limit")
                : tr(`共 ${num(Number(f.max))} 次`, `${num(Number(f.max))} uses`)}
              {" · "}
              {perText}
              {f.enabled ? "" : tr(" · 停用", " · disabled")}
            </div>
          </div>
        </aside>
      </div>
    </Dialog>
  );
}

/* ---------- Detail ---------- */

type Tab = "usage" | "settings";

export function CouponDetail({
  id,
  plans,
  onClose,
}: {
  id: string;
  plans: PlanView[] | undefined;
  onClose: () => void;
}) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["coupon", id],
    queryFn: () => get<{ coupon: Coupon; redemptions: Redemption[] }>(`/coupons/${id}`),
  });
  const c = q.data?.coupon;
  useCrumb(c?.code);
  if (!c)
    return (
      <Dialog open size="lg" onClose={onClose} icon={Ticket} title={tr("优惠券", "Coupon")}>
        {q.isError ? (
          <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <LoadingBlock rows={8} />
        )}
      </Dialog>
    );
  return <Detail key={c.id} c={c} redemptions={q.data?.redemptions ?? []} plans={plans} onClose={onClose} />;
}

const editOf = (c: Coupon) => ({
  name: c.name,
  max: c.max_uses == null ? "" : String(c.max_uses),
  per: c.per_user_limit == null ? "" : String(c.per_user_limit),
  ends: c.ends_at ? dateOnly(c.ends_at) : "",
});

function Detail({
  c,
  redemptions,
  plans,
  onClose,
}: {
  c: Coupon;
  redemptions: Redemption[];
  plans: PlanView[] | undefined;
  onClose: () => void;
}) {
  const tr = useTr();
  const [query, patchQ] = useQS();
  const tab: Tab = query.get("tab") === "settings" ? "settings" : "usage";
  const [ed, setEd] = useState(() => editOf(c));
  const saved = editOf(c);
  const dirty = JSON.stringify(ed) !== JSON.stringify(saved);
  const [run, busy] = useAction();
  const { toggle, remove } = useCouponActions();
  const s = couponState(c);
  const w = windowText(c, s, tr);
  const start = c.starts_at ? dateOnly(c.starts_at) : dateOnly(c.created_at);
  const maxE =
    numErr(ed.max, tr, { int: true, min: 1, max: MAX_LIMIT, allowEmpty: true }) ??
    (ed.max.trim() && Number(ed.max) < c.used
      ? tr(`不能少于已用的 ${c.used} 次`, `Not below the ${c.used} uses already counted`)
      : undefined);
  const e = {
    name: ed.name.trim() ? undefined : tr("必填", "Required"),
    max: maxE,
    per: numErr(ed.per, tr, { int: true, min: 1, max: MAX_LIMIT, allowEmpty: true }),
    ends: ed.ends && daysBetween(start, ed.ends) < 0 ? tr("早于开始日期", "Before the start") : undefined,
  };
  const errs = Object.values(e).filter(Boolean).length;
  const used = c.used > 0 || redemptions.length > 0;
  const save = async () => {
    if (errs || !dirty) return;
    await run(
      () =>
        patch(`/coupons/${c.id}`, {
          name: ed.name.trim(),
          max_uses: ed.max.trim() ? Number(ed.max.trim()) : null,
          per_user_limit: ed.per.trim() ? Number(ed.per.trim()) : null,
          ends_at: ed.ends ? endOfDay(ed.ends) : null,
        }),
      { ok: tr("已保存", "Saved") },
    );
  };
  const rules = ruleParts(c, plans, tr);
  const recent = redemptions.filter((r) => r.status !== "released");
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dirty={dirty}
      icon={Ticket}
      title={
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="font-mono">{c.code}</span>
          <CouponStatus state={s} />
        </span>
      }
      description={`${c.name} · ${rules.join(" · ")}`}
      tabs={
        <Tabs<Tab>
          value={tab}
          onChange={(v) => patchQ({ tab: v === "usage" ? null : v }, true)}
          tabs={[
            { value: "usage", label: tr("使用情况", "Usage"), count: c.used },
            { value: "settings", label: tr("设置", "Settings") },
          ]}
        />
      }
      onSubmit={() => void save()}
      footer={
        <>
          <Button
            variant="destructive-soft"
            icon={Trash2}
            disabled={used}
            onClick={async () => {
              if (await remove(c)) onClose();
            }}
          >
            {tr("删除", "Delete")}
          </Button>
          {used && (
            <span className="text-footnote text-faint max-sm:hidden">
              {tr(
                `已被使用 ${num(c.used)} 次，不能删除；不想再用可以停用`,
                `Used ${num(c.used)} times: it cannot be deleted; disable it instead`,
              )}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" icon={c.enabled ? PowerOff : Power} onClick={() => void toggle(c)}>
              {c.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
            </Button>
            {tab === "settings" && (
              <>
                <FixCount n={errs} />
                <Button type="submit" variant="primary" loading={busy} disabled={!dirty || errs > 0}>
                  {tr("保存", "Save")}
                </Button>
              </>
            )}
          </div>
        </>
      }
    >
      {tab === "usage" ? (
        <div className="grid gap-4">
          <StatStrip
            items={[
              {
                label: tr("已使用", "Used"),
                value: num(c.used),
                foot:
                  c.max_uses == null
                    ? tr("总次数不限", "No total limit")
                    : tr(
                        `共 ${num(c.max_uses)} 次 · 剩 ${num(Math.max(0, c.max_uses - c.used))}`,
                        `of ${num(c.max_uses)} · ${num(Math.max(0, c.max_uses - c.used))} left`,
                      ),
              },
              {
                label: tr("近 7 天", "Last 7 days"),
                value: `+${c.redeemed_7d}`,
                tone: c.redeemed_7d ? "success" : undefined,
                foot: c.redeemed_7d ? tr("仍在被使用", "Still in use") : tr("没有新的核销", "No new redemptions"),
              },
              {
                label: tr("共优惠", "Discount given"),
                value: yuan(c.discount_cents_total),
                foot: tr("已付款订单合计", "Over paid orders"),
              },
              { label: tr("有效期", "Validity"), value: <span className="text-title3">{w.t}</span>, foot: w.sub },
            ]}
          />
          <section>
            <h4 className="mb-2 text-footnote font-semibold text-muted-foreground">{tr("最近使用", "Recent uses")}</h4>
            {recent.length === 0 ? (
              <p className="rounded-xl bg-window px-4 py-6 text-center text-body text-muted-foreground ring-1 ring-border ring-inset">
                {tr("还没有人用过这张优惠券。", "Nobody has used this coupon yet.")}
                {s === "scheduled" && tr(`${mdOf(start, tr)} 开始生效。`, ` It starts on ${mdOf(start, tr)}.`)}
              </p>
            ) : (
              <ul className="divide-y divide-separator overflow-hidden rounded-xl ring-1 ring-border ring-inset">
                {recent.slice(0, 8).map((r) => (
                  <li key={r.order_id} className="flex min-h-12 items-center gap-3 px-3 py-2">
                    <Avatar name={r.user_email ?? r.user_label} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body">{r.user_email ?? r.user_label}</span>
                      <span className="block truncate text-footnote text-muted-foreground">
                        {r.plan_name} · {periodLabel(r.period, tr)} ·{" "}
                        <Link to={`/orders?open=${r.order_id}`} className="font-mono text-primary hover:underline">
                          {r.out_trade_no}
                        </Link>
                        {r.status === "reserved" && tr(" · 待付款", " · awaiting payment")}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="tnum block text-body font-medium text-success">−{yuan(r.discount_cents)}</span>
                      <span className="tnum block text-footnote text-faint">{dateTime(r.created_at).slice(5)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {recent.length > 8 && (
              <p className="mt-2 px-1 text-footnote text-muted-foreground">
                {tr(
                  `只列出最近 8 笔，共 ${num(recent.length)} 笔${redemptions.length >= 200 ? "（最多取 200 笔）" : ""}`,
                  `The latest 8 of ${num(recent.length)}${redemptions.length >= 200 ? " (200 at most)" : ""}`,
                )}
              </p>
            )}
          </section>
        </div>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={tr("代码", "Code")}
              hint={tr("创建后不能修改，用户手里的码会失效", "Fixed once created (handed-out codes would break)")}
            >
              <div className="relative">
                <Input value={c.code} disabled className="pr-8 font-mono" />
                <Lock className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
              </div>
            </Field>
            <Field label={tr("名称", "Name")} required error={e.name}>
              <Input value={ed.name} maxLength={100} onChange={(ev) => setEd({ ...ed, name: ev.target.value })} />
            </Field>
            <Field
              label={tr("总次数", "Total uses")}
              error={e.max}
              hint={tr(`留空 = 不限 · 已用 ${num(c.used)}`, `Empty = unlimited · ${num(c.used)} used`)}
            >
              <AffixInput
                suffix={tr("次", "uses")}
                inputMode="numeric"
                value={ed.max}
                onChange={(ev) => setEd({ ...ed, max: ev.target.value })}
                placeholder={tr("不限", "unlimited")}
              />
            </Field>
            <Field label={tr("每人次数", "Per user")} error={e.per} hint={tr("留空 = 不限", "Empty = unlimited")}>
              <AffixInput
                suffix={tr("次", "uses")}
                inputMode="numeric"
                value={ed.per}
                onChange={(ev) => setEd({ ...ed, per: ev.target.value })}
                placeholder={tr("不限", "unlimited")}
              />
            </Field>
            <Field
              label={tr("结束日期", "End date")}
              error={e.ends}
              hint={tr("留空 = 长期有效；提前结束会让代码立即失效", "Empty = no end; an earlier end stops it")}
            >
              <Input type="date" value={ed.ends} onChange={(ev) => setEd({ ...ed, ends: ev.target.value })} />
            </Field>
          </div>
          <div className="rounded-xl bg-window p-3 ring-1 ring-border ring-inset">
            <div className="flex items-center gap-1.5 text-footnote font-semibold text-muted-foreground">
              <Lock className="size-3.5" aria-hidden="true" />
              {tr("折扣规则（创建后不可改）", "Discount rules (fixed once created)")}
            </div>
            <p className="mt-1 text-body">
              {rules.join(" · ")} ·{" "}
              {c.new_users_only ? tr("仅新用户", "new customers only") : tr("所有用户", "everyone")} ·{" "}
              {tr(`自 ${start} 起`, `from ${start}`)}
            </p>
            <p className="mt-0.5 text-footnote text-faint">
              {tr(
                "要换规则，请停用这张并新建一张，避免已经发出去的代码突然变了。",
                "To change the rules, disable this one and create another, so handed-out codes never change.",
              )}
            </p>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/* ---------- Batch generator ---------- */

export function BatchDialog({ plans, onClose }: { plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const [f, setF] = useState({
    name: "",
    prefix: "",
    count: "100",
    length: "10",
    kind: "percent" as "percent" | "fixed",
    value: "",
    plans: [] as string[],
    periods: [] as string[],
    min: "",
    per: "1",
    ends: "",
    newOnly: false,
  });
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const e = {
    name: f.name.trim() ? undefined : tr("必填，作废时要输入它确认", "Required; you type it to void the batch"),
    prefix: PREFIX_RE.test(f.prefix.trim())
      ? undefined
      : tr("最多 16 位大写字母、数字、- 或 _", "At most 16 of A–Z, 0–9, - or _"),
    count: numErr(f.count, tr, { int: true, min: 1, max: 5000 }),
    length: numErr(f.length, tr, { int: true, min: 6, max: 16 }),
    value: valueErr(f.kind, f.value, tr),
    per: numErr(f.per, tr, { int: true, min: 1, max: MAX_LIMIT }),
    min: numErr(f.min, tr, { money: true, allowEmpty: true, max: MAX_PRICE_YUAN }),
    ends:
      f.ends && daysBetween(siteToday(), f.ends) < 0 ? tr("结束日期已经过去", "The end date has passed") : undefined,
  };
  const errs = Object.values(e).filter(Boolean).length;
  const show = (k: keyof typeof e) => (tried ? e[k] : undefined);
  const len = e.length ? 10 : Number(f.length);
  const prefix = f.prefix.trim();
  // Example codes (new random characters only when the length changes).
  const samples = useMemo(() => [0, 1, 2].map(() => randomCode(16)), []);
  const value = e.value ? 0 : f.kind === "percent" ? Number(f.value) : yuanToCents(f.value);
  const submit = async () => {
    setTried(true);
    if (errs) return;
    const r = await run(
      () =>
        post("/coupon-batches", {
          name: f.name.trim(),
          prefix: prefix || undefined,
          count: Number(f.count.trim()),
          length: len,
          kind: f.kind,
          value,
          plan_ids: f.plans.length ? f.plans : undefined,
          periods: f.periods.length ? f.periods : undefined,
          min_amount_cents: f.min.trim() ? yuanToCents(f.min) : 0,
          new_users_only: f.newOnly,
          max_uses: Number(f.per.trim()),
          ends_at: f.ends ? endOfDay(f.ends) : undefined,
        }),
      { ok: tr(`已生成 ${num(Number(f.count))} 个码`, `Generated ${num(Number(f.count))} codes`) },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      icon={Layers3}
      title={tr("批量生成优惠码", "Generate codes")}
      description={tr(
        "一次生成一批一次性兑换码，生成后可导出 CSV 发放",
        "A batch of one-off codes; export the CSV to hand them out",
      )}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {tried && <FixCount n={errs} />}
            <Button type="submit" variant="primary" loading={busy}>
              {e.count
                ? tr("生成", "Generate")
                : tr(`生成 ${num(Number(f.count))} 个码`, `Generate ${num(Number(f.count))} codes`)}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={tr("批次名", "Batch name")} required error={show("name")}>
          <Input
            data-autofocus
            value={f.name}
            maxLength={100}
            onChange={(ev) => set("name", ev.target.value)}
            placeholder={tr("例如：线下展会卡片", "e.g. trade-show cards")}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tr("前缀", "Prefix")} error={show("prefix") ?? (f.prefix ? e.prefix : undefined)}>
            <Input
              value={f.prefix}
              onChange={(ev) => set("prefix", ev.target.value.toUpperCase())}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field label={tr("数量", "Count")} error={show("count")} hint={tr("最多 5,000", "At most 5,000")}>
            <AffixInput
              suffix={tr("个", "")}
              inputMode="numeric"
              value={f.count}
              onChange={(ev) => set("count", ev.target.value)}
            />
          </Field>
          <Field label={tr("随机部分长度", "Random length")} error={show("length")} hint={tr("6–16 位", "6–16")}>
            <AffixInput
              suffix={tr("位", "")}
              inputMode="numeric"
              value={f.length}
              onChange={(ev) => set("length", ev.target.value)}
            />
          </Field>
        </div>
        <div className="rounded-lg bg-window px-3 py-2 ring-1 ring-border ring-inset">
          <div className="text-footnote text-muted-foreground">
            {tr("示例（字母表不含易混的 I、O、0、1）", "Examples (no confusable I, O, 0, 1)")}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-4 font-mono text-body break-all">
            {samples.map((s) => (
              <span key={s}>
                {prefix}
                {s.slice(0, len)}
              </span>
            ))}
          </div>
        </div>
        <KindValue
          kind={f.kind}
          value={f.value}
          error={show("value") ?? (f.value.trim() ? e.value : undefined)}
          onKind={(k) => set("kind", k)}
          onValue={(v) => set("value", v)}
        />
        <Field group label={tr("适用套餐", "Plans")}>
          <MultiChips
            label={tr("适用套餐", "Plans")}
            all={tr("全部套餐", "Every plan")}
            value={f.plans}
            onChange={(v) => set("plans", v)}
            items={plans.map((p) => ({ value: p.id, label: p.name }))}
          />
        </Field>
        <Field group label={tr("适用周期", "Terms")}>
          <MultiChips
            label={tr("适用周期", "Terms")}
            all={tr("全部周期", "Every term")}
            value={f.periods}
            onChange={(v) => set("periods", v)}
            items={PERIODS.map((p) => ({ value: p as string, label: periodLabel(p, tr) }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label={tr("每个码可用次数", "Uses per code")} error={show("per")} hint={tr("通常为 1", "Usually 1")}>
            <AffixInput
              suffix={tr("次", "")}
              inputMode="numeric"
              value={f.per}
              onChange={(ev) => set("per", ev.target.value)}
            />
          </Field>
          <Field label={tr("最低消费", "Minimum")} error={show("min")} hint={tr("留空 = 无门槛", "Empty = none")}>
            <AffixInput prefix="¥" value={f.min} onChange={(ev) => set("min", ev.target.value)} />
          </Field>
          <Field label={tr("结束日期", "End date")} error={show("ends")} hint={tr("留空 = 长期有效", "Empty = no end")}>
            <Input type="date" value={f.ends} onChange={(ev) => set("ends", ev.target.value)} />
          </Field>
        </div>
        <SwitchRow
          label={tr("仅限新用户", "New customers only")}
          hint={tr("只有从未付款过的用户能用（首单）", "Only users who never paid (first order)")}
          checked={f.newOnly}
          onChange={(v) => set("newOnly", v)}
        />
      </div>
    </Dialog>
  );
}
