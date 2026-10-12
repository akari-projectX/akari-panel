// The order dialog (ORD-03/04/05/06, v2 §3 "订单详情 / 退款"): a status hero
// with the next step, the receipt waterfall, the payment events as a
// timeline in plain words (raw values folded), the fulfilment error with
// links to where it is fixed, the refund block; stacked on it the
// "mark paid / retry" dialog (reason required) and the refund dialog
// (preview of what is undone → route cards → amount, reason → the order
// number's last 6 characters).
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Ban,
  CircleAlert,
  CircleCheck,
  Clock,
  CreditCard,
  Hourglass,
  NotebookPen,
  ReceiptText,
  RotateCw,
  ShieldCheck,
  Undo2,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { get, post } from "../../shared/api";
import { cn } from "../../shared/cn";
import { bytes, centsToYuanText, dateTime, parseYuan, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Textarea } from "../../shared/ui/form";
import { Banner, KV } from "../../shared/ui/layout";
import { ErrorState, LoadingBlock, SkeletonRows } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { CopyText, FixCount, IconBadge, Timeline, type TimelineItem } from "../components/kit";
import { AffixInput, RadioCards } from "../components/inputs";
import { OrdStatus, orderState } from "../components/status";
import { useCrumb } from "../session";
import { periodLabel } from "../terms";
import { actionText, MethodTag, paidTotal, type Order, type RefundEffect } from "./orders";

type PayEvent = {
  id: number;
  source: string;
  verified: boolean;
  outcome: string;
  trade_status: string | null;
  ip: string | null;
  params: unknown;
  created_at: string;
};

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

function sourceText(s: string, tr: Tr): string {
  return (
    {
      notify: tr("渠道回调", "Provider notify"),
      query: tr("主动查询", "Status query"),
      precreate: tr("创建支付", "Payment created"),
      manual: tr("后台人工", "By an admin"),
      system: tr("系统", "System"),
    }[s] ?? tr("其他来源", "Other source")
  );
}

function outcomeText(o: string, tr: Tr): [string, Tone] {
  const m: Record<string, [string, Tone]> = {
    ok: [tr("已生成付款码", "Payment code issued"), "info"],
    failed: [tr("创建支付失败", "Could not create the payment"), "danger"],
    paid: [tr("确认已付款", "Paid"), "success"],
    paid_unfulfilled: [tr("已付款，开通失败", "Paid, fulfilment failed"), "danger"],
    duplicate: [tr("重复通知，已忽略", "Duplicate, ignored"), "neutral"],
    ignored: [tr("未付款状态，已忽略", "Not a payment, ignored"), "neutral"],
    amount_mismatch: [tr("金额不符，未入账", "Amount mismatch, refused"), "danger"],
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
      WAIT_BUYER_PAY: tr("渠道：等待付款", "Provider: waiting for payment"),
      TRADE_SUCCESS: tr("渠道：交易成功", "Provider: trade succeeded"),
      TRADE_FINISHED: tr("渠道：交易完结", "Provider: trade finished"),
      TRADE_CLOSED: tr("渠道：交易关闭", "Provider: trade closed"),
    }[s] ?? tr("渠道状态", "Provider status")
  );
}

/** Folded raw text (provider payloads, backend messages). */
function Raw({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="mt-1 text-footnote text-muted-foreground">
      <summary className="cursor-default text-faint select-none hover:text-foreground">{label}</summary>
      <pre className="mt-1 overflow-x-auto rounded-md bg-window p-2 font-mono text-caption break-all whitespace-pre-wrap">
        {children}
      </pre>
    </details>
  );
}

/** A fulfilment error in plain words and where to fix it. */
function fulfilFix(e: string, o: Order, tr: Tr): { text: string; fix?: { to: string; label: string } } {
  if (/insufficient balance/i.test(e))
    return {
      text: tr(
        "下单时用的余额无法再次扣除（用户余额不足）。给用户补足余额后重试开通，或退款。",
        "The balance used at checkout could not be taken again. Top the balance up and retry, or refund.",
      ),
      fix: o.user_id ? { to: `/users?open=${o.user_id}`, label: tr("去补余额", "Top up the balance") } : undefined,
    };
  if (/sold out|capacity/i.test(e))
    return {
      text: tr(
        "套餐已售罄（库存已满）。调高库存后重试开通，或退款。",
        "The plan is sold out. Raise its stock and retry, or refund.",
      ),
      fix: { to: "/plans", label: tr("去调整库存", "Adjust the stock") },
    };
  if (/plan/i.test(e) && /(disabled|gone|not found|deleted)/i.test(e))
    return {
      text: tr(
        "套餐已停用或删除。启用套餐后重试开通，或退款。",
        "The plan is disabled or gone. Enable it and retry, or refund.",
      ),
      fix: { to: "/plans", label: tr("去检查套餐", "Check the plan") },
    };
  if (/group|entrance/i.test(e))
    return {
      text: tr(
        "套餐的节点组有问题。检查节点组后重试开通，或退款。",
        "The plan's node groups are wrong. Check them and retry, or refund.",
      ),
      fix: { to: "/plans/groups", label: tr("去检查节点组", "Check node groups") },
    };
  return {
    text: tr(
      "用户已付款，但套餐没有开通（例如用户已删除、套餐已停用或已售罄）。查看原因后可以重试开通，或者退款。",
      "The user paid but the plan was not granted (e.g. user gone, plan disabled or sold out). Retry, or refund.",
    ),
  };
}

export function effectText(e: RefundEffect, tr: Tr): string {
  switch (e.kind) {
    case "cancel":
      return tr(`取消订阅「${e.plan_name}」并踢线`, `Cancels the "${e.plan_name}" subscription (user disconnected)`);
    case "rollback":
      return tr(
        `「${e.plan_name}」到期日 ${dateTime(e.from)} → ${dateTime(e.to)}`,
        `"${e.plan_name}" expiry ${dateTime(e.from)} → ${dateTime(e.to)}`,
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
          not_fulfilled: tr("尚未开通，无需收回", "Not fulfilled: nothing to take back"),
          reset_pack: tr("流量重置包：已用流量不回滚，只退款", "Reset pack: used traffic stays, money only"),
          not_active: tr("对应订阅已不再生效，只退款", "The subscription is no longer active: money only"),
          user_gone: tr("用户已删除，只退款", "The user is gone: money only"),
          untracked: tr("无法确定订阅效果", "Effect not tracked"),
        }[e.why] ?? tr("无法确定订阅效果", "Effect not tracked")
      );
  }
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

/** Where the refund went: provider / balance / recorded. */
function refundRoute(o: Order, tr: Tr): string {
  if ((o.refund_external_cents ?? 0) > 0 && o.refund_request?.state === "done") return tr("原路退回", "To the payer");
  if ((o.refund_external_cents ?? 0) > 0) return tr("仅登记（商家平台已退）", "Recorded (refunded outside)");
  return tr("退到余额", "To the balance");
}

const AUTO = /^自动退款[:：]\s*/;

type Hero = { tone: Tone; icon: LucideIcon; title: string; text: ReactNode };

function hero(o: Order, tr: Tr): Hero {
  const st = orderState(o);
  const plan = `${o.plan_name} · ${periodLabel(o.period, tr, o.period_days)}`;
  switch (st) {
    case "pending":
      return {
        tone: "info",
        icon: Clock,
        title: tr("等待用户付款", "Waiting for the payment"),
        text: tr(
          `${dateTime(o.expires_at)} 前没付款会自动关闭。如果用户已通过其他途径付款（如转账），可以人工确认付款。`,
          `Closes at ${dateTime(o.expires_at)} unless paid. If the user paid another way (a transfer), mark it paid.`,
        ),
      };
    case "completed":
      return {
        tone: "success",
        icon: CircleCheck,
        title: tr("已付款并开通", "Paid and fulfilled"),
        text: tr(`用户已获得「${plan}」。`, `The user got "${plan}".`),
      };
    case "unfulfilled":
      return {
        tone: "danger",
        icon: CircleAlert,
        title: tr("已付款，但套餐没有开通", "Paid, but the plan was not granted"),
        text: tr(
          `用户已付 ${yuan(paidTotal(o))}，开通时出错（原因见「经过」）。修好后点「重试开通」；开不了就退款。`,
          `The user paid ${yuan(paidTotal(o))}; granting failed (see the history). Fix it and retry, or refund.`,
        ),
      };
    case "refunding":
      return {
        tone: "warning",
        icon: Undo2,
        title: tr(`退款 ${yuan(o.refund_request?.cents)} 处理中`, `Refund of ${yuan(o.refund_request?.cents)} pending`),
        text: tr(
          "支付渠道已受理，通常 1–3 天到账；到账后状态会自动更新。",
          "The provider accepted it; it usually lands in 1–3 days and the status updates by itself.",
        ),
      };
    case "partial_refund":
    case "refunded": {
      const auto = o.refund_reason && AUTO.test(o.refund_reason);
      return {
        tone: "neutral",
        icon: Undo2,
        title: auto
          ? tr("已自动退款", "Refunded automatically")
          : st === "partial_refund"
            ? tr(`已部分退款 ${yuan(o.refund_cents)}`, `Partly refunded: ${yuan(o.refund_cents)}`)
            : tr("已退款", "Refunded"),
        text: (
          <>
            {yuan(o.refund_cents)} {refundRoute(o, tr)}
            {auto && (
              <>
                {tr("。原因：", ". Why: ")}
                {o.refund_reason!.replace(AUTO, "")}
              </>
            )}
            {tr("。", ".")}
          </>
        ),
      };
    }
    case "expired":
      return {
        tone: "neutral",
        icon: Hourglass,
        title: tr("已过期，未付款", "Expired, not paid"),
        text: tr(
          "超时没付款，系统已关闭这笔订单。用户可以重新下单；确认用户确实付了钱时才人工确认付款。",
          "Not paid in time; closed. The user can order again. Mark it paid only if the user really paid.",
        ),
      };
    default:
      return {
        tone: "neutral",
        icon: Ban,
        title: tr("已取消", "Cancelled"),
        text: tr("订单在付款前被取消。", "The order was cancelled before it was paid."),
      };
  }
}

const heroTone: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  info: "bg-info-soft text-info",
  danger: "bg-destructive-soft text-destructive",
  neutral: "bg-secondary text-muted-foreground",
  warning: "bg-warning-soft text-warning",
};

/** Receipt waterfall: list price → deductions → paid; refunds below. */
function Receipt({
  lines,
  total,
  after,
}: {
  lines: { label: ReactNode; cents: number; note?: ReactNode; minus?: boolean }[];
  total: { label: ReactNode; cents: number };
  after?: { label: ReactNode; cents: number; tone?: "danger" | "muted"; note?: ReactNode }[];
}) {
  return (
    <div className="rounded-xl bg-window px-4 py-3 ring-1 ring-border ring-inset">
      <dl className="grid gap-1.5 text-body">
        {lines.map((l, i) => (
          <div key={i} className="flex items-baseline gap-3">
            <dt className="text-muted-foreground">{l.label}</dt>
            {l.note && <span className="min-w-0 truncate font-mono text-footnote text-faint">{l.note}</span>}
            <span className="flex-1 border-b border-dotted border-border" aria-hidden="true" />
            <dd className={cn("tnum", l.minus && "text-success")}>
              {l.minus ? "−" : ""}
              {yuan(l.cents)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2.5 flex items-baseline justify-between border-t border-dashed border-border pt-2.5">
        <span className="text-callout font-semibold">{total.label}</span>
        <span className="tnum text-title3 font-semibold tracking-[-0.01em]">{yuan(total.cents)}</span>
      </div>
      {after?.map((a, i) => (
        <div
          key={i}
          className={cn(
            "mt-1.5 flex items-baseline justify-between text-body",
            a.tone === "danger" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          <span>
            {a.label}
            {a.note && <span className="ml-1.5 text-footnote opacity-80">{a.note}</span>}
          </span>
          <span className="tnum font-medium">−{yuan(a.cents)}</span>
        </div>
      ))}
    </div>
  );
}

export function OrderDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tr = useTr();
  const q = useQuery({
    queryKey: ["order", id],
    queryFn: () => get<{ order: Order; events: PayEvent[] }>(`/orders/${id}`),
  });
  const [sub, setSub] = useState<"fulfil" | "refund" | null>(null);
  const o = q.data?.order;
  useCrumb(o?.out_trade_no);
  const st = o ? orderState(o) : null;
  const paidish = st === "completed" || st === "unfulfilled";
  const gift = !!o && o.gift_cents > 0;
  const canRefund = !!o && o.status === "paid" && !o.refunded_at && o.refund_request?.state !== "pending";
  const primary: { label: string; icon: LucideIcon } | null =
    st === "unfulfilled"
      ? { label: tr("重试开通", "Retry fulfilment"), icon: RotateCw }
      : st === "pending" || st === "expired" || st === "cancelled"
        ? { label: tr("人工确认付款", "Mark paid"), icon: ShieldCheck }
        : null;
  const h = o ? hero(o, tr) : null;
  const refundNote = !o
    ? null
    : o.refunded_at || o.refund_request?.state === "pending"
      ? tr("这笔订单已经退过款", "Already refunded")
      : gift
        ? tr("赠送订单没有收钱，不能退款", "A gift took no money: nothing to refund")
        : null;
  return (
    <>
      <Dialog
        open
        size="lg"
        onClose={onClose}
        icon={ReceiptText}
        tone={st === "unfulfilled" ? "danger" : "default"}
        title={
          o ? (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {tr("订单", "Order")} <span className="font-mono text-headline">{o.out_trade_no}</span>
            </span>
          ) : (
            tr("订单详情", "Order")
          )
        }
        description={
          o &&
          `${o.plan_name} · ${periodLabel(o.period, tr, o.period_days)} · ${actionText(o.action, tr)} · ${tr("下单于", "ordered")} ${dateTime(o.created_at)}`
        }
        footer={
          o && (
            <>
              {(paidish || o.refunded_at) && (
                <Button
                  variant="destructive-soft"
                  icon={Undo2}
                  disabled={!canRefund || gift}
                  title={refundNote ?? undefined}
                  onClick={() => setSub("refund")}
                >
                  {tr("退款", "Refund")}
                </Button>
              )}
              {refundNote && (paidish || o.refunded_at) && (
                <span className="text-footnote text-faint max-sm:hidden">{refundNote}</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {o.user_id && (
                  <Link
                    to={`/users?open=${o.user_id}&tab=orders`}
                    className="hit-44 inline-flex h-8 items-center gap-1 rounded-md px-3 text-body font-medium hover:bg-accent pointer-coarse:h-10"
                  >
                    {tr("打开用户", "Open user")}
                    <ArrowUpRight className="size-4" aria-hidden="true" />
                  </Link>
                )}
                {primary && (
                  <Button variant="primary" icon={primary.icon} onClick={() => setSub("fulfil")}>
                    {primary.label}
                  </Button>
                )}
              </div>
            </>
          )
        }
      >
        {q.isPending ? (
          <LoadingBlock rows={8} />
        ) : q.isError ? (
          <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          o &&
          h && (
            <>
              <div className={cn("flex items-start gap-3 rounded-xl p-4", heroTone[h.tone])}>
                <h.icon className="mt-0.5 size-6 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="text-title3 font-semibold tracking-[-0.015em]">{h.title}</div>
                  <p className="mt-1 text-body text-foreground/80">{h.text}</p>
                </div>
              </div>
              <OrderBody o={o} events={q.data?.events ?? []} />
            </>
          )
        )}
      </Dialog>
      {o && sub === "fulfil" && <FulfilDialog order={o} onClose={() => setSub(null)} />}
      {o && sub === "refund" && <RefundDialog order={o} onClose={() => setSub(null)} />}
    </>
  );
}

function OrderBody({ o, events }: { o: Order; events: PayEvent[] }) {
  const tr = useTr();
  const st = orderState(o);
  const tries = events.filter((e) => e.outcome === "paid_unfulfilled" || e.outcome === "fulfil_failed").length;
  const items: TimelineItem[] = [
    { title: tr("创建订单", "Order created"), time: dateTime(o.created_at), tone: "neutral" },
    ...events.map((e): TimelineItem => {
      const [text, tone] = outcomeText(e.outcome, tr);
      return {
        tone,
        title: text,
        time: dateTime(e.created_at),
        body: (
          <>
            <span>
              {sourceText(e.source, tr)}
              {e.trade_status ? ` · ${tradeStatusText(e.trade_status, tr)}` : ""}
              {!e.verified ? ` · ${tr("未通过验签", "unverified")}` : ""}
            </span>
            <Raw label={tr("原始数据", "Raw data")}>
              {`source=${e.source} outcome=${e.outcome}${e.trade_status ? ` trade_status=${e.trade_status}` : ""}${
                e.verified ? " verified" : " unverified"
              }${e.ip ? ` ip=${e.ip}` : ""}${e.params ? `\n${JSON.stringify(e.params, null, 2)}` : ""}`}
            </Raw>
          </>
        ),
      };
    }),
    ...(o.refunded_at
      ? [{ title: tr("退款", "Refunded"), time: dateTime(o.refunded_at), tone: "warning" as const }]
      : []),
  ];
  const fix = o.fulfil_error ? fulfilFix(o.fulfil_error, o, tr) : null;
  const totalLabel =
    o.gift_cents > 0
      ? tr("实付（赠送）", "Paid (gift)")
      : o.amount_cents === 0 && o.balance_cents > 0
        ? tr("实付（余额）", "Paid (balance)")
        : tr("实付", "Paid");
  const refundPending = o.refund_request?.state === "pending";
  return (
    <div className="mt-4 grid gap-5 md:grid-cols-2">
      <section className="grid content-start gap-3">
        <h4 className="text-footnote font-semibold text-muted-foreground">{tr("金额", "Amount")}</h4>
        <Receipt
          lines={[
            {
              label: tr(
                `原价（${o.plan_name} · ${periodLabel(o.period, tr, o.period_days)}）`,
                `List price (${o.plan_name} · ${periodLabel(o.period, tr, o.period_days)})`,
              ),
              cents: o.list_price_cents,
            },
            ...(o.discount_cents
              ? [
                  {
                    label: tr("优惠券", "Coupon"),
                    note: o.coupon_code ?? undefined,
                    cents: o.discount_cents,
                    minus: true,
                  },
                ]
              : []),
            ...(o.credit_cents
              ? [
                  {
                    label: tr("换套餐抵扣", "Switch credit"),
                    note: tr("旧套餐剩余价值", "old plan's remainder"),
                    cents: o.credit_cents,
                    minus: true,
                  },
                ]
              : []),
            ...(o.gift_cents ? [{ label: tr("赠送", "Gift"), cents: o.gift_cents, minus: true }] : []),
          ]}
          total={{ label: totalLabel, cents: paidTotal(o) }}
          after={[
            ...(o.balance_cents > 0 && o.amount_cents > 0
              ? [
                  {
                    label: tr("其中余额支付", "of which from the balance"),
                    cents: o.balance_cents,
                    tone: "muted" as const,
                  },
                ]
              : []),
            ...(refundPending
              ? [
                  {
                    label: tr("退款处理中", "Refund pending"),
                    note: tr("原路退回", "to the payer"),
                    cents: o.refund_request!.cents,
                    tone: "muted" as const,
                  },
                ]
              : o.refunded_at
                ? [
                    {
                      label: tr("已退款", "Refunded"),
                      note: refundRoute(o, tr),
                      cents: o.refund_cents ?? 0,
                      tone: "danger" as const,
                    },
                  ]
                : []),
          ]}
        />
        <KV
          cols={2}
          items={[
            {
              k: tr("用户", "User"),
              v: o.user_id ? (
                <Link className="text-primary hover:underline" to={`/users?open=${o.user_id}`}>
                  {o.user_email ?? o.user_label}
                </Link>
              ) : (
                <span className="text-muted-foreground">{o.user_label}</span>
              ),
              span: 2,
            },
            { k: tr("付款方式", "Paid via"), v: <MethodTag o={o} /> },
            { k: tr("状态", "Status"), v: <OrdStatus state={st} /> },
            {
              k: tr("订单号", "Order no."),
              v: <CopyText value={o.out_trade_no} label={tr("订单号", "order no.")} />,
              span: 2,
            },
            {
              k: tr("交易号", "Trade no."),
              v: o.trade_no ? (
                <CopyText value={o.trade_no} label={tr("交易号", "trade no.")} />
              ) : (
                <span className="text-faint">—</span>
              ),
            },
            ...(o.paid_at ? [{ k: tr("付款时间", "Paid at"), v: dateTime(o.paid_at) }] : []),
            ...(o.fulfilled_at ? [{ k: tr("开通时间", "Fulfilled at"), v: dateTime(o.fulfilled_at) }] : []),
            ...(o.manual_reason
              ? [
                  {
                    k: tr("人工原因", "Manual reason"),
                    v: <span className="whitespace-normal">{o.manual_reason}</span>,
                    span: 2 as const,
                  },
                ]
              : []),
          ]}
        />
      </section>

      <section className="grid content-start gap-3">
        <h4 className="text-footnote font-semibold text-muted-foreground">{tr("经过", "History")}</h4>
        <Timeline items={items} />

        {st === "unfulfilled" && (
          <div className="rounded-xl bg-destructive-soft/60 p-3 ring-1 ring-destructive/20 ring-inset">
            <div className="flex items-center gap-2 text-body font-semibold text-destructive">
              <CircleAlert className="size-4" aria-hidden="true" />
              {tries > 0
                ? tr(`开通失败 · 已尝试 ${tries} 次`, `Fulfilment failed · ${tries} attempts`)
                : tr("开通失败", "Fulfilment failed")}
            </div>
            <p className="mt-1 text-body">
              {fix?.text ??
                tr(
                  "用户已付款，但套餐还没有开通。可以重试开通，或退款。",
                  "Paid but not granted yet. Retry, or refund.",
                )}
            </p>
            {fix?.fix && (
              <Link
                to={fix.fix.to}
                className="mt-1 inline-flex items-center gap-0.5 text-footnote font-medium text-primary hover:underline"
              >
                {fix.fix.label}
                <ArrowUpRight className="size-3" aria-hidden="true" />
              </Link>
            )}
            {o.fulfil_error && <Raw label={tr("原始错误", "Raw error")}>{o.fulfil_error}</Raw>}
          </div>
        )}
        {st === "completed" && o.fulfilled_at && (
          <div className="flex items-center gap-2 rounded-xl bg-window px-3 py-2.5 text-body ring-1 ring-border ring-inset">
            <CircleCheck className="size-4 text-success" aria-hidden="true" />
            {tr("开通成功 · ", "Fulfilled · ")}
            {dateTime(o.fulfilled_at)}
          </div>
        )}
        {refundPending && (
          <div className="rounded-xl bg-warning-soft/60 p-3 ring-1 ring-border ring-inset">
            <div className="flex items-center gap-2 text-body font-semibold">
              <Clock className="size-4 text-warning" aria-hidden="true" />
              {tr("原路退款处理中 · ", "Refund to the payer pending · ")}
              {yuan(o.refund_request!.cents)}
            </div>
            <p className="mt-1 text-body text-muted-foreground">
              {tr("等待支付渠道确认（系统会自动查询）。", "Waiting for the provider (checked automatically).")}
            </p>
            {o.refund_request!.last_error && (
              <>
                <p className="mt-1 text-body">{refundErrorText(o.refund_request!.last_error, tr)}</p>
                <Raw label={tr("原始错误", "Raw error")}>{o.refund_request!.last_error}</Raw>
              </>
            )}
          </div>
        )}
        {o.refund_request?.state === "failed" && !o.refunded_at && (
          <div className="rounded-xl bg-destructive-soft/60 p-3 ring-1 ring-destructive/20 ring-inset">
            <div className="flex items-center gap-2 text-body font-semibold text-destructive">
              <CircleAlert className="size-4" aria-hidden="true" />
              {tr("原路退款失败", "Refund to the payer failed")}
            </div>
            <p className="mt-1 text-body">{refundErrorText(o.refund_request.last_error ?? "", tr)}</p>
            {o.refund_request.last_error && (
              <Raw label={tr("原始错误", "Raw error")}>{o.refund_request.last_error}</Raw>
            )}
          </div>
        )}
        {o.refunded_at && (
          <div className="rounded-xl bg-window p-3 ring-1 ring-border ring-inset">
            <div className="flex items-center gap-2 text-body font-semibold">
              <Undo2 className="size-4 text-muted-foreground" aria-hidden="true" />
              {tr("退款 · ", "Refund · ")}
              {yuan(o.refund_cents)}
            </div>
            <KV
              cols={2}
              className="mt-2"
              items={[
                { k: tr("去向", "Went to"), v: refundRoute(o, tr) },
                { k: tr("时间", "When"), v: dateTime(o.refunded_at) },
                { k: tr("退到余额", "To the balance"), v: yuan(o.refund_balance_cents) },
                { k: tr("渠道退回", "At the provider"), v: yuan(o.refund_external_cents) },
                {
                  k: tr("套餐", "Plan"),
                  v: (
                    <span className="whitespace-normal">{o.refund_effect ? effectText(o.refund_effect, tr) : "—"}</span>
                  ),
                  span: 2,
                },
                {
                  k: tr("原因", "Reason"),
                  v: (
                    <span className="whitespace-normal">
                      {o.refund_reason && AUTO.test(o.refund_reason) ? (
                        <>
                          <b className="font-semibold">{tr("自动退款", "Automatic refund")}</b> ·{" "}
                          {o.refund_reason.replace(AUTO, "")}
                        </>
                      ) : (
                        (o.refund_reason ?? "—")
                      )}
                    </span>
                  ),
                  span: 2,
                },
              ]}
            />
          </div>
        )}
      </section>
    </div>
  );
}

function FulfilDialog({ order: o, onClose }: { order: Order; onClose: () => void }) {
  const tr = useTr();
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [run, busy] = useAction();
  const retry = o.status === "paid";
  const closed = o.status === "expired" || o.status === "cancelled";
  const err = reason.trim() ? null : tr("请写明原因（会记入审计日志）", "Give a reason (it is audited)");
  const fix = o.fulfil_error ? fulfilFix(o.fulfil_error, o, tr) : null;
  const submit = async () => {
    setTried(true);
    if (err) return;
    const r = await run(() => post(`/orders/${o.id}/fulfil`, { reason: reason.trim() }), {
      ok: retry ? tr("已重试开通", "Fulfilment retried") : tr("已确认付款", "Marked paid"),
    });
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      size="sm"
      onClose={onClose}
      icon={retry ? RotateCw : ShieldCheck}
      tone={retry ? "danger" : "default"}
      title={retry ? tr("重试开通", "Retry fulfilment") : tr("人工确认付款", "Mark paid by hand")}
      description={
        retry
          ? tr(
              `再次为 ${o.user_email ?? o.user_label} 开通「${o.plan_name}」`,
              `Grant "${o.plan_name}" to ${o.user_email ?? o.user_label} again`,
            )
          : tr(
              `把这笔 ${yuan(o.amount_cents)} 的订单标记为已付款，并立即开通`,
              `Mark this ${yuan(o.amount_cents)} order paid and fulfil it now`,
            )
      }
      onSubmit={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            {tried && err && <FixCount n={1} />}
            <Button type="submit" variant="primary" loading={busy}>
              {retry ? tr("重试开通", "Retry fulfilment") : tr("确认付款并开通", "Mark paid and fulfil")}
            </Button>
          </div>
        </>
      }
    >
      {closed && (
        <Banner
          tone="warning"
          icon={<CircleAlert />}
          className="mb-3"
          title={
            o.status === "expired"
              ? tr("这笔订单已过期关闭。", "This order expired.")
              : tr("这笔订单已取消。", "This order was cancelled.")
          }
        >
          {tr(
            "确认付款会重新打开它并立即开通。请先核实用户确实付了钱（如转账截图、流水）。",
            "Marking it paid reopens it and fulfils it now. First check the user really paid (a transfer record).",
          )}
        </Banner>
      )}
      {retry && fix && (
        <Banner tone="danger" icon={<CircleAlert />} className="mb-3" title={tr("上次失败：", "Last failure:")}>
          {fix.text}
        </Banner>
      )}
      <Field
        label={tr("原因", "Reason")}
        required
        error={tried ? err : undefined}
        hint={tr("会记入审计日志，例如「微信转账，已核对流水」", "Audited, e.g. “bank transfer, checked”")}
      >
        <Textarea data-autofocus value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

type Preview = {
  balance_part_cents: number;
  amount_cents: number;
  effect: RefundEffect;
  original_available: boolean;
  original_request: { state: string } | null;
};

type Route = "original" | "balance" | "record";

function RefundDialog({ order: o, onClose }: { order: Order; onClose: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const p = useQuery({
    queryKey: ["refund-preview", o.id],
    queryFn: () => get<Preview>(`/orders/${o.id}/refund-preview`),
    gcTime: 0,
  });
  const max = p.data?.amount_cents ?? 0;
  const gateway = max > 0;
  const [route, setRoute] = useState<Route | null>(null);
  const r: Route = route ?? (p.data?.original_available ? "original" : "balance");
  const [amount, setAmount] = useState<string | null>(null);
  const amountText = amount ?? centsToYuanText(max);
  const [keepPlan, setKeepPlan] = useState(false);
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [tried, setTried] = useState(false);
  const [done, setDone] = useState<{ pending: boolean; route: Route; cents: number } | null>(null);
  const [run, busy] = useAction();
  const tail = o.out_trade_no.slice(-6);
  const cents = parseYuan(amountText);
  const amountErr =
    !gateway || r === "balance"
      ? null
      : cents === null
        ? tr("请输入金额，最多两位小数", "Enter an amount (2 decimals at most)")
        : r === "original" && cents <= 0
          ? tr("金额必须大于 0", "Must be more than 0")
          : cents > max
            ? r === "record"
              ? tr(`超出实付 ${yuan(max)}，请填商家平台实际退的金额`, `More than the ${yuan(max)} paid`)
              : tr(`最多可退 ${yuan(max)}`, `At most ${yuan(max)}`)
            : null;
  const reasonErr = reason.trim() ? null : tr("请写明退款原因", "Give the reason");
  const typedErr = typed.trim() === tail ? null : tr("请输入订单号后 6 位", "Type the last 6 characters");
  const errs = [amountErr, reasonErr, typedErr].filter(Boolean).length;
  const refundCents =
    (p.data?.balance_part_cents ?? 0) + (gateway ? (r === "balance" ? max : amountErr ? 0 : (cents ?? 0)) : 0);
  const submit = async () => {
    setTried(true);
    if (!p.data || errs) return;
    const body: Record<string, unknown> = { reason: reason.trim(), keep_plan: keepPlan, to_balance: false };
    if (gateway) {
      if (r === "original") {
        body.original = true;
        if (cents !== max) body.original_cents = cents;
      } else if (r === "balance") body.to_balance = true;
      else body.external_cents = cents;
    }
    const res = await run(() => post<{ pending?: boolean }>(`/orders/${o.id}/refund`, body));
    if (res !== undefined) {
      toast({
        tone: "success",
        title: res?.pending
          ? tr("原路退款已提交，等待渠道确认", "Refund submitted; waiting for the provider")
          : tr("已退款", "Refunded"),
      });
      setDone({ pending: !!res?.pending, route: r, cents: refundCents });
    }
  };
  const effects: { k: string; v: string }[] = p.data
    ? [
        { k: tr("套餐", "Plan"), v: effectText(p.data.effect, tr) },
        ...(o.coupon_code
          ? [
              {
                k: tr("优惠券", "Coupon"),
                v: tr(`${o.coupon_code} 的使用次数退回 1 次`, `${o.coupon_code}: one use back`),
              },
            ]
          : []),
      ]
    : [];
  const originalOff = !p.data
    ? null
    : p.data.original_available
      ? null
      : o.paid_via === "manual"
        ? tr("人工订单没有支付渠道可以原路退", "A manual order has no provider to refund through")
        : tr("该支付方式未开启原路退款", "Refunds to the payer are off for this method");
  return (
    <Dialog
      open
      size="md"
      tone="danger"
      icon={Undo2}
      onClose={onClose}
      dirty={done ? false : undefined}
      title={tr("退款", "Refund")}
      description={`${o.out_trade_no} · ${tr("实付", "paid")} ${yuan(paidTotal(o))}`}
      onSubmit={done ? onClose : () => void submit()}
      footer={
        done ? (
          <Button className="ml-auto" variant="primary" onClick={onClose}>
            {tr("完成", "Done")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tr("取消", "Cancel")}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {tried && <FixCount n={errs} />}
              <Button type="submit" variant="destructive" loading={busy} disabled={!p.data}>
                {r === "record" && gateway ? tr("登记退款 ", "Record refund ") : tr("退款 ", "Refund ")}
                {refundCents > 0 ? yuan(refundCents) : ""}
              </Button>
            </div>
          </>
        )
      }
    >
      {done ? (
        <div className="flex flex-col items-center py-8 text-center" role="status">
          <IconBadge icon={done.pending ? Clock : CircleCheck} tone={done.pending ? "warning" : "success"} round />
          <div className="mt-3 text-headline font-semibold">
            {done.pending
              ? tr("已提交，支付渠道处理中", "Submitted; the provider is processing it")
              : done.route === "record"
                ? tr("已登记退款", "Refund recorded")
                : tr("已退款", "Refunded")}
          </div>
          <p className="mt-1 max-w-sm text-body text-muted-foreground">
            {done.pending
              ? tr(
                  `${yuan(done.cents)} 通常 1–3 天原路到账。完成后订单状态会自动变为「已退款」，无需刷新。`,
                  `${yuan(done.cents)} usually lands in 1–3 days; the order turns “refunded” by itself.`,
                )
              : tr("订单与用户的余额、套餐已经更新。", "The order, the balance and the plan are updated.")}
          </p>
        </div>
      ) : p.isError ? (
        <ErrorState compact error={p.error} onRetry={() => void p.refetch()} />
      ) : (
        <div className="grid gap-5">
          <section>
            <h4 className="mb-2 text-footnote font-semibold text-muted-foreground">
              {tr("退款后会发生什么", "What the refund undoes")}
            </h4>
            {p.isPending ? (
              <div className="overflow-hidden rounded-xl ring-1 ring-border ring-inset">
                <SkeletonRows rows={2} height={36} avatar={false} />
                <p className="px-3 pb-2 text-footnote text-faint">
                  {tr("正在计算会撤销哪些效果…", "Working out what is undone…")}
                </p>
              </div>
            ) : (
              <ul
                className={cn(
                  "divide-y divide-separator rounded-xl bg-window ring-1 ring-border ring-inset transition-opacity",
                  keepPlan && "opacity-45",
                )}
              >
                {effects.map((it) => (
                  <li key={it.k} className="flex gap-3 px-3 py-2 text-body">
                    <span className="w-16 shrink-0 text-muted-foreground">{it.k}</span>
                    <span className={cn("min-w-0", keepPlan && "line-through")}>{it.v}</span>
                  </li>
                ))}
              </ul>
            )}
            {p.data && p.data.balance_part_cents > 0 && (
              <p className="mt-1.5 text-footnote text-muted-foreground">
                {tr(
                  `余额支付的 ${yuan(p.data.balance_part_cents)} 总是退回余额。`,
                  `The ${yuan(p.data.balance_part_cents)} paid from the balance always goes back to it.`,
                )}
              </p>
            )}
            <label className="mt-2 flex min-h-8 items-center gap-2 text-body">
              <Checkbox
                checked={keepPlan}
                onChange={setKeepPlan}
                label={tr("仅退款，保留套餐", "Money only, keep the plan")}
              />
              {tr("仅退款，保留套餐", "Money only, keep the plan")}
              <span className="text-footnote text-faint max-sm:hidden">
                {tr("（补偿、折价时用）", "(compensation)")}
              </span>
            </label>
          </section>

          {gateway && (
            <section>
              <h4 className="mb-2 text-footnote font-semibold text-muted-foreground">
                {tr(`渠道实付 ${yuan(max)} 退到哪里`, `Where the ${yuan(max)} paid goes`)}
              </h4>
              <RadioCards<Route>
                label={tr("退款去向", "Refund route")}
                value={r}
                onChange={(v) => {
                  setRoute(v);
                  setAmount(null);
                }}
                cols={3}
                items={[
                  {
                    value: "original",
                    icon: <CreditCard />,
                    title: tr("原路退回", "To the payer"),
                    desc: tr("调用支付渠道退款，可部分退", "Through the provider; partial allowed"),
                    disabled: originalOff,
                  },
                  {
                    value: "balance",
                    icon: <Wallet />,
                    title: tr("退到余额", "To the balance"),
                    desc: tr("立即到账，可再消费", "Credited now, can be spent"),
                  },
                  {
                    value: "record",
                    icon: <NotebookPen />,
                    title: tr("仅登记", "Record only"),
                    desc: tr("商家平台已退过，只记账", "Refunded outside; just record it"),
                  },
                ]}
              />
            </section>
          )}

          <div className={cn("grid gap-4", gateway && r !== "balance" && "sm:grid-cols-[180px_1fr]")}>
            {gateway && r !== "balance" && (
              <Field
                label={r === "record" ? tr("实际已退金额", "Amount refunded") : tr("退款金额", "Amount")}
                required
                error={tried || amount !== null ? (amountErr ?? undefined) : undefined}
                hint={tr(`最多 ${yuan(max)}`, `At most ${yuan(max)}`)}
              >
                <AffixInput prefix="¥" value={amountText} onChange={(e) => setAmount(e.target.value)} />
              </Field>
            )}
            <Field
              label={tr("原因", "Reason")}
              required
              error={tried ? (reasonErr ?? undefined) : undefined}
              hint={tr("用户可在订单记录里看到", "The user sees it on the order")}
            >
              <Input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            </Field>
          </div>

          <Field
            label={
              <>
                {tr("输入订单号后 6 位 ", "Type the last 6 characters ")}
                <code className="rounded bg-secondary px-1 font-mono text-foreground">{tail}</code>
                {tr(" 以确认", " to confirm")}
              </>
            }
            error={tried ? (typedErr ?? undefined) : undefined}
          >
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={tail}
              autoComplete="off"
              spellCheck={false}
              className="font-mono sm:w-48"
            />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
