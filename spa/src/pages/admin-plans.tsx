import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  del,
  describePeriod,
  get,
  patch,
  post,
  put,
  type GroupView,
  type NodeSummary,
  type PlanView,
} from "../lib/api";
import { PERIOD_KINDS, parseYuan, periodZh, yuan, type PeriodKind, type PlanPrice } from "../lib/billing";
import { GIB, humanBytes } from "../lib/utils";
import { ErrorText, TableNote } from "../components/status";
import { useT } from "../i18n";
import { adminErrorText, errorText } from "../lib/errors";
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
function planFields(f: {
  speed: string;
  seats: string;
  capacity: string;
}): { speed_limit_mbps: number | null; device_seats: number | null; capacity: number | null } | string {
  const speed = optionalInt(f.speed, 1, 100000);
  if (speed === undefined) return "限速须为 1–100000 的整数（Mbps）";
  const seats = optionalInt(f.seats, 0, 10000);
  if (seats === undefined) return "设备数须为非负整数";
  const capacity = optionalInt(f.capacity, 0, 100000000);
  if (capacity === undefined) return "库存须为非负整数";
  return { speed_limit_mbps: speed, device_seats: seats, capacity };
}

function PlansCard({ plans = [], loading, groups }: { plans?: PlanView[]; loading: boolean; groups: GroupView[] }) {
  const t = useT();
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [quota, setQuota] = useState("");
  const [kind, setKind] = useState("monthly");
  const [days, setDays] = useState("30");
  const [speed, setSpeed] = useState("");
  const [seats, setSeats] = useState("");
  const [capacity, setCapacity] = useState("");
  const [description, setDescription] = useState("");
  const [renewalOnly, setRenewalOnly] = useState(false);
  const [allowSwitchIn, setAllowSwitchIn] = useState(true);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pricing, setPricing] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const period = periodValue(kind, days);
    const traffic = quotaBytes(quota);
    if (period == null) return setError("天数须为 1–3650 的整数");
    if (traffic === undefined) return setError("流量额度须为数字（GiB）");
    const fields = planFields({ speed, seats, capacity });
    if (typeof fields === "string") return setError(fields);
    const body: Record<string, unknown> = {
      name,
      period,
      traffic_quota_bytes: traffic,
      group_ids: groupIds,
    };
    if (fields.speed_limit_mbps != null) body.speed_limit_mbps = fields.speed_limit_mbps;
    if (fields.device_seats != null) body.device_seats = fields.device_seats;
    if (fields.capacity != null) body.capacity = fields.capacity;
    if (description.trim() !== "") body.description = description;
    if (renewalOnly) body.renewal_only = true;
    if (!allowSwitchIn) body.allow_switch_in = false;
    try {
      const created = await post<PlanView>("/plans", body);
      setName("");
      setQuota("");
      setSpeed("");
      setSeats("");
      setCapacity("");
      setDescription("");
      setRenewalOnly(false);
      setAllowSwitchIn(true);
      setGroupIds([]);
      await invalidate();
      setPricing(created.id);
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function toggle(p: PlanView) {
    setError(null);
    try {
      await patch(`/plans/${p.id}`, { enabled: !p.enabled });
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function remove(p: PlanView) {
    if (!window.confirm(`删除套餐「${p.name}」？`)) return;
    setError(null);
    try {
      await del(`/plans/${p.id}`);
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? id.slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>套餐</h1>
        </CardTitle>
        <CardDescription>
          流量额度、重置周期、限速与授予的节点组；在「定价」里按周期（月/季/半年/年/两年/三年/自定义天数/一次性/流量重置包）设置价格并上架。
          限速按用户在每个节点上生效（上下行分别限制，节点 agent 需 ≥ 协议 4）；设备数为席位绑定预留，客户端上线后生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="space-y-3" onSubmit={create} aria-label="新建套餐">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="np-name">名称</Label>
              <Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-quota">流量额度（GiB，留空不限）</Label>
              <Input
                id="np-quota"
                type="number"
                min="0"
                step="any"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-period">流量重置</Label>
              <select
                id="np-period"
                className="h-9 rounded-lg border border-border bg-card px-2 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="monthly">每月</option>
                <option value="days">每 N 天</option>
                <option value="none">不重置</option>
              </select>
            </div>
            {kind === "days" && (
              <div className="space-y-1.5">
                <Label htmlFor="np-days">天数</Label>
                <Input
                  id="np-days"
                  type="number"
                  min="1"
                  max="3650"
                  value={days}
                  onChange={(e) => setDays(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="np-speed">限速（Mbps，留空不限）</Label>
              <Input id="np-speed" type="number" min="1" value={speed} onChange={(e) => setSpeed(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-capacity">库存（最多用户数，留空不限）</Label>
              <Input
                id="np-capacity"
                type="number"
                min="0"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="np-seats">设备数（客户端上线后生效）</Label>
              <Input id="np-seats" type="number" min="0" value={seats} onChange={(e) => setSeats(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="np-desc">说明（显示在购买页；以「- 」开头的行显示为列表）</Label>
            <textarea
              id="np-desc"
              className="min-h-20 w-full rounded-lg border border-border bg-card p-2 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={renewalOnly} onChange={(e) => setRenewalOnly(e.target.checked)} />
              仅限现有用户续费
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={allowSwitchIn} onChange={(e) => setAllowSwitchIn(e.target.checked)} />
              允许从其他套餐更换到此套餐
            </label>
          </div>
          <Checklist label="节点组" items={groups} selected={groupIds} onChange={setGroupIds} />
          <Button type="submit">创建套餐</Button>
        </form>
        <ErrorText>{error}</ErrorText>
        <Table>
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
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && <TableNote colSpan={9}>加载中…</TableNote>}
            {!loading && plans.length === 0 && <TableNote colSpan={9}>还没有套餐。</TableNote>}
            {plans.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  {p.name}
                  {editing === p.id && (
                    <EditPlan plan={p} groups={groups} onDone={() => setEditing(null)} onError={setError} />
                  )}
                  {pricing === p.id && <PriceEditor plan={p} onDone={() => setPricing(null)} />}
                </TableCell>
                <TableCell>{p.traffic_quota_bytes != null ? humanBytes(p.traffic_quota_bytes) : "不限"}</TableCell>
                <TableCell>{describePeriod(p.period, t)}</TableCell>
                <TableCell>{p.speed_limit_mbps != null ? `${p.speed_limit_mbps} Mbps` : "不限"}</TableCell>
                <TableCell className="text-xs">
                  {p.prices.length === 0
                    ? "未定价"
                    : p.prices.map((x) => (
                        <div key={x.period}>
                          {periodZh(x.period, x.days)} ¥{yuan(x.price_cents)}
                        </div>
                      ))}
                </TableCell>
                <TableCell>
                  {p.active_users}
                  {p.capacity != null && ` / ${p.capacity}`}
                </TableCell>
                <TableCell className="space-x-1">
                  {p.group_ids.map((g) => (
                    <Badge key={g} variant="secondary">
                      {groupName(g)}
                    </Badge>
                  ))}
                </TableCell>
                <TableCell className="space-x-1">
                  {!p.enabled ? (
                    <Badge variant="secondary">已停用</Badge>
                  ) : p.on_sale ? (
                    <Badge variant="success">在售</Badge>
                  ) : (
                    <Badge variant="secondary">未上架</Badge>
                  )}
                  {p.renewal_only && <Badge variant="secondary">仅续费</Badge>}
                  {!p.allow_switch_in && <Badge variant="secondary">禁止换入</Badge>}
                  {p.capacity != null && p.active_users >= p.capacity && <Badge variant="destructive">满员</Badge>}
                </TableCell>
                <TableCell className="space-x-2 whitespace-nowrap text-right">
                  <Button variant="outline" size="sm" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    编辑
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPricing(pricing === p.id ? null : p.id)}>
                    定价
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => toggle(p)}>
                    {p.enabled ? "停用" : "启用"}
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => remove(p)}>
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

function EditPlan({
  plan,
  groups,
  onDone,
  onError,
}: {
  plan: PlanView;
  groups: GroupView[];
  onDone: () => void;
  onError: (e: string | null) => void;
}) {
  const t = useT();
  const invalidate = useInvalidate();
  const id = plan.id;
  const [quota, setQuota] = useState(plan.traffic_quota_bytes != null ? String(plan.traffic_quota_bytes / GIB) : "");
  const [speed, setSpeed] = useState(plan.speed_limit_mbps != null ? String(plan.speed_limit_mbps) : "");
  const [seats, setSeats] = useState(plan.device_seats != null ? String(plan.device_seats) : "");
  const [capacity, setCapacity] = useState(plan.capacity != null ? String(plan.capacity) : "");
  const [description, setDescription] = useState(plan.description);
  const [renewalOnly, setRenewalOnly] = useState(plan.renewal_only);
  const [allowSwitchIn, setAllowSwitchIn] = useState(plan.allow_switch_in);
  const [groupIds, setGroupIds] = useState<string[]>(plan.group_ids);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    onError(null);
    const traffic = quotaBytes(quota);
    if (traffic === undefined) return onError("流量额度须为数字（GiB）");
    const fields = planFields({ speed, seats, capacity });
    if (typeof fields === "string") return onError(fields);
    try {
      await patch(`/plans/${id}`, {
        traffic_quota_bytes: traffic,
        group_ids: groupIds,
        ...fields,
        description,
        renewal_only: renewalOnly,
        allow_switch_in: allowSwitchIn,
      });
      await invalidate();
      onDone();
    } catch (err) {
      onError(errorText(err, t));
    }
  }

  return (
    <form className="mt-2 space-y-2 font-normal" onSubmit={save} aria-label={`编辑 ${plan.name}`}>
      <div className="flex flex-wrap gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`ep-quota-${id}`}>流量额度（GiB，留空不限）</Label>
          <Input
            id={`ep-quota-${id}`}
            type="number"
            min="0"
            step="any"
            value={quota}
            onChange={(e) => setQuota(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ep-speed-${id}`}>限速（Mbps，留空不限）</Label>
          <Input id={`ep-speed-${id}`} type="number" min="1" value={speed} onChange={(e) => setSpeed(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ep-capacity-${id}`}>库存（留空不限）</Label>
          <Input
            id={`ep-capacity-${id}`}
            type="number"
            min="0"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`ep-seats-${id}`}>设备数（客户端上线后生效）</Label>
          <Input id={`ep-seats-${id}`} type="number" min="0" value={seats} onChange={(e) => setSeats(e.target.value)} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`ep-desc-${id}`}>说明</Label>
        <textarea
          id={`ep-desc-${id}`}
          className="min-h-20 w-full rounded-lg border border-border bg-card p-2 text-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={renewalOnly} onChange={(e) => setRenewalOnly(e.target.checked)} />
          仅限现有用户续费
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={allowSwitchIn} onChange={(e) => setAllowSwitchIn(e.target.checked)} />
          允许从其他套餐更换到此套餐
        </label>
      </div>
      <Checklist label="节点组" items={groups} selected={groupIds} onChange={setGroupIds} />
      <Button type="submit" size="sm">
        保存
      </Button>
    </form>
  );
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

function PriceEditor({ plan, onDone }: { plan: PlanView; onDone: () => void }) {
  const invalidate = useInvalidate();
  const [drafts, setDrafts] = useState<Record<PeriodKind, PriceDraft>>(() => {
    const init = {} as Record<PeriodKind, PriceDraft>;
    for (const kind of PERIOD_KINDS) {
      const p = plan.prices.find((x) => x.period === kind);
      init[kind] = {
        enabled: p != null,
        price: p ? yuan(p.price_cents) : "",
        days: p?.days != null ? String(p.days) : kind === "days" ? "30" : "",
      };
    }
    return init;
  });
  const [onSale, setOnSale] = useState(plan.on_sale);
  const [error, setError] = useState<string | null>(null);
  const set = (kind: PeriodKind, patchDraft: Partial<PriceDraft>) =>
    setDrafts((d) => ({ ...d, [kind]: { ...d[kind], ...patchDraft } }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const prices = pricesBody(drafts);
    if (typeof prices === "string") return setError(prices);
    try {
      await put(`/plans/${plan.id}/prices`, { on_sale: onSale, prices });
      await invalidate();
      onDone();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  return (
    <form className="mt-2 space-y-2 font-normal" onSubmit={save} aria-label={`定价 ${plan.name}`}>
      <p className="text-xs text-muted-foreground">
        价格以元填写（最多两位小数）。续费从当前到期时间顺延；更换套餐收新套餐全价，并按天数抵扣当前套餐剩余价值；
        流量重置包只对当前使用此套餐的用户出售，清零已用流量、不改变到期时间。
      </p>
      <table className="text-sm">
        <tbody>
          {PERIOD_KINDS.map((kind) => {
            const d = drafts[kind];
            const label = PERIOD_EDIT_ZH[kind];
            return (
              <tr key={kind}>
                <td className="pr-3">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={d.enabled}
                      onChange={(e) => set(kind, { enabled: e.target.checked })}
                    />
                    {label}
                  </label>
                </td>
                <td className="pr-3">
                  <Input
                    aria-label={`${plan.name} ${label} 价格`}
                    className="h-8 w-28"
                    inputMode="decimal"
                    placeholder="9.90"
                    disabled={!d.enabled}
                    value={d.price}
                    onChange={(e) => set(kind, { price: e.target.value })}
                  />
                </td>
                <td>
                  {(kind === "days" || kind === "onetime") && (
                    <Input
                      aria-label={`${plan.name} ${label} 天数`}
                      className="h-8 w-24"
                      inputMode="numeric"
                      placeholder={kind === "onetime" ? "留空=永久" : "天数"}
                      disabled={!d.enabled}
                      value={d.days}
                      onChange={(e) => set(kind, { days: e.target.value })}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <label className="flex items-center gap-1.5 text-sm">
        <input type="checkbox" checked={onSale} onChange={(e) => setOnSale(e.target.checked)} />
        上架（在购买页出售）
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          保存定价
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          取消
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

function GroupsCard({ groups = [], loading, nodes }: { groups?: GroupView[]; loading: boolean; nodes: NodeSummary[] }) {
  const t = useT();
  const invalidate = useInvalidate();
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
      setError(errorText(err, t));
    }
  }

  async function saveMembers(g: GroupView) {
    setError(null);
    try {
      await patch(`/node-groups/${g.id}`, { node_ids: members });
      setEditing(null);
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
    }
  }

  async function remove(g: GroupView) {
    if (!window.confirm(`删除节点组「${g.name}」？授予该组的套餐会失去其中的节点。`)) return;
    setError(null);
    try {
      await del(`/node-groups/${g.id}`);
      await invalidate();
    } catch (err) {
      setError(errorText(err, t));
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>节点组</TableHead>
              <TableHead>节点</TableHead>
              <TableHead>套餐数</TableHead>
              <TableHead className="text-right">操作</TableHead>
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
