// 订单 (ORD-*): list with filters and keyset paging, the order drawer
// (amount breakdown, payment events, fulfilment), manual payment / retry,
// refunds (P1 preview, three routes, keep_plan), manual orders, CSV.
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiBase } from "../../shared/base";
import { get, post, qs } from "../../shared/api";
import { bytes, centsToYuanText, dateTime, daysBefore, parseYuan, siteToday, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Dialog, Drawer, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  Field,
  Input,
  KV,
  PageHeader,
  Select,
  Skeleton,
  type Tone,
} from "../../shared/ui/primitives";
import { DataTable, type Column } from "../../shared/ui/table";
import { FormError, Mono, SectionTitle, useDebounced, useRun } from "../kit";
import { setQuery, useRoute } from "../router";
import { periodLabel } from "../terms";
import type { PlanPrice } from "../types";
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
type Event = {
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

export function orderStatusText(s: string, tr: Tr): [string, Tone] {
  switch (s) {
    case "paid":
      return [tr("已付款", "Paid"), "success"];
    case "pending":
      return [tr("待付款", "Pending"), "info"];
    case "expired":
      return [tr("已过期", "Expired"), "neutral"];
    case "cancelled":
      return [tr("已取消", "Cancelled"), "neutral"];
    default:
      return [s, "neutral"];
  }
}

export function OrderStatus({ status }: { status: string }) {
  const tr = useTr();
  const [t, tone] = orderStatusText(status, tr);
  return <Badge tone={tone}>{t}</Badge>;
}

function viaText(v: string | null, tr: Tr): string {
  switch (v) {
    case "manual":
      return tr("人工", "Manual");
    case "notify":
    case "query":
      return tr("在线支付", "Online");
    case "balance":
      return tr("余额", "Balance");
    case "coupon":
      return tr("优惠券全额", "Coupon");
    case "credit":
      return tr("抵扣", "Credit");
    default:
      return "—";
  }
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
        }[e.why] ?? e.why
      );
  }
}

const LIMIT = 50;

export function OrdersPage() {
  const tr = useTr();
  const { query } = useRoute();
  const status = query.get("status") ?? "";
  const email = query.get("email") ?? "";
  const no = query.get("no") ?? "";
  const unfulfilled = query.get("unfulfilled") === "1";
  const via = query.get("via") ?? "";
  const open = query.get("open");
  const [emailText, setEmailText] = useState(email);
  const [noText, setNoText] = useState(no);
  const de = useDebounced(emailText, 400);
  const dn = useDebounced(noText, 400);
  useEffect(() => {
    if (de !== email) setQuery({ email: de || null });
  }, [de, email]);
  useEffect(() => {
    if (dn !== no) setQuery({ no: dn || null });
  }, [dn, no]);
  const [exporting, setExporting] = useState(false);
  const filters = { status, email, out_trade_no: no, unfulfilled: unfulfilled ? "true" : "", via };
  const list = useInfiniteQuery({
    queryKey: ["orders", filters],
    queryFn: ({ pageParam }) => get<Order[]>(`/orders${qs({ ...filters, limit: LIMIT, before: pageParam })}`),
    initialPageParam: "",
    getNextPageParam: (last) => (last.length === LIMIT ? last[last.length - 1].id : undefined),
  });
  const rows = list.data?.pages.flat() ?? [];
  const failed = rows.filter((o) => o.status === "paid" && !o.fulfilled_at && o.fulfil_error).length;

  const columns: Column<Order>[] = [
    {
      key: "no",
      header: tr("订单号", "Order"),
      fixed: true,
      mobile: "title",
      cell: (o) => (
        <span className="flex items-center gap-1.5 font-mono text-xs">
          {o.out_trade_no}
          {o.status === "paid" && !o.fulfilled_at && <Badge tone="danger">{tr("未开通", "Unfulfilled")}</Badge>}
        </span>
      ),
    },
    {
      key: "user",
      header: tr("用户", "User"),
      cell: (o) => o.user_email ?? <span className="text-muted-foreground">{o.user_label}</span>,
    },
    {
      key: "plan",
      header: tr("套餐 / 周期", "Plan / term"),
      cell: (o) => `${o.plan_name} · ${periodLabel(o.period, tr, o.period_days)}`,
    },
    {
      key: "amount",
      header: tr("实付", "Paid"),
      align: "right",
      cell: (o) => <span className="tabular-nums">{yuan(o.amount_cents)}</span>,
    },
    {
      key: "extras",
      header: tr("优惠 / 余额", "Discount / balance"),
      optional: true,
      cell: (o) =>
        [
          o.discount_cents ? `-${yuan(o.discount_cents)}` : "",
          o.balance_cents ? `${tr("余额", "bal.")} ${yuan(o.balance_cents)}` : "",
        ]
          .filter(Boolean)
          .join(" · ") || "—",
    },
    {
      key: "via",
      header: tr("方式", "Via"),
      cell: (o) => (
        <span className="flex gap-1">
          {viaText(o.paid_via, tr)}
          {o.gift_cents > 0 && <Badge tone="info">{tr("赠送", "Gift")}</Badge>}
        </span>
      ),
    },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (o) => (
        <span className="flex gap-1">
          <OrderStatus status={o.status} />
          {o.refunded_at && <Badge tone="warning">{tr("已退款", "Refunded")}</Badge>}
          {o.refund_request?.state === "pending" && <Badge tone="info">{tr("退款处理中", "Refund pending")}</Badge>}
        </span>
      ),
    },
    { key: "created", header: tr("下单时间", "Created"), cell: (o) => dateTime(o.created_at) },
  ];

  return (
    <>
      <PageHeader
        title={tr("订单", "Orders")}
        actions={
          <>
            <Button size="sm" icon="download" onClick={() => setExporting(true)}>
              {tr("导出 CSV", "Export CSV")}
            </Button>
            <Button size="sm" variant="primary" icon="plus" onClick={() => setQuery({ new: "1" }, false)}>
              {tr("新建人工订单", "New manual order")}
            </Button>
          </>
        }
      />
      {failed > 0 && (
        <div className="mb-4">
          <Callout
            tone="danger"
            title={tr(`${failed} 个订单已付款但开通失败`, `${failed} paid orders failed to fulfil`)}
          >
            {tr("打开订单查看原因并重试开通。", "Open the order to see why and retry.")}
          </Callout>
        </div>
      )}
      <DataTable
        label={tr("订单列表", "Orders")}
        storageKey="orders"
        rows={rows}
        columns={columns}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        activeId={open}
        onRowClick={(o) => setQuery({ open: o.id }, false)}
        toolbar={
          <>
            <Select
              aria-label={tr("状态", "Status")}
              className="w-40 [&_select]:h-8"
              value={unfulfilled ? "unfulfilled" : via === "manual" ? "manual" : status}
              onChange={(e) => {
                const v = e.target.value;
                setQuery({
                  status: ["paid", "pending", "expired", "cancelled"].includes(v) ? v : null,
                  unfulfilled: v === "unfulfilled" ? "1" : null,
                  via: v === "manual" ? "manual" : null,
                });
              }}
            >
              <option value="">{tr("全部状态", "Any status")}</option>
              <option value="paid">{tr("已付款", "Paid")}</option>
              <option value="pending">{tr("待付款", "Pending")}</option>
              <option value="expired">{tr("已过期", "Expired")}</option>
              <option value="cancelled">{tr("已取消", "Cancelled")}</option>
              <option value="unfulfilled">{tr("已付款未开通", "Paid, unfulfilled")}</option>
              <option value="manual">{tr("人工订单", "Manual orders")}</option>
            </Select>
            <Input
              type="search"
              className="h-8 w-full sm:w-52"
              aria-label={tr("用户邮箱", "User email")}
              placeholder={tr("用户邮箱", "User email")}
              value={emailText}
              onChange={(e) => setEmailText(e.target.value)}
            />
            <Input
              type="search"
              className="h-8 w-full sm:w-56"
              aria-label={tr("订单号 / 交易号", "Order / trade no.")}
              placeholder={tr("订单号 / 支付宝交易号", "Order / trade no.")}
              value={noText}
              onChange={(e) => setNoText(e.target.value)}
            />
          </>
        }
        footer={
          list.hasNextPage ? (
            <Button
              size="sm"
              variant="ghost"
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {tr("加载更早的订单", "Load older orders")}
            </Button>
          ) : (
            <span>{tr(`共 ${rows.length} 条`, `${rows.length} shown`)}</span>
          )
        }
      />
      {open && <OrderDrawer id={open} onClose={() => setQuery({ open: null })} />}
      {query.get("new") === "1" && <ManualOrderDialog onClose={() => setQuery({ new: null })} />}
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </>
  );
}

function OrderDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["orders", "detail", id],
    queryFn: () => get<{ order: Order; events: Event[] }>(`/orders/${id}`),
  });
  const [dialog, setDialog] = useState<"fulfil" | "refund" | null>(null);
  const o = q.data?.order;
  const unfulfilled = o && o.status === "paid" && !o.fulfilled_at;
  return (
    <Drawer
      open
      onClose={onClose}
      title={o ? <span className="font-mono">{o.out_trade_no}</span> : tr("订单", "Order")}
      subtitle={o && <OrderStatus status={o.status} />}
      footer={
        o && (
          <>
            {(o.status === "pending" || o.status === "expired" || o.status === "cancelled" || unfulfilled) && (
              <Button onClick={() => setDialog("fulfil")}>
                {unfulfilled ? tr("重试开通", "Retry fulfilment") : tr("人工确认付款", "Mark paid")}
              </Button>
            )}
            {o.status === "paid" && !o.refunded_at && o.refund_request?.state !== "pending" && (
              <Button variant="destructive-soft" onClick={() => setDialog("refund")}>
                {tr("退款", "Refund")}
              </Button>
            )}
          </>
        )
      }
    >
      {q.isPending && <Skeleton className="h-64" />}
      <FormError error={q.error} />
      {o && (
        <div className="space-y-4">
          {unfulfilled && o.fulfil_error && (
            <Callout tone="danger" title={tr("已付款但开通失败", "Paid, fulfilment failed")}>
              {o.fulfil_error}
            </Callout>
          )}
          {o.refund_request?.state === "pending" && (
            <Callout tone="info" title={tr("原路退款处理中", "Original-route refund pending")}>
              {tr(
                `${yuan(o.refund_request.cents)}，等支付渠道确认（对账循环会自动查询）。`,
                `${yuan(o.refund_request.cents)}, waiting for the provider (reconciled automatically).`,
              )}
            </Callout>
          )}
          {o.refund_request?.state === "failed" && (
            <Callout tone="danger" title={tr("原路退款失败", "Original-route refund failed")}>
              {o.refund_request.last_error}
            </Callout>
          )}
          <KV
            items={[
              [tr("用户", "User"), o.user_email ?? o.user_label],
              [tr("套餐", "Plan"), `${o.plan_name} · ${periodLabel(o.period, tr, o.period_days)}`],
              [tr("下单", "Created"), dateTime(o.created_at)],
              [tr("付款", "Paid"), o.paid_at ? `${dateTime(o.paid_at)} · ${viaText(o.paid_via, tr)}` : "—"],
              [tr("支付方式", "Method"), o.payment_method_name ?? "—"],
              [tr("交易号", "Trade no."), o.trade_no ? <Mono key="t">{o.trade_no}</Mono> : "—"],
              [tr("开通", "Fulfilled"), dateTime(o.fulfilled_at)],
              ...(o.manual_reason ? ([[tr("人工原因", "Manual reason"), o.manual_reason]] as [string, string][]) : []),
            ]}
          />
          <SectionTitle>{tr("金额拆分", "Amount breakdown")}</SectionTitle>
          <div className="rounded-md border border-border text-[13px]">
            {(
              [
                [tr("原价", "List price"), o.list_price_cents, false],
                [
                  tr(`优惠券 ${o.coupon_code ?? ""}`, `Coupon ${o.coupon_code ?? ""}`),
                  -o.discount_cents,
                  o.discount_cents === 0,
                ],
                [tr("换套餐抵扣", "Switch credit"), -o.credit_cents, o.credit_cents === 0],
                [tr("余额支付", "Paid from balance"), -o.balance_cents, o.balance_cents === 0],
                [tr("赠送", "Gift"), -o.gift_cents, o.gift_cents === 0],
              ] as [string, number, boolean][]
            )
              .filter(([, , hide]) => !hide)
              .map(([k, v]) => (
                <div key={k} className="flex justify-between border-b border-border px-3 py-2 last:border-0">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="tabular-nums">{yuan(v)}</span>
                </div>
              ))}
            <div className="flex justify-between bg-subtle px-3 py-2 font-medium">
              <span>{tr("实付", "Paid")}</span>
              <span className="tabular-nums">{yuan(o.amount_cents)}</span>
            </div>
          </div>
          {o.refunded_at && (
            <>
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
            </>
          )}
          {(q.data?.events.length ?? 0) > 0 && (
            <>
              <SectionTitle>{tr("支付事件", "Payment events")}</SectionTitle>
              <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
                {q.data?.events.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <Badge>{e.source}</Badge>
                    <Badge tone={e.verified ? "success" : "danger"}>
                      {e.verified ? tr("已验签", "verified") : tr("未验签", "unverified")}
                    </Badge>
                    <span>{e.outcome}</span>
                    {e.trade_status && <span className="text-muted-foreground">{e.trade_status}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">{dateTime(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {o && dialog === "fulfil" && (
        <FulfilDialog order={o} onClose={() => setDialog(null)} onDone={() => void q.refetch()} />
      )}
      {o && dialog === "refund" && (
        <RefundDialog order={o} onClose={() => setDialog(null)} onDone={() => void q.refetch()} />
      )}
    </Drawer>
  );
}

function FulfilDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const tr = useTr();
  const [reason, setReason] = useState("");
  const [run, busy] = useRun();
  const retry = order.status === "paid";
  const submit = async () => {
    const r = await run(() => post(`/orders/${order.id}/fulfil`, { reason: reason.trim() }), {
      ok: retry ? tr("已重试开通", "Fulfilment retried") : tr("已确认付款", "Marked paid"),
      invalidate: [["orders"], ["dashboard"]],
    });
    if (r !== undefined) {
      onDone();
      onClose();
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={retry ? tr("重试开通", "Retry fulfilment") : tr("人工确认付款", "Mark paid by hand")}
      description={
        retry
          ? undefined
          : tr(
              "用于线下已收款的订单：按原价记为已付款并开通。",
              "For an order paid outside the gateway: recorded paid and fulfilled.",
            )
      }
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!reason.trim()}>
            {tr("确认", "Confirm")}
          </Button>
        </>
      }
    >
      <Field label={tr("原因（必填，写入审计）", "Reason (required, audited)")}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
      </Field>
    </Dialog>
  );
}

function RefundDialog({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const p = useQuery({
    queryKey: ["orders", "refund-preview", order.id],
    queryFn: () => get<Preview>(`/orders/${order.id}/refund-preview`),
    gcTime: 0,
  });
  const gateway = (p.data?.amount_cents ?? 0) > 0;
  const [route, setRoute] = useState<"original" | "balance" | "record">("balance");
  const [amount, setAmount] = useState("");
  const [keepPlan, setKeepPlan] = useState(false);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [run, busy] = useRun();
  const tail = order.out_trade_no.slice(-6);
  const submit = async () => {
    if (!p.data) return;
    const body: Record<string, unknown> = { reason: reason.trim(), keep_plan: keepPlan, to_balance: false };
    if (gateway) {
      if (route === "original") {
        body.original = true;
        if (amount.trim()) {
          const c = parseYuan(amount);
          if (c === null || c <= 0) return setError(new Error(tr("金额无效", "Invalid amount")));
          body.original_cents = c;
        }
      } else if (route === "balance") body.to_balance = true;
      else {
        const c = parseYuan(amount);
        if (c === null)
          return setError(
            new Error(tr("请填写在商家平台实际退回的金额", "Enter the amount refunded in the merchant console")),
          );
        body.external_cents = c;
      }
    }
    setError(null);
    const r = await run(() => post<{ pending?: boolean }>(`/orders/${order.id}/refund`, body), {
      invalidate: [["orders"], ["dashboard"], ["users"]],
    });
    if (r !== undefined) {
      toast({
        tone: "success",
        title: r?.pending
          ? tr("原路退款已提交，等待渠道确认", "Refund submitted; waiting for the provider")
          : tr("已退款", "Refunded"),
      });
      onDone();
      onClose();
    }
  };
  return (
    <Dialog
      open
      wide
      tone="danger"
      icon="alert"
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
      {p.isPending && <Skeleton className="h-24" />}
      <FormError error={p.error} />
      {p.data && (
        <div className="space-y-3 text-[13px]">
          <KV
            items={[
              [tr("渠道实付", "Gateway amount"), yuan(p.data.amount_cents)],
              [
                tr("余额部分（总是退回余额）", "Balance part (always back to the balance)"),
                yuan(p.data.balance_part_cents),
              ],
            ]}
          />
          <div className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 font-medium text-warning">
            {keepPlan ? tr("保留套餐（仅退款）", "Plan kept (money only)") : effectText(p.data.effect, tr)}
          </div>
          {gateway && (
            <Field group label={tr("退款去向", "Refund route")}>
              <div className="space-y-1.5" role="radiogroup">
                {(
                  [
                    [
                      "original",
                      tr("① 原路退回（调用支付渠道退款接口）", "① Back to the payer (provider refund API)"),
                      !p.data.original_available,
                    ],
                    ["balance", tr("② 退到用户余额", "② To the user's balance"), false],
                    [
                      "record",
                      tr("③ 仅登记（已在商家平台手动退款）", "③ Record only (refunded in the merchant console)"),
                      false,
                    ],
                  ] as [typeof route, string, boolean][]
                ).map(([v, label, off]) => (
                  <label key={v} className={`flex items-center gap-2 ${off ? "opacity-50" : ""}`}>
                    <input
                      type="radio"
                      name="route"
                      checked={route === v}
                      disabled={off}
                      onChange={() => setRoute(v)}
                    />
                    {label}
                    {off && v === "original" && (
                      <span className="text-xs text-muted-foreground">
                        {tr("（该支付方式未开启原路退款）", "(not enabled for this method)")}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </Field>
          )}
          {gateway && route !== "balance" && (
            <Field
              label={
                route === "original"
                  ? tr("退回金额（元，留空 = 全部）", "Amount (yuan; empty = all)")
                  : tr("实际退回金额（元）", "Amount refunded (yuan)")
              }
            >
              <Input
                inputMode="decimal"
                value={amount}
                placeholder={centsToYuanText(p.data.amount_cents)}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
          )}
          <div className="flex items-center gap-2">
            <Checkbox
              checked={keepPlan}
              onChange={setKeepPlan}
              label={tr("仅退款，保留套餐", "Money only, keep the plan")}
            />
            <span>{tr("仅退款，保留套餐", "Money only, keep the plan")}</span>
          </div>
          <Field label={tr("退款原因（必填，写入审计）", "Reason (required, audited)")}>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
          </Field>
          <Field
            label={tr(`二次确认：输入订单号后 6 位 ${tail}`, `Type the last 6 characters of the order number: ${tail}`)}
          >
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} />
          </Field>
          <FormError error={error} />
        </div>
      )}
    </Dialog>
  );
}

type PriceRow = { plan_id: string; plan_name: string; plan_enabled: boolean; on_sale: boolean; prices: PlanPrice[] };

export function ManualOrderDialog({ onClose, user: preset }: { onClose: () => void; user?: UserRow }) {
  const tr = useTr();
  const [q, setQ] = useState(preset?.email ?? "");
  const dq = useDebounced(q, 300);
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
  const [run, busy] = useRun();
  const plan = prices.data?.plans.find((p) => p.plan_id === planId);
  const submit = async () => {
    if (!user || !planId || !period || !reason.trim()) return;
    const r = await run(
      () => post("/orders/manual", { user_id: user.id, plan_id: planId, period, gift, reason: reason.trim() }),
      {
        ok: tr("人工订单已创建并开通", "Manual order created and fulfilled"),
        invalidate: [["orders"], ["users"], ["dashboard"]],
      },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      wide
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
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={!user || !planId || !period || !reason.trim()}
          >
            {tr("创建并开通", "Create and fulfil")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {user ? (
          <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[13px]">
            <span>{user.email}</span>
            {!preset && (
              <Button size="sm" variant="ghost" onClick={() => setUser(null)}>
                {tr("更换", "Change")}
              </Button>
            )}
          </div>
        ) : (
          <Field label={tr("用户邮箱", "User email")}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="user@example.com" />
            {(found.data ?? []).length > 0 && (
              <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                {found.data?.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-1.5 text-left text-[13px] hover:bg-muted"
                      onClick={() => setUser(u)}
                    >
                      {u.email}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={tr("套餐", "Plan")}>
            <Select value={planId} onChange={(e) => (setPlanId(e.target.value), setPeriod(""))}>
              <option value="">{tr("请选择…", "Choose…")}</option>
              {prices.data?.plans
                .filter((p) => p.prices.length > 0)
                .map((p) => (
                  <option key={p.plan_id} value={p.plan_id}>
                    {p.plan_name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={tr("周期（有价格的）", "Term (priced)")}>
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
        <div className="flex items-center gap-2 text-[13px]">
          <Checkbox checked={gift} onChange={setGift} label={tr("赠送（金额记 0）", "Gift (amount 0)")} />
          {tr("赠送（金额记 0，不算营收）", "Gift (amount 0, not revenue)")}
        </div>
        <Field label={tr("原因（必填，写入订单与审计）", "Reason (required, on the order and audited)")}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
        </Field>
      </div>
    </Dialog>
  );
}

function ExportDialog({ onClose }: { onClose: () => void }) {
  const tr = useTr();
  const today = siteToday();
  const [from, setFrom] = useState(daysBefore(today, 29));
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState("");
  const [via, setVia] = useState("");
  const href = `${apiBase}/orders/export.csv${qs({ from, to, status, via })}`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr("导出订单 CSV", "Export orders (CSV)")}
      description={tr("按站点时区的日，最长 366 天；导出写入审计。", "Site days, at most 366; the export is audited.")}
      footer={
        <>
          <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
          <a
            href={href}
            download
            onClick={() => setTimeout(onClose, 300)}
            className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3.5 text-sm font-medium text-primary-foreground shadow-card hover:bg-primary/90"
          >
            {tr("下载", "Download")}
          </a>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tr("从", "From")}>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label={tr("到", "To")}>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
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
        <Field label={tr("方式", "Via")}>
          <Select value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="">{tr("全部", "Any")}</option>
            <option value="manual">{tr("人工", "Manual")}</option>
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}
