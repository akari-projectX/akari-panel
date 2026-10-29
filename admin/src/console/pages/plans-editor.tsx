// 套餐编辑 (PLN-02 / PLN-03; proposal-v2 §3 套餐编辑): an xl dialog with a
// section nav (基本 / 流量与限速 / 节点组 / 价格 / 库存与上架; after a submit
// every section shows its error count and the dialog jumps to the first one),
// one request for everything (PATCH carries `pricing`), the terms impact
// confirmation stacked over it (POST /plans/{id}/impact; Esc closes only it;
// each choice has its own spinner), and the enable / disable / delete
// confirmations the board's menu shares.
import {
  ArrowRight,
  ArrowRightLeft,
  ArrowUpRight,
  Boxes,
  CircleAlert,
  Gauge,
  Info,
  Package,
  Power,
  PowerOff,
  Tag,
  Trash2,
  Users,
  Waypoints,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { del, patch, post } from "../../shared/api";
import { cn } from "../../shared/cn";
import { bytes, parseYuan, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Segmented, SwitchField, Textarea } from "../../shared/ui/form";
import { Banner } from "../../shared/ui/layout";
import { useToast } from "../../shared/ui/toast";
import {
  NOMINAL_DAYS,
  byServer,
  entrancesOf,
  groupFacts,
  listed,
  rateText,
  yuanRaw,
  type EntranceInfo,
} from "../components/commerce-plans";
import { AffixInput, numErr } from "../components/inputs";
import { EntranceChip, FixCount, ImpactList } from "../components/kit";
import { useAction } from "../data";
import { PERIODS, periodLabel, resetLabel } from "../terms";
import type { NodeGroup, PlanView } from "../types";

const GiB = 1024 ** 3;
const num = (n: number) => n.toLocaleString("en");

export type Sec = "basic" | "traffic" | "groups" | "prices" | "stock";
export const SECS: Sec[] = ["basic", "traffic", "groups", "prices", "stock"];

function secLabel(s: Sec, tr: Tr): string {
  return {
    basic: tr("基本", "Basics"),
    traffic: tr("流量与限速", "Traffic & speed"),
    groups: tr("节点组", "Node groups"),
    prices: tr("价格", "Prices"),
    stock: tr("库存与上架", "Stock & sale"),
  }[s];
}
const SEC_ICON: Record<Sec, typeof Tag> = {
  basic: Tag,
  traffic: Gauge,
  groups: Waypoints,
  prices: Boxes,
  stock: Users,
};

type Reset = "monthly" | "days" | "none";
type PriceDraft = { price: string; days: string };

type Form = {
  name: string;
  description: string;
  sort: string;
  quota: string;
  speed: string;
  reset: Reset;
  resetDays: string;
  groups: string[];
  prices: Record<string, PriceDraft>;
  capacity: string;
  enabled: boolean;
  onSale: boolean;
  renewalOnly: boolean;
  renewOffSale: boolean;
  allowSwitchIn: boolean;
  recommended: boolean;
};

function resetOf(period: string): Reset {
  return period === "monthly" || period === "none" ? period : "days";
}

function formOf(plan: PlanView | null, nextSort: number): Form {
  return {
    name: plan?.name ?? "",
    description: plan?.description ?? "",
    sort: String(plan?.sort ?? nextSort),
    quota: plan?.traffic_quota_bytes ? String(+(plan.traffic_quota_bytes / GiB).toFixed(3)) : "",
    speed: plan?.speed_limit_mbps ? String(plan.speed_limit_mbps) : "",
    reset: resetOf(plan?.period ?? "monthly"),
    resetDays: plan && /^days-\d+$/.test(plan.period) ? plan.period.slice(5) : "30",
    groups: plan?.group_ids ?? [],
    prices: Object.fromEntries(
      PERIODS.map((p) => {
        const x = plan?.prices.find((pp) => pp.period === p);
        return [p, { price: x ? yuanRaw(x.price_cents) : "", days: x?.days ? String(x.days) : "" }];
      }),
    ),
    capacity: plan?.capacity !== null && plan?.capacity !== undefined ? String(plan.capacity) : "",
    enabled: plan?.enabled ?? true,
    onSale: plan?.on_sale ?? false,
    renewalOnly: plan?.renewal_only ?? false,
    renewOffSale: plan?.renew_off_sale ?? true,
    allowSwitchIn: plan?.allow_switch_in ?? true,
    recommended: plan?.recommended ?? false,
  };
}

/** Field error key → its section. */
function secOf(k: string): Sec {
  if (k === "name" || k === "sort") return "basic";
  if (k === "quota" || k === "speed" || k === "resetDays") return "traffic";
  if (k.startsWith("price-") || k.startsWith("days-")) return "prices";
  return "stock";
}

/** A price error ("" = valid) of a yuan text; blank = not sold. */
function priceErr(raw: string, tr: Tr): string | undefined {
  if (!raw.trim()) return undefined;
  const e = numErr(raw, tr, { money: true });
  if (e) return e;
  const c = parseYuan(raw);
  return c === null || c < 1 ? tr("金额须大于 0", "Must be above 0") : undefined;
}

/** Field errors of the form, and the request body when there are none (PATCH: changed fields only). */
function bodyOf(
  plan: PlanView | null,
  f: Form,
  tr: Tr,
): { errors: Record<string, string | undefined>; body: Record<string, unknown> | null } {
  const errors: Record<string, string | undefined> = {
    name: f.name.trim() ? undefined : tr("必填", "Required"),
    sort: /^-?\d+$/.test(f.sort.trim()) ? undefined : tr("请输入整数", "Enter a whole number"),
    quota:
      numErr(f.quota, tr, { allowEmpty: true, max: 1_000_000_000 }) ??
      (f.quota.trim() && Number(f.quota) <= 0
        ? tr("须大于 0；留空 = 不限", "Must be above 0; empty = unlimited")
        : undefined),
    speed: numErr(f.speed, tr, { int: true, min: 1, max: 100_000, allowEmpty: true }),
    resetDays: f.reset === "days" ? numErr(f.resetDays, tr, { int: true, min: 1, max: 3650 }) : undefined,
    capacity: numErr(f.capacity, tr, { int: true, min: 0, max: 2_147_483_647, allowEmpty: true }),
  };
  if (!errors.sort && Math.abs(Number(f.sort)) > 2_147_483_647) errors.sort = tr("数字太大", "Too large");
  const list: { period: string; days?: number; price_cents: number }[] = [];
  for (const p of PERIODS) {
    const d = f.prices[p];
    if (!d.price.trim()) continue;
    const e = priceErr(d.price, tr);
    if (e) errors[`price-${p}`] = e;
    const item: { period: string; days?: number; price_cents: number } = {
      period: p,
      price_cents: parseYuan(d.price) ?? 0,
    };
    if (p === "days" || p === "onetime") {
      const de = numErr(d.days, tr, { int: true, min: 1, max: 3650, allowEmpty: p === "onetime" });
      if (de) errors[`days-${p}`] = de;
      else if (d.days.trim()) item.days = Number(d.days);
    }
    list.push(item);
  }
  if (f.onSale && !list.some((x) => x.period !== "reset"))
    errors.onSale = tr(
      "上架前至少给一个周期定价（流量重置包不算）",
      "Price at least one period (not the reset pack) before selling",
    );
  if (Object.values(errors).some(Boolean)) return { errors, body: null };
  const all: Record<string, unknown> = {
    name: f.name.trim(),
    description: f.description,
    traffic_quota_bytes: f.quota.trim() ? Math.round(Number(f.quota) * GiB) : null,
    speed_limit_mbps: f.speed.trim() ? Number(f.speed) : null,
    period: f.reset === "days" ? `days-${Number(f.resetDays)}` : f.reset,
    group_ids: f.groups,
    capacity: f.capacity.trim() ? Number(f.capacity) : null,
    renewal_only: f.renewalOnly,
    renew_off_sale: f.renewOffSale,
    allow_switch_in: f.allowSwitchIn,
    recommended: f.recommended,
    sort: Number(f.sort),
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
    recommended: plan.recommended,
    sort: plan.sort,
    enabled: plan.enabled,
  };
  const out: Record<string, unknown> = { pricing };
  for (const [k, v] of Object.entries(all)) if (JSON.stringify(v) !== JSON.stringify(was[k])) out[k] = v;
  return { errors, body: out };
}

const TERM_KEYS = ["traffic_quota_bytes", "speed_limit_mbps", "period", "group_ids"];

/** "流量 500 GiB → 300 GiB" lines of the term changes in a PATCH body. */
function termChanges(
  plan: PlanView,
  body: Record<string, unknown>,
  groups: NodeGroup[],
  tr: Tr,
): { k: string; from: string; to: string }[] {
  const quota = (v: number | null) => (v ? bytes(v) : tr("不限", "Unlimited"));
  const speed = (v: number | null) => (v ? `${v} Mbps` : tr("不限", "Unlimited"));
  const names = (ids: string[]) =>
    ids.length ? ids.map((id) => groups.find((g) => g.id === id)?.name ?? "?").join(tr("、", ", ")) : tr("无", "None");
  const out: { k: string; from: string; to: string }[] = [];
  if ("traffic_quota_bytes" in body)
    out.push({
      k: tr("流量", "Traffic"),
      from: quota(plan.traffic_quota_bytes),
      to: quota(body.traffic_quota_bytes as number | null),
    });
  if ("speed_limit_mbps" in body)
    out.push({
      k: tr("限速", "Speed"),
      from: speed(plan.speed_limit_mbps),
      to: speed(body.speed_limit_mbps as number | null),
    });
  if ("period" in body)
    out.push({ k: tr("重置", "Reset"), from: resetLabel(plan.period, tr), to: resetLabel(body.period as string, tr) });
  if ("group_ids" in body)
    out.push({ k: tr("节点组", "Groups"), from: names(plan.group_ids), to: names(body.group_ids as string[]) });
  return out;
}

type Impact = { body: Record<string, unknown>; subscribers: number; over_quota: number };

export function PlanEditor({
  plan,
  plans,
  groups,
  idx,
  tab,
  onTab,
  onClose,
  onToggle,
  onDelete,
}: {
  plan: PlanView | null;
  plans: PlanView[];
  groups: NodeGroup[];
  idx: Map<string, EntranceInfo>;
  tab: Sec;
  onTab: (s: Sec) => void;
  onClose: () => void;
  onToggle: (p: PlanView) => void;
  onDelete: (p: PlanView) => void;
}) {
  const tr = useTr();
  const nextSort = (plans.reduce((m, p) => Math.max(m, p.sort), 0) || 0) + 10;
  const [f, setF] = useState(() => formOf(plan, nextSort));
  const [tried, setTried] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [run, busy] = useAction();
  const [previewing, setPreviewing] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((o) => ({ ...o, [k]: v }));
  const setPrice = (p: string, v: Partial<PriceDraft>) =>
    setF((o) => ({ ...o, prices: { ...o.prices, [p]: { ...o.prices[p], ...v } } }));
  const { errors, body } = bodyOf(plan, f, tr);
  const errKeys = Object.keys(errors).filter((k) => errors[k]);
  const secErr = (s: Sec) => errKeys.filter((k) => secOf(k) === s).length;
  const show = (k: string) => (tried ? errors[k] : undefined);
  const dirty = JSON.stringify(f) !== JSON.stringify(formOf(plan, nextSort));
  const subs = plan?.active_users ?? 0;
  const f0 = plan ? formOf(plan, 0) : null;
  const termsChanged =
    !!f0 &&
    (f.quota !== f0.quota ||
      f.speed !== f0.speed ||
      f.reset !== f0.reset ||
      (f.reset === "days" && f.resetDays !== f0.resetDays) ||
      [...f.groups].sort().join() !== [...f0.groups].sort().join());

  const save = async (b: Record<string, unknown>) => {
    const r = await run(() => (plan ? patch(`/plans/${plan.id}`, b) : post("/plans", b)), {
      ok: plan ? tr("套餐已保存", "Plan saved") : tr("套餐已创建", "Plan created"),
    });
    if (r !== undefined) onClose();
    return r !== undefined;
  };
  const submit = async () => {
    setTried(true);
    if (!body) {
      const first = SECS.find((s) => secErr(s) > 0);
      if (first) onTab(first);
      return;
    }
    if (plan && TERM_KEYS.some((k) => k in body)) {
      setPreviewing(true);
      const im = await run(() => post<{ subscribers: number; over_quota: number }>(`/plans/${plan.id}/impact`, body));
      setPreviewing(false);
      if (!im) return;
      if (im.subscribers > 0) return setImpact({ body, ...im });
    }
    await save(body);
  };

  const ents = entrancesOf(f.groups, groups);
  const rows = byServer(ents, idx);
  const monthC = parseYuan(f.prices.month.price);

  return (
    <Dialog
      open
      size="xl"
      icon={Package}
      onClose={onClose}
      onSubmit={submit}
      dirty={dirty}
      title={plan ? tr(`编辑「${plan.name}」`, `Edit "${plan.name}"`) : tr("新建套餐", "New plan")}
      description={
        plan
          ? tr(
              `${num(subs)} 位用户正在使用 · 改流量、限速、节点组会先预览对他们的影响`,
              `${num(subs)} users hold it · changing traffic, speed or groups previews the impact on them first`,
            )
          : tr(
              "名称、流量、节点和价格；保存后可以在门户上架",
              "Name, traffic, nodes and prices; then sell it in the portal",
            )
      }
      footer={
        <>
          {plan && (
            <Button variant="destructive-soft" icon={Trash2} onClick={() => onDelete(plan)}>
              {tr("删除", "Delete")}
            </Button>
          )}
          {plan && (
            <Button variant="ghost" icon={plan.enabled ? PowerOff : Power} onClick={() => onToggle(plan)}>
              {plan.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
            </Button>
          )}
          <div className="ml-auto flex items-center gap-2">
            {tried && <FixCount n={errKeys.length} />}
            <Button variant="ghost" onClick={onClose}>
              {tr("取消", "Cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={busy || previewing} disabled={tried && errKeys.length > 0}>
              {plan ? tr("保存", "Save") : tr("创建套餐", "Create plan")}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid gap-5 sm:grid-cols-[168px_minmax(0,1fr)]">
        <nav
          aria-label={tr("套餐设置分区", "Plan sections")}
          className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none] sm:sticky sm:top-0 sm:mx-0 sm:flex-col sm:self-start sm:px-0"
        >
          {SECS.map((s) => {
            const n = tried ? secErr(s) : 0;
            const Icon = SEC_ICON[s];
            return (
              <button
                type="button"
                key={s}
                aria-current={tab === s ? "page" : undefined}
                onClick={() => onTab(s)}
                className={cn(
                  "hit-44 flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-body font-medium whitespace-nowrap transition-colors [&_svg]:size-4",
                  tab === s
                    ? "bg-primary-soft text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" />
                <span className="flex-1 text-left">{secLabel(s, tr)}</span>
                {n > 0 && (
                  <span
                    className="tnum inline-flex size-4.5 items-center justify-center rounded-full bg-destructive-soft text-caption font-semibold text-destructive"
                    aria-label={tr(`${n} 处错误`, `${n} errors`)}
                  >
                    {n}
                  </span>
                )}
                {s === "groups" && n === 0 && <span className="tnum text-footnote text-faint">{f.groups.length}</span>}
              </button>
            );
          })}
        </nav>

        <div className="min-w-0">
          {tab === "basic" && (
            <div className="grid max-w-xl gap-4">
              <Field
                label={tr("名称", "Name")}
                required
                error={show("name")}
                hint={tr("门户和订单里显示", "Shown in the portal and orders")}
              >
                <Input
                  data-autofocus
                  value={f.name}
                  placeholder={tr("例如：专业", "e.g. Pro")}
                  onChange={(e) => set("name", e.target.value)}
                />
              </Field>
              <Field
                label={tr("说明", "Description")}
                hint={tr(
                  "门户套餐卡片上显示，支持 Markdown：**粗体**、- 列表、链接；第一段是卡片上的简介，其余是功能清单",
                  "Shown on the portal card, Markdown supported: **bold**, - lists, links; the first paragraph is the card's summary, the rest its feature list",
                )}
              >
                <Textarea rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} />
              </Field>
              <Field
                label={tr("排序", "Sort")}
                error={show("sort")}
                hint={tr(
                  "门户里从小到大排列；也可以在卡片页直接拖动",
                  "Ascending in the portal; you can also drag the cards",
                )}
              >
                <AffixInput
                  inputMode="numeric"
                  value={f.sort}
                  onChange={(e) => set("sort", e.target.value)}
                  className="w-28"
                />
              </Field>
            </div>
          )}

          {tab === "traffic" && (
            <div className="grid max-w-xl gap-4">
              {plan && subs > 0 && termsChanged && (
                <Banner tone="info" icon={<Info />}>
                  {tr(
                    `保存时会先显示这次改动对 ${num(subs)} 位现有用户的影响，再由你决定是否同步给他们。`,
                    `Saving first shows the impact on the ${num(subs)} current users; then you decide whether they get it too.`,
                  )}
                </Banner>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <Field
                  label={tr("流量", "Traffic")}
                  error={show("quota")}
                  hint={tr("留空 = 不限流量", "Empty = unlimited")}
                >
                  <AffixInput
                    suffix="GiB"
                    value={f.quota}
                    placeholder={tr("不限", "Unlimited")}
                    onChange={(e) => set("quota", e.target.value)}
                  />
                </Field>
                <Field
                  label={tr("限速", "Speed limit")}
                  error={show("speed")}
                  hint={tr("留空 = 不限速", "Empty = no limit")}
                >
                  <AffixInput
                    suffix="Mbps"
                    inputMode="numeric"
                    value={f.speed}
                    placeholder={tr("不限", "Unlimited")}
                    onChange={(e) => set("speed", e.target.value)}
                  />
                </Field>
              </div>
              <Field
                label={tr("流量重置", "Traffic reset")}
                group
                hint={
                  f.reset === "monthly"
                    ? tr("每月按站点时区重置已用流量", "Usage resets every month (site time zone)")
                    : f.reset === "days"
                      ? tr("从开通起每 N 天重置一次", "Usage resets every N days from activation")
                      : tr("流量用完为止，不会重置", "Usage never resets")
                }
              >
                <Segmented
                  label={tr("流量重置", "Traffic reset")}
                  value={f.reset}
                  onChange={(v) => set("reset", v)}
                  options={[
                    { value: "monthly", label: tr("每月", "Monthly") },
                    { value: "days", label: tr("每 N 天", "Every N days") },
                    { value: "none", label: tr("不重置", "Never") },
                  ]}
                />
              </Field>
              {f.reset === "days" && (
                <Field label={tr("重置间隔", "Reset every")} error={show("resetDays")}>
                  <AffixInput
                    suffix={tr("天", "days")}
                    inputMode="numeric"
                    value={f.resetDays}
                    onChange={(e) => set("resetDays", e.target.value)}
                    className="w-40"
                  />
                </Field>
              )}
            </div>
          )}

          {tab === "groups" && (
            <div className="grid gap-5 lg:grid-cols-2">
              <section aria-label={tr("选择节点组", "Choose node groups")}>
                <div className="mb-2 flex items-center justify-between">
                  <h4 className="text-footnote font-semibold text-muted-foreground">
                    {tr("选择节点组", "Choose node groups")}
                  </h4>
                  <Link to="/plans/groups" className="text-footnote font-medium text-primary hover:underline">
                    {tr("管理节点组", "Manage node groups")}
                  </Link>
                </div>
                {groups.length === 0 ? (
                  <div className="flex flex-col items-center rounded-xl bg-window px-4 py-8 text-center ring-1 ring-border ring-inset">
                    <Waypoints className="size-6 text-faint" aria-hidden="true" />
                    <div className="mt-2 text-body font-medium">{tr("还没有节点组", "No node groups yet")}</div>
                    <p className="mt-0.5 max-w-xs text-footnote text-muted-foreground">
                      {tr(
                        "节点组把一组入口打包，套餐通过它决定用户能连哪些节点。",
                        "A node group bundles entrances; plans use groups to decide which nodes users reach.",
                      )}
                    </p>
                    <Link
                      to="/plans/groups?open=new"
                      className="mt-3 inline-flex h-8 items-center gap-1 rounded-lg bg-primary px-3 text-body font-medium text-primary-foreground hover:brightness-110"
                    >
                      {tr("去创建节点组", "Create a node group")}
                      <ArrowUpRight className="size-4" aria-hidden="true" />
                    </Link>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {groups.map((g) => {
                      const fx = groupFacts(g, idx);
                      const on = f.groups.includes(g.id);
                      return (
                        <label
                          key={g.id}
                          htmlFor={`plan-group-${g.id}`}
                          className={cn(
                            "flex cursor-default items-start gap-3 rounded-lg bg-card p-3 shadow-[0_0_0_0.5px_var(--input)] transition-shadow",
                            on && "shadow-[0_0_0_1.5px_var(--primary),0_0_0_4px_var(--ring)]",
                          )}
                        >
                          <Checkbox
                            id={`plan-group-${g.id}`}
                            checked={on}
                            label={g.name}
                            onChange={(v) =>
                              set("groups", v ? [...f.groups, g.id] : f.groups.filter((x) => x !== g.id))
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center gap-2 text-body font-semibold">
                              <span className="truncate">{g.name}</span>
                              {fx.relays > 0 && (
                                <span className="inline-flex shrink-0 items-center gap-0.5 text-footnote font-medium text-chart-2">
                                  <ArrowRightLeft className="size-3" aria-hidden="true" />
                                  {tr("含中转", "Relays")}
                                </span>
                              )}
                            </span>
                            <span className="block text-footnote text-muted-foreground">
                              {tr(
                                `${fx.count} 个入口 · ${fx.servers} 台服务器`,
                                `${fx.count} entrances · ${fx.servers} servers`,
                              )}
                              {g.description && ` · ${g.description}`}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>
              <section
                className="rounded-xl bg-window p-3 ring-1 ring-border ring-inset"
                aria-label={tr("用户将获得这些入口", "Entrances users get")}
              >
                <h4 className="text-footnote font-semibold text-muted-foreground">
                  {tr(`用户将获得这些入口 · ${ents.length}`, `Entrances users get · ${ents.length}`)}
                </h4>
                {ents.length === 0 ? (
                  <p className="my-6 flex items-center justify-center gap-1.5 text-center text-body text-warning">
                    <CircleAlert className="size-4" aria-hidden="true" />
                    {tr("没有入口：用户买了也连不上", "No entrances: buyers could not connect")}
                  </p>
                ) : (
                  <div className="mt-2 grid gap-3">
                    {rows.map((r) => (
                      <div key={r.serverId}>
                        <div className="text-footnote font-medium">{r.serverName}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.list.map((e) => (
                            <EntranceChip
                              key={e.id}
                              name={e.name}
                              kind={e.kind}
                              rate={rateText(e.rate)}
                              muted={!e.enabled || e.hidden}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                    <p className="text-caption text-faint">
                      {tr(
                        "蓝色 = 直连，橙色 = 中转；×2 表示按 2 倍计流量。",
                        "Blue = direct, orange = relay; ×2 counts traffic twice.",
                      )}
                    </p>
                  </div>
                )}
              </section>
            </div>
          )}

          {tab === "prices" && (
            <div className="grid gap-1">
              <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 px-1 text-footnote font-medium text-muted-foreground max-sm:hidden">
                <span>{tr("周期", "Period")}</span>
                <span>{tr("价格", "Price")}</span>
              </div>
              {PERIODS.map((p) => {
                const d = f.prices[p];
                const err = show(`price-${p}`);
                const daysE = show(`days-${p}`);
                const c = parseYuan(d.price);
                const nd = NOMINAL_DAYS[p];
                const save =
                  !err && c && nd && p !== "month" && monthC
                    ? Math.max(0, Math.round((1 - c / (monthC * (nd / 30))) * 100))
                    : null;
                return (
                  <div key={p} className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-3 rounded-lg px-1 py-1.5">
                    <span className="pt-1.5">
                      <span className="block text-body font-medium">{periodLabel(p, tr)}</span>
                      <span className="block text-caption text-faint">
                        {nd
                          ? tr(`${nd} 天`, `${nd} days`)
                          : p === "reset"
                            ? tr("清零已用流量", "Clears usage")
                            : p === "onetime"
                              ? tr("天数可留空 = 不过期", "Days empty = no expiry")
                              : tr("自定义天数", "Custom days")}
                      </span>
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap gap-2">
                        <Field
                          label={
                            <span className="sr-only">
                              {tr(`${periodLabel(p, tr)}价格`, `${periodLabel(p, tr)} price`)}
                            </span>
                          }
                          error={err}
                        >
                          <AffixInput
                            prefix="¥"
                            value={d.price}
                            placeholder={tr("不卖这个周期", "Not sold")}
                            onChange={(e) => setPrice(p, { price: e.target.value })}
                            className="w-48 max-w-full"
                          />
                        </Field>
                        {(p === "days" || p === "onetime") && (
                          <Field
                            label={
                              <span className="sr-only">
                                {tr(`${periodLabel(p, tr)}天数`, `${periodLabel(p, tr)} days`)}
                              </span>
                            }
                            error={d.price.trim() ? daysE : undefined}
                          >
                            <AffixInput
                              suffix={tr("天", "days")}
                              inputMode="numeric"
                              value={d.days}
                              placeholder={p === "onetime" ? tr("不过期", "No expiry") : tr("天数", "Days")}
                              onChange={(e) => setPrice(p, { days: e.target.value })}
                              className="w-32"
                            />
                          </Field>
                        )}
                      </div>
                      {save !== null && c && nd && (
                        <p className="mt-1 text-footnote text-faint">
                          {tr(
                            `折合每月 ${yuan(Math.round(c / (nd / 30)))} · 比月付省 ${save}%`,
                            `${yuan(Math.round(c / (nd / 30)))} a month · ${save}% less than monthly`,
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
              <p className="px-1 text-footnote text-faint">
                {tr(
                  "留空 = 不卖这个周期。门户是否展示由「库存与上架」里的「在售」决定；人工订单和续费也按这里的价格。",
                  'Empty = not sold. Whether the portal shows the plan is "On sale" under Stock & sale; manual orders and renewals use these prices too.',
                )}
              </p>
            </div>
          )}

          {tab === "stock" && (
            <div className="grid max-w-xl gap-4">
              <Field
                label={tr("库存（同时持有的人数上限）", "Stock (max holders at once)")}
                error={show("capacity")}
                hint={
                  !errors.capacity && f.capacity.trim() && Number(f.capacity) < subs ? (
                    <span className="text-warning">
                      {tr(
                        `低于当前 ${num(subs)} 人：新用户将买不到，现有用户不受影响`,
                        `Below the current ${num(subs)}: new buyers are refused, holders keep it`,
                      )}
                    </span>
                  ) : (
                    tr(`留空 = 不限 · 当前 ${num(subs)} 人持有`, `Empty = no limit · ${num(subs)} hold it now`)
                  )
                }
              >
                <AffixInput
                  suffix={tr("人", "users")}
                  inputMode="numeric"
                  value={f.capacity}
                  placeholder={tr("不限", "No limit")}
                  onChange={(e) => set("capacity", e.target.value)}
                  className="w-40"
                />
              </Field>
              <div className="divide-y divide-separator overflow-hidden rounded-xl bg-card px-3 ring-1 ring-border ring-inset">
                <SwitchRow
                  label={tr("启用", "Enabled")}
                  hint={tr("停用后不再出售，现有订阅照常使用", "Disabled = not sold; holders keep using it")}
                  checked={f.enabled}
                  onChange={(v) => set("enabled", v)}
                />
                <SwitchRow
                  label={tr("在售（门户上架）", "On sale (in the portal)")}
                  hint={tr("关闭后门户不展示，新用户不能购买", "Off = hidden in the portal; nobody new can buy")}
                  checked={f.onSale}
                  onChange={(v) => set("onSale", v)}
                />
                <SwitchRow
                  label={tr("仅续费", "Renewal only")}
                  hint={tr("只有已持有的用户能续费，不接受新购", "Only holders can renew; no new purchases")}
                  checked={f.renewalOnly}
                  onChange={(v) => set("renewalOnly", v)}
                />
                <SwitchRow
                  label={tr("下架后仍允许续费", "Renewable off sale")}
                  hint={tr("下架后现有用户还能续费和买重置包", "Off sale, holders may still renew and buy reset packs")}
                  checked={f.renewOffSale}
                  onChange={(v) => set("renewOffSale", v)}
                />
                <SwitchRow
                  label={tr("允许从其他套餐换入", "Allow switching in")}
                  hint={tr("用户可以把当前套餐换成这个", "Users may switch to it from other plans")}
                  checked={f.allowSwitchIn}
                  onChange={(v) => set("allowSwitchIn", v)}
                />
                <SwitchRow
                  label={tr("推荐", "Recommended")}
                  hint={tr(
                    "门户商店的套餐卡片显示「推荐」标签，购买按钮用主色；只影响显示",
                    "The portal shop card shows a “Recommended” tag and a primary button; display only",
                  )}
                  checked={f.recommended}
                  onChange={(v) => set("recommended", v)}
                />
              </div>
              {show("onSale") && (
                <p className="flex items-center gap-1 text-footnote text-destructive">
                  <CircleAlert className="size-3.5" aria-hidden="true" />
                  {show("onSale")}{" "}
                  <button type="button" className="font-medium underline" onClick={() => onTab("prices")}>
                    {tr("去定价", "Set prices")}
                  </button>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
      {impact && plan && (
        <ImpactDialog
          plan={plan}
          impact={impact}
          changes={termChanges(plan, impact.body, groups, tr)}
          onCancel={() => setImpact(null)}
          onSave={async (b) => {
            if (await save(b)) setImpact(null);
          }}
        />
      )}
    </Dialog>
  );
}

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: ReactNode;
  hint: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SwitchField className="min-h-12 py-2.5" label={label} description={hint} checked={checked} onChange={onChange} />
  );
}

/**
 * "This change reaches current users": a sm dialog stacked over the editor
 * (Esc closes only it). Each choice has its own spinner.
 */
function ImpactDialog({
  plan,
  impact,
  changes,
  onCancel,
  onSave,
}: {
  plan: PlanView;
  impact: Impact;
  changes: { k: string; from: string; to: string }[];
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
  const paused = impact.over_quota;
  return (
    <Dialog
      open
      size="sm"
      icon={Users}
      tone="warning"
      dirty={false}
      onClose={() => !busy && onCancel()}
      title={tr("这次改动会影响现有用户", "This change reaches current users")}
      description={tr(
        `「${plan.name}」有 ${num(impact.subscribers)} 个生效订阅`,
        `"${plan.name}" has ${num(impact.subscribers)} active subscriptions`,
      )}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button disabled={busy === "all"} loading={busy === "new"} onClick={() => void go("new")}>
            {tr("只对新订单生效", "New orders only")}
          </Button>
          <Button
            variant={paused > 0 ? "destructive" : "primary"}
            disabled={busy === "new"}
            loading={busy === "all"}
            onClick={() => void go("all")}
          >
            {tr("同时应用到现有用户", "Apply to current users too")}
          </Button>
        </div>
      }
    >
      {changes.length > 0 && (
        <ul className="divide-y divide-separator rounded-xl bg-window ring-1 ring-border ring-inset">
          {changes.map((c) => (
            <li key={c.k} className="flex flex-wrap items-center gap-2 px-3 py-2 text-body">
              <span className="w-14 shrink-0 text-muted-foreground">{c.k}</span>
              <span className="tnum min-w-0 text-muted-foreground line-through decoration-faint">{c.from}</span>
              <ArrowRight className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
              <span className="tnum min-w-0 font-semibold">{c.to}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-card p-3 ring-1 ring-border ring-inset">
          <dt className="text-footnote text-muted-foreground">{tr("订阅人数", "Subscribers")}</dt>
          <dd className="tnum text-title2 font-semibold">{num(impact.subscribers)}</dd>
        </div>
        <div
          className={cn(
            "rounded-xl p-3 ring-1 ring-inset",
            paused ? "bg-destructive-soft ring-destructive/20" : "bg-card ring-border",
          )}
        >
          <dt className="text-footnote text-muted-foreground">{tr("会被立即暂停", "Suspended at once")}</dt>
          <dd className={cn("tnum text-title2 font-semibold", paused > 0 && "text-destructive")}>{num(paused)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-footnote text-muted-foreground">
        {paused
          ? tr(
              `应用到现有用户时，本期已用流量超过新上限的 ${num(paused)} 人会立即暂停，直到下次重置或续费。`,
              `Applied to current users, the ${num(paused)} already over the new quota are suspended until the next reset or renewal.`,
            )
          : tr("应用到现有用户不会让任何人立即暂停。", "Applying it to current users suspends nobody.")}
        {tr(
          "「只对新订单生效」则现有用户保持原条款（条款在购买时快照）。",
          ' "New orders only" keeps current users on their terms (terms are snapshotted at purchase).',
        )}
      </p>
    </Dialog>
  );
}

/* ---------- enable / disable / delete (board menu and editor footer) ---------- */

/** Enable / disable with the consequences; delete with the name (or the "still held" dialog). */
export function usePlanActions(onBlocked: (p: PlanView) => void) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const toggle = async (p: PlanView) => {
    const off = p.enabled;
    const ok = await confirm({
      title: off ? tr(`停用「${p.name}」？`, `Disable "${p.name}"?`) : tr(`启用「${p.name}」？`, `Enable "${p.name}"?`),
      description: off
        ? tr(
            "门户不再展示，新用户不能购买，也不能从其他套餐换入。",
            "Hidden in the portal: nobody can buy it or switch to it.",
          )
        : listed({ ...p, enabled: true })
          ? tr("门户会立即展示这个套餐。", "The portal shows it at once.")
          : tr(
              "它还没有在售或没有定价，启用后门户仍然看不到；请在编辑里定价并打开「在售」。",
              'It is off sale or unpriced: the portal still will not show it. Price it and turn on "On sale" in the editor.',
            ),
      impacts: [
        {
          label: tr("现有用户", "Current holders"),
          value: off
            ? p.renew_off_sale
              ? tr(`${num(p.active_users)} 位 · 照常使用，可续费`, `${num(p.active_users)} · keep it and may renew`)
              : tr(
                  `${num(p.active_users)} 位 · 照常使用到期，不能续费`,
                  `${num(p.active_users)} · keep it until expiry, no renewal`,
                )
            : tr(`${num(p.active_users)} 位 · 不受影响`, `${num(p.active_users)} · unaffected`),
        },
      ],
      tone: off ? "warning" : "default",
      confirmLabel: off ? tr("停用", "Disable") : tr("启用", "Enable"),
      action: () => patch(`/plans/${p.id}`, { enabled: !p.enabled }),
    });
    if (ok) toast({ tone: "success", title: off ? tr("已停用", "Disabled") : tr("已启用", "Enabled") });
  };
  const remove = async (p: PlanView): Promise<boolean> => {
    if (p.active_users > 0) {
      onBlocked(p);
      return false;
    }
    const ok = await confirm({
      title: tr(`删除套餐「${p.name}」？`, `Delete plan "${p.name}"?`),
      description: tr(
        "没有用户持有这个套餐。删除后门户和后台都不再显示它，历史订单保留套餐名称。",
        "Nobody holds this plan. It disappears from the portal and the console; past orders keep its name.",
      ),
      impacts: [
        { label: tr("持有用户", "Holders"), value: "0" },
        {
          label: tr("已定价的周期", "Priced periods"),
          value: tr(`${p.prices.length} 个`, String(p.prices.length)),
        },
        {
          label: tr("库存", "Stock"),
          value: p.capacity === null ? tr("不限", "No limit") : tr(`${num(p.capacity)} 人`, num(p.capacity)),
        },
      ],
      typeToConfirm: p.name,
      confirmLabel: tr("删除套餐", "Delete plan"),
      action: () => del(`/plans/${p.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("套餐已删除", "Plan deleted") });
    return ok;
  };
  return { toggle, remove };
}

/** Delete refused while users hold the plan: why, what to do, and who they are. */
export function DeleteBlocked({ plan, onClose }: { plan: PlanView; onClose: () => void }) {
  const tr = useTr();
  return (
    <Dialog
      open
      size="sm"
      icon={Trash2}
      dirty={false}
      onClose={onClose}
      title={tr(`暂时不能删除「${plan.name}」`, `"${plan.name}" cannot be deleted yet`)}
      description={tr(
        `还有 ${num(plan.active_users)} 个用户正在使用这个套餐`,
        `${num(plan.active_users)} users still hold this plan`,
      )}
      footer={
        <>
          <Link
            to={`/users?plan=${plan.id}`}
            onClick={onClose}
            className="hit-44 inline-flex h-8 items-center gap-1 rounded-lg px-3 text-body font-medium hover:bg-accent"
          >
            {tr("查看这些用户", "See these users")}
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </Link>
          <Button className="ml-auto" variant="primary" onClick={onClose}>
            {tr("知道了", "OK")}
          </Button>
        </>
      }
    >
      <p className="text-body">
        {tr(
          "删除会让这些用户的订阅失去依据。可以先停用（门户不再展示），等用户全部到期或换到其他套餐后再删除。",
          "Deleting would leave their subscriptions without a plan. Disable it first (hidden in the portal) and delete it once every holder has expired or switched.",
        )}
      </p>
      {plan.enabled && (
        <p className="mt-2 text-footnote text-muted-foreground">
          {plan.renew_off_sale
            ? tr("停用不影响现有用户使用和续费。", "Disabling keeps holders using and renewing it.")
            : tr("停用不影响现有用户使用到期。", "Disabling keeps holders using it until expiry.")}
        </p>
      )}
      <ImpactList
        className="mt-3"
        items={[{ label: tr("历史订单", "Past orders"), value: tr("保留套餐名称", "Keep the plan name") }]}
      />
    </Dialog>
  );
}
