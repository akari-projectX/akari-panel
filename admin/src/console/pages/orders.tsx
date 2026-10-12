// 订单 (ORD-*): list with filters and keyset paging, the order dialog
// (amount breakdown, payment events, fulfilment), manual payment / retry,
// refunds (P1 preview, three routes, keep_plan), manual orders, CSV.
// Counts are honest (audit §5.5): the list says "N loaded" until the last
// page is in, and the "paid, not fulfilled" banner comes from its own
// filtered request, not from the loaded pages.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { CircleAlert, Download, Plus, ReceiptText, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { get, post, qs } from "../../shared/api";
import { bytes, centsToYuanText, dateTime, daysBefore, parseYuan, siteToday, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Segmented, Select } from "../../shared/ui/form";
import { Callout, KV, PageHeader, SectionTitle } from "../../shared/ui/layout";
import { EmptyState, ErrorState, LoadingBlock } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { CopyButton, FormError, Mono, useDebounced } from "../kit";
import { setQuery, useRoute } from "../router";
import { useCrumb } from "../session";
import { periodLabel } from "../terms";
import type { PlanPrice } from "../types";
import { downloadFile } from "./download";
import { LedgerTable, ScrollX, SearchField, When, shortTime, useColumns } from "./ledger";
import { needsAttention, OrderChip } from "./order-status";
import { findUsers, type UserRow } from "./users";

type RefundEffect =
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
  paid_at: string | null;
};
type PayEvent = {
  id: number;
  source: string;
  verified: boolean;
  outcome: string;
  trade_status: string | null;
  ip: string | null;
  created_at: string;
};
type Preview = {
  balance_part_cents: number;
  amount_cents: number;
  effect: RefundEffect;
  original_available: boolean;
  original_request: { state: string } | null;
};

const VIAS = ["manual", "notify", "query", "balance", "coupon", "credit"] as const;

function viaText(v: string | null, tr: Tr): string {
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

function sourceText(s: string, tr: Tr): string {
  return (
    {
      notify: tr("支付回调", "Payment notify"),
      query: tr("主动查询", "Status query"),
      precreate: tr("创建支付", "Payment created"),
      manual: tr("人工操作", "Manual"),
    }[s] ?? tr("其他来源", "Other source")
  );
}

function outcomeText(o: string, tr: Tr): [string, Tone] {
  const m: Record<string, [string, Tone]> = {
    ok: [tr("已生成付款码", "Payment code issued"), "info"],
    failed: [tr("创建支付失败", "Could not create the payment"), "danger"],
    paid: [tr("付款成功", "Paid"), "success"],
    paid_unfulfilled: [tr("付款成功，开通失败", "Paid, fulfilment failed"), "danger"],
    duplicate: [tr("重复通知（已处理过）", "Duplicate (already handled)"), "neutral"],
    ignored: [tr("未付款状态（忽略）", "Not a payment (ignored)"), "neutral"],
    amount_mismatch: [tr("金额不符，已拒绝", "Amount mismatch, refused"), "danger"],
    unknown_order: [tr("找不到订单，已拒绝", "Unknown order, refused"), "danger"],
    bad_signature: [tr("签名无效，已拒绝", "Bad signature, refused"), "danger"],
    malformed: [tr("格式错误，已拒绝", "Malformed, refused"), "danger"],
    oversized: [tr("请求过大，已拒绝", "Too large, refused"), "danger"],
    app_id_mismatch: [tr("应用 ID 不符，已拒绝", "App ID mismatch, refused"), "danger"],
    seller_id_mismatch: [tr("收款账号不符，已拒绝", "Seller mismatch, refused"), "danger"],
    marked_paid: [tr("人工确认付款", "Marked paid by hand"), "success"],
    manual_order: [tr("人工订单", "Manual order"), "success"],
    fulfilled: [tr("重试开通成功", "Fulfilment retried: done"), "success"],
    fulfil_failed: [tr("重试开通失败", "Fulfilment retried: failed"), "danger"],
    expire: [tr("订单过期关闭", "Closed (expired)"), "neutral"],
    close: [tr("订单关闭", "Closed"), "neutral"],
  };
  return m[o] ?? [tr("其他结果", "Other outcome"), "neutral"];
}

function tradeStatusText(s: string, tr: Tr): string {
  return (
    {
      WAIT_BUYER_PAY: tr("等待付款", "Waiting for payment"),
      TRADE_SUCCESS: tr("交易成功", "Trade succeeded"),
      TRADE_FINISHED: tr("交易完结", "Trade finished"),
      TRADE_CLOSED: tr("交易关闭", "Trade closed"),
    }[s] ?? tr("渠道状态", "Provider status")
  );
}

/** A server or provider message: mapped copy, the original text folded away. */
function Raw({ children }: { children: ReactNode }) {
  const tr = useTr();
  return (
    <details className="mt-1 text-footnote text-muted-foreground">
      <summary className="cursor-default select-none hover:text-foreground">{tr("原始信息", "Raw details")}</summary>
      <div className="mt-1 font-mono break-all">{children}</div>
    </details>
  );
}

function fulfilErrorText(e: string, tr: Tr): string {
  if (/insufficient balance/i.test(e))
    return tr(
      "用户余额不足，下单时使用的余额无法再次扣除。可以给用户补足余额后重试，或退款。",
      "The balance used at checkout could not be taken again. Top the balance up and retry, or refund.",
    );
  return tr(
    "用户已付款，但套餐没有开通（例如用户已删除、套餐已停用或已售罄）。查看原因后可以重试开通，或者退款。",
    "The user paid but the plan was not granted (e.g. user gone, plan disabled or sold out). Retry, or refund.",
  );
}

function refundErrorText(e: string, tr: Tr): string {
  if (/smaller amount/i.test(e))
    return tr("渠道确认的金额小于申请金额，会自动再查。", "The provider confirmed less; it is checked again.");
  if (/does not know/i.test(e))
    return tr("渠道还查不到这笔退款，会自动再查。", "The provider does not know the refund yet; checked again.");
  return tr(
    "支付渠道拒绝了原路退款。可以改为退到余额，或在商家平台手动退款后仅登记。",
    "The provider refused the refund. Refund to the balance, or refund by hand and record it.",
  );
}

export function effectText(e: RefundEffect, tr: Tr): string {
  switch (e.kind) {
    case "cancel":
      return tr(`将取消订阅「${e.plan_name}」并踢线`, `Cancels the "${e.plan_name}" subscription (user disconnected)`);
    case "rollback":
      return tr(
        `「${e.plan_name}」到期时间从 ${dateTime(e.from)} 回退到 ${dateTime(e.to)}`,
        `"${e.plan_name}" expiry goes back from ${dateTime(e.from)} to ${dateTime(e.to)}`,
      );
    case "restore":
      return tr(
        `恢复到换套餐前的「${e.plan_name}」（到期 ${dateTime(e.expires_at)}，已用 ${bytes(e.prior_used_bytes)}）`,
        `Restores the previous plan "${e.plan_name}" (expires ${dateTime(e.expires_at)}, used ${bytes(e.prior_used_bytes)})`,
      );
    default:
      return (
        {
          keep_plan: tr("保留套餐（仅退款）", "Plan kept (money only)"),
          not_fulfilled: tr("订单未开通，套餐不受影响", "Not fulfilled: no plan effect"),
          reset_pack: tr("流量重置包：已用流量不回滚，只退款", "Reset pack: used traffic stays, money only"),
          not_active: tr("对应订阅已不再生效", "The subscription is no longer active"),
          user_gone: tr("用户已删除", "The user is gone"),
          untracked: tr("无法确定订阅效果", "Effect not tracked"),
        }[e.why] ?? tr("无法确定订阅效果", "Effect not tracked")
      );
  }
}

const LIMIT = 50;
/** The attention banner's request: at most this many (shown as "N+"). */
const ATTENTION_CAP = 200;

type StatusFilter = "" | "pending" | "paid" | "unfulfilled" | "expired" | "cancelled";

/** The dashboard's "today" window: the header's one line of numbers. */
type Today = { today: { orders: number; gross_cents: number; refunds_cents: number } };

export function OrdersPage() {
  const tr = useTr();
  const { query } = useRoute();
  const status = query.get("status") ?? "";
  const email = query.get("email") ?? "";
  const no = query.get("no") ?? "";
  const unfulfilled = query.get("unfulfilled") === "1";
  const via = query.get("via") ?? "";
  const open = query.get("open");
  // One search box: an address (has "@") filters by buyer, anything else by
  // order / provider trade number. Both are exact matches on the server.
  const [term, setTerm] = useState(email || no);
  const dt = useDebounced(term.trim(), 400);
  const applied = useRef(dt);
  useEffect(() => {
    if (dt === applied.current) return;
    applied.current = dt;
    if (dt.includes("@")) setQuery({ email: dt, no: null });
    else setQuery({ no: dt || null, email: null });
  }, [dt]);
  const [exporting, setExporting] = useState(false);
  const filters = { status, email, out_trade_no: no, unfulfilled: unfulfilled ? "true" : "", via };
  const list = useInfiniteQuery({
    queryKey: ["orders", filters],
    queryFn: ({ pageParam }) => get<Order[]>(`/orders${qs({ ...filters, limit: LIMIT, before: pageParam })}`),
    initialPageParam: "",
    getNextPageParam: (last) => (last.length === LIMIT ? last[last.length - 1].id : undefined),
  });
  const attention = useQuery({
    queryKey: ["orders", "attention"],
    queryFn: () => get<Order[]>(`/orders${qs({ unfulfilled: "true", limit: ATTENTION_CAP })}`),
  });
  // Same key as the dashboard: one request when both are open, refreshed by every write.
  const dash = useQuery({ queryKey: ["dashboard"], queryFn: () => get<Today>("/dashboard") });
  const rows = list.data?.pages.flat() ?? [];
  const stuck = attention.data?.length ?? 0;
  const stuckText = stuck >= ATTENTION_CAP ? `${ATTENTION_CAP}+` : String(stuck);
  const statusF: StatusFilter = unfulfilled ? "unfulfilled" : (status as StatusFilter);
  const filtered = !!(status || unfulfilled || via || email || no);
  const clear = () => {
    setTerm("");
    setQuery({ status: null, unfulfilled: null, via: null, email: null, no: null });
  };
  const newOrder = () => setQuery({ new: "1" }, false);
  const today = dash.data?.today;

  const [columns, chooser] = useColumns<Order>("orders", [
    {
      key: "no",
      header: tr("订单号", "Order"),
      cell: (o) => (
        <span className="inline-flex items-center gap-1.5 font-mono text-footnote whitespace-nowrap">
          {needsAttention(o) && (
            <CircleAlert
              className="size-3.5 shrink-0 text-destructive"
              aria-label={tr("已付款未开通", "Paid, not fulfilled")}
            />
          )}
          {o.out_trade_no}
        </span>
      ),
    },
    {
      key: "user",
      header: tr("用户", "User"),
      className: "max-w-56 truncate",
      cell: (o) => o.user_email ?? <span className="text-muted-foreground">{o.user_label}</span>,
    },
    {
      key: "plan",
      header: tr("套餐 / 周期", "Plan / term"),
      cell: (o) => (
        <span>
          {o.plan_name} <span className="text-muted-foreground">· {periodLabel(o.period, tr, o.period_days)}</span>
        </span>
      ),
    },
    {
      key: "via",
      header: tr("方式", "Via"),
      cell: (o) => (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-muted-foreground">
          {viaText(o.paid_via, tr)}
          {o.gift_cents > 0 && <Badge tone="primary">{tr("赠送", "Gift")}</Badge>}
        </span>
      ),
    },
    { key: "status", header: tr("状态", "Status"), cell: (o) => <OrderChip order={o} /> },
    {
      key: "extras",
      header: tr("优惠 / 余额", "Discount / balance"),
      optional: true,
      className: "text-muted-foreground",
      cell: (o) =>
        [
          o.discount_cents ? `-${yuan(o.discount_cents)}` : "",
          o.balance_cents ? `${tr("余额", "bal.")} ${yuan(o.balance_cents)}` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "—",
    },
    {
      key: "amount",
      header: tr("实付", "Paid"),
      align: "right",
      cell: (o) => <span className="font-semibold">{yuan(o.amount_cents)}</span>,
    },
    {
      key: "created",
      header: tr("时间", "Time"),
      align: "right",
      className: "whitespace-nowrap text-muted-foreground",
      cell: (o) => <When iso={o.created_at} />,
    },
  ]);

  return (
    <>
      <PageHeader
        title={tr("订单", "Orders")}
        description={
          today ? (
            <span className="tnum">
              {tr(
                `今日已付 ${today.orders} 笔 · 实收 ${yuan(today.gross_cents)} · 退款 ${yuan(today.refunds_cents)}`,
                `Today ${today.orders} paid · collected ${yuan(today.gross_cents)} · refunded ${yuan(today.refunds_cents)}`,
              )}
            </span>
          ) : (
            tr("用户的购买、续费与人工订单。", "Purchases, renewals and manual orders.")
          )
        }
        actions={
          <>
            <Button variant="outline" icon={Download} onClick={() => setExporting(true)}>
              {tr("导出 CSV", "Export CSV")}
            </Button>
            <Button variant="primary" icon={Plus} onClick={newOrder}>
              {tr("人工订单", "Manual order")}
            </Button>
          </>
        }
      />
      {stuck > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-xl bg-destructive-soft px-4 py-3 text-body">
          <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <b className="font-semibold">
              {tr(`${stuckText} 个订单已付款但未开通。`, `${stuckText} paid orders are not fulfilled.`)}
            </b>
            <span className="text-muted-foreground max-sm:hidden">
              {tr(" 用户已扣款，请打开订单重试开通或退款。", " The users paid: open each to retry or refund.")}
            </span>
          </span>
          {!unfulfilled && (
            <Button size="sm" variant="destructive-soft" onClick={() => setQuery({ unfulfilled: "1", status: null })}>
              {tr("查看", "Show")}
            </Button>
          )}
        </div>
      )}
      <LedgerTable
        label={tr("订单列表", "Orders")}
        rows={rows}
        columns={columns}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        activeId={open}
        onRowClick={(o) => setQuery({ open: o.id }, false)}
        phone={(o) => ({
          title: (
            <>
              {needsAttention(o) && (
                <CircleAlert
                  className="size-3.5 shrink-0 text-destructive"
                  aria-label={tr("已付款未开通", "Paid, not fulfilled")}
                />
              )}
              {o.plan_name}
              <span className="font-normal text-muted-foreground">· {periodLabel(o.period, tr, o.period_days)}</span>
              {o.gift_cents > 0 && <Badge tone="primary">{tr("赠送", "Gift")}</Badge>}
            </>
          ),
          sub: o.user_email ?? o.user_label,
          meta: (
            <span className="font-mono">
              {o.out_trade_no} · {shortTime(o.created_at, tr)}
            </span>
          ),
          amount: yuan(o.amount_cents),
          status: <OrderChip order={o} />,
        })}
        empty={
          filtered ? (
            <EmptyState
              icon={ReceiptText}
              title={tr("没有符合条件的订单", "No orders match")}
              description={
                email || no
                  ? tr(
                      `没有订单号或邮箱为「${email || no}」的订单（精确匹配）。检查拼写，或清除筛选查看全部订单。`,
                      `No order whose number or email is “${email || no}” (exact match). Check the spelling, or clear the filters to see every order.`,
                    )
                  : tr(
                      "当前筛选下没有订单。清除筛选查看全部订单。",
                      "No order under these filters. Clear them to see every order.",
                    )
              }
              action={
                <>
                  <Button onClick={clear}>{tr("清除筛选", "Clear filters")}</Button>
                  <Button variant="primary" icon={Plus} onClick={newOrder}>
                    {tr("人工订单", "Manual order")}
                  </Button>
                </>
              }
            />
          ) : (
            <EmptyState
              icon={ReceiptText}
              title={tr("还没有订单", "No orders yet")}
              description={tr(
                "用户下单，或你新建人工订单后，订单会出现在这里。",
                "Orders appear here once users buy or you create a manual order.",
              )}
              action={
                <Button variant="primary" icon={Plus} onClick={newOrder}>
                  {tr("人工订单", "Manual order")}
                </Button>
              }
            />
          )
        }
        toolbar={
          <>
            <SearchField
              aria-label={tr("搜索订单号或邮箱", "Search order no. or email")}
              placeholder={tr("订单号、交易号或用户邮箱", "Order / trade no. or user email")}
              value={term}
              onChange={(e) => setTerm(e.target.value)}
            />
            <ScrollX>
              <Segmented
                label={tr("订单状态", "Order status")}
                value={statusF}
                onChange={(v) =>
                  setQuery({
                    status: ["paid", "pending", "expired", "cancelled"].includes(v) ? v : null,
                    unfulfilled: v === "unfulfilled" ? "1" : null,
                  })
                }
                options={[
                  { value: "", label: tr("全部", "All") },
                  { value: "pending", label: tr("待付款", "Pending") },
                  { value: "paid", label: tr("已付款", "Paid") },
                  {
                    value: "unfulfilled",
                    label: tr("未开通", "Not fulfilled"),
                    count: stuck > 0 ? stuck : undefined,
                  },
                  { value: "expired", label: tr("已过期", "Expired") },
                  { value: "cancelled", label: tr("已取消", "Cancelled") },
                ]}
              />
            </ScrollX>
            <Select
              aria-label={tr("付款方式", "Paid via")}
              className="w-32 max-sm:flex-1"
              value={via}
              onChange={(e) => setQuery({ via: e.target.value || null })}
            >
              <option value="">{tr("全部方式", "Any method")}</option>
              {VIAS.map((v) => (
                <option key={v} value={v}>
                  {viaText(v, tr)}
                </option>
              ))}
            </Select>
            {chooser}
          </>
        }
        footer={
          rows.length > 0 && (
            <>
              <span className="tnum">
                {list.hasNextPage
                  ? tr(`已加载 ${rows.length} 笔`, `${rows.length} loaded`)
                  : tr(`共 ${rows.length} 笔`, `${rows.length} in total`)}
              </span>
              {list.hasNextPage && (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  {tr("加载更早的订单", "Load older orders")}
                </Button>
              )}
            </>
          )
        }
      />
      {open && <OrderDialog id={open} onClose={() => setQuery({ open: null })} />}
      {query.get("new") === "1" && <ManualOrderDialog onClose={() => setQuery({ new: null })} />}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </>
  );
}

/** The order: details, money, refund, events; actions in the footer. */
function OrderDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["order", id],
    queryFn: () => get<{ order: Order; events: PayEvent[] }>(`/orders/${id}`),
  });
  const [sub, setSub] = useState<"fulfil" | "refund" | null>(null);
  const o = q.data?.order;
  useCrumb(o?.out_trade_no);
  const stuck = o ? needsAttention(o) : false;
  const unpaid = !!o && o.status !== "paid" && !o.refunded_at;
  const canRefund = !!o && o.status === "paid" && !o.refunded_at && o.refund_request?.state !== "pending";
  return (
    <>
      <Dialog
        open
        size="lg"
        onClose={onClose}
        title={o ? <span className="font-mono">{o.out_trade_no}</span> : tr("订单详情", "Order")}
        description={
          o && (
            <span className="flex flex-wrap items-center gap-1.5">
              <OrderChip order={o} />
              <span className="tnum font-semibold text-foreground">{yuan(o.amount_cents)}</span>
              <span>· {o.user_email ?? o.user_label}</span>
            </span>
          )
        }
        footer={
          <>
            {canRefund && (
              <Button variant="destructive-soft" icon={Undo2} className="mr-auto" onClick={() => setSub("refund")}>
                {tr("退款", "Refund")}
              </Button>
            )}
            <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
            {(unpaid || stuck) && (
              <Button variant="primary" onClick={() => setSub("fulfil")}>
                {stuck ? tr("重试开通", "Retry fulfilment") : tr("人工确认付款", "Mark paid")}
              </Button>
            )}
          </>
        }
      >
        {q.isPending ? (
          <LoadingBlock rows={8} />
        ) : q.isError ? (
          <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          o && <OrderBody o={o} events={q.data?.events ?? []} />
        )}
      </Dialog>
      {o && sub === "fulfil" && <FulfilDialog order={o} onClose={() => setSub(null)} />}
      {o && sub === "refund" && <RefundDialog order={o} onClose={() => setSub(null)} />}
    </>
  );
}

function OrderBody({ o, events }: { o: Order; events: PayEvent[] }) {
  const tr = useTr();
  const stuck = needsAttention(o);
  const money: [string, number][] = (
    [
      [tr("原价", "List price"), o.list_price_cents, true],
      [
        o.coupon_code ? tr(`优惠券 ${o.coupon_code}`, `Coupon ${o.coupon_code}`) : tr("优惠券", "Coupon"),
        -o.discount_cents,
        o.discount_cents !== 0,
      ],
      [tr("换套餐抵扣", "Switch credit"), -o.credit_cents, o.credit_cents !== 0],
      [tr("余额支付", "Paid from balance"), -o.balance_cents, o.balance_cents !== 0],
      [tr("赠送", "Gift"), -o.gift_cents, o.gift_cents !== 0],
    ] as [string, number, boolean][]
  )
    .filter(([, , show]) => show)
    .map(([k, v]) => [k, v]);
  return (
    <div className="grid gap-4">
      {stuck && (
        <Callout tone="danger" title={tr("已付款但开通失败", "Paid, fulfilment failed")}>
          {o.fulfil_error
            ? fulfilErrorText(o.fulfil_error, tr)
            : tr("用户已付款，但套餐还没有开通。可以重试开通，或退款。", "Paid but not granted yet. Retry, or refund.")}
          {o.fulfil_error && <Raw>{o.fulfil_error}</Raw>}
        </Callout>
      )}
      {(o.status === "expired" || o.status === "cancelled") && !o.refunded_at && (
        <Callout tone="info">
          {tr(
            "这个订单已经关闭。只有确认用户确实付了款（例如付款在订单关闭后才到账、或线下转账），才需要人工确认付款，确认后会开通套餐。",
            "This order is closed. Mark it paid only when the user really paid (e.g. the payment arrived late, or offline); it is then fulfilled.",
          )}
        </Callout>
      )}
      {o.refund_request?.state === "pending" && (
        <Callout tone="info" title={tr("原路退款处理中", "Original-route refund pending")}>
          {tr(
            `${yuan(o.refund_request.cents)}，等待支付渠道确认（系统会自动查询）。`,
            `${yuan(o.refund_request.cents)}, waiting for the provider (checked automatically).`,
          )}
          {o.refund_request.last_error && (
            <>
              <div className="mt-1">{refundErrorText(o.refund_request.last_error, tr)}</div>
              <Raw>{o.refund_request.last_error}</Raw>
            </>
          )}
        </Callout>
      )}
      {o.refund_request?.state === "failed" && (
        <Callout tone="danger" title={tr("原路退款失败", "Original-route refund failed")}>
          {refundErrorText(o.refund_request.last_error ?? "", tr)}
          {o.refund_request.last_error && <Raw>{o.refund_request.last_error}</Raw>}
        </Callout>
      )}
      <KV
        items={[
          [tr("用户", "User"), o.user_email ?? o.user_label],
          [tr("套餐", "Plan"), `${o.plan_name} · ${periodLabel(o.period, tr, o.period_days)}`],
          [tr("下单", "Created"), dateTime(o.created_at)],
          [tr("付款", "Paid"), o.paid_at ? `${dateTime(o.paid_at)} · ${viaText(o.paid_via, tr)}` : "—"],
          [tr("支付方式", "Method"), o.payment_method_name ?? "—"],
          [
            tr("交易号", "Trade no."),
            o.trade_no ? (
              <span key="t" className="inline-flex flex-wrap items-center gap-1">
                <Mono>{o.trade_no}</Mono>
                <CopyButton text={o.trade_no} />
              </span>
            ) : (
              "—"
            ),
          ],
          [tr("开通", "Fulfilled"), dateTime(o.fulfilled_at)],
          ...(o.manual_reason ? ([[tr("人工原因", "Manual reason"), o.manual_reason]] as [string, string][]) : []),
        ]}
      />
      <section>
        <SectionTitle>{tr("金额拆分", "Amount breakdown")}</SectionTitle>
        <dl className="divide-y divide-separator rounded-lg bg-window text-body ring-1 ring-border ring-inset">
          {money.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 px-3 py-2">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="tnum">{yuan(v)}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-3 px-3 py-2 font-semibold">
            <dt>{tr("实付", "Paid")}</dt>
            <dd className="tnum">{yuan(o.amount_cents)}</dd>
          </div>
        </dl>
      </section>
      {o.refunded_at && (
        <section>
          <SectionTitle>{tr("退款", "Refund")}</SectionTitle>
          <KV
            items={[
              [tr("时间", "When"), dateTime(o.refunded_at)],
              [tr("金额", "Amount"), yuan(o.refund_cents)],
              [tr("退到余额", "To balance"), yuan(o.refund_balance_cents)],
              [tr("渠道退回", "At the provider"), yuan(o.refund_external_cents)],
              [tr("原因", "Reason"), o.refund_reason ?? "—"],
              [tr("订阅效果", "Subscription effect"), o.refund_effect ? effectText(o.refund_effect, tr) : "—"],
            ]}
          />
        </section>
      )}
      {events.length > 0 && (
        <section>
          <SectionTitle>{tr("支付事件", "Payment events")}</SectionTitle>
          <ul className="divide-y divide-separator rounded-lg text-body ring-1 ring-border ring-inset">
            {events.map((e) => {
              const [text, tone] = outcomeText(e.outcome, tr);
              return (
                <li key={e.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{sourceText(e.source, tr)}</span>
                    <Badge tone={tone}>{text}</Badge>
                    {!e.verified && <Badge tone="danger">{tr("未验签", "Unverified")}</Badge>}
                    {e.trade_status && (
                      <span className="text-footnote text-muted-foreground">{tradeStatusText(e.trade_status, tr)}</span>
                    )}
                    <span className="tnum ml-auto text-footnote text-muted-foreground">{dateTime(e.created_at)}</span>
                  </div>
                  <Raw>
                    source={e.source} outcome={e.outcome}
                    {e.trade_status ? ` trade_status=${e.trade_status}` : ""}
                    {e.verified ? " verified" : " unverified"}
                    {e.ip ? ` ip=${e.ip}` : ""}
                  </Raw>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function FulfilDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const tr = useTr();
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [run, busy] = useAction();
  const retry = order.status === "paid";
  const closed = order.status === "expired" || order.status === "cancelled";
  const submit = async () => {
    setTouched(true);
    if (!reason.trim()) return;
    const r = await run(() => post(`/orders/${order.id}/fulfil`, { reason: reason.trim() }), {
      ok: retry ? tr("已重试开通", "Fulfilment retried") : tr("已确认付款", "Marked paid"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      title={retry ? tr("重试开通", "Retry fulfilment") : tr("人工确认付款", "Mark paid by hand")}
      description={
        retry
          ? tr("再次为用户开通这个订单的套餐。", "Grant this order's plan to the user again.")
          : tr(
              "用于线下已收款的订单：按订单金额记为已付款并开通。",
              "For an order paid outside the gateway: recorded paid and fulfilled.",
            )
      }
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("确认", "Confirm")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {closed && (
          <Callout tone="warning">
            {order.status === "expired"
              ? tr(
                  "订单已过期。确认用户确实已经付款再继续。",
                  "The order expired. Continue only if the user really paid.",
                )
              : tr(
                  "订单已取消。确认用户确实已经付款再继续。",
                  "The order was cancelled. Continue only if the user paid.",
                )}
          </Callout>
        )}
        <Field
          label={tr("原因（必填，写入审计）", "Reason (required, audited)")}
          error={touched && !reason.trim() ? tr("请填写原因", "Enter a reason") : undefined}
        >
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            maxLength={200}
            data-autofocus
          />
        </Field>
      </div>
    </Dialog>
  );
}

type Route = "original" | "balance" | "record";

function RefundDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const p = useQuery({
    queryKey: ["refund-preview", order.id],
    queryFn: () => get<Preview>(`/orders/${order.id}/refund-preview`),
    gcTime: 0,
  });
  const gateway = (p.data?.amount_cents ?? 0) > 0;
  const [route, setRoute] = useState<Route>("balance");
  const [amount, setAmount] = useState("");
  const [amountErr, setAmountErr] = useState<string | null>(null);
  const [keepPlan, setKeepPlan] = useState(false);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [run, busy] = useAction();
  const tail = order.out_trade_no.slice(-6);
  const checkAmount = (value = amount): number | null | undefined => {
    // undefined = invalid; null = empty (all, original route only)
    if (route === "balance") return null;
    if (!value.trim()) {
      if (route === "original") return null;
      setAmountErr(tr("请填写在商家平台实际退回的金额", "Enter the amount refunded in the merchant console"));
      return undefined;
    }
    const c = parseYuan(value);
    const max = p.data?.amount_cents ?? 0;
    if (c === null || (route === "original" && c <= 0) || c > max) {
      setAmountErr(
        tr(`金额无效：0–${centsToYuanText(max)} 元，最多两位小数`, `Invalid: 0–${centsToYuanText(max)}, 2 decimals`),
      );
      return undefined;
    }
    setAmountErr(null);
    return c;
  };
  const submit = async () => {
    if (!p.data || !reason.trim() || typed.trim() !== tail) return;
    const body: Record<string, unknown> = { reason: reason.trim(), keep_plan: keepPlan, to_balance: false };
    if (gateway) {
      const c = checkAmount();
      if (c === undefined) return;
      if (route === "original") {
        body.original = true;
        if (c !== null) body.original_cents = c;
      } else if (route === "balance") body.to_balance = true;
      else body.external_cents = c;
    }
    const r = await run(() => post<{ pending?: boolean }>(`/orders/${order.id}/refund`, body));
    if (r !== undefined) {
      toast({
        tone: "success",
        title: r?.pending
          ? tr("原路退款已提交，等待渠道确认", "Refund submitted; waiting for the provider")
          : tr("已退款", "Refunded"),
      });
      onClose();
    }
  };
  const routes: { value: Route; label: string }[] = [
    ...(p.data?.original_available ? [{ value: "original" as const, label: tr("原路退回", "To the payer") }] : []),
    { value: "balance", label: tr("退到余额", "To the balance") },
    { value: "record", label: tr("仅登记", "Record only") },
  ];
  const routeHint: Record<Route, string> = {
    original: tr(
      "调用支付渠道的退款接口，钱退回付款账户（可部分退款）。",
      "Calls the provider's refund API (partial allowed).",
    ),
    balance: tr("渠道实付部分也记入用户余额。", "The gateway part is credited to the user's balance too."),
    record: tr(
      "你已在商家平台手动退款：这里只登记实际退回的金额。",
      "You refunded in the merchant console: record the amount here.",
    ),
  };
  return (
    <Dialog
      open
      size="lg"
      tone="danger"
      icon={TriangleAlert}
      onClose={onClose}
      title={tr(`退款 ${order.out_trade_no}`, `Refund ${order.out_trade_no}`)}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button
            type="submit"
            variant="destructive"
            loading={busy}
            disabled={!p.data || !reason.trim() || typed.trim() !== tail}
          >
            {tr("确认退款", "Refund")}
          </Button>
        </>
      }
    >
      {p.isPending ? (
        <LoadingBlock rows={5} />
      ) : p.isError ? (
        <ErrorState compact error={p.error} onRetry={() => void p.refetch()} />
      ) : (
        p.data && (
          <div className="grid gap-4">
            <KV
              items={[
                [tr("渠道实付", "Gateway amount"), yuan(p.data.amount_cents)],
                [
                  tr("余额部分（总是退回余额）", "Balance part (always back to the balance)"),
                  yuan(p.data.balance_part_cents),
                ],
              ]}
            />
            <Callout tone="warning" title={tr("对订阅的影响", "Effect on the subscription")}>
              {keepPlan ? tr("保留套餐（仅退款）", "Plan kept (money only)") : effectText(p.data.effect, tr)}
            </Callout>
            {gateway && (
              <Field
                group
                label={tr("退款去向", "Refund route")}
                hint={
                  <>
                    {routeHint[route]}
                    {!p.data.original_available &&
                      tr(" 该支付方式未开启原路退款。", " Refunds to the payer are not enabled for this method.")}
                  </>
                }
              >
                <Segmented
                  label={tr("退款去向", "Refund route")}
                  value={route}
                  onChange={(v) => {
                    setRoute(v);
                    setAmountErr(null);
                  }}
                  options={routes}
                />
              </Field>
            )}
            {gateway && route !== "balance" && (
              <Field
                label={
                  route === "original"
                    ? tr("退回金额（元，留空 = 全部）", "Amount (yuan; empty = all)")
                    : tr("实际退回金额（元）", "Amount refunded (yuan)")
                }
                error={amountErr ?? undefined}
              >
                <Input
                  inputMode="decimal"
                  value={amount}
                  placeholder={centsToYuanText(p.data.amount_cents)}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    // A shown error clears as soon as the value is right — not on blur,
                    // where the shift under the pointer would eat the next click.
                    if (amountErr) checkAmount(e.target.value);
                  }}
                  onBlur={() => amount.trim() && checkAmount()}
                />
              </Field>
            )}
            <label className="flex items-center gap-2 text-body">
              <Checkbox
                checked={keepPlan}
                onChange={setKeepPlan}
                label={tr("仅退款，保留套餐", "Money only, keep the plan")}
              />
              {tr("仅退款，保留套餐", "Money only, keep the plan")}
            </label>
            <Field label={tr("退款原因（必填，写入审计）", "Reason (required, audited)")}>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
            </Field>
            <Field
              label={tr(
                `二次确认：输入订单号后 6 位 ${tail}`,
                `Type the last 6 characters of the order number: ${tail}`,
              )}
            >
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </div>
        )
      )}
    </Dialog>
  );
}

type PriceRow = { plan_id: string; plan_name: string; plan_enabled: boolean; on_sale: boolean; prices: PlanPrice[] };

export function ManualOrderDialog({ onClose, user: preset }: { onClose: () => void; user?: UserRow }) {
  const tr = useTr();
  const [q, setQ] = useState(preset?.email ?? "");
  const dq = useDebounced(q.trim(), 300);
  const [user, setUser] = useState<UserRow | null>(preset ?? null);
  const found = useQuery({
    queryKey: ["users", "find", dq],
    queryFn: () => findUsers(dq),
    enabled: dq.length >= 2 && !user,
  });
  const prices = useQuery({ queryKey: ["plan-prices"], queryFn: () => get<{ plans: PriceRow[] }>("/plan-prices") });
  const [planId, setPlanId] = useState("");
  const [period, setPeriod] = useState("");
  const [gift, setGift] = useState(false);
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const plan = prices.data?.plans.find((p) => p.plan_id === planId);
  const price = plan?.prices.find((pp) => pp.period === period);
  const giftLabel = tr("赠送（金额记 0，不算营收）", "Gift (amount 0, not revenue)");
  const searching = q.trim() !== dq || found.isFetching;
  const candidates = (found.data ?? []).filter((u) => u.role === "user");
  const submit = async () => {
    setTried(true);
    if (!user || !planId || !period || !reason.trim()) return;
    const r = await run(
      () => post("/orders/manual", { user_id: user.id, plan_id: planId, period, gift, reason: reason.trim() }),
      { ok: tr("人工订单已创建并开通", "Manual order created and fulfilled") },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      title={tr("新建人工订单", "New manual order")}
      description={tr(
        "赠送或线下收款：走唯一的付款路径，金额由服务端按套餐价格计算。",
        "A gift or an offline payment through the one pay path; the server prices it.",
      )}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("创建并开通", "Create and fulfil")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {user ? (
          <Field group label={tr("用户", "User")}>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-window px-3 py-2 text-body ring-1 ring-border ring-inset">
              <span className="min-w-0 truncate">{user.email}</span>
              {!preset && (
                <Button size="sm" variant="ghost" onClick={() => setUser(null)}>
                  {tr("更换", "Change")}
                </Button>
              )}
            </div>
          </Field>
        ) : (
          <div className="grid gap-1.5">
            <Field
              label={tr("用户邮箱", "User email")}
              hint={dq.length < 2 ? tr("输入至少 2 个字符查找用户。", "Type at least 2 characters.") : undefined}
              error={tried ? tr("请选择一个用户", "Choose a user") : undefined}
            >
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="user@example.com"
                autoComplete="off"
                data-autofocus
              />
            </Field>
            {dq.length >= 2 && (
              <div aria-live="polite" className="text-body">
                {searching ? (
                  <p className="px-1 text-footnote text-muted-foreground">{tr("搜索中…", "Searching…")}</p>
                ) : found.isError ? (
                  <FormError error={found.error} />
                ) : candidates.length === 0 ? (
                  <p className="px-1 text-footnote text-muted-foreground">
                    {tr(
                      "没有匹配的用户（管理员账户不能有套餐）。",
                      "No matching user (admin accounts cannot have plans).",
                    )}
                  </p>
                ) : (
                  <ul className="divide-y divide-separator overflow-hidden rounded-lg ring-1 ring-border ring-inset">
                    {candidates.map((u) => (
                      <li key={u.id}>
                        <button
                          type="button"
                          className="flex min-h-9 w-full items-center px-3 py-1.5 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none pointer-coarse:min-h-11"
                          onClick={() => setUser(u)}
                        >
                          {u.email}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
        {prices.isError ? (
          <ErrorState compact error={prices.error} onRetry={() => void prices.refetch()} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={tr("套餐", "Plan")} error={tried && !planId ? tr("请选择套餐", "Choose a plan") : undefined}>
              <Select
                value={planId}
                disabled={prices.isPending}
                onChange={(e) => {
                  setPlanId(e.target.value);
                  setPeriod("");
                }}
              >
                <option value="">{prices.isPending ? tr("加载中…", "Loading…") : tr("请选择…", "Choose…")}</option>
                {prices.data?.plans
                  .filter((p) => p.prices.length > 0)
                  .map((p) => (
                    <option key={p.plan_id} value={p.plan_id}>
                      {p.plan_name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field
              label={tr("周期（有价格的）", "Term (priced)")}
              error={tried && planId && !period ? tr("请选择周期", "Choose a term") : undefined}
            >
              <Select value={period} onChange={(e) => setPeriod(e.target.value)} disabled={!plan}>
                <option value="">{tr("请选择…", "Choose…")}</option>
                {plan?.prices.map((pp) => (
                  <option key={pp.period} value={pp.period}>
                    {periodLabel(pp.period, tr, pp.days)} · {yuan(pp.price_cents)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <label className="flex items-center gap-2 text-body">
          <Checkbox checked={gift} onChange={setGift} label={giftLabel} />
          {giftLabel}
        </label>
        {price && (
          <div className="grid gap-1">
            <div className="flex items-baseline justify-between gap-3 rounded-lg bg-window px-3 py-2.5 ring-1 ring-border ring-inset">
              <span className="text-body text-muted-foreground">{tr("预计成交价", "Expected price")}</span>
              <span className="tnum text-headline font-semibold" data-testid="manual-price">
                {gift ? (
                  <>
                    {yuan(0)}{" "}
                    <span className="text-footnote font-normal text-muted-foreground line-through">
                      {yuan(price.price_cents)}
                    </span>
                  </>
                ) : (
                  yuan(price.price_cents)
                )}
              </span>
            </div>
            <p className="px-1 text-footnote text-faint">
              {tr(
                "最终金额由服务端按当前价格计算（换套餐时会扣减原套餐的剩余价值）。",
                "The server sets the final amount from current prices (a switch credits the old plan's remainder).",
              )}
            </p>
          </div>
        )}
        <Field
          label={tr("原因（必填，写入订单与审计）", "Reason (required, on the order and audited)")}
          error={tried && !reason.trim() ? tr("请填写原因", "Enter a reason") : undefined}
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
      </div>
    </Dialog>
  );
}

const MAX_EXPORT_DAYS = 366;

function ExportDialog({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const today = siteToday();
  const [from, setFrom] = useState(daysBefore(today, 29));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState("");
  const [via, setVia] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const days =
    from && to ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1 : 0;
  const rangeErr =
    !from || !to
      ? tr("请选择开始和结束日期", "Choose both dates")
      : days < 1
        ? tr("开始日期不能晚于结束日期", "From must not be after to")
        : days > MAX_EXPORT_DAYS
          ? tr(`日期范围不能超过 ${MAX_EXPORT_DAYS} 天`, `At most ${MAX_EXPORT_DAYS} days`)
          : null;
  const download = async () => {
    if (rangeErr || busy) return;
    setBusy(true);
    setError(null);
    try {
      await downloadFile(`/orders/export.csv${qs({ from, to, status, via })}`, `akari-orders-${to}.csv`);
      toast({ tone: "success", title: tr("已开始下载", "Download started") });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      title={tr("导出订单 CSV", "Export orders (CSV)")}
      description={tr(
        `按站点时区的日期筛选下单时间，最长 ${MAX_EXPORT_DAYS} 天；导出会写入审计日志。`,
        `Site-zone days of the order date, at most ${MAX_EXPORT_DAYS}; the export is audited.`,
      )}
      onSubmit={() => void download()}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" icon={Download} loading={busy} disabled={!!rangeErr}>
            {tr("下载", "Download")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("从", "From")}>
          <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={tr("到", "To")} error={rangeErr ?? undefined}>
          <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label={tr("状态", "Status")}>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{tr("全部", "Any")}</option>
            <option value="paid">{tr("已付款", "Paid")}</option>
            <option value="pending">{tr("待付款", "Pending")}</option>
            <option value="expired">{tr("已过期", "Expired")}</option>
            <option value="cancelled">{tr("已取消", "Cancelled")}</option>
          </Select>
        </Field>
        <Field label={tr("付款方式", "Paid via")}>
          <Select value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="">{tr("全部", "Any")}</option>
            {VIAS.map((v) => (
              <option key={v} value={v}>
                {viaText(v, tr)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2">
          <FormError error={error} />
        </div>
      </div>
    </Dialog>
  );
}
