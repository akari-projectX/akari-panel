// 套餐 (PLN-*, NOD-21): plan cards, the plan dialog (terms, sale rules,
// node groups with the entrances users get, prices — one request), the
// impact preview with "apply to existing subscribers" (a confirmation
// stacked over the dialog), enable / disable / delete; and the node groups
// tab (plan → group → entrance). Both tabs use the same row menu; plans and
// groups refresh each other (data.ts: a write to either refetches both).
import { AlertDialog as A } from "radix-ui";
import { useMemo, useState } from "react";
import { del, patch, post } from "../../shared/api";
import { bytes, centsToYuanText, parseYuan, pct, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { SectionTitle } from "../kit";
import { useAction } from "../data";
import { navigate, setQuery, useRoute } from "../router";
import { PERIODS, periodLabel, resetLabel } from "../terms";
import type { NodeGroup, PlanView, ServerView } from "../types";
import { useGroups, usePlanList, useServers } from "../servers";
import { FixCount, Summary, num, shown, type NumRule } from "./node-common";
import {
  ArrowRightLeft,
  Layers,
  Package,
  Pause,
  Play,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Users,
  Zap,
  Gauge,
} from "lucide-react";
import { Meter } from "../../shared/ui/meter";
import { cn } from "../../shared/cn";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Select, SwitchField, Textarea } from "../../shared/ui/form";
import { Callout, PageHeader } from "../../shared/ui/layout";
import { MenuItem, RowMenu } from "../../shared/ui/menu";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";

const GiB = 1024 ** 3;

type EntranceInfo = { label: string; relay: boolean; hidden: boolean; rate: number; server: string };

/** Entrance id → "server / node / entrance" (and whether it is a relay). */
function useEntranceIndex(servers: ServerView[] | undefined) {
  return useMemo(() => {
    const m = new Map<string, EntranceInfo>();
    for (const s of servers ?? [])
      for (const n of s.nodes)
        for (const e of n.entrances)
          m.set(e.id, {
            label: `${n.display_name || n.name} · ${e.name}`,
            relay: e.kind === "relay",
            hidden: !!e.hidden_since,
            rate: e.rate,
            server: s.name,
          });
    return m;
  }, [servers]);
}

export function PlansPage() {
  const tr = useTr();
  const { sub, query } = useRoute();
  const tab = sub[0] === "groups" ? "groups" : "plans";
  return (
    <>
      <PageHeader
        title={tr("套餐", "Plans")}
        description={tr(
          "用户能用哪些入口只由套餐决定：套餐 → 节点组 → 入口。",
          "Access comes from plans only: plan → node group → entrance.",
        )}
        actions={
          tab === "plans" ? (
            <Button variant="primary" icon={Plus} onClick={() => setQuery({ open: "new" }, false)}>
              {tr("新建套餐", "New plan")}
            </Button>
          ) : (
            <Button variant="primary" icon={Plus} onClick={() => setQuery({ group: "new" }, false)}>
              {tr("新建节点组", "New node group")}
            </Button>
          )
        }
      />
      <PlanSummary />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={(v) => navigate(v === "groups" ? "/plans/groups" : "/plans")}
          tabs={[
            { value: "plans", label: tr("套餐", "Plans") },
            { value: "groups", label: tr("节点组", "Node groups") },
          ]}
        />
      </div>
      {tab === "plans" ? <PlanList open={query.get("open")} /> : <GroupList open={query.get("group")} />}
    </>
  );
}

/** Four tiles over both tabs (the nodes page's summary style). */
function PlanSummary() {
  const tr = useTr();
  const plans = usePlanList();
  const groups = useGroups();
  if (plans.isPending || groups.isPending)
    return (
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[74px] rounded-xl" />
        ))}
      </div>
    );
  if (!plans.data || !groups.data) return null;
  const list = plans.data;
  const onSale = list.filter((p) => p.enabled && p.on_sale).length;
  const disabled = list.filter((p) => !p.enabled).length;
  const subs = list.reduce((n, p) => n + p.active_users, 0);
  const full = list.filter((p) => p.capacity !== null && p.active_users >= p.capacity).length;
  const unused = groups.data.filter((g) => g.plan_ids.length === 0).length;
  const empty = list.filter((p) => p.enabled && p.group_ids.length === 0).length;
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Summary
        icon={Package}
        label={tr("套餐", "Plans")}
        value={list.length}
        foot={tr(
          `在售 ${onSale} · 未上架 ${list.length - onSale - disabled} · 停用 ${disabled}`,
          `${onSale} on sale · ${list.length - onSale - disabled} off sale · ${disabled} disabled`,
        )}
      />
      <Summary
        icon={Users}
        label={tr("生效订阅", "Active subscriptions")}
        value={subs.toLocaleString()}
        tone={full > 0 ? "warning" : undefined}
        foot={full > 0 ? tr(`${full} 个套餐已售罄`, `${full} plans sold out`) : tr("没有售罄的套餐", "None sold out")}
      />
      <Summary
        icon={Layers}
        label={tr("节点组", "Node groups")}
        value={groups.data.length}
        foot={unused > 0 ? tr(`${unused} 个未被套餐使用`, `${unused} unused by plans`) : tr("都在使用中", "All in use")}
      />
      <Summary
        icon={TriangleAlert}
        label={tr("没有节点组的套餐", "Plans without node groups")}
        value={empty}
        tone={empty > 0 ? "danger" : undefined}
        foot={
          empty > 0
            ? tr("用户买了也用不了", "Buyers would get nothing")
            : tr("每个启用的套餐都有节点组", "Every enabled plan has groups")
        }
      />
    </div>
  );
}

function EntranceLine({ id, e }: { id: string; e: EntranceInfo | undefined }) {
  const tr = useTr();
  return (
    <li className="flex min-w-0 items-center gap-1.5">
      {e?.relay ? (
        <ArrowRightLeft className="size-3 shrink-0 text-chart-2" aria-hidden="true" />
      ) : (
        <ShieldCheck className="size-3 shrink-0 text-chart-1" aria-hidden="true" />
      )}
      <span className="min-w-0 truncate">
        {e ? `${e.server} / ${e.label}` : tr("已删除的入口", "Deleted entrance")}
      </span>
      {e && <span className="tnum shrink-0 text-footnote text-muted-foreground">{e.rate}x</span>}
      {e?.hidden && <Badge tone="danger">{tr("已隐藏", "hidden")}</Badge>}
      {!e && <span className="sr-only">{id}</span>}
    </li>
  );
}

function PlanList({ open }: { open: string | null }) {
  const tr = useTr();
  const plans = usePlanList();
  const groups = useGroups();
  const servers = useServers();
  const confirm = useConfirm();
  const toast = useToast();
  const [run] = useAction();
  const [newGroup, setNewGroup] = useState(false);
  const groupById = new Map((groups.data ?? []).map((g) => [g.id, g]));
  const idx = useEntranceIndex(servers.data);
  if (plans.isError)
    return (
      <Card>
        <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />
      </Card>
    );
  if (plans.isPending)
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-56" />
        ))}
      </div>
    );
  const list = plans.data;
  const toggle = async (p: PlanView) => {
    const ok = await confirm({
      title: p.enabled
        ? tr(`停用套餐 ${p.name}？`, `Disable ${p.name}?`)
        : tr(`启用套餐 ${p.name}？`, `Enable ${p.name}?`),
      description: p.enabled
        ? tr("停用后不再出售；现有订阅照常使用。", "No longer sold; existing subscriptions keep working.")
        : undefined,
      impacts: p.enabled
        ? [{ label: tr("生效订阅（照常使用）", "Active subscriptions (kept)"), value: p.active_users }]
        : undefined,
      tone: p.enabled ? "warning" : "default",
    });
    if (ok) await run(() => patch(`/plans/${p.id}`, { enabled: !p.enabled }), { ok: tr("已保存", "Saved") });
  };
  const remove = async (p: PlanView) => {
    const ok = await confirm({
      title: tr(`删除套餐 ${p.name}？`, `Delete ${p.name}?`),
      impact: p.active_users
        ? tr(
            `${p.active_users} 个用户正在使用：需先更换或取消`,
            `${p.active_users} users hold it: change or cancel theirs first`,
          )
        : tr("没有用户持有这个套餐", "Nobody holds this plan"),
      typeToConfirm: p.name,
      action: () => del(`/plans/${p.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("套餐已删除", "Plan deleted") });
  };
  return (
    <>
      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Package}
            title={tr("还没有套餐", "No plans yet")}
            description={tr(
              "套餐决定用户能用哪些入口、多少流量和什么价格。",
              "A plan decides which entrances users get, how much traffic and at what price.",
            )}
            action={
              <Button variant="primary" icon={Plus} onClick={() => setQuery({ open: "new" }, false)}>
                {tr("新建套餐", "New plan")}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => {
            const ents = new Set(p.group_ids.flatMap((g) => groupById.get(g)?.entrance_ids ?? []));
            const relays = [...ents].filter((e) => idx.get(e)?.relay).length;
            const main = p.prices[0];
            const fill = p.capacity ? pct(p.active_users, p.capacity) : null;
            return (
              <section key={p.id} aria-label={p.name}>
                <Card className={cn("flex h-full flex-col overflow-hidden", !p.enabled && "opacity-70")}>
                  <div className="flex items-start gap-3 px-4 pt-3.5">
                    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-primary">
                      <Package className="size-[18px]" aria-hidden="true" />
                    </span>
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setQuery({ open: p.id }, false)}
                    >
                      <div className="truncate text-headline font-semibold hover:underline">{p.name}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {!p.enabled ? (
                          <Badge>{tr("已停用", "Disabled")}</Badge>
                        ) : p.on_sale ? (
                          <Badge tone="success" dot>
                            {tr("在售", "On sale")}
                          </Badge>
                        ) : (
                          <Badge tone="warning">{tr("未上架", "Off sale")}</Badge>
                        )}
                        {p.renewal_only && <Badge tone="outline">{tr("仅续费", "Renewal only")}</Badge>}
                        {relays > 0 && (
                          <Badge tone="info">
                            <ArrowRightLeft aria-hidden="true" />
                            {tr("含中转", "Has relays")}
                          </Badge>
                        )}
                      </div>
                    </button>
                    <RowMenu label={tr(`套餐 ${p.name} 的操作`, `Actions of ${p.name}`)}>
                      {(close) => (
                        <>
                          <MenuItem icon={Settings} onClick={() => (close(), setQuery({ open: p.id }, false))}>
                            {tr("编辑", "Edit")}
                          </MenuItem>
                          <MenuItem icon={p.enabled ? Pause : Play} onClick={() => (close(), void toggle(p))}>
                            {p.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
                          </MenuItem>
                          <MenuItem icon={Trash2} danger onClick={() => (close(), void remove(p))}>
                            {tr("删除", "Delete")}
                          </MenuItem>
                        </>
                      )}
                    </RowMenu>
                  </div>
                  <div className="px-4 pt-3">
                    {main ? (
                      <div className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="tnum text-title2 font-semibold tracking-[-0.02em]">
                          {yuan(main.price_cents)}
                        </span>
                        <span className="text-footnote text-muted-foreground">
                          / {periodLabel(main.period, tr, main.days)}
                        </span>
                      </div>
                    ) : (
                      <div className="text-body text-muted-foreground">{tr("未定价", "No prices")}</div>
                    )}
                    {p.prices.length > 1 && (
                      <ul className="mt-1.5 flex flex-wrap gap-1" aria-label={tr("其他周期", "Other periods")}>
                        {p.prices.slice(1).map((pp) => (
                          <li key={pp.period}>
                            <Badge tone="outline" className="tnum">
                              {periodLabel(pp.period, tr, pp.days)} {yuan(pp.price_cents)}
                            </Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <ul className="grid gap-1.5 px-4 py-3 text-footnote text-muted-foreground sm:grid-cols-2">
                    <li className="flex min-w-0 items-center gap-1.5">
                      <Gauge className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                      <span className="truncate">
                        <span className="tnum font-medium text-foreground">
                          {p.traffic_quota_bytes ? bytes(p.traffic_quota_bytes) : tr("不限流量", "Unlimited")}
                        </span>{" "}
                        · {resetLabel(p.period, tr)}
                      </span>
                    </li>
                    <li className="flex min-w-0 items-center gap-1.5">
                      <Zap className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                      <span className="tnum truncate">
                        {p.speed_limit_mbps ? `${p.speed_limit_mbps} Mbps` : tr("不限速", "No speed limit")}
                      </span>
                    </li>
                    <li className="flex min-w-0 items-center gap-1.5 sm:col-span-2">
                      <Layers className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
                      <span className="truncate">
                        {tr(
                          `${p.group_ids.length} 个节点组 · ${ents.size} 个入口`,
                          `${p.group_ids.length} groups · ${ents.size} entrances`,
                        )}
                        {relays > 0 && tr(`（中转 ${relays}）`, ` (${relays} relays)`)}
                      </span>
                    </li>
                  </ul>
                  <div className="mt-auto border-t border-separator bg-window/60 px-4 py-2.5">
                    <div className="flex justify-between gap-2 text-footnote text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Users className="size-3.5 text-faint" aria-hidden="true" />
                        {tr(`订阅 ${p.active_users}`, `${p.active_users} subscribers`)}
                        {p.capacity !== null && tr(` / 库存 ${p.capacity}`, ` / stock ${p.capacity}`)}
                      </span>
                      {fill !== null && <span className="tnum font-semibold text-foreground">{fill}%</span>}
                    </div>
                    {fill !== null && <Meter value={fill} className="mt-1.5" label={tr("库存占用", "Stock used")} />}
                  </div>
                </Card>
              </section>
            );
          })}
        </div>
      )}
      {open && (open === "new" || list.some((p) => p.id === open)) && (
        <PlanDialog
          key={open}
          plan={open === "new" ? null : (list.find((p) => p.id === open) ?? null)}
          groups={groups.data ?? []}
          idx={idx}
          onCreateGroup={() => setNewGroup(true)}
          onClose={() => setQuery({ open: null })}
        />
      )}
      {newGroup && <GroupDialog group={null} servers={servers.data ?? []} onClose={() => setNewGroup(false)} />}
    </>
  );
}

type PriceDraft = { on: boolean; price: string; days: string };

function resetKind(p: string): "monthly" | "none" | "days" {
  return p === "monthly" || p === "none" ? p : "days";
}

const QUOTA: NumRule = { min: 0, max: 1_000_000_000, above: true, optional: true };
const SPEED: NumRule = { min: 1, max: 100_000, int: true, optional: true };
const CAPACITY: NumRule = { min: 0, max: 2_147_483_647, int: true, optional: true };
const DAYS: NumRule = { min: 1, max: 3650, int: true };
const SORT: NumRule = { min: -2_147_483_648, max: 2_147_483_647, int: true };

type PlanForm = {
  name: string;
  description: string;
  quota: string;
  speed: string;
  reset: "monthly" | "none" | "days";
  resetDays: string;
  groups: string[];
  capacity: string;
  renewalOnly: boolean;
  renewOffSale: boolean;
  allowSwitchIn: boolean;
  sort: string;
  enabled: boolean;
  onSale: boolean;
};

function planForm(plan: PlanView | null): PlanForm {
  return {
    name: plan?.name ?? "",
    description: plan?.description ?? "",
    quota: plan?.traffic_quota_bytes ? String(+(plan.traffic_quota_bytes / GiB).toFixed(3)) : "",
    speed: plan?.speed_limit_mbps ? String(plan.speed_limit_mbps) : "",
    reset: resetKind(plan?.period ?? "monthly"),
    resetDays: plan && /^days-\d+$/.test(plan.period) ? plan.period.slice(5) : "30",
    groups: plan?.group_ids ?? [],
    capacity: plan?.capacity !== null && plan?.capacity !== undefined ? String(plan.capacity) : "",
    renewalOnly: plan?.renewal_only ?? false,
    renewOffSale: plan?.renew_off_sale ?? true,
    allowSwitchIn: plan?.allow_switch_in ?? true,
    sort: String(plan?.sort ?? 0),
    enabled: plan?.enabled ?? true,
    onSale: plan?.on_sale ?? false,
  };
}

function priceDrafts(plan: PlanView | null): Record<string, PriceDraft> {
  return Object.fromEntries(
    PERIODS.map((p) => {
      const x = plan?.prices.find((pp) => pp.period === p);
      return [p, { on: !!x, price: x ? centsToYuanText(x.price_cents) : "", days: x?.days ? String(x.days) : "" }];
    }),
  );
}

/** Field errors of the plan form, and the request body when there are none. */
function planBody(
  plan: PlanView | null,
  f: PlanForm,
  prices: Record<string, PriceDraft>,
  tr: Tr,
): { errors: Record<string, string | undefined>; body: Record<string, unknown> | null } {
  const [quota, quotaE] = num(f.quota, QUOTA, tr);
  const [speed, speedE] = num(f.speed, SPEED, tr);
  const [capacity, capacityE] = num(f.capacity, CAPACITY, tr);
  const [resetDays, resetDaysE] = f.reset === "days" ? num(f.resetDays, DAYS, tr) : [null, undefined];
  const [sort, sortE] = num(f.sort, SORT, tr);
  const errors: Record<string, string | undefined> = {
    name: !f.name.trim() ? tr("请填写名称", "Enter a name") : undefined,
    quota: quotaE,
    speed: speedE,
    capacity: capacityE,
    resetDays: resetDaysE,
    sort: sortE,
  };
  const list: { period: string; days?: number; price_cents: number }[] = [];
  for (const p of PERIODS) {
    const d = prices[p];
    if (!d.on) continue;
    const c = parseYuan(d.price);
    if (c === null || c < 1)
      errors[`price-${p}`] = tr("请输入大于 0 的金额（最多 2 位小数）", "Enter an amount above 0 (2 decimals at most)");
    const item: { period: string; days?: number; price_cents: number } = { period: p, price_cents: c ?? 0 };
    if (p === "days" || p === "onetime") {
      const [days, daysE] = num(d.days, { ...DAYS, optional: p === "onetime" }, tr);
      if (daysE) errors[`days-${p}`] = daysE;
      if (days !== null) item.days = days;
    }
    list.push(item);
  }
  if (f.onSale && !list.some((x) => x.period !== "reset"))
    errors.onSale = tr(
      "上架前至少设置一个流量重置包以外的价格",
      "Set at least one price other than the reset pack before selling",
    );
  if (Object.values(errors).some(Boolean)) return { errors, body: null };
  const all: Record<string, unknown> = {
    name: f.name.trim(),
    description: f.description,
    traffic_quota_bytes: quota === null ? null : Math.round(quota * GiB),
    speed_limit_mbps: speed,
    period: f.reset === "days" ? `days-${resetDays}` : f.reset,
    group_ids: f.groups,
    capacity,
    renewal_only: f.renewalOnly,
    renew_off_sale: f.renewOffSale,
    allow_switch_in: f.allowSwitchIn,
    sort: sort ?? 0,
    enabled: f.enabled,
  };
  const pricing = { on_sale: f.onSale, prices: list };
  if (!plan) return { errors, body: { ...all, pricing } };
  const was: Record<string, unknown> = {
    name: plan.name,
    description: plan.description,
    traffic_quota_bytes: plan.traffic_quota_bytes,
    speed_limit_mbps: plan.speed_limit_mbps,
    period: plan.period,
    group_ids: plan.group_ids,
    capacity: plan.capacity,
    renewal_only: plan.renewal_only,
    renew_off_sale: plan.renew_off_sale,
    allow_switch_in: plan.allow_switch_in,
    sort: plan.sort,
    enabled: plan.enabled,
  };
  const out: Record<string, unknown> = { pricing };
  for (const [k, v] of Object.entries(all)) if (JSON.stringify(v) !== JSON.stringify(was[k])) out[k] = v;
  return { errors, body: out };
}

type Impact = { body: Record<string, unknown>; subscribers: number; over_quota: number };

function PlanDialog({
  plan,
  groups,
  idx,
  onCreateGroup,
  onClose,
}: {
  plan: PlanView | null;
  groups: NodeGroup[];
  idx: Map<string, EntranceInfo>;
  onCreateGroup: () => void;
  onClose: () => void;
}) {
  const tr = useTr();
  const [f, setF] = useState(() => planForm(plan));
  const [prices, setPrices] = useState(() => priceDrafts(plan));
  const [tried, setTried] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [run, busy] = useAction();
  const [previewing, setPreviewing] = useState(false);
  const ents = [...new Set(f.groups.flatMap((g) => groups.find((x) => x.id === g)?.entrance_ids ?? []))];
  const { errors, body } = planBody(plan, f, prices, tr);
  const bad = Object.values(errors).filter(Boolean).length;
  const dirty =
    JSON.stringify(f) !== JSON.stringify(planForm(plan)) ||
    JSON.stringify(prices) !== JSON.stringify(priceDrafts(plan));
  const err = (k: string, text: string) => shown(text, errors[k], tried);

  const save = async (b: Record<string, unknown>) => {
    const r = await run(() => (plan ? patch(`/plans/${plan.id}`, b) : post("/plans", b)), {
      ok: tr("套餐已保存", "Plan saved"),
    });
    if (r !== undefined) onClose();
    return r !== undefined;
  };
  const submit = async () => {
    setTried(true);
    if (!body) return;
    const terms = ["traffic_quota_bytes", "speed_limit_mbps", "period", "group_ids"].some((k) => k in body);
    if (plan && terms) {
      setPreviewing(true);
      const im = await run(() => post<{ subscribers: number; over_quota: number }>(`/plans/${plan.id}/impact`, body));
      setPreviewing(false);
      if (!im) return;
      if (im.subscribers > 0) return setImpact({ body, ...im });
    }
    await save(body);
  };

  return (
    <Dialog
      open
      size="lg"
      icon={Package}
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty}
      title={plan ? tr(`编辑套餐 ${plan.name}`, `Edit ${plan.name}`) : tr("新建套餐", "New plan")}
      footer={
        <>
          <FixCount n={tried ? bad : 0} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy || previewing}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={tr("名称", "Name")} required className="sm:col-span-2" error={tried ? errors.name : undefined}>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field
          label={tr(
            "说明（购买页显示；「- 」开头的行显示为列表）",
            'Description (shop; lines starting with "- " are a list)',
          )}
          className="sm:col-span-2"
        >
          <Textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field
          label={tr("流量额度（GiB，留空不限）", "Traffic quota (GiB; empty = unlimited)")}
          error={err("quota", f.quota)}
        >
          <Input inputMode="decimal" value={f.quota} onChange={(e) => setF({ ...f, quota: e.target.value })} />
        </Field>
        <Field label={tr("限速（Mbps，留空不限）", "Speed limit (Mbps; empty = none)")} error={err("speed", f.speed)}>
          <Input inputMode="numeric" value={f.speed} onChange={(e) => setF({ ...f, speed: e.target.value })} />
        </Field>
        <Field label={tr("流量重置", "Traffic reset")}>
          <Select value={f.reset} onChange={(e) => setF({ ...f, reset: e.target.value as PlanForm["reset"] })}>
            <option value="monthly">{tr("每月（站点时区）", "Monthly (site time zone)")}</option>
            <option value="days">{tr("每 N 天", "Every N days")}</option>
            <option value="none">{tr("不重置", "Never")}</option>
          </Select>
        </Field>
        {f.reset === "days" && (
          <Field label={tr("N（天）", "N (days)")} error={err("resetDays", f.resetDays)}>
            <Input
              inputMode="numeric"
              value={f.resetDays}
              onChange={(e) => setF({ ...f, resetDays: e.target.value })}
            />
          </Field>
        )}
        <Field
          label={tr("库存（最多用户数，留空不限）", "Stock (max subscribers; empty = no limit)")}
          error={err("capacity", f.capacity)}
        >
          <Input inputMode="numeric" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
        </Field>
        <Field label={tr("排序", "Sort")} error={err("sort", f.sort)}>
          <Input inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} />
        </Field>
      </div>
      <SectionTitle>{tr("销售规则", "Sale rules")}</SectionTitle>
      <div className="divide-y divide-separator rounded-xl px-4 ring-1 ring-border ring-inset">
        {(
          [
            [
              "enabled",
              tr("启用", "Enabled"),
              tr("停用 = 不再出售，现有订阅照常", "Disabled = not sold; subscribers keep it"),
            ],
            ["onSale", tr("上架", "On sale"), tr("在商店里显示", "Shown in the shop")],
            ["renewalOnly", tr("仅续费", "Renewal only"), tr("只给已持有的用户续费", "Only current holders can renew")],
            [
              "renewOffSale",
              tr("下架后允许续费", "Renewable off sale"),
              tr("下架后现有用户仍可续费和买重置包", "Holders may still renew and buy reset packs off sale"),
            ],
            [
              "allowSwitchIn",
              tr("允许换入", "Allow switching in"),
              tr("允许从其他套餐换到这个套餐", "Users may switch to it from other plans"),
            ],
          ] as const
        ).map(([k, label, description]) => (
          <SwitchField
            key={k}
            className="py-2.5"
            checked={f[k]}
            onChange={(v) => setF({ ...f, [k]: v })}
            label={label}
            description={description}
          />
        ))}
      </div>
      {tried && errors.onSale && <p className="mt-1.5 text-footnote text-destructive">{errors.onSale}</p>}
      <SectionTitle>{tr("价格（元）", "Prices (yuan)")}</SectionTitle>
      <div className="grid gap-2">
        {PERIODS.map((p) => {
          const d = prices[p];
          const set = (x: Partial<PriceDraft>) => setPrices({ ...prices, [p]: { ...d, ...x } });
          const priceE = d.on ? err(`price-${p}`, d.price) : undefined;
          const daysE = d.on ? err(`days-${p}`, d.days) : undefined;
          return (
            <div
              key={p}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,8rem)] items-start gap-x-2 gap-y-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,8rem)_minmax(0,7rem)]"
            >
              <label className="flex min-h-8 items-center gap-2.5 text-body pointer-coarse:min-h-10">
                <Checkbox checked={d.on} label={periodLabel(p, tr)} onChange={(v) => set({ on: v })} />
                <span className="min-w-0 truncate">{periodLabel(p, tr)}</span>
              </label>
              <div>
                <Input
                  aria-label={tr(`${periodLabel(p, tr)}价格`, `${periodLabel(p, tr)} price`)}
                  aria-invalid={!!priceE || undefined}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={d.price}
                  disabled={!d.on}
                  onChange={(e) => set({ price: e.target.value })}
                />
                {priceE && <p className="mt-1 text-footnote text-destructive">{priceE}</p>}
              </div>
              {p === "days" || p === "onetime" ? (
                <div className="max-sm:col-start-2">
                  <Input
                    aria-label={tr(`${periodLabel(p, tr)}天数`, `${periodLabel(p, tr)} days`)}
                    aria-invalid={!!daysE || undefined}
                    inputMode="numeric"
                    placeholder={p === "onetime" ? tr("天数/永久", "days / none") : tr("天数", "days")}
                    value={d.days}
                    disabled={!d.on}
                    onChange={(e) => set({ days: e.target.value })}
                  />
                  {daysE && <p className="mt-1 text-footnote text-destructive">{daysE}</p>}
                </div>
              ) : (
                <span className="max-sm:hidden" />
              )}
            </div>
          );
        })}
      </div>
      <SectionTitle>{tr("节点组", "Node groups")}</SectionTitle>
      {groups.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset">
          <span className="text-body text-muted-foreground">
            {tr("还没有节点组：套餐通过节点组授予入口。", "No node groups yet: plans grant entrances through groups.")}
          </span>
          <Button size="sm" icon={Plus} onClick={onCreateGroup}>
            {tr("去创建节点组", "Create a node group")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <label
              key={g.id}
              className="flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-body ring-1 ring-border ring-inset"
            >
              <Checkbox
                checked={f.groups.includes(g.id)}
                label={g.name}
                onChange={(on) => setF({ ...f, groups: on ? [...f.groups, g.id] : f.groups.filter((x) => x !== g.id) })}
              />
              {g.name}
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 rounded-xl p-3 ring-1 ring-border ring-inset">
        <div className="mb-1.5 text-footnote font-medium text-muted-foreground">
          {tr(`用户将获得的入口（${ents.length}）`, `Entrances users get (${ents.length})`)}
        </div>
        {ents.length === 0 ? (
          <p className="text-body text-muted-foreground">
            {tr("还没有入口：勾选节点组。", "None yet: tick node groups.")}
          </p>
        ) : (
          <ul className="space-y-1 text-body">
            {ents.map((id) => (
              <EntranceLine key={id} id={id} e={idx.get(id)} />
            ))}
          </ul>
        )}
      </div>
      {impact && (
        <ImpactConfirm
          impact={impact}
          onCancel={() => setImpact(null)}
          onSave={async (b) => {
            if (await save(b)) setImpact(null);
          }}
        />
      )}
    </Dialog>
  );
}

/**
 * "Apply the new terms to existing subscribers too?" — an alertdialog
 * stacked over the plan dialog (Esc closes only it). Each choice has its own
 * spinner.
 */
function ImpactConfirm({
  impact,
  onCancel,
  onSave,
}: {
  impact: Impact;
  onCancel: () => void;
  onSave: (b: Record<string, unknown>) => Promise<void>;
}) {
  const tr = useTr();
  const [busy, setBusy] = useState<"new" | "all" | null>(null);
  const go = async (which: "new" | "all") => {
    setBusy(which);
    try {
      await onSave(which === "all" ? { ...impact.body, apply_to_existing: true } : impact.body);
    } finally {
      setBusy(null);
    }
  };
  return (
    <A.Root open onOpenChange={(o) => !o && !busy && onCancel()}>
      <A.Portal>
        <A.Overlay className="fixed inset-0 z-50 bg-(--scrim) data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <A.Content className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-[calc(100vw-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl bg-card p-5 shadow-dialog data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.97]">
          <div className="flex gap-3.5">
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning">
              <TriangleAlert className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <A.Title className="text-title3 font-semibold">{tr("套餐条款变更", "Plan terms changed")}</A.Title>
              <A.Description asChild>
                <div className="mt-1 text-body text-muted-foreground">
                  {tr(
                    `这个套餐有 ${impact.subscribers} 个生效订阅。改动默认只影响新购买（条款在购买时快照）。`,
                    `${impact.subscribers} active subscriptions hold this plan. By default changes apply to new purchases only (terms are snapshotted).`,
                  )}
                </div>
              </A.Description>
            </div>
          </div>
          <dl className="mt-4 divide-y divide-separator rounded-lg bg-window ring-1 ring-border ring-inset">
            <div className="flex items-center justify-between gap-3 px-3 py-2 text-body">
              <dt className="text-muted-foreground">{tr("生效订阅", "Active subscriptions")}</dt>
              <dd className="tnum font-medium">{impact.subscribers}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2 text-body">
              <dt className="text-muted-foreground">{tr("应用后会被立即暂停", "Suspended at once if applied")}</dt>
              <dd className="tnum font-medium">{impact.over_quota}</dd>
            </div>
          </dl>
          {impact.over_quota > 0 && (
            <Callout tone="danger" className="mt-3">
              {tr(
                `其中 ${impact.over_quota} 人已超出新额度，应用后会被立即暂停。`,
                `${impact.over_quota} of them are over the new quota and would be suspended at once.`,
              )}
            </Callout>
          )}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <A.Cancel asChild>
              <Button variant="secondary" disabled={!!busy}>
                {tr("取消", "Cancel")}
              </Button>
            </A.Cancel>
            <Button disabled={busy === "all"} loading={busy === "new"} onClick={() => void go("new")}>
              {tr("只影响新购买", "New purchases only")}
            </Button>
            <Button
              variant={impact.over_quota > 0 ? "destructive" : "primary"}
              disabled={busy === "new"}
              loading={busy === "all"}
              onClick={() => void go("all")}
            >
              {tr(
                `同时应用到 ${impact.subscribers} 个现有订阅`,
                `Apply to the ${impact.subscribers} subscriptions too`,
              )}
            </Button>
          </div>
        </A.Content>
      </A.Portal>
    </A.Root>
  );
}

function GroupList({ open }: { open: string | null }) {
  const tr = useTr();
  const groups = useGroups();
  const servers = useServers();
  const plans = usePlanList();
  const confirm = useConfirm();
  const toast = useToast();
  const idx = useEntranceIndex(servers.data);
  const planById = new Map((plans.data ?? []).map((p) => [p.id, p]));
  if (groups.isError)
    return (
      <Card>
        <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
      </Card>
    );
  if (groups.isPending) return <Skeleton className="h-48" />;
  const remove = async (g: NodeGroup) => {
    const holders = g.plan_ids.reduce((n, p) => n + (planById.get(p)?.active_users ?? 0), 0);
    const ok = await confirm({
      title: tr(`删除节点组 ${g.name}？`, `Delete ${g.name}?`),
      impact: g.plan_ids.length
        ? tr(
            `${g.plan_ids.length} 个套餐的用户会失去这些入口`,
            `Subscribers of ${g.plan_ids.length} plans lose these entrances`,
          )
        : undefined,
      impacts: [
        { label: tr("使用它的套餐", "Plans using it"), value: g.plan_ids.length },
        { label: tr("这些套餐的生效订阅", "Their active subscriptions"), value: holders },
        { label: tr("组里的入口", "Entrances in it"), value: g.entrance_ids.length },
      ],
      typeToConfirm: g.name,
      action: () => del(`/node-groups/${g.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("节点组已删除", "Node group deleted") });
      if (open === g.id) setQuery({ group: null });
    }
  };
  return (
    <>
      <div className="mb-3">
        <Callout tone="info">
          {tr(
            "中转入口与落地机共享隔离：低价套餐不要放中转入口所在的节点组（中转按入口倍率计费）。",
            "Relays share the landing machine: keep relay entrances out of cheap plans' groups (relays bill at their own multiplier).",
          )}
        </Callout>
      </div>
      {groups.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={Layers}
            title={tr("还没有节点组", "No node groups yet")}
            description={tr(
              "节点组把入口打包，套餐再选择节点组。",
              "A node group bundles entrances; plans then pick groups.",
            )}
            action={
              <Button variant="primary" icon={Plus} onClick={() => setQuery({ group: "new" }, false)}>
                {tr("新建节点组", "New node group")}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {groups.data.map((g) => (
            <section key={g.id} aria-label={g.name}>
              <Card className="flex h-full flex-col overflow-hidden">
                <div className="flex items-start gap-3 px-4 py-3.5">
                  <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-soft text-primary">
                    <Layers className="size-[18px]" aria-hidden="true" />
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setQuery({ group: g.id }, false)}
                  >
                    <div className="truncate text-headline font-semibold hover:underline">{g.name}</div>
                    {g.description && <div className="text-footnote text-muted-foreground">{g.description}</div>}
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-footnote text-muted-foreground">
                      {tr("套餐", "Plans")}
                      {g.plan_ids.length === 0
                        ? " —"
                        : g.plan_ids.map((p) => (
                            <Badge key={p} tone="outline">
                              {planById.get(p)?.name ?? tr("已删除", "deleted")}
                            </Badge>
                          ))}
                    </div>
                  </button>
                  <RowMenu label={tr(`节点组 ${g.name} 的操作`, `Actions of ${g.name}`)}>
                    {(close) => (
                      <>
                        <MenuItem icon={Settings} onClick={() => (close(), setQuery({ group: g.id }, false))}>
                          {tr("编辑", "Edit")}
                        </MenuItem>
                        <MenuItem icon={Trash2} danger onClick={() => (close(), void remove(g))}>
                          {tr("删除", "Delete")}
                        </MenuItem>
                      </>
                    )}
                  </RowMenu>
                </div>
                <ul
                  className="mt-auto grid gap-1.5 border-t border-separator bg-window/60 px-4 py-2.5 text-body"
                  aria-label={tr(`${g.name} 的入口`, `Entrances of ${g.name}`)}
                >
                  {g.entrance_ids.map((id) => (
                    <EntranceLine key={id} id={id} e={idx.get(id)} />
                  ))}
                  {g.entrance_ids.length === 0 && (
                    <li className="text-muted-foreground">{tr("没有入口", "No entrances")}</li>
                  )}
                </ul>
              </Card>
            </section>
          ))}
        </div>
      )}
      {open && (open === "new" || groups.data.some((g) => g.id === open)) && (
        <GroupDialog
          key={open}
          group={open === "new" ? null : (groups.data.find((g) => g.id === open) ?? null)}
          servers={servers.data ?? []}
          onClose={() => setQuery({ group: null })}
          onDelete={(g) => void remove(g)}
        />
      )}
    </>
  );
}

function GroupDialog({
  group,
  servers,
  onClose,
  onDelete,
}: {
  group: NodeGroup | null;
  servers: ServerView[];
  onClose: () => void;
  onDelete?: (g: NodeGroup) => void;
}) {
  const tr = useTr();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [ids, setIds] = useState<string[]>(group?.entrance_ids ?? []);
  const [search, setSearch] = useState("");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const nameError = !name.trim() ? tr("请填写名称", "Enter a name") : undefined;
  const needle = search.trim().toLowerCase();
  const dirty =
    name !== (group?.name ?? "") ||
    description !== (group?.description ?? "") ||
    [...ids].sort().join() !== [...(group?.entrance_ids ?? [])].sort().join();
  const submit = async () => {
    setTried(true);
    if (nameError) return;
    const b = { name: name.trim(), description, entrance_ids: ids };
    const r = await run(() => (group ? patch(`/node-groups/${group.id}`, b) : post("/node-groups", b)), {
      ok: tr("节点组已保存", "Node group saved"),
    });
    if (r !== undefined) onClose();
  };
  const rows = servers
    .map((s) => ({
      s,
      ents: s.nodes.flatMap((n) =>
        n.entrances
          .filter(
            (e) =>
              !needle ||
              [s.name, n.name, n.display_name ?? "", e.name, ...e.tags].some((t) => t.toLowerCase().includes(needle)),
          )
          .map((e) => ({ n, e })),
      ),
    }))
    .filter((r) => r.ents.length > 0);
  return (
    <Dialog
      open
      size="lg"
      icon={Layers}
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty}
      title={group ? tr(`编辑节点组 ${group.name}`, `Edit ${group.name}`) : tr("新建节点组", "New node group")}
      footer={
        <>
          {group && onDelete && (
            <Button variant="destructive-soft" icon={Trash2} onClick={() => onDelete(group)} className="mr-auto">
              {tr("删除", "Delete")}
            </Button>
          )}
          <FixCount n={tried && nameError ? 1 : 0} />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={tr("名称", "Name")} required error={tried ? nameError : undefined}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={tr("说明", "Description")}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-footnote font-medium text-muted-foreground">
              {tr(`入口（按服务器，已选 ${ids.length}）`, `Entrances (by server, ${ids.length} chosen)`)}
            </span>
          </legend>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
              aria-hidden="true"
            />
            <Input
              type="search"
              data-nodirty
              className="pl-8"
              aria-label={tr("搜索入口", "Search entrances")}
              placeholder={tr("按服务器、节点、入口或标签搜索…", "Search by server, node, entrance or tag…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {servers.length === 0 && (
            <p className="text-body text-muted-foreground">{tr("还没有服务器和入口", "No servers or entrances yet")}</p>
          )}
          {servers.length > 0 && rows.length === 0 && (
            <p className="text-body text-muted-foreground">{tr("没有匹配的入口", "No matching entrances")}</p>
          )}
          {rows.map(({ s, ents }) => {
            const all = ents.every(({ e }) => ids.includes(e.id));
            const some = !all && ents.some(({ e }) => ids.includes(e.id));
            const visible = new Set(ents.map(({ e }) => e.id));
            return (
              <div key={s.id} className="rounded-xl ring-1 ring-border ring-inset">
                <label className="flex min-h-10 items-center gap-2.5 border-b border-separator px-3 text-footnote font-medium text-muted-foreground">
                  <Checkbox
                    checked={all}
                    indeterminate={some}
                    label={tr(`全选 ${s.name}`, `All of ${s.name}`)}
                    onChange={() =>
                      setIds(all ? ids.filter((x) => !visible.has(x)) : [...new Set([...ids, ...visible])])
                    }
                  />
                  {s.name}
                  <span className="tnum ml-auto">
                    {ents.filter(({ e }) => ids.includes(e.id)).length} / {ents.length}
                  </span>
                </label>
                <div className="px-3 py-1">
                  {ents.map(({ n, e }) => (
                    <label key={e.id} className="flex min-h-9 items-center gap-2.5 text-body">
                      <Checkbox
                        checked={ids.includes(e.id)}
                        label={`${n.name} · ${e.name}`}
                        onChange={(on) => setIds(on ? [...ids, e.id] : ids.filter((x) => x !== e.id))}
                      />
                      {e.kind === "relay" ? (
                        <ArrowRightLeft className="size-3 shrink-0 text-chart-2" aria-hidden="true" />
                      ) : (
                        <ShieldCheck className="size-3 shrink-0 text-chart-1" aria-hidden="true" />
                      )}
                      <span className="min-w-0 truncate">
                        {n.display_name || n.name} · {e.name}
                      </span>
                      <span className="tnum shrink-0 text-footnote text-muted-foreground">{e.rate}x</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </fieldset>
      </div>
    </Dialog>
  );
}
