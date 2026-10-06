// 优惠券 (CPN-*): coupons (list, create, detail with redemptions, edit,
// enable / disable, delete) and generated code batches (generate, CSV,
// revoke).
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiBase } from "../../shared/base";
import { del, get, patch, post } from "../../shared/api";
import { dateTime, fromLocalInput, parseYuan, toLocalInput, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Dialog, Drawer, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Field,
  Input,
  KV,
  PageHeader,
  Segmented,
  Skeleton,
  Switch,
} from "../../shared/ui/primitives";
import { DataTable, type Column } from "../../shared/ui/table";
import { FormError, SectionTitle, useRun } from "../kit";
import { setQuery, useRoute } from "../router";
import { PERIODS, periodLabel } from "../terms";
import type { PlanView } from "../types";
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

export function couponValue(c: { kind: string; value: number }, tr: Tr): string {
  return c.kind === "percent"
    ? tr(`${c.value}% 折扣`, `${c.value}% off`)
    : tr(`减 ${yuan(c.value)}`, `${yuan(c.value)} off`);
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

function termsBody(t: Terms, tr: Tr): Record<string, unknown> | string {
  let value: number | null;
  if (t.kind === "percent") {
    value = Number(t.value);
    if (!Number.isInteger(value) || value < 1 || value > 100)
      return tr("比例须为 1–100 的整数", "Percent must be 1–100");
  } else {
    value = parseYuan(t.value);
    if (!value) return tr("金额无效（元）", "Invalid amount (yuan)");
  }
  const min = t.min.trim() ? parseYuan(t.min) : 0;
  if (min === null) return tr("最低消费无效", "Invalid minimum");
  const int = (s: string) => (s.trim() ? Number(s) : undefined);
  return {
    kind: t.kind,
    value,
    plan_ids: t.planIds.length ? t.planIds : undefined,
    periods: t.periods.length ? t.periods : undefined,
    min_amount_cents: min,
    starts_at: t.starts ? fromLocalInput(t.starts) : undefined,
    ends_at: t.ends ? fromLocalInput(t.ends) : undefined,
    max_uses: int(t.maxUses),
    per_user_limit: int(t.perUser),
    new_users_only: t.newOnly,
  };
}

function TermsFields({
  t,
  set,
  plans,
  batch,
}: {
  t: Terms;
  set: (t: Terms) => void;
  plans: PlanView[];
  batch?: boolean;
}) {
  const tr = useTr();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field group label={tr("优惠类型", "Kind")}>
        <Segmented
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
      >
        <Input inputMode="decimal" value={t.value} onChange={(e) => set({ ...t, value: e.target.value })} />
      </Field>
      <Field label={tr("最低消费（元，原价）", "Minimum (yuan, list price)")}>
        <Input inputMode="decimal" value={t.min} onChange={(e) => set({ ...t, min: e.target.value })} />
      </Field>
      <Field
        label={
          batch
            ? tr("每码次数（空 = 不限，默认 1）", "Uses per code (empty = unlimited)")
            : tr("总次数（空 = 不限）", "Total uses (empty = unlimited)")
        }
      >
        <Input inputMode="numeric" value={t.maxUses} onChange={(e) => set({ ...t, maxUses: e.target.value })} />
      </Field>
      <Field label={tr("每人次数（空 = 不限）", "Per user (empty = unlimited)")}>
        <Input inputMode="numeric" value={t.perUser} onChange={(e) => set({ ...t, perUser: e.target.value })} />
      </Field>
      <label className="flex items-end gap-2 pb-2 text-[13px]">
        <Switch
          checked={t.newOnly}
          onChange={(v) => set({ ...t, newOnly: v })}
          label={tr("仅新用户（首单）", "New users only (first order)")}
        />
        {tr("仅新用户（首单）", "New users only (first order)")}
      </label>
      <Field label={tr("生效时间（站点时区）", "Starts (site time zone)")}>
        <Input type="datetime-local" value={t.starts} onChange={(e) => set({ ...t, starts: e.target.value })} />
      </Field>
      <Field label={tr("失效时间（站点时区）", "Ends (site time zone)")}>
        <Input type="datetime-local" value={t.ends} onChange={(e) => set({ ...t, ends: e.target.value })} />
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-[13px] font-medium">{tr("适用套餐（不选 = 全部）", "Plans (none = all)")}</legend>
        <div className="flex flex-wrap gap-2">
          {plans.map((p) => (
            <label key={p.id} className="flex items-center gap-1.5 text-[13px]">
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
      </fieldset>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-[13px] font-medium">{tr("适用周期（不选 = 全部）", "Terms (none = all)")}</legend>
        <div className="flex flex-wrap gap-2">
          {PERIODS.map((p) => (
            <label key={p} className="flex items-center gap-1.5 text-[13px]">
              <Checkbox
                checked={t.periods.includes(p)}
                label={periodLabel(p, tr)}
                onChange={(on) => set({ ...t, periods: on ? [...t.periods, p] : t.periods.filter((x) => x !== p) })}
              />
              {periodLabel(p, tr)}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

export function CouponsPage() {
  const tr = useTr();
  const { query } = useRoute();
  const open = query.get("open");
  const plans = usePlans();
  const list = useQuery({ queryKey: ["coupons"], queryFn: () => get<Coupon[]>("/coupons") });
  const [creating, setCreating] = useState(false);
  const columns: Column<Coupon>[] = [
    {
      key: "code",
      header: tr("优惠码", "Code"),
      fixed: true,
      mobile: "title",
      cell: (c) => <span className="font-mono">{c.code}</span>,
    },
    { key: "name", header: tr("名称", "Name"), cell: (c) => c.name || "—" },
    { key: "value", header: tr("面值", "Value"), cell: (c) => couponValue(c, tr) },
    { key: "uses", header: tr("已用 / 总次数", "Used / max"), cell: (c) => `${c.used} / ${c.max_uses ?? "∞"}` },
    {
      key: "window",
      header: tr("有效期", "Valid"),
      optional: true,
      cell: (c) => `${dateTime(c.starts_at)} → ${dateTime(c.ends_at)}`,
    },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (c) => (
        <Badge tone={c.enabled ? "success" : "neutral"}>{c.enabled ? tr("启用", "On") : tr("停用", "Off")}</Badge>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        title={tr("优惠券", "Coupons")}
        actions={
          <Button size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {tr("新建优惠券", "New coupon")}
          </Button>
        }
      />
      <DataTable
        label={tr("优惠券", "Coupons")}
        storageKey="coupons"
        rows={list.data ?? []}
        columns={columns}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        onRowClick={(c) => setQuery({ open: c.id }, false)}
        activeId={open}
      />
      <div className="mt-4">
        <Batches plans={plans.data ?? []} />
      </div>
      {creating && <CreateCoupon plans={plans.data ?? []} onClose={() => setCreating(false)} />}
      {open && <CouponDrawer id={open} onClose={() => setQuery({ open: null })} />}
    </>
  );
}

function CreateCoupon({ plans, onClose }: { plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [t, setT] = useState<Terms>(EMPTY_TERMS);
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const submit = async () => {
    const b = termsBody(t, tr);
    if (typeof b === "string") return setError(new Error(b));
    const r = await run(() => post("/coupons", { code: code.trim(), name: name.trim() || undefined, ...b }), {
      ok: tr("优惠券已创建", "Coupon created"),
      invalidate: [["coupons"]],
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={tr("新建优惠券", "New coupon")}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!code.trim()}>
            {tr("创建", "Create")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("优惠码（3–32 位字母、数字、- 或 _）", "Code (3–32 of A-Z 0-9 - _)")}>
            <Input value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <Field label={tr("备注名称", "Name")}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <TermsFields t={t} set={setT} plans={plans} />
        <FormError error={error} />
      </div>
    </Dialog>
  );
}

function CouponDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["coupons", id],
    queryFn: () => get<{ coupon: Coupon; redemptions: Redemption[] }>(`/coupons/${id}`),
  });
  const c = q.data?.coupon;
  const [edit, setEdit] = useState<{ name: string; maxUses: string; perUser: string; ends: string } | null>(null);
  const [run, busy] = useRun();
  useEffect(() => {
    if (c && !edit)
      setEdit({
        name: c.name,
        maxUses: c.max_uses === null ? "" : String(c.max_uses),
        perUser: c.per_user_limit === null ? "" : String(c.per_user_limit),
        ends: toLocalInput(c.ends_at),
      });
  }, [c, edit]);
  const save = async () => {
    if (!c || !edit) return;
    await run(
      () =>
        patch(`/coupons/${c.id}`, {
          name: edit.name,
          max_uses: edit.maxUses.trim() ? Number(edit.maxUses) : null,
          per_user_limit: edit.perUser.trim() ? Number(edit.perUser) : null,
          ends_at: edit.ends ? fromLocalInput(edit.ends) : null,
        }),
      { ok: tr("已保存", "Saved"), invalidate: [["coupons"]] },
    );
  };
  const toggle = async () => {
    if (!c) return;
    const ok = await confirm({
      title: c.enabled ? tr(`停用 ${c.code}？`, `Disable ${c.code}?`) : tr(`启用 ${c.code}？`, `Enable ${c.code}?`),
      tone: c.enabled ? "warning" : "default",
    });
    if (ok)
      await run(() => patch(`/coupons/${c.id}`, { enabled: !c.enabled }), {
        ok: tr("已保存", "Saved"),
        invalidate: [["coupons"]],
      });
  };
  const remove = async () => {
    if (!c) return;
    const ok = await confirm({
      title: tr(`删除 ${c.code}？`, `Delete ${c.code}?`),
      description: tr("只能删除从未使用的优惠券。", "Only never-used coupons can be deleted."),
      action: () => del(`/coupons/${c.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("已删除", "Deleted") });
      void run(async () => undefined, { invalidate: [["coupons"]] });
      onClose();
    }
  };
  return (
    <Drawer
      open
      onClose={onClose}
      title={c ? <span className="font-mono">{c.code}</span> : tr("优惠券", "Coupon")}
      subtitle={c && couponValue(c, tr)}
      footer={
        c && (
          <>
            <Button variant="destructive-soft" onClick={remove} disabled={c.used > 0}>
              {tr("删除", "Delete")}
            </Button>
            <Button onClick={toggle}>{c.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}</Button>
          </>
        )
      }
    >
      {q.isPending && <Skeleton className="h-40" />}
      <FormError error={q.error} />
      {c && edit && (
        <>
          <KV
            items={[
              [tr("最低消费", "Minimum"), yuan(c.min_amount_cents)],
              [tr("生效", "Starts"), dateTime(c.starts_at)],
              [tr("仅新用户", "New users only"), c.new_users_only ? tr("是", "yes") : tr("否", "no")],
              [tr("已用", "Used"), `${c.used}（${tr("已核销", "redeemed")} ${c.redeemed}）`],
              [tr("适用周期", "Terms"), c.periods?.map((p) => periodLabel(p, tr)).join(", ") ?? tr("全部", "all")],
            ]}
          />
          <SectionTitle>{tr("修改", "Edit")}</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("备注名称", "Name")}>
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label={tr("总次数（空 = 不限）", "Total uses (empty = unlimited)")}>
              <Input
                inputMode="numeric"
                value={edit.maxUses}
                onChange={(e) => setEdit({ ...edit, maxUses: e.target.value })}
              />
            </Field>
            <Field label={tr("每人次数（空 = 不限）", "Per user (empty = unlimited)")}>
              <Input
                inputMode="numeric"
                value={edit.perUser}
                onChange={(e) => setEdit({ ...edit, perUser: e.target.value })}
              />
            </Field>
            <Field label={tr("失效时间（站点时区）", "Ends (site time zone)")}>
              <Input
                type="datetime-local"
                value={edit.ends}
                onChange={(e) => setEdit({ ...edit, ends: e.target.value })}
              />
            </Field>
          </div>
          <Button className="mt-3" size="sm" variant="primary" loading={busy} onClick={save}>
            {tr("保存", "Save")}
          </Button>
          <SectionTitle>{tr("使用记录", "Redemptions")}</SectionTitle>
          {q.data?.redemptions.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{tr("还没有人使用。", "Not used yet.")}</p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
              {q.data?.redemptions.map((r) => (
                <li key={r.order_id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                  <span className="font-mono text-xs">{r.out_trade_no}</span>
                  <span>{r.user_email ?? r.user_label}</span>
                  <Badge>{r.status}</Badge>
                  <span className="ml-auto tabular-nums">-{yuan(r.discount_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Drawer>
  );
}

function Batches({ plans }: { plans: PlanView[] }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run] = useRun();
  const q = useQuery({ queryKey: ["coupon-batches"], queryFn: () => get<Batch[]>("/coupon-batches") });
  const [creating, setCreating] = useState(false);
  return (
    <Card>
      <CardHeader
        title={tr("优惠码批次", "Code batches")}
        actions={
          <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
            {tr("批量生成优惠码", "Generate codes")}
          </Button>
        }
      />
      {q.isPending ? (
        <Skeleton className="m-4 h-16" />
      ) : (q.data ?? []).length === 0 ? (
        <p className="px-5 py-4 text-[13px] text-muted-foreground">{tr("还没有批次。", "No batches yet.")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {q.data?.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13px] sm:px-5">
              <span className="font-medium">{b.name || b.prefix}</span>
              {b.revoked_at && <Badge tone="danger">{tr("已作废", "Revoked")}</Badge>}
              <span className="text-xs text-muted-foreground">
                {tr(
                  `${b.codes} 个码 · 已用 ${b.used} · 核销 ${b.redeemed}`,
                  `${b.codes} codes · ${b.used} used · ${b.redeemed} redeemed`,
                )}{" "}
                · {dateTime(b.created_at)}
              </span>
              <span className="ml-auto flex gap-2">
                <a
                  href={`${apiBase}/coupon-batches/${b.id}/export.csv`}
                  download
                  className="inline-flex h-8 items-center rounded-md border border-border px-2.5 text-[13px] hover:bg-muted"
                >
                  {tr("导出 CSV", "Export CSV")}
                </a>
                {!b.revoked_at && (
                  <Button
                    size="sm"
                    variant="destructive-soft"
                    onClick={async () => {
                      const ok = await confirm({
                        title: tr("作废整批优惠码？", "Revoke the whole batch?"),
                        impact: tr(`停用 ${b.codes} 个码`, `${b.codes} codes disabled`),
                        typeToConfirm: String(b.codes),
                      });
                      if (ok)
                        await run(() => post(`/coupon-batches/${b.id}/revoke`), {
                          ok: tr("已作废", "Revoked"),
                          invalidate: [["coupon-batches"], ["coupons"]],
                        });
                    }}
                  >
                    {tr("作废", "Revoke")}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {creating && <BatchDialog plans={plans} onClose={() => setCreating(false)} />}
    </Card>
  );
}

function BatchDialog({ plans, onClose }: { plans: PlanView[]; onClose: () => void }) {
  const tr = useTr();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  const [count, setCount] = useState("100");
  const [length, setLength] = useState("10");
  const [t, setT] = useState<Terms>({ ...EMPTY_TERMS, maxUses: "1" });
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const submit = async () => {
    const b = termsBody(t, tr);
    if (typeof b === "string") return setError(new Error(b));
    const r = await run(
      () =>
        post("/coupon-batches", {
          ...b,
          name: name.trim() || undefined,
          prefix: prefix.trim() || undefined,
          count: Number(count),
          length: Number(length),
          max_uses: t.maxUses.trim() ? Number(t.maxUses) : null,
        }),
      { ok: tr("已生成", "Generated"), invalidate: [["coupon-batches"], ["coupons"]] },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={tr("批量生成优惠码", "Generate codes")}
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
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={tr("批次名称", "Batch name")} className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={tr("前缀（可选）", "Prefix (optional)")}>
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </Field>
          <Field label={tr("数量（1–5000）", "Count (1–5000)")}>
            <Input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
          </Field>
          <Field label={tr("随机长度（6–16）", "Random length (6–16)")}>
            <Input inputMode="numeric" value={length} onChange={(e) => setLength(e.target.value)} />
          </Field>
        </div>
        <TermsFields t={t} set={setT} plans={plans} batch />
        <FormError error={error} />
      </div>
    </Dialog>
  );
}
