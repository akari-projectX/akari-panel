// 订单 (ORD-01/02, v2 §3 "订单账本"): a day-grouped ledger. Each site day
// has a sticky header with its count, refunds and net (GET /orders/summary,
// so a day's totals are honest even when only part of it is loaded); the
// "paid, not fulfilled" banner and the segment counts come from the same
// summary, never from the loaded pages. One search box: `@…` = the buyer's
// email contains, else the order / trade number contains. Keyset paging:
// "已加载 N 条 · 加载更早" until the last page is in. Everything is in the URL
// (?status&via&q&open&new&export). The order dialog, refund, fulfil, manual
// order and export dialogs live in orders-detail.tsx / orders-dialogs.tsx.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { AtSign, CircleAlert, Download, Gift, Hand, Plus, ReceiptText, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateOnly, dateTime, siteToday, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { Kbd, Segmented, Select } from "../../shared/ui/form";
import { Banner, PageHeader } from "../../shared/ui/layout";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { FilterChip } from "../../shared/ui/table";
import { SearchField } from "../components/kit";
import { OrdStatus, orderState } from "../components/status";
import { useDebounced } from "../kit";
import { useQS } from "../router";
import { periodLabel } from "../terms";
import { OrderDialog } from "./orders-detail";
import { ExportDialog, ManualOrderDialog } from "./orders-dialogs";

export type RefundEffect =
  | { kind: "none"; why: string }
  | { kind: "cancel"; plan_name: string; expires_at: string | null }
  | { kind: "rollback"; plan_name: string; from: string; to: string }
  | { kind: "restore"; plan_name: string; expires_at: string | null; prior_used_bytes: number };

export type Order = {
  id: string;
  out_trade_no: string;
  user_id: string | null;
  user_label: string;
  user_email: string | null;
  plan_id: string | null;
  plan_name: string;
  amount_cents: number;
  period: string;
  period_days: number | null;
  list_price_cents: number;
  credit_cents: number;
  discount_cents: number;
  coupon_code: string | null;
  balance_cents: number;
  gift_cents: number;
  refunded_at: string | null;
  refund_cents: number | null;
  refund_balance_cents: number | null;
  refund_external_cents: number | null;
  refund_reason: string | null;
  refund_effect: RefundEffect | null;
  refund_request: { state: string; cents: number; last_error: string | null; attempts: number } | null;
  status: string;
  trade_no: string | null;
  paid_via: string | null;
  paid_amount_cents: number | null;
  manual_reason: string | null;
  fulfilled_at: string | null;
  fulfil_error: string | null;
  payment_method_name?: string | null;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  ended_at: string | null;
  action: string;
};

export const VIAS = ["notify", "query", "balance", "coupon", "credit", "manual"] as const;

export function viaText(v: string | null, tr: Tr): string {
  switch (v) {
    case "manual":
      return tr("人工", "Manual");
    case "notify":
      return tr("在线支付", "Online");
    case "query":
      return tr("在线支付（查询确认）", "Online (by query)");
    case "balance":
      return tr("余额", "Balance");
    case "coupon":
      return tr("优惠券全额", "Coupon");
    case "credit":
      return tr("换套餐抵扣", "Switch credit");
    default:
      return "—";
  }
}

/** The order's kind: new / renewal / switch / reset pack. */
export function actionText(a: string, tr: Tr): string {
  return (
    {
      new: tr("新购", "New"),
      renew: tr("续费", "Renewal"),
      switch: tr("换套餐", "Switch"),
      reset: tr("重置包", "Reset pack"),
    }[a] ?? a
  );
}

export function KindTag({ action }: { action: string }) {
  const tr = useTr();
  return (
    <span
      className={cn(
        "shrink-0 rounded-[5px] px-1 text-caption font-medium",
        action === "new"
          ? "bg-primary-soft text-primary"
          : action === "switch"
            ? "bg-warning-soft text-warning"
            : "bg-secondary text-muted-foreground",
      )}
    >
      {actionText(action, tr)}
    </span>
  );
}

/** How it was paid: manual / gift as badges, the rest as text. */
export function MethodTag({ o }: { o: Order }) {
  const tr = useTr();
  if (o.gift_cents > 0)
    return (
      <Badge tone="primary">
        <Gift className="size-3" aria-hidden="true" />
        {tr("赠送", "Gift")}
      </Badge>
    );
  if (o.paid_via === "manual")
    return (
      <Badge tone="info">
        <Hand className="size-3" aria-hidden="true" />
        {tr("人工", "Manual")}
      </Badge>
    );
  const text =
    o.paid_via === "notify" || o.paid_via === "query"
      ? (o.payment_method_name ?? viaText(o.paid_via, tr))
      : o.paid_via
        ? viaText(o.paid_via, tr)
        : (o.payment_method_name ?? "—");
  return <span className="truncate text-body text-muted-foreground">{text}</span>;
}

/** What the buyer paid in total: the channel amount plus the balance part. */
export const paidTotal = (o: Order) => o.amount_cents + o.balance_cents;

/** The small line under the amount: refund, gift, coupon / credit / balance parts. */
function AmountSub({ o }: { o: Order }) {
  const tr = useTr();
  if (o.refund_request?.state === "pending")
    return (
      <span className="text-warning">
        {tr("退款处理中 ", "Refunding ")}
        {yuan(o.refund_request.cents)}
      </span>
    );
  if (o.refunded_at)
    return (
      <span className="text-destructive">
        {tr("已退 ", "Refunded ")}
        {yuan(o.refund_cents)}
      </span>
    );
  if (o.gift_cents > 0)
    return (
      <span>
        {tr("原价 ", "List ")}
        {yuan(o.list_price_cents)}
      </span>
    );
  const parts = [
    o.discount_cents > 0 && `${tr("券", "Coupon")} −${yuan(o.discount_cents)}`,
    o.credit_cents > 0 && `${tr("抵扣", "Credit")} −${yuan(o.credit_cents)}`,
    o.balance_cents > 0 && `${tr("余额", "Balance")} ${yuan(o.balance_cents)}`,
  ].filter(Boolean);
  return parts.length ? <span>{parts.join(" · ")}</span> : null;
}

const GRID = "md:grid-cols-[44px_minmax(0,1.25fr)_minmax(0,0.9fr)_96px_92px_168px]";

function Row({ o, onOpen }: { o: Order; onOpen: () => void }) {
  const tr = useTr();
  const st = orderState(o);
  const stuck = st === "unfulfilled";
  const struck = o.status === "cancelled" || o.status === "expired";
  const time = dateTime(o.created_at).slice(11);
  return (
    <button
      type="button"
      data-row={o.id}
      onClick={onOpen}
      className={cn(
        "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none md:min-h-12 md:py-1.5",
        GRID,
        stuck && "bg-destructive-soft/40",
      )}
    >
      <span className="tnum text-footnote text-faint max-md:hidden">{time}</span>
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5 text-body">
          {stuck && (
            <CircleAlert
              className="size-3.5 shrink-0 text-destructive"
              aria-label={tr("已付款未开通", "Paid, not fulfilled")}
            />
          )}
          <span className="truncate font-semibold">{o.plan_name}</span>
          <span className="shrink-0 text-muted-foreground">· {periodLabel(o.period, tr, o.period_days)}</span>
          <KindTag action={o.action} />
        </span>
        <span className="mt-0.5 block truncate font-mono text-caption text-faint max-md:hidden">{o.out_trade_no}</span>
        <span className="mt-0.5 block truncate text-footnote text-muted-foreground md:hidden">
          <span className="tnum">{time}</span> · {o.user_email ?? o.user_label}
        </span>
      </span>
      <span className="min-w-0 truncate text-body text-muted-foreground max-md:hidden">
        {o.user_email ?? o.user_label}
      </span>
      <span className="min-w-0 max-md:hidden">
        <MethodTag o={o} />
      </span>
      <span className="max-md:hidden">
        <OrdStatus state={st} />
      </span>
      <span className="flex flex-col items-end gap-0.5 text-right">
        <span
          className={cn(
            "tnum text-body font-semibold",
            (struck || o.status === "pending") && "text-muted-foreground",
            struck && "line-through decoration-faint",
          )}
        >
          {yuan(paidTotal(o))}
        </span>
        <span className="tnum max-w-full truncate text-caption text-faint max-md:hidden">
          <AmountSub o={o} />
        </span>
        <span className="flex items-center gap-1 md:hidden">
          {(o.paid_via === "manual" || o.gift_cents > 0) && <MethodTag o={o} />}
          <OrdStatus state={st} />
        </span>
      </span>
    </button>
  );
}

const LIMIT = 50;

type Seg = "all" | "pending" | "paid" | "unfulfilled" | "refunded" | "expired" | "cancelled";
const SEGS: Seg[] = ["all", "pending", "paid", "unfulfilled", "refunded", "expired", "cancelled"];

type Counts = Record<Seg, number>;
type Day = { day: string; orders: number; paid_cents: number; refund_cents: number };
type Summary = { counts: Counts; days: Day[] };
/** The dashboard's "today" window (same query key: one request, refreshed by every write). */
type Dash = { today: { orders: number; gross_cents: number; refunds_cents: number } };

/** The list API's parameters for a segment. */
function statusParams(s: Seg): Record<string, string> {
  if (s === "unfulfilled") return { unfulfilled: "true" };
  if (s === "refunded") return { refunded: "true" };
  if (s === "all") return {};
  return { status: s };
}

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];
const WEEK_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "今天 · 10月12日 周一" for a site day (YYYY-MM-DD). */
export function dayLabel(day: string, today: string, tr: Tr): string {
  const d = new Date(`${day}T12:00:00Z`);
  const t = new Date(`${today}T12:00:00Z`);
  const diff = Math.round((t.getTime() - d.getTime()) / 86_400_000);
  const m = d.getUTCMonth();
  const md = tr(
    `${m + 1}月${d.getUTCDate()}日 周${WEEK_ZH[d.getUTCDay()]}`,
    `${WEEK_EN[d.getUTCDay()]}, ${MONTH_EN[m]} ${d.getUTCDate()}`,
  );
  const year = d.getUTCFullYear() !== t.getUTCFullYear() ? `${d.getUTCFullYear()} · ` : "";
  if (diff === 0) return `${tr("今天", "Today")} · ${md}`;
  if (diff === 1) return `${tr("昨天", "Yesterday")} · ${md}`;
  return `${year}${md}`;
}

export function OrdersPage() {
  const tr = useTr();
  const [query, patch] = useQS();
  // Links from elsewhere (dashboard, user detail, finance) use the old
  // parameters: map them onto the ledger's (replace, no history entry).
  useEffect(() => {
    const legacy: Record<string, string | null> = {};
    if (query.get("unfulfilled") === "1") Object.assign(legacy, { unfulfilled: null, status: "unfulfilled" });
    const email = query.get("email");
    const no = query.get("no");
    if (email) Object.assign(legacy, { email: null, q: `@${email}` });
    else if (no) Object.assign(legacy, { no: null, q: no });
    if (Object.keys(legacy).length) patch(legacy, true);
  }, [query, patch]);
  const seg = (SEGS.includes(query.get("status") as Seg) ? query.get("status") : "all") as Seg;
  const via = query.get("via") ?? "";
  const q = query.get("q") ?? "";
  const open = query.get("open");
  const emailMode = q.startsWith("@") || q.includes("@");
  const [term, setTerm] = useState(q);
  const dt = useDebounced(term.trim(), 300);
  const applied = useRef(q);
  useEffect(() => {
    if (dt === applied.current) return;
    applied.current = dt;
    patch({ q: dt || null }, true);
  }, [dt, patch]);
  useEffect(() => {
    // Back/forward or a chip cleared the search: follow the URL.
    if (q !== applied.current) {
      applied.current = q;
      setTerm(q);
    }
  }, [q]);

  const search = { via, q };
  const filters = { ...statusParams(seg), ...search };
  const list = useInfiniteQuery({
    queryKey: ["orders", "list", filters],
    queryFn: ({ pageParam }) => get<Order[]>(`/orders${qs({ ...filters, limit: LIMIT, before: pageParam })}`),
    initialPageParam: "",
    getNextPageParam: (last) => (last.length === LIMIT ? last[last.length - 1].id : undefined),
  });
  const rows = useMemo(() => list.data?.pages.flat() ?? [], [list.data]);
  const days = useMemo(() => {
    const m = new Map<string, Order[]>();
    for (const o of rows) {
      const d = dateOnly(o.created_at);
      m.set(d, [...(m.get(d) ?? []), o]);
    }
    return [...m.entries()];
  }, [rows]);
  const span = days.length ? { from: days[days.length - 1][0], to: days[0][0] } : {};
  const summary = useQuery({
    queryKey: ["orders", "summary", filters, span],
    queryFn: () => get<Summary>(`/orders/summary${qs({ ...filters, ...span })}`),
    enabled: !list.isPending,
    placeholderData: (prev) => prev,
  });
  // The banner: every paid-but-not-fulfilled order, whatever the filters.
  const attention = useQuery({
    queryKey: ["orders", "summary", "all"],
    queryFn: () => get<Summary>("/orders/summary"),
  });
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: () => get<Dash>("/dashboard") });
  const counts = summary.data?.counts;
  const dayTotals = new Map((summary.data?.days ?? []).map((d) => [d.day, d]));
  const stuck = attention.data?.counts.unfulfilled ?? 0;
  const today = siteToday();
  const filtered = seg !== "all" || !!via || !!q;
  const clear = () => {
    setTerm("");
    applied.current = "";
    patch({ status: null, via: null, q: null });
  };
  const newOrder = () => patch({ new: "1" });
  const t = dash.data?.today;
  const segLabel: Record<Seg, ReactNode> = {
    all: tr("全部", "All"),
    pending: tr("待支付", "Pending"),
    paid: tr("已付款", "Paid"),
    unfulfilled: <span className={cn(stuck > 0 && "text-destructive")}>{tr("未开通", "Not fulfilled")}</span>,
    refunded: tr("已退款", "Refunded"),
    expired: tr("已过期", "Expired"),
    cancelled: tr("已取消", "Cancelled"),
  };

  return (
    <>
      <PageHeader
        title={tr("订单", "Orders")}
        description={
          t ? (
            <span className="tnum">
              {tr("今天 ", "Today ")}
              <b className="font-semibold text-foreground">{t.orders}</b>
              {tr(" 笔 · 净收 ", " paid · net ")}
              <b className="font-semibold text-foreground">{yuan(t.gross_cents - t.refunds_cents)}</b>
            </span>
          ) : (
            tr("用户的购买、续费与人工订单，按天记账。", "Purchases, renewals and manual orders, by day.")
          )
        }
        actions={
          <>
            <Button
              variant="outline"
              icon={Download}
              onClick={() => patch({ export: "1" })}
              aria-label={tr("导出 CSV", "Export CSV")}
            >
              <span className="max-sm:hidden">{tr("导出 CSV", "Export CSV")}</span>
            </Button>
            <Button variant="primary" icon={Plus} onClick={newOrder}>
              {tr("新建人工订单", "New manual order")}
            </Button>
          </>
        }
      />

      {stuck > 0 && (
        <Banner
          tone="danger"
          icon={<Wrench />}
          className="mb-3"
          title={tr(`${stuck} 笔订单已付款但未开通`, `${stuck} paid orders are not fulfilled`)}
          action={
            seg !== "unfulfilled" ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setTerm("");
                  applied.current = "";
                  patch({ status: "unfulfilled", via: null, q: null });
                }}
              >
                {tr("处理", "Handle")}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => patch({ status: null })}>
                {tr("返回全部", "Back to all")}
              </Button>
            )
          }
        >
          <span className="max-sm:hidden">
            {tr(
              "用户已经付钱，但没拿到套餐。打开订单可以重试开通，或退款。",
              "The users paid but got no plan. Open each to retry or refund.",
            )}
          </span>
        </Banner>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-separator p-3">
          <SearchField
            label={tr("搜索订单号或邮箱", "Search order no. or email")}
            placeholder={tr("订单号 / 交易号；@ 开头搜邮箱", "Order / trade no.; @ for an email")}
            value={term}
            onChange={setTerm}
            shortcut="/"
            className="min-w-56 flex-1 max-sm:order-first max-sm:basis-full"
          />
          <Segmented
            label={tr("订单状态", "Order status")}
            value={seg}
            onChange={(v) => patch({ status: v === "all" ? null : v })}
            className="max-sm:w-full"
            options={SEGS.map((s) => ({ value: s, label: segLabel[s], count: counts?.[s] }))}
          />
          <Select
            aria-label={tr("付款方式", "Paid via")}
            className="w-36 max-sm:flex-1"
            value={via}
            onChange={(e) => patch({ via: e.target.value || null })}
          >
            <option value="">{tr("全部方式", "Any method")}</option>
            {VIAS.map((v) => (
              <option key={v} value={v}>
                {viaText(v, tr)}
              </option>
            ))}
          </Select>
        </div>
        {(q || via) && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-separator px-3 py-2">
            {q &&
              (emailMode ? (
                <FilterChip
                  label={tr("用户邮箱包含", "User email contains")}
                  value={
                    <span className="inline-flex items-center gap-0.5">
                      <AtSign className="size-3" aria-hidden="true" />
                      {q.replace(/^@/, "") || "…"}
                    </span>
                  }
                  onClear={() => {
                    setTerm("");
                    applied.current = "";
                    patch({ q: null });
                  }}
                />
              ) : (
                <FilterChip
                  label={tr("订单号或交易号包含", "Order or trade no. contains")}
                  value={q}
                  onClear={() => {
                    setTerm("");
                    applied.current = "";
                    patch({ q: null });
                  }}
                />
              ))}
            {via && (
              <FilterChip label={tr("方式", "Method")} value={viaText(via, tr)} onClear={() => patch({ via: null })} />
            )}
            {q && !emailMode && (
              <span className="text-footnote text-faint">
                {tr("提示：输入 ", "Tip: start with ")}
                <Kbd>@</Kbd>
                {tr(" 开头改为按用户邮箱搜索", " to search by the user's email")}
              </span>
            )}
          </div>
        )}

        <div
          className={cn(
            "grid gap-x-3 border-b border-separator px-4 py-1.5 text-footnote font-medium text-muted-foreground max-md:hidden",
            GRID,
          )}
          aria-hidden="true"
        >
          <span>{tr("时间", "Time")}</span>
          <span>{tr("套餐 · 订单号", "Plan · order")}</span>
          <span>{tr("用户", "User")}</span>
          <span>{tr("方式", "Method")}</span>
          <span>{tr("状态", "Status")}</span>
          <span className="text-right">{tr("实付", "Paid")}</span>
        </div>

        {list.isPending ? (
          <SkeletonRows rows={9} height={48} avatar={false} />
        ) : list.isError ? (
          <ErrorState
            title={tr("订单加载失败", "Orders failed to load")}
            error={list.error}
            raw={list.error instanceof Error ? list.error.message : undefined}
            onRetry={() => void list.refetch()}
          />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              icon={ReceiptText}
              title={tr("没有符合条件的订单", "No orders match")}
              description={
                emailMode
                  ? tr(
                      `没有邮箱包含「${q.replace(/^@/, "")}」的用户下过这样的订单。`,
                      `No such order from a user whose email contains “${q.replace(/^@/, "")}”.`,
                    )
                  : q
                    ? tr(
                        `没有订单号或交易号包含「${q}」的订单。要按邮箱找，请以 @ 开头。`,
                        `No order or trade number contains “${q}”. Start with @ to search by email.`,
                      )
                    : tr("当前筛选下没有订单。", "No order under these filters.")
              }
              action={<Button onClick={clear}>{tr("清除筛选", "Clear filters")}</Button>}
            />
          ) : (
            <EmptyState
              icon={ReceiptText}
              title={tr("还没有订单", "No orders yet")}
              description={tr(
                "用户在门户购买套餐后，订单会按天出现在这里。也可以给用户手动开一笔人工订单。",
                "Orders appear here by day once users buy a plan. You can also create a manual order.",
              )}
              action={
                <Button variant="primary" icon={Plus} onClick={newOrder}>
                  {tr("新建人工订单", "New manual order")}
                </Button>
              }
            />
          )
        ) : (
          <>
            {days.map(([day, list]) => {
              const sum = dayTotals.get(day);
              return (
                <section key={day} data-day={day} aria-label={dayLabel(day, today, tr)}>
                  <header className="glass sticky top-12 z-10 flex items-baseline gap-3 border-b border-separator bg-(--glass-toolbar) px-4 py-1.5 lg:top-13">
                    <h3 className="text-footnote font-semibold">{dayLabel(day, today, tr)}</h3>
                    <span className="tnum text-footnote text-faint">
                      {tr(`${sum?.orders ?? list.length} 笔`, `${sum?.orders ?? list.length} orders`)}
                    </span>
                    <span className="tnum ml-auto text-footnote text-muted-foreground">
                      {sum ? (
                        <>
                          {sum.refund_cents > 0 && (
                            <span className="mr-2 text-destructive max-sm:hidden">
                              {tr("退款 −", "Refunds −")}
                              {yuan(sum.refund_cents)}
                            </span>
                          )}
                          {tr("净收 ", "Net ")}
                          <b className="font-semibold text-foreground">{yuan(sum.paid_cents - sum.refund_cents)}</b>
                        </>
                      ) : (
                        <span className="text-faint">…</span>
                      )}
                    </span>
                  </header>
                  <div className="divide-y divide-separator">
                    {list.map((o) => (
                      <Row key={o.id} o={o} onOpen={() => patch({ open: o.id })} />
                    ))}
                  </div>
                </section>
              );
            })}
            <div className="flex items-center justify-between gap-3 border-t border-separator px-4 py-2.5 text-footnote text-muted-foreground">
              {list.hasNextPage ? (
                <>
                  <span className="tnum">{tr(`已加载 ${rows.length} 条`, `${rows.length} loaded`)}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    loading={list.isFetchingNextPage}
                    onClick={() => void list.fetchNextPage()}
                  >
                    {tr("加载更早", "Load older")}
                  </Button>
                </>
              ) : (
                <span className="tnum">
                  {tr(`共 ${rows.length} 条 · 已全部加载`, `${rows.length} in total · all loaded`)}
                </span>
              )}
            </div>
          </>
        )}
      </Card>

      {open && <OrderDialog id={open} onClose={() => patch({ open: null, act: null })} />}
      {query.get("new") === "1" && <ManualOrderDialog onClose={() => patch({ new: null })} />}
      {query.get("export") === "1" && <ExportDialog onClose={() => patch({ export: null })} />}
    </>
  );
}
