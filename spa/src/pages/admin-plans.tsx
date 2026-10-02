import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { del, describePeriod, get, patch, post, type GroupView, type NodeSummary, type PlanView } from "../lib/api";
import { PERIOD_KINDS, parseYuan, periodZh, sortPrices, yuan, type PeriodKind, type PlanPrice } from "../lib/billing";
import { GIB, humanBytes } from "../lib/utils";
import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { Dialog } from "../components/dialog";
import { RowMenu } from "../components/row-menu";
import { ErrorText, TableNote } from "../components/status";
import { useT } from "../i18n";
import { adminErrorText } from "../lib/admin-errors";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

// Plans grant node groups; a user's nodes are the members of their plan's
// groups (credentials are issued and revoked by the panel). W7: prices per
// period, description, stock, sale rules and an enforced speed limit.
// Admin console: Chinese only.
const selectCls =
  "h-9 rounded-lg border border-border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AdminPlans() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: () => get<GroupView[]>("/node-groups") });
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const nodes = useQuery({ queryKey: ["nodes", "summary"], queryFn: () => get<NodeSummary[]>("/nodes?view=summary") });
  return (
    <div className="space-y-6">
      <PlansCard plans={plans.data} loading={plans.isPending} groups={groups.data ?? []} />
      <GroupsCard groups={groups.data} loading={groups.isPending} nodes={nodes.data ?? []} />
    </div>
  );
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["groups"] }),
      queryClient.invalidateQueries({ queryKey: ["plans"] }),
      queryClient.invalidateQueries({ queryKey: ["users"] }),
    ]);
  };
}

function Checklist({
  label,
  items,
  selected,
  onChange,
}: {
  label: string;
  items: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">还没有{label}。</p>;
  return (
    <fieldset className="flex flex-wrap gap-3">
      <legend className="sr-only">{label}</legend>
      {items.map((it) => (
        <label key={it.id} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={selected.includes(it.id)}
            onChange={(e) => onChange(e.target.checked ? [...selected, it.id] : selected.filter((x) => x !== it.id))}
          />
          {it.name}
        </label>
      ))}
    </fieldset>
  );
}

// "monthly" | "none" | "days-N" from the form controls.
export function periodValue(kind: string, days: string): string | null {
  if (kind === "monthly" || kind === "none") return kind;
  const n = Number(days);
  return Number.isInteger(n) && n >= 1 && n <= 3650 ? `days-${n}` : null;
}

// GiB text -> bytes; "" = unlimited (null); undefined = invalid.
export function quotaBytes(gib: string): number | null | undefined {
  if (gib.trim() === "") return null;
  const n = Number(gib);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * GIB) : undefined;
}

// "" = unlimited (null); undefined = invalid. Positive integers only.
export function optionalInt(text: string, min: number, max: number): number | null | undefined {
  if (text.trim() === "") return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

// The plan's optional fields from the form, validated; a string = error.
// Device seats (R25) are reserved for the client's seat binding and not
// shown (W21): an existing value is left untouched.
function planFields(f: {
  speed: string;
  capacity: string;
}): { speed_limit_mbps: number | null; capacity: number | null } | string {
  const speed = optionalInt(f.speed, 1, 100000);
  if (speed === undefined) return "限速须为 1–100000 的整数（Mbps）";
  const capacity = optionalInt(f.capacity, 0, 100000000);
  if (capacity === undefined) return "库存须为非负整数";
  return { speed_limit_mbps: speed, capacity };
}

const PERIOD_EDIT_ZH: Record<PeriodKind, string> = {
  month: "月付",
  quarter: "季付",
  half_year: "半年付",
  year: "年付",
  two_year: "两年付",
  three_year: "三年付",
  days: "自定义天数",
  onetime: "一次性",
  reset: "流量重置包",
};

// One editable row per period kind (W7). Empty price = not sold in that
// period. Money is typed in yuan and sent as integer cents.
interface PriceDraft {
  enabled: boolean;
  price: string;
  days: string;
}

export function pricesBody(drafts: Record<PeriodKind, PriceDraft>): PlanPrice[] | string {
  const out: PlanPrice[] = [];
  for (const kind of PERIOD_KINDS) {
    const d = drafts[kind];
    if (!d.enabled) continue;
    const cents = parseYuan(d.price);
    if (cents == null || cents > 100000000) return `${PERIOD_EDIT_ZH[kind]}：价格无效`;
    let days: number | null = null;
    if (kind === "days" || kind === "onetime") {
      const n = optionalInt(d.days, 1, 3650);
      if (n === undefined || (kind === "days" && n == null)) return `${PERIOD_EDIT_ZH[kind]}：天数须为 1–3650`;
      days = n;
    }
    out.push({ period: kind, days, price_cents: cents });
  }
  return out;
}

function priceDrafts(plan: PlanView | null): Record<PeriodKind, PriceDraft> {
  const init = {} as Record<PeriodKind, PriceDraft>;
  for (const kind of PERIOD_KINDS) {
    const p = plan?.prices.find((x) => x.period === kind);
    init[kind] = {
      enabled: p != null,
      price: p ? yuan(p.price_cents) : "",
      days: p?.days != null ? String(p.days) : kind === "days" ? "30" : "",
    };
  }
  return init;
}

/** "monthly" | "none" | "days-N" -> the form's kind and days. */
function periodForm(p: string): { kind: string; days: string } {
  const m = /^days-(\d+)$/.exec(p);
  return m ? { kind: "days", days: m[1] } : { kind: p === "none" ? "none" : "monthly", days: "30" };
}

export interface PlanForm {
  name: string;
  quota: string;
  kind: string;
  days: string;
  speed: string;
  capacity: string;
  description: string;
  renewalOnly: boolean;
  allowSwitchIn: boolean;
  groupIds: string[];
  onSale: boolean;
  prices: Record<PeriodKind, PriceDraft>;
}

export function planForm(plan: PlanView | null): PlanForm {
  const period = periodForm(plan?.period ?? "monthly");
  return {
    name: plan?.name ?? "",
    quota: plan?.traffic_quota_bytes != null ? String(Number((plan.traffic_quota_bytes / GIB).toFixed(3))) : "",
    kind: period.kind,
    days: period.days,
    speed: plan?.speed_limit_mbps != null ? String(plan.speed_limit_mbps) : "",
    capacity: plan?.capacity != null ? String(plan.capacity) : "",
    description: plan?.description ?? "",
    renewalOnly: plan?.renewal_only ?? false,
    allowSwitchIn: plan?.allow_switch_in ?? true,
    groupIds: plan?.group_ids ?? [],
    onSale: plan?.on_sale ?? false,
    prices: priceDrafts(plan),
  };
}

/**
 * The one request of the plan dialog (W21, M11): POST /plans (new) or
 * PATCH /plans/{id} (changed fields only), with `pricing` — the server
 * applies the plan and its prices in one transaction. A string = what is
 * wrong in the form.
 */
export function planBody(f: PlanForm, plan: PlanView | null): Record<string, unknown> | string {
  const period = periodValue(f.kind, f.days);
  const traffic = quotaBytes(f.quota);
  if (!f.name.trim()) return "请填写名称";
  if (period == null) return "天数须为 1–3650 的整数";
  if (traffic === undefined) return "流量额度须为数字（GiB）";
  const fields = planFields(f);
  if (typeof fields === "string") return fields;
  const prices = pricesBody(f.prices);
  if (typeof prices === "string") return prices;
  if (f.onSale && !prices.some((p) => p.period !== "reset")) return "上架前至少设置一个流量重置包以外的价格";
  const pricing = { on_sale: f.onSale, prices };
  const all: Record<string, unknown> = {
    name: f.name.trim(),
    period,
    traffic_quota_bytes: traffic,
    group_ids: f.groupIds,
    speed_limit_mbps: fields.speed_limit_mbps,
    capacity: fields.capacity,
    description: f.description,
    renewal_only: f.renewalOnly,
    allow_switch_in: f.allowSwitchIn,
  };
  if (!plan) {
    // New plan: defaults left out.
    const body: Record<string, unknown> = {
      name: all.name,
      period,
      traffic_quota_bytes: traffic,
      group_ids: f.groupIds,
    };
    if (fields.speed_limit_mbps != null) body.speed_limit_mbps = fields.speed_limit_mbps;
    if (fields.capacity != null) body.capacity = fields.capacity;
    if (f.description.trim() !== "") body.description = f.description;
    if (f.renewalOnly) body.renewal_only = true;
    if (!f.allowSwitchIn) body.allow_switch_in = false;
    body.pricing = pricing;
    return body;
  }
  const was: Record<string, unknown> = {
    name: plan.name,
    period: plan.period,
    traffic_quota_bytes: plan.traffic_quota_bytes,
    group_ids: plan.group_ids,
    speed_limit_mbps: plan.speed_limit_mbps,
    capacity: plan.capacity,
    description: plan.description,
    renewal_only: plan.renewal_only,
    allow_switch_in: plan.allow_switch_in,
  };
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (JSON.stringify(v) !== JSON.stringify(was[k])) body[k] = v;
  }
  body.pricing = pricing;
  return body;
}

function PlansCard({ plans = [], loading, groups }: { plans?: PlanView[]; loading: boolean; groups: GroupView[] }) {
  const t = useT();
  const invalidate = useInvalidate();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  // null = closed; "new" = create; else the plan being edited.
  const [dialog, setDialog] = useState<PlanView | "new" | null>(null);

  async function toggle(p: PlanView) {
    if (
      p.enabled &&
      !(await confirm({
        title: `停用套餐「${p.name}」？`,
        message: "停用后购买页不再出售、也不能再分配给用户；已持有此套餐的用户不受影响，可随时重新启用。",
        confirmLabel: "停用",
        destructive: true,
      }))
    ) {
      return;
    }
    setError(null);
    try {
      await patch(`/plans/${p.id}`, { enabled: !p.enabled });
      await invalidate();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function remove(p: PlanView) {
    const ok = await confirm({
      title: `删除套餐「${p.name}」？`,
      message: "仍有用户持有此套餐时不能删除（可改为停用）。删除后不可恢复。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await del(`/plans/${p.id}`);
      await invalidate();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      {dialog && <PlanDialog plan={dialog === "new" ? null : dialog} groups={groups} onClose={() => setDialog(null)} />}
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div className="space-y-1.5">
          <CardTitle>
            <h1>套餐</h1>
          </CardTitle>
          <CardDescription>
            流量额度、重置周期、限速、授予的节点组与各周期价格，在一个对话框里设置、一次保存。
            限速按用户在每个节点上生效（上下行分别限制，节点 agent 需 ≥ 协议 4）。
          </CardDescription>
        </div>
        <Button onClick={() => setDialog("new")}>新建套餐</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorText>{error}</ErrorText>
        <Table label="套餐列表">
          <TableHeader>
            <TableRow>
              <TableHead>套餐</TableHead>
              <TableHead>流量额度</TableHead>
              <TableHead>重置</TableHead>
              <TableHead>限速</TableHead>
              <TableHead>价格</TableHead>
              <TableHead>用户 / 库存</TableHead>
              <TableHead>节点组</TableHead>
              <TableHead>状态</TableHead>
              <TableHead className="sticky right-0 z-[1] bg-card text-right">
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableNote colSpan={9}>加载中…</TableNote>}
            {!loading && plans.length === 0 && (
              <TableNote colSpan={9}>还没有套餐，点「新建套餐」创建第一个。</TableNote>
            )}
            {plans.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="whitespace-nowrap font-medium">{p.name}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {p.traffic_quota_bytes != null ? humanBytes(p.traffic_quota_bytes) : "不限"}
                </TableCell>
                <TableCell className="whitespace-nowrap">{describePeriod(p.period, t)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {p.speed_limit_mbps != null ? `${p.speed_limit_mbps} Mbps` : "不限"}
                </TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {p.prices.length === 0
                    ? "未定价"
                    : sortPrices(p.prices).map((x) => (
                        <div key={`${x.period}-${x.days ?? ""}`}>
                          {periodZh(x.period, x.days)} ¥{yuan(x.price_cents)}
                        </div>
                      ))}
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {p.active_users}
                  {p.capacity != null && ` / ${p.capacity}`}
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {p.group_ids.map((g) => (
                      <Badge key={g} variant="secondary">
                        {groupName(g)}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {!p.enabled ? (
                      <Badge variant="secondary">已停用</Badge>
                    ) : p.on_sale ? (
                      <Badge variant="success">在售</Badge>
                    ) : (
                      <Badge variant="outline">未上架</Badge>
                    )}
                    {p.renewal_only && <Badge variant="secondary">仅续费</Badge>}
                    {!p.allow_switch_in && <Badge variant="secondary">禁止换入</Badge>}
                    {p.capacity != null && p.active_users >= p.capacity && <Badge variant="destructive">满员</Badge>}
                  </span>
                </TableCell>
                <TableCell className="sticky right-0 z-[1] bg-card text-right">
                  <span className="inline-flex items-center gap-1">
                    <Button variant="outline" size="sm" aria-label={`编辑 ${p.name}`} onClick={() => setDialog(p)}>
                      编辑
                    </Button>
                    <RowMenu
                      label={`${p.name} 的更多操作`}
                      items={[
                        { label: p.enabled ? "停用" : "启用", onSelect: () => void toggle(p) },
                        { label: "删除", destructive: true, onSelect: () => void remove(p) },
                      ]}
                    />
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PlanDialog({ plan, groups, onClose }: { plan: PlanView | null; groups: GroupView[]; onClose: () => void }) {
  const invalidate = useInvalidate();
  const [f, setF] = useState<PlanForm>(() => planForm(plan));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<PlanForm>) => setF((x) => ({ ...x, ...p }));
  const setPrice = (kind: PeriodKind, p: Partial<PriceDraft>) =>
    setF((x) => ({ ...x, prices: { ...x.prices, [kind]: { ...x.prices[kind], ...p } } }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = planBody(f, plan);
    if (typeof body === "string") return setError(body);
    setBusy(true);
    try {
      if (plan) await patch(`/plans/${plan.id}`, body);
      else await post<PlanView>("/plans", body);
      await invalidate();
      onClose();
    } catch (err) {
      setError(adminErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={plan ? `编辑套餐「${plan.name}」` : "新建套餐"}
      description="套餐信息、价格与上架状态一次保存（同一事务：要么全部生效，要么都不变）。"
      onClose={onClose}
      className="sm:max-w-3xl"
    >
      <form className="space-y-5" onSubmit={save} aria-label={plan ? `编辑 ${plan.name}` : "新建套餐"} noValidate>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="pd-name">名称</Label>
            <Input id="pd-name" value={f.name} onChange={(e) => set({ name: e.target.value })} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pd-quota">流量额度（GiB，留空不限）</Label>
            <Input
              id="pd-quota"
              type="number"
              min="0"
              step="any"
              value={f.quota}
              onChange={(e) => set({ quota: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pd-period">流量重置</Label>
            <div className="flex gap-2">
              <select
                id="pd-period"
                className={selectCls}
                value={f.kind}
                onChange={(e) => set({ kind: e.target.value })}
              >
                <option value="monthly">每月</option>
                <option value="days">每 N 天</option>
                <option value="none">不重置</option>
              </select>
              {f.kind === "days" && (
                <Input
                  aria-label="天数"
                  className="w-24"
                  type="number"
                  min="1"
                  max="3650"
                  value={f.days}
                  onChange={(e) => set({ days: e.target.value })}
                />
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pd-speed">限速（Mbps，留空不限）</Label>
            <Input
              id="pd-speed"
              type="number"
              min="1"
              value={f.speed}
              onChange={(e) => set({ speed: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pd-capacity">库存（最多用户数，留空不限）</Label>
            <Input
              id="pd-capacity"
              type="number"
              min="0"
              value={f.capacity}
              onChange={(e) => set({ capacity: e.target.value })}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="pd-desc">说明（显示在购买页；以「- 」开头的行显示为列表）</Label>
          <textarea
            id="pd-desc"
            className="min-h-20 w-full rounded-lg border border-border bg-card p-2 text-sm"
            value={f.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={f.renewalOnly} onChange={(e) => set({ renewalOnly: e.target.checked })} />
            仅限现有用户续费
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={f.allowSwitchIn}
              onChange={(e) => set({ allowSwitchIn: e.target.checked })}
            />
            允许从其他套餐更换到此套餐
          </label>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">节点组</legend>
          <Checklist label="节点组" items={groups} selected={f.groupIds} onChange={(groupIds) => set({ groupIds })} />
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">价格（元）</legend>
          <p className="text-xs text-muted-foreground">
            勾选要出售的周期并填写价格（最多两位小数）。续费从当前到期时间顺延；更换套餐收新套餐全价，并按天数抵扣当前套餐剩余价值；
            流量重置包只对当前使用此套餐的用户出售，清零已用流量、不改变到期时间。
          </p>
          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
            {PERIOD_KINDS.map((kind) => {
              const d = f.prices[kind];
              const label = PERIOD_EDIT_ZH[kind];
              return (
                <div key={kind} className="flex items-center gap-2">
                  <label className="flex w-28 shrink-0 items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      onChange={(e) => setPrice(kind, { enabled: e.target.checked })}
                    />
                    {label}
                  </label>
                  <Input
                    aria-label={`${label} 价格`}
                    className="h-8 w-28"
                    inputMode="decimal"
                    placeholder="9.90"
                    disabled={!d.enabled}
                    value={d.price}
                    onChange={(e) => setPrice(kind, { price: e.target.value })}
                  />
                  {(kind === "days" || kind === "onetime") && (
                    <Input
                      aria-label={`${label} 天数`}
                      className="h-8 w-24"
                      inputMode="numeric"
                      placeholder={kind === "onetime" ? "留空=永久" : "天数"}
                      disabled={!d.enabled}
                      value={d.days}
                      onChange={(e) => setPrice(kind, { days: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <label className="flex items-center gap-1.5 pt-1 text-sm font-medium">
            <input type="checkbox" checked={f.onSale} onChange={(e) => set({ onSale: e.target.checked })} />
            上架（在购买页出售）
          </label>
        </fieldset>
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "保存中…" : plan ? "保存" : "创建套餐"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function GroupsCard({ groups = [], loading, nodes }: { groups?: GroupView[]; loading: boolean; nodes: NodeSummary[] }) {
  const invalidate = useInvalidate();
  const confirm = useConfirm();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [members, setMembers] = useState<string[]>([]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await post<GroupView>("/node-groups", { name, description });
      setName("");
      setDescription("");
      await invalidate();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function saveMembers(g: GroupView) {
    setError(null);
    try {
      await patch(`/node-groups/${g.id}`, { node_ids: members });
      setEditing(null);
      await invalidate();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function remove(g: GroupView) {
    const ok = await confirm({
      title: `删除节点组「${g.name}」？`,
      message: "授予该组的套餐会失去其中的节点，持有这些套餐的用户随即失去这些节点的访问权。",
      confirmLabel: "删除",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await del(`/node-groups/${g.id}`);
      await invalidate();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>节点组</h2>
        </CardTitle>
        <CardDescription>一个节点可以属于任意多个组；套餐通过节点组授予节点。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={create} aria-label="新建节点组">
          <div className="space-y-1.5">
            <Label htmlFor="ng-name">名称</Label>
            <Input id="ng-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ng-desc">说明</Label>
            <Input id="ng-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <Button type="submit">创建节点组</Button>
        </form>
        <ErrorText>{error}</ErrorText>
        <Table label="节点组列表">
          <TableHeader>
            <TableRow>
              <TableHead>节点组</TableHead>
              <TableHead>节点</TableHead>
              <TableHead>套餐数</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableNote colSpan={4}>加载中…</TableNote>}
            {!loading && groups.length === 0 && <TableNote colSpan={4}>还没有节点组。</TableNote>}
            {groups.map((g) => (
              <TableRow key={g.id}>
                <TableCell>
                  <p className="font-medium">{g.name}</p>
                  {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
                </TableCell>
                <TableCell className="space-y-2">
                  {editing === g.id ? (
                    <>
                      <Checklist label="节点" items={nodes} selected={members} onChange={setMembers} />
                      <Button size="sm" onClick={() => saveMembers(g)}>
                        保存成员
                      </Button>
                    </>
                  ) : (
                    <div className="space-x-1">
                      {g.node_ids.map((n) => (
                        <Badge key={n} variant="secondary">
                          {nodeName(n)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </TableCell>
                <TableCell>{g.plan_ids.length}</TableCell>
                <TableCell className="space-x-2 text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setMembers(g.node_ids);
                      setEditing(editing === g.id ? null : g.id);
                    }}
                  >
                    成员
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(g)}>
                    删除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
