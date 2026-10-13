// 套餐 (PLN-*, NOD-21; proposal-v2 §3 套餐看板 / 价格表 / 套餐编辑 / 节点组):
// page tabs 套餐 / 节点组 (/plans, /plans/groups); the board = plan cards in
// portal order (drag a card or use 上移 / 下移: PATCH sort), switchable to
// the price table (?view=prices, one PUT /plans/{id}/prices per changed
// plan); the plan editor (plans-editor.tsx) and the node groups view
// (plans-groups.tsx). Plans and groups refresh each other (data.ts).
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Gauge,
  GripVertical,
  Layers,
  LayoutGrid,
  Pencil,
  Plus,
  Power,
  PowerOff,
  Table2,
  Trash2,
  Users,
  Waypoints,
  Zap,
} from "lucide-react";
import { useState, type DragEvent } from "react";
import { Link } from "react-router";
import { patch, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { bytes, parseYuan, pct } from "../../shared/format";
import { useTr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Segmented, Switch } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { Meter } from "../../shared/ui/meter";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import {
  entrancesOf,
  firstLine,
  groupFacts,
  listed,
  periodShort,
  useEntranceIndex,
  yuanRaw,
  type EntranceInfo,
} from "../components/commerce-plans";
import { AffixInput, numErr } from "../components/inputs";
import { FixCount, PageTabs } from "../components/kit";
import { useAction } from "../data";
import { useQS, useRoute } from "../router";
import { useGroups, usePlanList, useServers } from "../servers";
import { resetLabel } from "../terms";
import type { NodeGroup, PlanView } from "../types";
import { DeleteBlocked, PlanEditor, SECS, usePlanActions, type Sec } from "./plans-editor";
import { NodeGroupsView } from "./plans-groups";

const num = (n: number) => n.toLocaleString("en");

export function PlansPage() {
  const tr = useTr();
  const { sub } = useRoute();
  const [query, setQ] = useQS();
  const isGroups = sub[0] === "groups";
  const open = query.get("open");
  const view = query.get("view") === "prices" ? "prices" : "board";
  const plans = usePlanList();
  const groups = useGroups();
  const servers = useServers();
  const idx = useEntranceIndex(servers.data);
  const list = plans.data ?? [];
  const glist = groups.data ?? [];
  const [blocked, setBlocked] = useState<PlanView | null>(null);
  const { toggle, remove } = usePlanActions(setBlocked);
  const onSale = list.filter(listed).length;
  const subs = list.reduce((n, p) => n + p.active_users, 0);
  const covered = new Set(glist.flatMap((g) => g.entrance_ids)).size;
  const rawTab = query.get("tab");
  const tab: Sec = (SECS as string[]).includes(rawTab ?? "") ? (rawTab as Sec) : "basic";
  const editing = open === "new" ? null : list.find((p) => p.id === open);
  return (
    <>
      <PageHeader
        title={tr("套餐", "Plans")}
        description={
          isGroups ? (
            groups.data ? (
              <span className="tnum">
                {tr(
                  `${glist.length} 个节点组 · 覆盖 ${covered} 个入口`,
                  `${glist.length} node groups · ${covered} entrances covered`,
                )}
              </span>
            ) : (
              tr("节点组把一组入口打包，供套餐选择。", "Node groups bundle entrances for plans.")
            )
          ) : plans.data ? (
            <span className="tnum">
              <b className="font-semibold text-foreground">{onSale}</b>
              {tr(" 个在售 · ", " on sale · ")}
              <b className="font-semibold text-foreground">{num(subs)}</b>
              {tr(" 位用户订阅中", " subscribers")}
            </span>
          ) : (
            tr(
              "用户能用哪些入口只由套餐决定：套餐 → 节点组 → 入口。",
              "Access comes from plans: plan → group → entrance.",
            )
          )
        }
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setQ({ open: "new", tab: null })}>
            {isGroups ? tr("新建节点组", "New node group") : tr("新建套餐", "New plan")}
          </Button>
        }
      />
      <PageTabs
        label={tr("套餐页面", "Plan pages")}
        items={[
          { to: "/plans", label: tr("套餐", "Plans"), count: plans.data ? list.length : undefined, end: true },
          {
            to: "/plans/groups",
            label: (
              <span className="inline-flex items-center gap-1">
                <Waypoints className="size-4" aria-hidden="true" />
                {tr("节点组", "Node groups")}
              </span>
            ),
            count: groups.data ? glist.length : undefined,
          },
        ]}
        trailing={
          isGroups ? undefined : (
            <Segmented
              size="sm"
              label={tr("套餐视图", "Plan view")}
              value={view}
              onChange={(v) => setQ({ view: v === "board" ? null : v }, true)}
              options={[
                {
                  value: "board",
                  label: (
                    <span className="inline-flex items-center gap-1">
                      <LayoutGrid className="size-3.5" aria-hidden="true" />
                      <span className="max-sm:sr-only">{tr("卡片", "Cards")}</span>
                    </span>
                  ),
                },
                {
                  value: "prices",
                  label: (
                    <span className="inline-flex items-center gap-1">
                      <Table2 className="size-3.5" aria-hidden="true" />
                      {tr("价格表", "Prices")}
                    </span>
                  ),
                },
              ]}
            />
          )
        }
      />
      {isGroups ? (
        <NodeGroupsView open={open} />
      ) : plans.isError ? (
        <Card>
          <ErrorState
            title={tr("套餐加载失败", "Plans failed to load")}
            error={plans.error}
            onRetry={() => void plans.refetch()}
          />
        </Card>
      ) : plans.isPending ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label={tr("加载中", "Loading")}>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-60 rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            icon={Layers}
            title={tr("创建第一个套餐", "Create your first plan")}
            description={tr(
              "套餐决定用户买到多少流量、能用哪些节点、多少钱。建议先建好节点组，再创建套餐。",
              "A plan decides how much traffic users get, which nodes they reach and the price. Set up node groups first.",
            )}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Link
                  to="/plans/groups"
                  className="hit-44 inline-flex h-8 items-center rounded-lg bg-secondary px-3 text-body font-medium hover:bg-accent"
                >
                  {tr("先看节点组", "See node groups")}
                </Link>
                <Button variant="primary" icon={Plus} onClick={() => setQ({ open: "new" })}>
                  {tr("新建套餐", "New plan")}
                </Button>
              </div>
            }
          />
        </Card>
      ) : view === "prices" ? (
        <PriceMatrix plans={list} />
      ) : (
        <Board
          plans={list}
          groups={glist}
          idx={idx}
          onOpen={(p) => setQ({ open: p.id, tab: null })}
          onNew={() => setQ({ open: "new", tab: null })}
          onToggle={(p) => void toggle(p)}
          onDelete={(p) => void remove(p)}
        />
      )}
      {!isGroups && open && editing !== undefined && plans.data && (
        <PlanEditor
          key={open}
          plan={editing}
          plans={list}
          groups={glist}
          idx={idx}
          tab={tab}
          onTab={(s) => setQ({ tab: s === "basic" ? null : s }, true)}
          onClose={() => setQ({ open: null, tab: null })}
          onToggle={(p) => void toggle(p)}
          onDelete={async (p) => {
            if (await remove(p)) setQ({ open: null, tab: null });
          }}
        />
      )}
      {blocked && <DeleteBlocked plan={blocked} onClose={() => setBlocked(null)} />}
    </>
  );
}

/* ---------- 看板 ---------- */

function Board({
  plans,
  groups,
  idx,
  onOpen,
  onNew,
  onToggle,
  onDelete,
}: {
  plans: PlanView[];
  groups: NodeGroup[];
  idx: Map<string, EntranceInfo>;
  onOpen: (p: PlanView) => void;
  onNew: () => void;
  onToggle: (p: PlanView) => void;
  onDelete: (p: PlanView) => void;
}) {
  const tr = useTr();
  const [run] = useAction();
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  // Portal order = sort, then name (GET /plans): rewrite the sorts of the
  // plans that moved as index × 10 so the new order is unambiguous.
  const reorder = async (ids: string[]) => {
    const changes = ids
      .map((id, i) => ({ p: plans.find((x) => x.id === id)!, sort: (i + 1) * 10 }))
      .filter(({ p, sort }) => p.sort !== sort);
    if (!changes.length) return;
    await run(() => Promise.all(changes.map(({ p, sort }) => patch(`/plans/${p.id}`, { sort }))), {
      ok: tr("顺序已保存", "Order saved"),
    });
  };
  const ids = plans.map((p) => p.id);
  const move = (id: string, to: number) => {
    const next = ids.filter((x) => x !== id);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, id);
    void reorder(next);
  };
  const onDrop = (target: string) => (e: DragEvent) => {
    e.preventDefault();
    const from = drag;
    setDrag(null);
    setOver(null);
    if (!from || from === target) return;
    move(from, ids.indexOf(target));
  };
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((p, i) => (
          <PlanCard
            key={p.id}
            p={p}
            index={i}
            last={i === plans.length - 1}
            groups={groups}
            idx={idx}
            dragging={drag === p.id}
            over={over === p.id && drag !== p.id}
            onDragStart={() => setDrag(p.id)}
            onDragEnd={() => (setDrag(null), setOver(null))}
            onDragOver={(e) => {
              if (!drag) return;
              e.preventDefault();
              setOver(p.id);
            }}
            onDrop={onDrop(p.id)}
            onOpen={() => onOpen(p)}
            onMove={(d) => move(p.id, i + d)}
            onToggle={() => onToggle(p)}
            onDelete={() => onDelete(p)}
          />
        ))}
        <button
          type="button"
          onClick={onNew}
          className="flex min-h-40 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-body font-medium text-muted-foreground transition-colors hover:border-primary hover:bg-primary-soft hover:text-primary"
        >
          <Plus className="size-5" aria-hidden="true" />
          {tr("新建套餐", "New plan")}
        </button>
      </div>
      <p className="mt-3 px-1 text-footnote text-faint">
        <span className="max-sm:hidden">
          {tr("卡片顺序就是门户里的展示顺序，按住 ", "Card order is the portal order: drag ")}
          <GripVertical className="inline size-3.5" aria-hidden="true" />
          {tr(" 拖动调整，或用 ⋯ 菜单上移 / 下移。", " to reorder, or use Move up / Move down in the ⋯ menu.")}
        </span>
        <span className="sm:hidden">
          {tr(
            "卡片顺序就是门户里的展示顺序，用 ⋯ 菜单上移 / 下移。",
            "Card order is the portal order; reorder in the ⋯ menu.",
          )}
        </span>
      </p>
    </>
  );
}

function PlanCard({
  p,
  index,
  last,
  groups,
  idx,
  dragging,
  over,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onOpen,
  onMove,
  onToggle,
  onDelete,
}: {
  p: PlanView;
  index: number;
  last: boolean;
  groups: NodeGroup[];
  idx: Map<string, EntranceInfo>;
  dragging: boolean;
  over: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onOpen: () => void;
  onMove: (d: -1 | 1) => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const tr = useTr();
  const sale = listed(p);
  const priced = p.prices.some((x) => x.period !== "reset");
  const mine = p.group_ids.map((id) => groups.find((g) => g.id === id)).filter((g): g is NodeGroup => !!g);
  const ents = entrancesOf(p.group_ids, groups);
  const fill = p.capacity !== null ? pct(p.active_users, p.capacity) : null;
  return (
    <section
      aria-label={p.name}
      onDragOver={onDragOver}
      onDrop={onDrop}
      className={cn("rounded-xl", over && "ring-2 ring-primary", dragging && "opacity-50")}
    >
      <Card
        className={cn(
          "group relative flex h-full flex-col transition-shadow hover:shadow-raised",
          !p.enabled && "bg-window",
        )}
      >
        <div className="flex items-start gap-2 px-4 pt-3.5">
          <span
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", p.id);
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            className="relative z-10 -ml-1.5 mt-0.5 inline-flex h-6 w-4 cursor-grab items-center justify-center text-faint opacity-50 group-hover:opacity-100 max-sm:hidden"
            title={tr("拖动调整门户中的顺序", "Drag to reorder in the portal")}
            aria-hidden="true"
          >
            <GripVertical className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="tnum text-footnote text-faint">#{index + 1}</span>
              <button
                type="button"
                onClick={onOpen}
                className="truncate text-left text-headline font-semibold tracking-[-0.01em] after:absolute after:inset-0 hover:underline"
              >
                {p.name}
              </button>
              {!p.enabled ? (
                <Badge>
                  <PowerOff aria-hidden="true" />
                  {tr("已停用", "Disabled")}
                </Badge>
              ) : sale ? (
                <Badge tone="success" dot>
                  {tr("在售", "On sale")}
                </Badge>
              ) : (
                <Badge tone="warning">{tr("未上架", "Off sale")}</Badge>
              )}
            </div>
            {firstLine(p.description) && (
              <p className="mt-0.5 truncate text-footnote text-muted-foreground">{firstLine(p.description)}</p>
            )}
          </div>
          <div className="relative z-10 -mr-1.5">
            <RowMenu label={tr(`套餐 ${p.name} 的操作`, `Actions of ${p.name}`)}>
              {(close) => (
                <>
                  <MenuItem icon={Pencil} onClick={() => (close(), onOpen())}>
                    {tr("编辑", "Edit")}
                  </MenuItem>
                  <MenuItem icon={ArrowUp} disabled={index === 0} onClick={() => (close(), onMove(-1))}>
                    {tr("上移", "Move up")}
                  </MenuItem>
                  <MenuItem icon={ArrowDown} disabled={last} onClick={() => (close(), onMove(1))}>
                    {tr("下移", "Move down")}
                  </MenuItem>
                  <MenuItem icon={p.enabled ? PowerOff : Power} onClick={() => (close(), onToggle())}>
                    {p.enabled ? tr("停用", "Disable") : tr("启用", "Enable")}
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem icon={Trash2} danger onClick={() => (close(), onDelete())}>
                    {tr("删除", "Delete")}
                    {p.active_users > 0 && (
                      <span className="ml-2 text-footnote text-muted-foreground">
                        {tr(`${num(p.active_users)} 人持有`, `${num(p.active_users)} hold it`)}
                      </span>
                    )}
                  </MenuItem>
                </>
              )}
            </RowMenu>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5 px-4" aria-label={tr("价格", "Prices")}>
          {!priced ? (
            <span className="rounded-lg bg-warning-soft px-2.5 py-1 text-footnote font-medium text-warning">
              {tr("还没有定价，门户不会展示", "No prices yet: hidden in the portal")}
            </span>
          ) : (
            p.prices.map((x) => (
              <span
                key={`${x.period}-${x.days ?? ""}`}
                className={cn(
                  "inline-flex items-baseline gap-1 rounded-lg px-2.5 py-1",
                  sale ? "bg-primary-soft text-primary" : "bg-secondary text-muted-foreground",
                )}
                title={
                  sale ? tr("门户在售", "On sale") : tr("有价格但门户未展示", "Priced but not shown in the portal")
                }
              >
                <span className="text-caption">{periodShort(x, tr)}</span>
                <span className={cn("tnum text-callout font-semibold", !sale && "line-through decoration-1")}>
                  ¥{yuanRaw(x.price_cents)}
                </span>
              </span>
            ))
          )}
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 px-4 text-body">
          <div className="flex min-w-0 items-center gap-1.5">
            <dt className="sr-only">{tr("流量", "Traffic")}</dt>
            <Gauge className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
            <dd className="min-w-0 truncate">
              <span className="tnum">
                {p.traffic_quota_bytes
                  ? // A configured quota reads as entered ("50 GiB", not "50.0 GiB").
                    bytes(p.traffic_quota_bytes).replace(/\.0 /, " ")
                  : tr("不限流量", "Unlimited")}
              </span>
              <span className="text-muted-foreground"> · {resetLabel(p.period, tr)}</span>
            </dd>
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <dt className="sr-only">{tr("限速", "Speed")}</dt>
            <Zap className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
            <dd className="tnum truncate">
              {p.speed_limit_mbps
                ? tr(`限速 ${p.speed_limit_mbps} Mbps`, `${p.speed_limit_mbps} Mbps`)
                : tr("不限速", "No speed limit")}
            </dd>
          </div>
        </dl>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 px-4">
          {mine.length === 0 ? (
            <span className="text-footnote text-warning">
              {tr("未选择节点组，用户拿不到任何入口", "No node group: users get no entrance")}
            </span>
          ) : (
            mine.map((g) => {
              const fx = groupFacts(g, idx);
              return (
                <span
                  key={g.id}
                  className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-secondary px-2 text-footnote"
                >
                  <Layers className="size-3 shrink-0 text-faint" aria-hidden="true" />
                  <span className="truncate font-medium">{g.name}</span>
                  <span className="tnum shrink-0 text-muted-foreground">
                    {tr(`${fx.count} 入口`, `${fx.count} ent.`)}
                  </span>
                  {fx.relays > 0 && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-chart-2">
                      <ArrowRightLeft className="size-3" aria-hidden="true" />
                      {tr("中转", "Relay")}
                    </span>
                  )}
                </span>
              );
            })
          )}
          {ents.length > 0 && (
            <span className="text-footnote text-faint">
              {tr(`共 ${ents.length} 个入口`, `${ents.length} entrances`)}
            </span>
          )}
        </div>

        {(p.renewal_only || !p.allow_switch_in || (!sale && p.renew_off_sale && p.active_users > 0)) && (
          <div className="mt-2 flex flex-wrap gap-1 px-4">
            {p.renewal_only && <Badge tone="outline">{tr("仅续费", "Renewal only")}</Badge>}
            {!sale && p.enabled && p.renew_off_sale && p.active_users > 0 && (
              <Badge tone="outline">{tr("下架后可续费", "Renewable off sale")}</Badge>
            )}
            {!p.allow_switch_in && <Badge tone="outline">{tr("不可换入", "No switching in")}</Badge>}
          </div>
        )}

        <div className="min-h-3 flex-1" />
        <div className="flex items-center gap-4 border-t border-separator px-4 py-2.5">
          <span className="inline-flex items-baseline gap-1.5">
            <Users className="size-3.5 translate-y-0.5 text-faint" aria-hidden="true" />
            <b className="tnum text-callout font-semibold">{num(p.active_users)}</b>
            <span className="text-footnote text-muted-foreground">{tr("订阅中", "subscribed")}</span>
          </span>
          <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2 text-footnote text-muted-foreground">
            {p.capacity === null || fill === null ? (
              tr("库存不限", "No stock limit")
            ) : (
              <>
                <span className="tnum whitespace-nowrap">
                  {tr(
                    `库存 ${num(p.active_users)} / ${num(p.capacity)}`,
                    `Stock ${num(p.active_users)} / ${num(p.capacity)}`,
                  )}
                </span>
                <Meter className="max-w-24" value={fill} label={tr("库存占用", "Stock used")} />
              </>
            )}
          </span>
        </div>
      </Card>
    </section>
  );
}

/* ---------- 价格表 ---------- */

/** The matrix's columns: the calendar periods and the reset pack (custom days / one-time stay in the editor). */
const COLS = ["month", "quarter", "half_year", "year", "two_year", "three_year", "reset"] as const;
type Col = (typeof COLS)[number];
type Draft = Record<string, { cells: Partial<Record<Col, string>>; onSale?: boolean }>;

function PriceMatrix({ plans }: { plans: PlanView[] }) {
  const tr = useTr();
  const [draft, setDraft] = useState<Draft>({});
  const [run, busy] = useAction();
  const base = (p: PlanView, c: Col) => {
    const x = p.prices.find((pp) => pp.period === c);
    return x ? yuanRaw(x.price_cents) : "";
  };
  const value = (p: PlanView, c: Col) => draft[p.id]?.cells[c] ?? base(p, c);
  const saleOf = (p: PlanView) => draft[p.id]?.onSale ?? p.on_sale;
  const cellErr = (raw: string) => {
    if (!raw.trim()) return undefined;
    const e = numErr(raw, tr, { money: true });
    if (e) return e;
    const c = parseYuan(raw);
    return c === null || c < 1 ? tr("须大于 0", "Must be above 0") : undefined;
  };
  // A row may go on sale only with a price other than the reset pack (kept custom-days / one-time prices count).
  const rowErr = (p: PlanView) =>
    saleOf(p) &&
    !COLS.some((c) => c !== "reset" && value(p, c).trim()) &&
    !p.prices.some((x) => x.period === "days" || x.period === "onetime")
      ? tr("在售需要至少一个价格", "On sale needs a price")
      : undefined;
  const changed = plans.flatMap((p) => [
    ...COLS.filter((c) => value(p, c) !== base(p, c)).map((c) => ({ p, c })),
    ...(saleOf(p) !== p.on_sale ? [{ p, c: "sale" as const }] : []),
  ]);
  const errs =
    plans.flatMap((p) => COLS.filter((c) => cellErr(value(p, c)))).length + plans.filter((p) => rowErr(p)).length;
  const dirtyPlans = plans.filter((p) => changed.some((x) => x.p.id === p.id));
  const setCell = (p: PlanView, c: Col, v: string) =>
    setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], cells: { ...d[p.id]?.cells, [c]: v } } }));
  const save = async () => {
    const r = await run(
      () =>
        Promise.all(
          dirtyPlans.map((p) =>
            put(`/plans/${p.id}/prices`, {
              on_sale: saleOf(p),
              prices: [
                ...COLS.filter((c) => value(p, c).trim()).map((c) => ({
                  period: c,
                  price_cents: parseYuan(value(p, c))!,
                })),
                ...p.prices
                  .filter((x) => x.period === "days" || x.period === "onetime")
                  .map((x) =>
                    x.days
                      ? { period: x.period, days: x.days, price_cents: x.price_cents }
                      : { period: x.period, price_cents: x.price_cents },
                  ),
              ],
            }),
          ),
        ),
      { ok: tr("价格已保存", "Prices saved") },
    );
    if (r !== undefined) setDraft({});
  };
  return (
    <>
      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-body">
            <thead>
              <tr className="text-footnote text-muted-foreground">
                <th scope="col" className="sticky left-0 z-[1] h-9 bg-card px-4 text-left font-medium">
                  {tr("套餐", "Plan")}
                </th>
                {COLS.map((c) => (
                  <th scope="col" key={c} className="px-2 text-left font-medium">
                    {periodShort({ period: c, days: null, price_cents: 0 }, tr)}
                    {c !== "reset" && tr("付", "")}
                  </th>
                ))}
                <th scope="col" className="px-3 text-left font-medium">
                  {tr("门户在售", "On sale")}
                </th>
              </tr>
            </thead>
            <tbody>
              {plans.map((p) => {
                const re = rowErr(p);
                const other = p.prices.filter((x) => x.period === "days" || x.period === "onetime");
                return (
                  <tr key={p.id} className="border-t border-separator">
                    <th scope="row" className="sticky left-0 z-[1] bg-card px-4 py-2.5 text-left align-top font-normal">
                      <div className="font-semibold">{p.name}</div>
                      <div className="text-footnote text-muted-foreground">
                        {p.enabled
                          ? tr(`${num(p.active_users)} 订阅中`, `${num(p.active_users)} subscribed`)
                          : tr("已停用", "Disabled")}
                      </div>
                      {other.length > 0 && (
                        <div className="text-caption text-faint">
                          {other.map((x) => `${periodShort(x, tr)} ¥${yuanRaw(x.price_cents)}`).join(" · ")}
                        </div>
                      )}
                    </th>
                    {COLS.map((c) => {
                      const v = value(p, c);
                      const b = base(p, c);
                      const ch = v !== b;
                      const err = cellErr(v);
                      const name = tr(
                        `${p.name} ${periodShort({ period: c, days: null, price_cents: 0 }, tr)}价格`,
                        `${p.name} ${c} price`,
                      );
                      return (
                        <td key={c} className={cn("px-2 py-2 align-top", ch && "bg-primary-soft")}>
                          <AffixInput
                            prefix="¥"
                            value={v}
                            placeholder={tr("未定价", "Not sold")}
                            aria-label={name}
                            aria-invalid={!!err || undefined}
                            onChange={(e) => setCell(p, c, e.target.value)}
                            className="w-28"
                          />
                          {err ? (
                            <div className="mt-0.5 max-w-28 text-caption text-destructive">{err}</div>
                          ) : ch && b ? (
                            <div className="tnum mt-0.5 text-caption text-faint">{tr(`原 ¥${b}`, `was ¥${b}`)}</div>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className={cn("px-3 py-2 align-top", saleOf(p) !== p.on_sale && "bg-primary-soft")}>
                      <label className="flex min-h-8 items-center gap-2 text-footnote text-muted-foreground">
                        <Switch
                          checked={saleOf(p)}
                          label={tr(`${p.name} 门户在售`, `${p.name} on sale`)}
                          onChange={(v) =>
                            setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], cells: d[p.id]?.cells ?? {}, onSale: v } }))
                          }
                        />
                        {saleOf(p) ? tr("在售", "On sale") : tr("未上架", "Off sale")}
                      </label>
                      {re && <div className="mt-0.5 text-caption text-destructive">{re}</div>}
                      {!p.enabled && saleOf(p) && (
                        <div className="mt-0.5 text-caption text-faint">{tr("套餐已停用", "Plan disabled")}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="border-t border-separator px-4 py-2.5 text-footnote text-faint">
          {tr(
            "改价只影响新订单和之后的续费；已付款的订单不变。留空 = 这个周期不卖；自定义天数与一次性价格在套餐编辑里改。",
            "New prices apply to new orders and later renewals; paid orders keep theirs. Empty = not sold; custom-days and one-time prices are in the plan editor.",
          )}
        </p>
      </Card>
      {changed.length > 0 && (
        <div className="pointer-events-none sticky bottom-[calc(env(safe-area-inset-bottom)+72px)] z-30 mt-3 flex justify-center lg:bottom-4">
          <div
            role="region"
            aria-label={tr("未保存的价格", "Unsaved prices")}
            className="glass pointer-events-auto flex max-w-full flex-wrap items-center gap-3 rounded-2xl bg-popover py-1.5 pr-1.5 pl-4 shadow-dialog"
          >
            <span className="text-body font-medium whitespace-nowrap" role="status">
              {tr(`已修改 ${changed.length} 处价格`, `${changed.length} changes`)}
            </span>
            <FixCount n={errs} />
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft({})}>
              {tr("放弃", "Discard")}
            </Button>
            <Button variant="primary" size="sm" loading={busy} disabled={errs > 0} onClick={() => void save()}>
              {tr("保存价格", "Save prices")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
