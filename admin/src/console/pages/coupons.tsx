// 优惠券 (CPN-*): coupons (list with search / status / pages, create, the
// coupon dialog with redemptions and edit, enable / disable, delete) and
// generated code batches (generate, CSV, revoke). Numbers stay text while
// edited and are checked field by field (audit §5.6: a bad number is never
// sent, so it can never be saved as "unlimited").
import { useQuery } from "@tanstack/react-query";
import { Download, Plus, TicketPercent, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { del, get, patch, post } from "../../shared/api";
import { dateTime, fromLocalInput, parseYuan, toLocalInput, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { CardHeader } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Segmented, SwitchField } from "../../shared/ui/form";
import { KV, PageHeader, SectionTitle } from "../../shared/ui/layout";
import { EmptyState, ErrorState, LoadingBlock } from "../../shared/ui/states";
import { DataTable, Pager, type Column } from "../../shared/ui/table";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { useDebounced } from "../kit";
import { setQuery, useRoute } from "../router";
import { useCrumb } from "../session";
import { PERIODS, periodLabel } from "../terms";
import type { PlanView } from "../types";
import { downloadFile } from "./download";
import { usePlans } from "./users";

type Coupon = {
  id: string;
  code: string;
  name: string;
  kind: "percent" | "fixed";
  value: number;
  plan_ids: string[] | null;
  periods: string[] | null;
  min_amount_cents: number;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  per_user_limit: number | null;
  new_users_only: boolean;
  enabled: boolean;
  used: number;
  redeemed: number;
  created_at: string;
};
type Redemption = {
  order_id: string;
  out_trade_no: string;
  user_label: string;
  user_email: string | null;
  status: string;
  discount_cents: number;
  order_status: string;
  created_at: string;
};
type Batch = {
  id: string;
  name: string;
  prefix: string;
  count: number;
  created_at: string;
  revoked_at: string | null;
  codes: number;
  used: number;
  redeemed: number;
  actor_label: string;
};

/** The server lists at most this many coupons (newest first). */
const LIST_CAP = 1000;
/** Uses limits: 1..this, or empty = unlimited (coupons.rs MAX_LIMIT). */
const MAX_LIMIT = 100_000_000;

export function couponValue(c: { kind: string; value: number }, tr: Tr): string {
  return c.kind === "percent"
    ? tr(`${c.value}% 折扣`, `${c.value}% off`)
    : tr(`减 ${yuan(c.value)}`, `${yuan(c.value)} off`);
}

function redemptionText(s: string, tr: Tr): [string, "success" | "info" | "neutral"] {
  return (
    (
      {
        reserved: [tr("已预占（待付款）", "Held (awaiting payment)"), "info"],
        redeemed: [tr("已核销", "Redeemed"), "success"],
        released: [tr("已释放", "Released"), "neutral"],
      } as Record<string, [string, "success" | "info" | "neutral"]>
    )[s] ?? [tr("其他", "Other"), "neutral"]
  );
}

/** A whole number in [min, max]; "" = null when `empty` is allowed. */
function intOf(s: string, min: number, max: number, empty: boolean, tr: Tr): number | null | string {
  const t = s.trim();
  if (!t) return empty ? null : tr("必填", "Required");
  if (!/^\d+$/.test(t)) return tr("请输入整数", "Enter a whole number");
  const n = Number(t);
  if (n < min || n > max) return tr(`范围 ${min}–${max}`, `Range ${min}–${max}`);
  return n;
}

type Terms = {
  kind: "percent" | "fixed";
  value: string;
  planIds: string[];
  periods: string[];
  min: string;
  starts: string;
  ends: string;
  maxUses: string;
  perUser: string;
  newOnly: boolean;
};
type TermKey = "value" | "min" | "maxUses" | "perUser" | "ends";
const EMPTY_TERMS: Terms = {
  kind: "percent",
  value: "",
  planIds: [],
  periods: [],
  min: "",
  starts: "",
  ends: "",
  maxUses: "",
  perUser: "",
  newOnly: false,
};

/** Field errors of the terms, and the request body when there are none. */
function checkTerms(t: Terms, tr: Tr): { errors: Partial<Record<TermKey, string>>; body?: Record<string, unknown> } {
  const errors: Partial<Record<TermKey, string>> = {};
  let value: number | null = null;
  if (t.kind === "percent") {
    const v = intOf(t.value, 1, 100, false, tr);
    if (typeof v === "string") errors.value = tr("比例须为 1–100 的整数", "Percent must be a whole number 1–100");
    else value = v;
  } else {
    value = parseYuan(t.value);
    if (!value) errors.value = tr("金额无效（元，大于 0，最多两位小数）", "Invalid amount (yuan, > 0, 2 decimals)");
  }
  const min = t.min.trim() ? parseYuan(t.min) : 0;
  if (min === null) errors.min = tr("金额无效（元，最多两位小数）", "Invalid amount (yuan, 2 decimals)");
  const maxUses = intOf(t.maxUses, 1, MAX_LIMIT, true, tr);
  if (typeof maxUses === "string") errors.maxUses = maxUses;
  const perUser = intOf(t.perUser, 1, MAX_LIMIT, true, tr);
  if (typeof perUser === "string") errors.perUser = perUser;
  if (t.starts && t.ends && t.ends <= t.starts) errors.ends = tr("失效时间要晚于生效时间", "Must be after the start");
  if (Object.keys(errors).length) return { errors };
  return {
    errors,
    body: {
      kind: t.kind,
      value,
      plan_ids: t.planIds.length ? t.planIds : undefined,
      periods: t.periods.length ? t.periods : undefined,
      min_amount_cents: min,
      starts_at: t.starts ? fromLocalInput(t.starts) : undefined,
      ends_at: t.ends ? fromLocalInput(t.ends) : undefined,
      max_uses: maxUses,
      per_user_limit: perUser ?? undefined,
      new_users_only: t.newOnly,
    },
  };
}

/** Which fields show their error: after a blur, or all after a submit. */
function useShown() {
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  return {
    show: (k: string) => setShown((s) => (s.has(k) ? s : new Set(s).add(k))),
    showAll: () => setAll(true),
    on: (k: string) => all || shown.has(k),
  };
}

function TermsFields({
  t,
  set,
  plans,
  batch,
  errors,
  shown,
}: {
  t: Terms;
  set: (t: Terms) => void;
  plans: PlanView[];
  batch?: boolean;
  errors: Partial<Record<TermKey, string>>;
  shown: ReturnType<typeof useShown>;
}) {
  const tr = useTr();
  const err = (k: TermKey) => (shown.on(k) ? errors[k] : undefined);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field group label={tr("优惠类型", "Kind")}>
        <Segmented
          label={tr("优惠类型", "Kind")}
          value={t.kind}
          onChange={(k) => set({ ...t, kind: k })}
          options={[
            { value: "percent", label: tr("按比例（%）", "Percent") },
            { value: "fixed", label: tr("固定金额（元）", "Fixed (yuan)") },
          ]}
        />
      </Field>
      <Field
        label={t.kind === "percent" ? tr("减免比例（%）", "Percent off") : tr("减免金额（元）", "Amount off (yuan)")}
        error={err("value")}
      >
        <Input
          inputMode="decimal"
          value={t.value}
          onChange={(e) => set({ ...t, value: e.target.value })}
          onBlur={() => shown.show("value")}
        />
      </Field>
      <Field
        label={tr("最低消费（元，原价）", "Minimum (yuan, list price)")}
        hint={tr("空 = 不限", "Empty = none")}
        error={err("min")}
      >
        <Input
          inputMode="decimal"
          value={t.min}
          onChange={(e) => set({ ...t, min: e.target.value })}
          onBlur={() => shown.show("min")}
        />
      </Field>
      <Field
        label={
          batch
            ? tr("每码次数（空 = 不限，默认 1）", "Uses per code (empty = unlimited)")
            : tr("总次数（空 = 不限）", "Total uses (empty = unlimited)")
        }
        error={err("maxUses")}
      >
        <Input
          inputMode="numeric"
          value={t.maxUses}
          onChange={(e) => set({ ...t, maxUses: e.target.value })}
          onBlur={() => shown.show("maxUses")}
        />
      </Field>
      <Field label={tr("每人次数（空 = 不限）", "Per user (empty = unlimited)")} error={err("perUser")}>
        <Input
          inputMode="numeric"
          value={t.perUser}
          onChange={(e) => set({ ...t, perUser: e.target.value })}
          onBlur={() => shown.show("perUser")}
        />
      </Field>
      <div className="flex items-end">
        <SwitchField
          className="w-full"
          checked={t.newOnly}
          onChange={(v) => set({ ...t, newOnly: v })}
          label={tr("仅新用户（首单）", "New users only (first order)")}
        />
      </div>
      <Field label={tr("生效时间（站点时区）", "Starts (site time zone)")} hint={tr("空 = 立即", "Empty = now")}>
        <Input type="datetime-local" value={t.starts} onChange={(e) => set({ ...t, starts: e.target.value })} />
      </Field>
      <Field
        label={tr("失效时间（站点时区）", "Ends (site time zone)")}
        hint={tr("空 = 长期有效", "Empty = no end")}
        error={err("ends")}
      >
        <Input
          type="datetime-local"
          value={t.ends}
          onChange={(e) => set({ ...t, ends: e.target.value })}
          onBlur={() => shown.show("ends")}
        />
      </Field>
      <Field group className="sm:col-span-2" label={tr("适用套餐（不选 = 全部）", "Plans (none = all)")}>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {plans.length === 0 && <span className="text-footnote text-faint">{tr("还没有套餐", "No plans yet")}</span>}
          {plans.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-body">
              <Checkbox
                checked={t.planIds.includes(p.id)}
                label={p.name}
                onChange={(on) =>
                  set({ ...t, planIds: on ? [...t.planIds, p.id] : t.planIds.filter((x) => x !== p.id) })
                }
              />
              {p.name}
            </label>
          ))}
        </div>
      </Field>
      <Field group className="sm:col-span-2" label={tr("适用周期（不选 = 全部）", "Terms (none = all)")}>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {PERIODS.map((p) => (
            <label key={p} className="flex items-center gap-2 text-body">
              <Checkbox
                checked={t.periods.includes(p)}
                label={periodLabel(p, tr)}
                onChange={(on) => set({ ...t, periods: on ? [...t.periods, p] : t.periods.filter((x) => x !== p) })}
              />
              {periodLabel(p, tr)}
            </label>
          ))}
        </div>
      </Field>
    </div>
  );
}

type StatusF = "" | "on" | "off";

export function CouponsPage() {
  const tr = useTr();
  const { query } = useRoute();
  const open = query.get("open");
  const q = query.get("q") ?? "";
  const status = (["on", "off"].includes(query.get("status") ?? "") ? query.get("status") : "") as StatusF;
  const [term, setTerm] = useState(q);
  const dq = useDebounced(term.trim(), 250);
  const applied = useRef(dq);
  useEffect(() => {
    if (dq === applied.current) return;
    applied.current = dq;
    setQuery({ q: dq || null });
  }, [dq]);
  const plans = usePlans();
  const list = useQuery({ queryKey: ["coupons"], queryFn: () => get<Coupon[]>("/coupons") });
  const [creating, setCreating] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(20);
  const all = useMemo(() => list.data ?? [], [list.data]);
  const rows = useMemo(() => {
    const needle = q.toLowerCase();
    return all.filter(
      (c) =>
        (!status || (status === "on") === c.enabled) &&
        (!needle || c.code.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle)),
    );
  }, [all, q, status]);
  const at = offset < rows.length ? offset : 0;
  const page = rows.slice(at, at + limit);
  const filtered = !!(q || status);
  const columns: Column<Coupon>[] = [
    {
      key: "code",
      header: tr("优惠码", "Code"),
      fixed: true,
      mobile: "title",
      cell: (c) => <span className="font-mono">{c.code}</span>,
    },
    { key: "name", header: tr("名称", "Name"), cell: (c) => c.name || <span className="text-faint">—</span> },
    { key: "value", header: tr("面值", "Value"), cell: (c) => couponValue(c, tr) },
    {
      key: "uses",
      header: tr("已用 / 总次数", "Used / max"),
      cell: (c) => <span className="tnum">{`${c.used} / ${c.max_uses ?? "∞"}`}</span>,
    },
    {
      key: "window",
      header: tr("有效期", "Valid"),
      optional: true,
      cell: (c) =>
        c.starts_at || c.ends_at ? `${dateTime(c.starts_at)} → ${dateTime(c.ends_at)}` : tr("长期", "Always"),
    },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (c) => (
        <Badge tone={c.enabled ? "success" : "neutral"} dot>
          {c.enabled ? tr("启用", "On") : tr("停用", "Off")}
        </Badge>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={tr("优惠券", "Coupons")}
        description={tr("单个优惠码与批量生成的码。", "Single coupon codes and generated batches.")}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            {tr("新建优惠券", "New coupon")}
          </Button>
        }
      />
      <DataTable
        label={tr("优惠券", "Coupons")}
        storageKey="coupons"
        rows={page}
        columns={columns}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(c) => setQuery({ open: c.id }, false)}
        activeId={open}
        filtered={filtered}
        onClearFilters={() => {
          setTerm("");
          setQuery({ q: null, status: null });
        }}
        empty={
          filtered ? undefined : (
            <EmptyState
              icon={TicketPercent}
              title={tr("还没有优惠券", "No coupons yet")}
              description={tr(
                "新建一个优惠码，或在下方批量生成一批码。",
                "Create a coupon code, or generate a batch below.",
              )}
              action={
                <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
                  {tr("新建优惠券", "New coupon")}
                </Button>
              }
            />
          )
        }
        toolbar={
          <>
            <Input
              type="search"
              className="min-w-0 flex-1 basis-48"
              aria-label={tr("搜索优惠码或名称", "Search code or name")}
              placeholder={tr("搜索优惠码或名称", "Search code or name")}
              value={term}
              onChange={(e) => {
                setTerm(e.target.value);
                setOffset(0);
              }}
            />
            <Segmented
              label={tr("优惠券状态", "Coupon status")}
              value={status}
              onChange={(v) => {
                setOffset(0);
                setQuery({ status: v || null });
              }}
              options={[
                { value: "", label: tr("全部", "All") },
                { value: "on", label: tr("启用", "On") },
                { value: "off", label: tr("停用", "Off") },
              ]}
            />
          </>
        }
        footer={
          rows.length > 0 && (
            <Pager
              total={rows.length}
              offset={at}
              limit={limit}
              onOffset={setOffset}
              onLimit={(l) => {
                setLimit(l);
                setOffset(0);
              }}
              totalLabel={
                all.length >= LIST_CAP
                  ? tr(
                      `${rows.length} 条（只取最新 ${LIST_CAP} 张优惠券）`,
                      `${rows.length} (newest ${LIST_CAP} coupons only)`,
                    )
                  : undefined
              }
            />
          )
        }
      />
      <div className="mt-6">
        <Batches plans={plans.data ?? []} />
      </div>
      {creating && <CreateCoupon plans={plans.data ?? []} onClose={() => setCreating(false)} />}
      {open && <CouponDialog id={open} plans={plans.data ?? []} onClose={() => setQuery({ open: null })} />}
    </>
  );
}

function CreateCoupon({ plans, onClose }: { plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [t, setT] = useState<Terms>(EMPTY_TERMS);
  const shown = useShown();
  const [run, busy] = useAction();
  const checked = checkTerms(t, tr);
  const codeErr = /^[A-Za-z0-9_-]{3,32}$/.test(code.trim())
    ? undefined
    : tr("3–32 位字母、数字、- 或 _", "3–32 of A-Z 0-9 - _");
  const submit = async () => {
    shown.showAll();
    if (codeErr || !checked.body) return;
    const r = await run(
      () => post("/coupons", { code: code.trim(), name: name.trim() || undefined, ...checked.body }),
      {
        ok: tr("优惠券已创建", "Coupon created"),
      },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={tr("新建优惠券", "New coupon")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("创建", "Create")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={tr("优惠码（3–32 位字母、数字、- 或 _）", "Code (3–32 of A-Z 0-9 - _)")}
            error={shown.on("code") ? codeErr : undefined}
          >
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onBlur={() => shown.show("code")}
              autoComplete="off"
              spellCheck={false}
              data-autofocus
            />
          </Field>
          <Field label={tr("备注名称", "Name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
        </div>
        <TermsFields t={t} set={setT} plans={plans} errors={checked.errors} shown={shown} />
      </div>
    </Dialog>
  );
}

type Edit = { name: string; maxUses: string; perUser: string; ends: string };
const editOf = (c: Coupon): Edit => ({
  name: c.name,
  maxUses: c.max_uses === null ? "" : String(c.max_uses),
  perUser: c.per_user_limit === null ? "" : String(c.per_user_limit),
  ends: toLocalInput(c.ends_at),
});

function CouponDialog({ id, plans, onClose }: { id: string; plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["coupon", id],
    queryFn: () => get<{ coupon: Coupon; redemptions: Redemption[] }>(`/coupons/${id}`),
  });
  const c = q.data?.coupon;
  useCrumb(c?.code);
  return c ? (
    <CouponEditor key={c.id} c={c} redemptions={q.data?.redemptions ?? []} plans={plans} onClose={onClose} />
  ) : (
    <Dialog open size="lg" onClose={onClose} title={tr("优惠券", "Coupon")}>
      {q.isError ? <ErrorState compact error={q.error} onRetry={() => void q.refetch()} /> : <LoadingBlock rows={8} />}
    </Dialog>
  );
}

function CouponEditor({
  c,
  redemptions,
  plans,
  onClose,
}: {
  c: Coupon;
  redemptions: Redemption[];
  plans: PlanView[];
  onClose: () => void;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [edit, setEdit] = useState<Edit>(() => editOf(c));
  const saved = editOf(c);
  const dirty = JSON.stringify(edit) !== JSON.stringify(saved);
  const shown = useShown();
  const [run, busy] = useAction();
  const maxUses = intOf(edit.maxUses, Math.max(1, c.used), MAX_LIMIT, true, tr);
  const perUser = intOf(edit.perUser, 1, MAX_LIMIT, true, tr);
  const endsErr = edit.ends && c.starts_at && edit.ends <= toLocalInput(c.starts_at);
  const errors = {
    maxUses:
      typeof maxUses === "string"
        ? /^\d+$/.test(edit.maxUses.trim()) && Number(edit.maxUses.trim()) < c.used
          ? tr(`不能少于已用的 ${c.used} 次`, `Not below the ${c.used} uses already counted`)
          : maxUses
        : undefined,
    perUser: typeof perUser === "string" ? perUser : undefined,
    ends: endsErr ? tr("失效时间要晚于生效时间", "Must be after the start") : undefined,
  };
  const inUse = c.used > 0 || redemptions.length > 0;
  const save = async () => {
    shown.showAll();
    if (errors.maxUses || errors.perUser || errors.ends) return;
    await run(
      () =>
        patch(`/coupons/${c.id}`, {
          name: edit.name.trim(),
          max_uses: maxUses,
          per_user_limit: perUser,
          ends_at: edit.ends ? fromLocalInput(edit.ends) : null,
        }),
      { ok: tr("已保存", "Saved") },
    );
  };
  const toggle = async () => {
    const ok = await confirm({
      title: c.enabled ? tr(`停用 ${c.code}？`, `Disable ${c.code}?`) : tr(`启用 ${c.code}？`, `Enable ${c.code}?`),
      description: c.enabled
        ? tr(
            "停用后用户不能再使用这个优惠码；已下的订单不受影响。",
            "Users can no longer apply it; existing orders stay.",
          )
        : tr("启用后用户可以在下单时使用这个优惠码。", "Users can apply it at checkout again."),
      tone: c.enabled ? "warning" : "default",
      action: () => patch(`/coupons/${c.id}`, { enabled: !c.enabled }),
    });
    if (ok) toast({ tone: "success", title: tr("已保存", "Saved") });
  };
  const remove = async () => {
    const ok = await confirm({
      title: tr(`删除 ${c.code}？`, `Delete ${c.code}?`),
      description: tr(
        "删除后不能恢复。只有从未被订单使用过的优惠券可以删除。",
        "This cannot be undone. Only never-used coupons can be deleted.",
      ),
      typeToConfirm: c.code,
      confirmLabel: tr("删除", "Delete"),
      action: () => del(`/coupons/${c.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("已删除", "Deleted") });
      onClose();
    }
  };
  const planNames = c.plan_ids?.map(
    (pid) => plans.find((p) => p.id === pid)?.name ?? tr("已删除的套餐", "Deleted plan"),
  );
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      dirty={dirty}
      title={<span className="font-mono">{c.code}</span>}
      description={
        <span className="flex flex-wrap items-center gap-1.5">
          {couponValue(c, tr)}
          <Badge tone={c.enabled ? "success" : "neutral"} dot>
            {c.enabled ? tr("启用", "On") : tr("停用", "Off")}
          </Badge>
        </span>
      }
      onSubmit={save}
      footer={
        <>
          <div className="mr-auto flex flex-wrap items-center gap-2">
            <Button
              variant="destructive-soft"
              icon={Trash2}
              onClick={remove}
              disabled={inUse}
              aria-describedby={inUse ? "coupon-delete-why" : undefined}
            >
              {tr("删除", "Delete")}
            </Button>
            {inUse && (
              <span id="coupon-delete-why" className="text-footnote text-muted-foreground">
                {tr("已被订单使用，不能删除，可以停用", "Used by orders: disable it instead")}
              </span>
            )}
          </div>
          <Button onClick={toggle}>{c.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <KV
          items={[
            [tr("最低消费", "Minimum"), c.min_amount_cents ? yuan(c.min_amount_cents) : tr("不限", "None")],
            [tr("生效", "Starts"), c.starts_at ? dateTime(c.starts_at) : tr("立即", "Now")],
            [tr("仅新用户", "New users only"), c.new_users_only ? tr("是", "Yes") : tr("否", "No")],
            [tr("已用", "Used"), tr(`${c.used} 次（已核销 ${c.redeemed}）`, `${c.used} (${c.redeemed} redeemed)`)],
            [tr("适用套餐", "Plans"), planNames?.join("、") || tr("全部", "All")],
            [tr("适用周期", "Terms"), c.periods?.map((p) => periodLabel(p, tr)).join("、") || tr("全部", "All")],
          ]}
        />
        <section>
          <SectionTitle>{tr("修改", "Edit")}</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("备注名称", "Name")}>
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={100} />
            </Field>
            <Field
              label={tr("总次数（空 = 不限）", "Total uses (empty = unlimited)")}
              error={shown.on("maxUses") ? errors.maxUses : undefined}
            >
              <Input
                inputMode="numeric"
                value={edit.maxUses}
                onChange={(e) => setEdit({ ...edit, maxUses: e.target.value })}
                onBlur={() => shown.show("maxUses")}
              />
            </Field>
            <Field
              label={tr("每人次数（空 = 不限）", "Per user (empty = unlimited)")}
              error={shown.on("perUser") ? errors.perUser : undefined}
            >
              <Input
                inputMode="numeric"
                value={edit.perUser}
                onChange={(e) => setEdit({ ...edit, perUser: e.target.value })}
                onBlur={() => shown.show("perUser")}
              />
            </Field>
            <Field
              label={tr("失效时间（站点时区）", "Ends (site time zone)")}
              hint={tr("空 = 长期有效", "Empty = no end")}
              error={shown.on("ends") ? errors.ends : undefined}
            >
              <Input
                type="datetime-local"
                value={edit.ends}
                onChange={(e) => setEdit({ ...edit, ends: e.target.value })}
                onBlur={() => shown.show("ends")}
              />
            </Field>
          </div>
        </section>
        <section>
          <SectionTitle>{tr("使用记录", "Redemptions")}</SectionTitle>
          {redemptions.length === 0 ? (
            <p className="text-body text-muted-foreground">{tr("还没有人使用。", "Not used yet.")}</p>
          ) : (
            <ul className="divide-y divide-separator rounded-lg text-body ring-1 ring-border ring-inset">
              {redemptions.map((r) => {
                const [text, tone] = redemptionText(r.status, tr);
                return (
                  <li key={r.order_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="font-mono text-footnote">{r.out_trade_no}</span>
                    <span className="min-w-0 truncate">{r.user_email ?? r.user_label}</span>
                    <Badge tone={tone}>{text}</Badge>
                    <span className="tnum ml-auto">-{yuan(r.discount_cents)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Dialog>
  );
}

const batchLabel = (b: Batch, tr: Tr) => b.name || b.prefix || tr("未命名批次", "Unnamed batch");

function Batches({ plans }: { plans: PlanView[] }) {
  const tr = useTr();
  const q = useQuery({ queryKey: ["coupon-batches"], queryFn: () => get<Batch[]>("/coupon-batches") });
  const [creating, setCreating] = useState(false);
  const [offset, setOffset] = useState(0);
  const rows = q.data ?? [];
  const LIMIT = 10;
  const at = offset < rows.length ? offset : 0;
  const columns: Column<Batch>[] = [
    {
      key: "name",
      header: tr("批次", "Batch"),
      fixed: true,
      mobile: "title",
      cell: (b) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{batchLabel(b, tr)}</span>
          {b.revoked_at && <Badge tone="danger">{tr("已作废", "Revoked")}</Badge>}
        </span>
      ),
    },
    {
      key: "codes",
      header: tr("码", "Codes"),
      cell: (b) => (
        <span className="tnum">
          {tr(
            `${b.codes} 个码 · 已用 ${b.used} · 核销 ${b.redeemed}`,
            `${b.codes} codes · ${b.used} used · ${b.redeemed} redeemed`,
          )}
        </span>
      ),
    },
    { key: "created", header: tr("生成时间", "Created"), cell: (b) => dateTime(b.created_at) },
    { key: "actor", header: tr("操作人", "By"), optional: true, cell: (b) => b.actor_label },
    {
      key: "act",
      header: <span className="sr-only">{tr("操作", "Actions")}</span>,
      label: tr("操作", "Actions"),
      fixed: true,
      align: "right",
      cell: (b) => <BatchActions b={b} />,
    },
  ];
  return (
    <section>
      <CardHeader
        className="px-1"
        title={tr("优惠码批次", "Code batches")}
        description={tr(
          "一次生成一批一次性的码（例如活动发放）；码在这里导出，不出现在上面的列表里。",
          "Generate many one-off codes at once (e.g. for a campaign); export them here — they are not in the list above.",
        )}
        actions={
          <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>
            {tr("批量生成优惠码", "Generate codes")}
          </Button>
        }
      />
      <div className="mt-1">
        <DataTable
          label={tr("优惠码批次", "Code batches")}
          rows={rows.slice(at, at + LIMIT)}
          columns={columns}
          loading={q.isPending}
          error={q.error}
          onRetry={() => void q.refetch()}
          empty={
            <EmptyState
              icon={TicketPercent}
              title={tr("还没有批次", "No batches yet")}
              description={tr(
                "需要大量一次性优惠码时，用「批量生成优惠码」。",
                "Use “Generate codes” for many one-off codes.",
              )}
            />
          }
          footer={rows.length > LIMIT && <Pager total={rows.length} offset={at} limit={LIMIT} onOffset={setOffset} />}
        />
      </div>
      {creating && <BatchDialog plans={plans} onClose={() => setCreating(false)} />}
    </section>
  );
}

/** Export and revoke of one batch (each button has its own busy state). */
function BatchActions({ b }: { b: Batch }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [download, downloading] = useAction();
  const label = batchLabel(b, tr);
  return (
    <span className="inline-flex flex-wrap justify-end gap-1.5">
      <Button
        size="sm"
        variant="outline"
        icon={Download}
        loading={downloading}
        onClick={() =>
          void download(() =>
            downloadFile(`/coupon-batches/${b.id}/export.csv`, `akari-coupon-batch-${b.id.slice(0, 8)}.csv`),
          )
        }
      >
        {tr("导出 CSV", "Export CSV")}
      </Button>
      {!b.revoked_at && (
        <Button
          size="sm"
          variant="destructive-soft"
          onClick={async () => {
            const ok = await confirm({
              title: tr(`作废批次「${label}」？`, `Revoke the batch "${label}"?`),
              description: tr(
                "整批码会被停用，用户不能再使用；已下的订单不受影响。不能撤销。",
                "Every code is disabled; existing orders stay. This cannot be undone.",
              ),
              impacts: [
                { label: tr("停用的码", "Codes disabled"), value: b.codes },
                { label: tr("已使用", "Already used"), value: b.used },
              ],
              typeToConfirm: label,
              confirmLabel: tr("作废", "Revoke"),
              action: () => post(`/coupon-batches/${b.id}/revoke`),
            });
            if (ok) toast({ tone: "success", title: tr("已作废", "Revoked") });
          }}
        >
          {tr("作废", "Revoke")}
        </Button>
      )}
    </span>
  );
}

function BatchDialog({ plans, onClose }: { plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [count, setCount] = useState("100");
  const [length, setLength] = useState("10");
  const [t, setT] = useState<Terms>({ ...EMPTY_TERMS, maxUses: "1" });
  const shown = useShown();
  const [run, busy] = useAction();
  const checked = checkTerms(t, tr);
  const n = intOf(count, 1, 5000, false, tr);
  const len = intOf(length, 6, 16, false, tr);
  const prefixErr = /^[A-Za-z0-9_-]{0,16}$/.test(prefix.trim())
    ? undefined
    : tr("最多 16 位字母、数字、- 或 _", "At most 16 of A-Z 0-9 - _");
  const submit = async () => {
    shown.showAll();
    if (!checked.body || typeof n === "string" || typeof len === "string" || prefixErr) return;
    const r = await run(
      () =>
        post("/coupon-batches", {
          ...checked.body,
          name: name.trim() || undefined,
          prefix: prefix.trim() || undefined,
          count: n,
          length: len,
        }),
      { ok: tr("已生成", "Generated") },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={tr("批量生成优惠码", "Generate codes")}
      description={tr(
        "每个码 = 前缀 + 随机字符；条款对整批相同。",
        "Each code = prefix + random characters; one set of terms.",
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("生成", "Generate")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={tr("批次名称", "Batch name")} className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} data-autofocus />
          </Field>
          <Field
            label={tr("前缀（可选）", "Prefix (optional)")}
            className="sm:col-span-2"
            error={shown.on("prefix") ? prefixErr : undefined}
          >
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} onBlur={() => shown.show("prefix")} />
          </Field>
          <Field
            label={tr("数量（1–5000）", "Count (1–5000)")}
            className="sm:col-span-2"
            error={shown.on("count") && typeof n === "string" ? n : undefined}
          >
            <Input
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              onBlur={() => shown.show("count")}
            />
          </Field>
          <Field
            label={tr("随机长度（6–16）", "Random length (6–16)")}
            className="sm:col-span-2"
            error={shown.on("length") && typeof len === "string" ? len : undefined}
          >
            <Input
              inputMode="numeric"
              value={length}
              onChange={(e) => setLength(e.target.value)}
              onBlur={() => shown.show("length")}
            />
          </Field>
        </div>
        <TermsFields t={t} set={setT} plans={plans} batch errors={checked.errors} shown={shown} />
      </div>
    </Dialog>
  );
}
