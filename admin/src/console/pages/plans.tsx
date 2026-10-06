// 套餐 (PLN-*, NOD-21): plan cards, the plan drawer (terms, sale rules,
// node groups with the entrances users get, prices — one request), the
// 中-5 impact preview with "apply to existing subscribers", enable /
// disable / delete; and the node groups tab (D3: plan → group → entrance).
import { useMemo, useState } from "react";
import { del, patch, post } from "../../shared/api";
import { bytes, centsToYuanText, parseYuan, yuan } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { Icon } from "../../shared/ui/icons";
import { Dialog, Drawer, MenuItem, RowMenu, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardBody,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Switch,
  Tabs,
  Textarea,
} from "../../shared/ui/primitives";
import { FormError, SectionTitle, useRun } from "../kit";
import { navigate, setQuery, useRoute } from "../router";
import { PERIODS, periodLabel, resetLabel } from "../terms";
import type { NodeGroup, PlanView, ServerView } from "../types";
import { useGroups, useServers } from "./nodes";
import { usePlans } from "./users";

const GiB = 1024 ** 3;

/** Entrance id → "server / node / entrance" (and whether it is a relay). */
function useEntranceIndex(servers: ServerView[] | undefined) {
  return useMemo(() => {
    const m = new Map<string, { label: string; relay: boolean; hidden: boolean; rate: number; server: string }>();
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
          "用户能用哪些入口只由套餐决定：套餐 → 节点组 → 入口（D3）。",
          "Access comes from plans only: plan → node group → entrance (D3).",
        )}
        actions={
          tab === "plans" ? (
            <Button size="sm" variant="primary" icon="plus" onClick={() => setQuery({ open: "new" }, false)}>
              {tr("新建套餐", "New plan")}
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon="plus" onClick={() => setQuery({ group: "new" }, false)}>
              {tr("新建节点组", "New node group")}
            </Button>
          )
        }
      />
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

function PlanList({ open }: { open: string | null }) {
  const tr = useTr();
  const plans = usePlans();
  const groups = useGroups();
  const confirm = useConfirm();
  const toast = useToast();
  const [run] = useRun();
  const groupName = new Map((groups.data ?? []).map((g) => [g.id, g]));
  const servers = useServers();
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
  return (
    <>
      {list.length === 0 ? (
        <Card>
          <EmptyState
            icon="layers"
            title={tr("还没有套餐", "No plans yet")}
            action={
              <Button variant="primary" onClick={() => setQuery({ open: "new" }, false)}>
                {tr("新建套餐", "New plan")}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {list.map((p) => {
            const ents = new Set(p.group_ids.flatMap((g) => groupName.get(g)?.entrance_ids ?? []));
            const relays = [...ents].filter((e) => idx.get(e)?.relay).length;
            return (
              <section key={p.id} aria-label={p.name}>
                <Card className={p.enabled ? "" : "opacity-70"}>
                  <CardBody>
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => setQuery({ open: p.id }, false)}
                      >
                        <div className="font-semibold hover:underline">{p.name}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {!p.enabled ? (
                            <Badge>{tr("已停用", "Disabled")}</Badge>
                          ) : p.on_sale ? (
                            <Badge tone="success">{tr("在售", "On sale")}</Badge>
                          ) : (
                            <Badge tone="warning">{tr("未上架", "Off sale")}</Badge>
                          )}
                          {p.renewal_only && <Badge tone="outline">{tr("仅续费", "Renewal only")}</Badge>}
                          {relays > 0 && <Badge tone="info">{tr("含中转", "Has relays")}</Badge>}
                        </div>
                      </button>
                      <RowMenu label={tr(`套餐 ${p.name} 的操作`, `Actions of ${p.name}`)}>
                        {(close) => (
                          <>
                            <MenuItem icon="settings" onClick={() => (close(), setQuery({ open: p.id }, false))}>
                              {tr("编辑", "Edit")}
                            </MenuItem>
                            <MenuItem
                              icon={p.enabled ? "pause" : "play"}
                              onClick={async () => {
                                close();
                                const ok = await confirm({
                                  title: p.enabled
                                    ? tr(`停用套餐 ${p.name}？`, `Disable ${p.name}?`)
                                    : tr(`启用套餐 ${p.name}？`, `Enable ${p.name}?`),
                                  description: p.enabled
                                    ? tr(
                                        "停用后不再出售；现有订阅照常使用。",
                                        "No longer sold; existing subscriptions keep working.",
                                      )
                                    : undefined,
                                  tone: p.enabled ? "warning" : "default",
                                });
                                if (ok)
                                  await run(() => patch(`/plans/${p.id}`, { enabled: !p.enabled }), {
                                    ok: tr("已保存", "Saved"),
                                    invalidate: [["plans"]],
                                  });
                              }}
                            >
                              {p.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
                            </MenuItem>
                            <MenuItem
                              icon="trash"
                              danger
                              onClick={async () => {
                                close();
                                const ok = await confirm({
                                  title: tr(`删除套餐 ${p.name}？`, `Delete ${p.name}?`),
                                  impact: p.active_users
                                    ? tr(
                                        `${p.active_users} 个用户正在使用：需先更换或取消`,
                                        `${p.active_users} users hold it: change or cancel theirs first`,
                                      )
                                    : undefined,
                                  typeToConfirm: p.name,
                                  action: () => del(`/plans/${p.id}`),
                                });
                                if (ok) {
                                  toast({ tone: "success", title: tr("套餐已删除", "Plan deleted") });
                                  void run(async () => undefined, { invalidate: [["plans"]] });
                                }
                              }}
                            >
                              {tr("删除", "Delete")}
                            </MenuItem>
                          </>
                        )}
                      </RowMenu>
                    </div>
                    <ul className="mt-3 space-y-1 text-[13px]">
                      {p.prices.map((pp) => (
                        <li key={pp.period} className="flex justify-between">
                          <span className="text-muted-foreground">{periodLabel(pp.period, tr, pp.days)}</span>
                          <span className="font-medium tabular-nums">{yuan(pp.price_cents)}</span>
                        </li>
                      ))}
                      {p.prices.length === 0 && <li className="text-muted-foreground">{tr("未定价", "No prices")}</li>}
                    </ul>
                    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                      <span>{p.traffic_quota_bytes ? bytes(p.traffic_quota_bytes) : tr("不限流量", "Unlimited")}</span>
                      <span>{resetLabel(p.period, tr)}</span>
                      <span>{p.speed_limit_mbps ? `${p.speed_limit_mbps} Mbps` : tr("不限速", "No speed limit")}</span>
                      <span>
                        {tr(
                          `${p.group_ids.length} 个节点组 · ${ents.size} 个入口`,
                          `${p.group_ids.length} groups · ${ents.size} entrances`,
                        )}
                      </span>
                      <span>
                        {tr(`订阅 ${p.active_users}`, `${p.active_users} subscribers`)}
                        {p.capacity !== null && tr(` / 库存 ${p.capacity}`, ` / stock ${p.capacity}`)}
                      </span>
                    </div>
                  </CardBody>
                </Card>
              </section>
            );
          })}
        </div>
      )}
      {open && (
        <PlanDrawer
          key={open}
          plan={open === "new" ? null : (list.find((p) => p.id === open) ?? null)}
          groups={groups.data ?? []}
          idx={idx}
          onClose={() => setQuery({ open: null })}
        />
      )}
    </>
  );
}

type PriceDraft = { on: boolean; price: string; days: string };

function resetKind(p: string): "monthly" | "none" | "days" {
  return p === "monthly" || p === "none" ? p : "days";
}

function PlanDrawer({
  plan,
  groups,
  idx,
  onClose,
}: {
  plan: PlanView | null;
  groups: NodeGroup[];
  idx: ReturnType<typeof useEntranceIndex>;
  onClose: () => void;
}) {
  const tr = useTr();
  const [f, setF] = useState({
    name: plan?.name ?? "",
    description: plan?.description ?? "",
    quota: plan?.traffic_quota_bytes ? String(plan.traffic_quota_bytes / GiB) : "",
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
  });
  const [prices, setPrices] = useState<Record<string, PriceDraft>>(() =>
    Object.fromEntries(
      PERIODS.map((p) => {
        const x = plan?.prices.find((pp) => pp.period === p);
        return [p, { on: !!x, price: x ? centsToYuanText(x.price_cents) : "", days: x?.days ? String(x.days) : "" }];
      }),
    ),
  );
  const [error, setError] = useState<unknown>(null);
  const [impact, setImpact] = useState<{
    body: Record<string, unknown>;
    subscribers: number;
    over_quota: number;
  } | null>(null);
  const [run, busy] = useRun();
  const ents = [...new Set(f.groups.flatMap((g) => groups.find((x) => x.id === g)?.entrance_ids ?? []))];

  const body = (): Record<string, unknown> | string => {
    if (!f.name.trim()) return tr("请填写名称", "Enter a name");
    const quota = f.quota.trim() ? Math.round(Number(f.quota) * GiB) : null;
    if (quota !== null && !(quota > 0))
      return tr("流量额度须为正数（GiB）", "The quota must be a positive number (GiB)");
    const speed = f.speed.trim() ? Number(f.speed) : null;
    const capacity = f.capacity.trim() ? Number(f.capacity) : null;
    const period = f.reset === "days" ? `days-${Number(f.resetDays)}` : f.reset;
    const list: { period: string; days?: number; price_cents: number }[] = [];
    for (const p of PERIODS) {
      const d = prices[p];
      if (!d.on) continue;
      const c = parseYuan(d.price);
      if (c === null) return tr(`${periodLabel(p, tr)}：价格无效`, `${periodLabel(p, tr)}: invalid price`);
      const item: { period: string; days?: number; price_cents: number } = { period: p, price_cents: c };
      if (p === "days" || (p === "onetime" && d.days.trim())) item.days = Number(d.days);
      list.push(item);
    }
    if (f.onSale && !list.some((x) => x.period !== "reset"))
      return tr(
        "上架前至少设置一个流量重置包以外的价格",
        "Set at least one price other than the reset pack before selling",
      );
    const all: Record<string, unknown> = {
      name: f.name.trim(),
      description: f.description,
      traffic_quota_bytes: quota,
      speed_limit_mbps: speed,
      period,
      group_ids: f.groups,
      capacity,
      renewal_only: f.renewalOnly,
      renew_off_sale: f.renewOffSale,
      allow_switch_in: f.allowSwitchIn,
      sort: Number(f.sort) || 0,
      enabled: f.enabled,
    };
    const pricing = { on_sale: f.onSale, prices: list };
    if (!plan) return { ...all, pricing };
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
    return out;
  };

  const save = async (b: Record<string, unknown>) => {
    const r = await run(() => (plan ? patch(`/plans/${plan.id}`, b) : post("/plans", b)), {
      ok: tr("套餐已保存", "Plan saved"),
      invalidate: [["plans"], ["node-groups"]],
    });
    if (r !== undefined) onClose();
  };
  const submit = async () => {
    const b = body();
    if (typeof b === "string") return setError(new Error(b));
    setError(null);
    const terms = ["traffic_quota_bytes", "speed_limit_mbps", "period", "group_ids"].some((k) => k in b);
    if (plan && terms) {
      try {
        const im = await post<{ subscribers: number; over_quota: number }>(`/plans/${plan.id}/impact`, b);
        if (im.subscribers > 0) return setImpact({ body: b, ...im });
      } catch (e) {
        return setError(e);
      }
    }
    await save(b);
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-2xl"
      title={plan ? tr(`编辑套餐 ${plan.name}`, `Edit ${plan.name}`) : tr("新建套餐", "New plan")}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("名称", "Name")} className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field
          label={tr(
            "说明（购买页显示；「- 」开头的行显示为列表）",
            'Description (shop; lines starting with "- " are a list)',
          )}
          className="sm:col-span-2"
        >
          <Textarea
            rows={3}
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
            className="font-sans"
          />
        </Field>
        <Field label={tr("流量额度（GiB，留空不限）", "Traffic quota (GiB; empty = unlimited)")}>
          <Input inputMode="decimal" value={f.quota} onChange={(e) => setF({ ...f, quota: e.target.value })} />
        </Field>
        <Field label={tr("限速（Mbps，留空不限）", "Speed limit (Mbps; empty = none)")}>
          <Input inputMode="numeric" value={f.speed} onChange={(e) => setF({ ...f, speed: e.target.value })} />
        </Field>
        <Field label={tr("流量重置", "Traffic reset")}>
          <Select value={f.reset} onChange={(e) => setF({ ...f, reset: e.target.value as typeof f.reset })}>
            <option value="monthly">{tr("每月（站点时区）", "Monthly (site time zone)")}</option>
            <option value="days">{tr("每 N 天", "Every N days")}</option>
            <option value="none">{tr("不重置", "Never")}</option>
          </Select>
        </Field>
        {f.reset === "days" && (
          <Field label={tr("N（天）", "N (days)")}>
            <Input
              inputMode="numeric"
              value={f.resetDays}
              onChange={(e) => setF({ ...f, resetDays: e.target.value })}
            />
          </Field>
        )}
        <Field label={tr("库存（最多用户数，留空不限）", "Stock (max subscribers; empty = no limit)")}>
          <Input inputMode="numeric" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
        </Field>
        <Field label={tr("排序", "Sort")}>
          <Input inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} />
        </Field>
      </div>
      <SectionTitle>{tr("销售规则", "Sale rules")}</SectionTitle>
      <div className="space-y-2 text-[13px]">
        {(
          [
            [
              "enabled",
              tr("启用（停用 = 不再出售，现有订阅照常）", "Enabled (disabled = not sold; subscribers keep it)"),
            ],
            ["onSale", tr("上架（商店里显示）", "On sale (shown in the shop)")],
            ["renewalOnly", tr("仅续费（只给已持有的用户续费）", "Renewal only (current holders)")],
            [
              "renewOffSale",
              tr("下架后现有用户仍可续费和买重置包", "Off sale: holders may still renew and buy reset packs"),
            ],
            ["allowSwitchIn", tr("允许从其他套餐换入", "Allow switching in from other plans")],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2">
            <Switch checked={f[k]} onChange={(v) => setF({ ...f, [k]: v })} label={label} />
            {label}
          </label>
        ))}
      </div>
      <SectionTitle>{tr("价格（元）", "Prices (yuan)")}</SectionTitle>
      <div className="space-y-1.5">
        {PERIODS.map((p) => (
          <div key={p} className="flex flex-wrap items-center gap-2 text-[13px]">
            <Checkbox
              checked={prices[p].on}
              label={periodLabel(p, tr)}
              onChange={(v) => setPrices({ ...prices, [p]: { ...prices[p], on: v } })}
            />
            <span className="w-36">{periodLabel(p, tr)}</span>
            <Input
              aria-label={tr(`${periodLabel(p, tr)}价格`, `${periodLabel(p, tr)} price`)}
              className="h-8 w-28"
              inputMode="decimal"
              value={prices[p].price}
              disabled={!prices[p].on}
              onChange={(e) => setPrices({ ...prices, [p]: { ...prices[p], price: e.target.value } })}
            />
            {(p === "days" || p === "onetime") && (
              <Input
                aria-label={tr("天数", "Days")}
                className="h-8 w-24"
                inputMode="numeric"
                placeholder={p === "onetime" ? tr("天数/永久", "days / none") : tr("天数", "days")}
                value={prices[p].days}
                disabled={!prices[p].on}
                onChange={(e) => setPrices({ ...prices, [p]: { ...prices[p], days: e.target.value } })}
              />
            )}
          </div>
        ))}
      </div>
      <SectionTitle>{tr("节点组", "Node groups")}</SectionTitle>
      <div className="flex flex-wrap gap-2">
        {groups.map((g) => (
          <label key={g.id} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[13px]">
            <Checkbox
              checked={f.groups.includes(g.id)}
              label={g.name}
              onChange={(on) => setF({ ...f, groups: on ? [...f.groups, g.id] : f.groups.filter((x) => x !== g.id) })}
            />
            {g.name}
          </label>
        ))}
        {groups.length === 0 && (
          <span className="text-[13px] text-muted-foreground">{tr("还没有节点组", "No node groups yet")}</span>
        )}
      </div>
      <div className="mt-3 rounded-md border border-border p-3">
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
          {tr(`用户将获得的入口（${ents.length}）`, `Entrances users get (${ents.length})`)}
        </div>
        <ul className="space-y-1 text-[13px]">
          {ents.map((id) => {
            const e = idx.get(id);
            return (
              <li key={id} className="flex items-center gap-1.5">
                <Icon name={e?.relay ? "route" : "zap"} size={12} className="text-muted-foreground" />
                {e ? `${e.server} / ${e.label}` : id}
                {e?.hidden && <Badge tone="danger">{tr("已隐藏", "hidden")}</Badge>}
                {e && <span className="text-xs text-muted-foreground">{e.rate}x</span>}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="mt-3">
        <FormError error={error} />
      </div>
      {impact && (
        <Dialog
          open
          tone="warning"
          icon="alert"
          onClose={() => setImpact(null)}
          title={tr("套餐条款变更", "Plan terms changed")}
          description={tr(
            `这个套餐有 ${impact.subscribers} 个生效订阅。改动默认只影响新购买（条款在购买时快照）。`,
            `${impact.subscribers} active subscriptions hold this plan. By default changes apply to new purchases only (terms are snapshotted).`,
          )}
          footer={
            <>
              <Button onClick={() => setImpact(null)}>{tr("取消", "Cancel")}</Button>
              <Button onClick={() => void save(impact.body)} loading={busy}>
                {tr("只影响新购买", "New purchases only")}
              </Button>
              <Button
                variant={impact.over_quota > 0 ? "destructive" : "primary"}
                loading={busy}
                onClick={() => void save({ ...impact.body, apply_to_existing: true })}
              >
                {tr(
                  `同时应用到 ${impact.subscribers} 个现有订阅`,
                  `Apply to the ${impact.subscribers} subscriptions too`,
                )}
              </Button>
            </>
          }
        >
          {impact.over_quota > 0 && (
            <Callout tone="danger">
              {tr(
                `其中 ${impact.over_quota} 人已超出新额度，应用后会被立即暂停。`,
                `${impact.over_quota} of them are over the new quota and would be suspended at once.`,
              )}
            </Callout>
          )}
        </Dialog>
      )}
    </Drawer>
  );
}

function GroupList({ open }: { open: string | null }) {
  const tr = useTr();
  const groups = useGroups();
  const servers = useServers();
  const plans = usePlans();
  const idx = useEntranceIndex(servers.data);
  const planName = new Map((plans.data ?? []).map((p) => [p.id, p.name]));
  if (groups.isError)
    return (
      <Card>
        <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
      </Card>
    );
  if (groups.isPending) return <Skeleton className="h-48" />;
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
            icon="layers"
            title={tr("还没有节点组", "No node groups yet")}
            action={
              <Button variant="primary" onClick={() => setQuery({ group: "new" }, false)}>
                {tr("新建节点组", "New node group")}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {groups.data.map((g) => (
            <section key={g.id} aria-label={g.name}>
              <Card>
                <CardBody>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-semibold">{g.name}</div>
                      {g.description && <div className="text-xs text-muted-foreground">{g.description}</div>}
                      <div className="mt-1 text-xs text-muted-foreground">
                        {tr("套餐：", "Plans: ")}
                        {g.plan_ids.map((p) => planName.get(p) ?? p.slice(0, 6)).join(", ") || "—"}
                      </div>
                    </div>
                    <Button size="sm" onClick={() => setQuery({ group: g.id }, false)}>
                      {tr("编辑", "Edit")}
                    </Button>
                  </div>
                  <ul className="mt-3 space-y-1 text-[13px]">
                    {g.entrance_ids.map((id) => {
                      const e = idx.get(id);
                      return (
                        <li key={id} className="flex items-center gap-1.5">
                          <Icon name={e?.relay ? "route" : "zap"} size={12} className="text-muted-foreground" />
                          {e ? `${e.server} / ${e.label}` : id}
                          {e && <span className="text-xs text-muted-foreground">{e.rate}x</span>}
                          {e?.hidden && <Badge tone="danger">{tr("已隐藏", "hidden")}</Badge>}
                        </li>
                      );
                    })}
                    {g.entrance_ids.length === 0 && (
                      <li className="text-muted-foreground">{tr("没有入口", "No entrances")}</li>
                    )}
                  </ul>
                </CardBody>
              </Card>
            </section>
          ))}
        </div>
      )}
      {open && (
        <GroupDialog
          group={open === "new" ? null : (groups.data.find((g) => g.id === open) ?? null)}
          servers={servers.data ?? []}
          onClose={() => setQuery({ group: null })}
        />
      )}
    </>
  );
}

function GroupDialog({
  group,
  servers,
  onClose,
}: {
  group: NodeGroup | null;
  servers: ServerView[];
  onClose: () => void;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [ids, setIds] = useState<string[]>(group?.entrance_ids ?? []);
  const [run, busy] = useRun();
  const submit = async () => {
    const b = { name: name.trim(), description, entrance_ids: ids };
    const r = await run(() => (group ? patch(`/node-groups/${group.id}`, b) : post("/node-groups", b)), {
      ok: tr("节点组已保存", "Node group saved"),
      invalidate: [["node-groups"], ["servers"]],
    });
    if (r !== undefined) onClose();
  };
  const remove = async () => {
    if (!group) return;
    const ok = await confirm({
      title: tr(`删除节点组 ${group.name}？`, `Delete ${group.name}?`),
      impact: group.plan_ids.length
        ? tr(
            `${group.plan_ids.length} 个套餐的用户会失去这些入口`,
            `Subscribers of ${group.plan_ids.length} plans lose these entrances`,
          )
        : undefined,
      typeToConfirm: group.name,
      action: () => del(`/node-groups/${group.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("节点组已删除", "Node group deleted") });
      void run(async () => undefined, { invalidate: [["node-groups"]] });
      onClose();
    }
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={group ? tr(`编辑节点组 ${group.name}`, `Edit ${group.name}`) : tr("新建节点组", "New node group")}
      onSubmit={submit}
      footer={
        <>
          {group && (
            <Button variant="destructive-soft" onClick={remove} className="sm:mr-auto">
              {tr("删除", "Delete")}
            </Button>
          )}
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!name.trim()}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={tr("名称", "Name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={tr("说明", "Description")}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[13px] font-medium">{tr("入口（按服务器）", "Entrances (by server)")}</legend>
          {servers.map((s) => (
            <div key={s.id} className="rounded-md border border-border p-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">{s.name}</div>
              {s.nodes.map((n) =>
                n.entrances.map((e) => (
                  <label key={e.id} className="flex items-center gap-2 py-0.5 text-[13px]">
                    <Checkbox
                      checked={ids.includes(e.id)}
                      label={`${n.name} · ${e.name}`}
                      onChange={(on) => setIds(on ? [...ids, e.id] : ids.filter((x) => x !== e.id))}
                    />
                    <Icon name={e.kind === "relay" ? "route" : "zap"} size={12} className="text-muted-foreground" />
                    {n.display_name || n.name} · {e.name}
                    <span className="text-xs text-muted-foreground">{e.rate}x</span>
                  </label>
                )),
              )}
            </div>
          ))}
          {servers.length === 0 && (
            <p className="text-[13px] text-muted-foreground">
              {tr("还没有服务器和入口", "No servers or entrances yet")}
            </p>
          )}
        </fieldset>
      </div>
    </Dialog>
  );
}
