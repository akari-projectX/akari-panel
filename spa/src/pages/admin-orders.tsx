// R18-3 后台（仅中文）：支付状态、订单列表/筛选、订单详情与支付事件、
// 人工确认收款 / 重试开通（必须填写原因，写审计）。W7：定价移到「套餐」页
// （按周期定价）；订单显示购买周期与换套餐抵扣。
import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { get, post } from "../lib/api";
import {
  periodZh,
  sortPrices,
  yuan,
  type AdminOrder,
  type OrderDetail,
  type OrderStatus,
  type Prices,
} from "../lib/billing";
import { adminErrorText, adminMessageText } from "../lib/admin-errors";
import { fmtDateTime } from "../lib/datetime";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const errText = (err: unknown) => (err instanceof Error ? adminErrorText(err) : "失败");
const fmt = (s: string | null) => fmtDateTime(s);

export const STATUS_ZH: Record<OrderStatus, string> = {
  pending: "待付款",
  paid: "已付款",
  expired: "已过期",
  cancelled: "已取消",
};

const VIA_ZH: Record<string, string> = {
  notify: "异步通知",
  query: "主动查询",
  manual: "人工确认",
  credit: "余值抵扣",
  balance: "余额支付",
  coupon: "优惠券全额抵扣",
};

const BALANCE_STATE_ZH: Record<AdminOrder["balance_state"], string> = {
  none: "",
  held: "已扣余额",
  refunded: "已退回余额",
};

export function AdminOrders() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <PaymentsCard />
      <OrdersCard onSelect={setSelected} />
      {selected && <OrderDetailCard id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

// Prices live with the plans (套餐 page, W7: one price per period); this
// card only says whether customers can pay at all.
function PaymentsCard() {
  const prices = useQuery({ queryKey: ["plan-prices"], queryFn: () => get<Prices>("/plan-prices") });
  const data = prices.data;
  if (!data) return null;
  const onSale = data.plans.filter((p) => p.on_sale && p.plan_enabled && p.prices.length > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>支付</h2>
        </CardTitle>
        <CardDescription>
          {data.payments_enabled
            ? "支付宝当面付已启用。"
            : "当前未启用支付宝（配置 [payments.alipay]），用户无法下单。"}
          定价、库存与售卖规则在「套餐」页按周期设置。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {onSale.length === 0 && <p className="text-muted-foreground">没有在售的套餐。</p>}
        {onSale.map((p) => (
          <p key={p.plan_id}>
            <span className="font-medium">{p.plan_name}</span>：
            {sortPrices(p.prices)
              .map((x) => `${periodZh(x.period, x.days)} ¥${yuan(x.price_cents)}`)
              .join("，")}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}

function OrdersCard({ onSelect }: { onSelect: (id: string) => void }) {
  const [status, setStatus] = useState<"" | OrderStatus | "unfulfilled">("");
  const [login, setLogin] = useState("");
  const [tradeNo, setTradeNo] = useState("");
  const [cursor, setCursor] = useState<string[]>([]);
  const before = cursor[cursor.length - 1];
  const params = new URLSearchParams();
  if (status === "unfulfilled") params.set("unfulfilled", "true");
  else if (status) params.set("status", status);
  if (login.trim()) params.set("login", login.trim());
  if (tradeNo.trim()) params.set("out_trade_no", tradeNo.trim());
  if (before) params.set("before", before);
  params.set("limit", "50");
  const qs = params.toString();
  const orders = useQuery({
    queryKey: ["orders", qs],
    queryFn: () => get<AdminOrder[]>(`/orders?${qs}`),
    refetchInterval: 10_000,
  });
  const rows = orders.data ?? [];
  const resetPage = () => setCursor([]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>订单</h1>
        </CardTitle>
        <CardDescription>
          金额均为订单创建时的价格；「已付款未开通」表示收到了钱但套餐开通失败，需人工处理。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="order-status">状态</Label>
            <select
              id="order-status"
              className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                resetPage();
              }}
            >
              <option value="">全部</option>
              <option value="pending">待付款</option>
              <option value="paid">已付款</option>
              <option value="unfulfilled">已付款未开通</option>
              <option value="expired">已过期</option>
              <option value="cancelled">已取消</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="order-login">用户名</Label>
            <Input
              id="order-login"
              value={login}
              onChange={(e) => {
                setLogin(e.target.value);
                resetPage();
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="order-no">订单号 / 支付宝交易号</Label>
            <Input
              id="order-no"
              value={tradeNo}
              onChange={(e) => {
                setTradeNo(e.target.value);
                resetPage();
              }}
            />
          </div>
        </div>
        {orders.isError && (
          <p role="alert" className="text-sm text-destructive">
            {errText(orders.error)}
          </p>
        )}
        <div className="overflow-x-auto">
          <Table label="订单列表">
            <TableHeader>
              <TableRow>
                <TableHead>下单时间</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>套餐</TableHead>
                <TableHead>周期</TableHead>
                <TableHead>金额</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>付款方式</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell>{fmt(o.created_at)}</TableCell>
                  <TableCell>{o.user_login}</TableCell>
                  <TableCell>{o.plan_name}</TableCell>
                  <TableCell>{periodZh(o.period, o.period_days)}</TableCell>
                  <TableCell>
                    ¥{yuan(o.amount_cents)}
                    {o.credit_cents > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">（抵扣 ¥{yuan(o.credit_cents)}）</span>
                    )}
                    {o.discount_cents > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        （券 {o.coupon_code} ¥{yuan(o.discount_cents)}）
                      </span>
                    )}
                    {o.balance_cents > 0 && (
                      <span className="ml-1 text-xs text-muted-foreground">（余额 ¥{yuan(o.balance_cents)}）</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={o.status === "paid" ? "default" : "secondary"}>{STATUS_ZH[o.status]}</Badge>
                    {o.status === "paid" && !o.fulfilled_at && (
                      <Badge variant="destructive" className="ml-1">
                        未开通
                      </Badge>
                    )}
                    {o.refunded_at && (
                      <Badge variant="secondary" className="ml-1">
                        已退款
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{o.paid_via ? VIA_ZH[o.paid_via] : "—"}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => onSelect(o.id)}>
                      详情
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    无订单
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={cursor.length === 0}
            onClick={() => setCursor(cursor.slice(0, -1))}
          >
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={rows.length < 50}
            onClick={() => setCursor([...cursor, rows[rows.length - 1].id])}
          >
            下一页
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OrderDetailCard({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const detail = useQuery({ queryKey: ["order-detail", id], queryFn: () => get<OrderDetail>(`/orders/${id}`) });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const o = detail.data?.order;

  async function fulfil() {
    if (!o) return;
    const what = o.status === "paid" ? "重试开通套餐" : "人工确认收款并开通套餐";
    if (!reason.trim()) return setError("请填写原因（写入审计）");
    if (
      !(await confirm({
        title: `${what}：订单 ${o.out_trade_no}，用户 ${o.user_login}，¥${yuan(o.amount_cents)}。确定吗？`,
        confirmLabel: what,
      }))
    )
      return;
    setError(null);
    setBusy(true);
    try {
      const r = await post<{ fulfilled: boolean }>(`/orders/${id}/fulfil`, { reason: reason.trim() });
      if (!r.fulfilled) setError("已记为已付款，但开通失败（见开通错误）");
      setReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["order-detail", id] }),
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
        queryClient.invalidateQueries({ queryKey: ["users"] }),
      ]);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!o) return null;
  const canFulfil = !o.refunded_at && (o.status !== "paid" || !o.fulfilled_at);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>订单详情</h2>
        </CardTitle>
        <CardDescription className="font-mono">{o.out_trade_no}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-muted-foreground">用户</dt>
          <dd>{o.user_login}</dd>
          <dt className="text-muted-foreground">套餐</dt>
          <dd>
            {o.plan_name}（{periodZh(o.period, o.period_days)}）
          </dd>
          <dt className="text-muted-foreground">金额</dt>
          <dd>
            ¥{yuan(o.amount_cents)}
            {o.credit_cents > 0 && `（原价 ¥${yuan(o.list_price_cents)}，换套餐抵扣 ¥${yuan(o.credit_cents)}）`}
          </dd>
          <dt className="text-muted-foreground">原价</dt>
          <dd>¥{yuan(o.list_price_cents)}</dd>
          <dt className="text-muted-foreground">优惠券</dt>
          <dd>{o.coupon_code ? `${o.coupon_code}（-¥${yuan(o.discount_cents)}）` : "—"}</dd>
          <dt className="text-muted-foreground">余额支付</dt>
          <dd>{o.balance_cents > 0 ? `¥${yuan(o.balance_cents)}（${BALANCE_STATE_ZH[o.balance_state]}）` : "—"}</dd>
          <dt className="text-muted-foreground">退款</dt>
          <dd>
            {o.refunded_at
              ? `${fmt(o.refunded_at)} 退回余额 ¥${yuan(o.refund_cents ?? 0)}（${o.refund_reason ?? ""}）`
              : "—"}
          </dd>
          <dt className="text-muted-foreground">实付</dt>
          <dd>{o.paid_amount_cents != null ? `¥${yuan(o.paid_amount_cents)}` : "—"}</dd>
          <dt className="text-muted-foreground">状态</dt>
          <dd>{STATUS_ZH[o.status]}</dd>
          <dt className="text-muted-foreground">付款方式</dt>
          <dd>{o.paid_via ? VIA_ZH[o.paid_via] : "—"}</dd>
          <dt className="text-muted-foreground">支付宝交易号</dt>
          <dd className="font-mono">{o.trade_no ?? "—"}</dd>
          <dt className="text-muted-foreground">下单 / 过期</dt>
          <dd>
            {fmt(o.created_at)} / {fmt(o.expires_at)}
          </dd>
          <dt className="text-muted-foreground">付款时间</dt>
          <dd>{fmt(o.paid_at)}</dd>
          <dt className="text-muted-foreground">开通时间</dt>
          <dd>{fmt(o.fulfilled_at)}</dd>
          <dt className="text-muted-foreground">关单结果</dt>
          <dd>{o.close_state ?? "—"}</dd>
          <dt className="text-muted-foreground">人工原因</dt>
          <dd>{o.manual_reason ?? "—"}</dd>
        </dl>
        {o.fulfil_error && (
          <p role="alert" className="text-sm text-destructive">
            开通错误：{adminMessageText(o.fulfil_error)}
          </p>
        )}
        {o.fulfil_result && (
          <p className="text-sm text-muted-foreground">开通结果：{JSON.stringify(o.fulfil_result)}</p>
        )}
        {canFulfil && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="fulfil-reason">原因（必填，写入审计）</Label>
              <Input id="fulfil-reason" className="w-80" value={reason} onChange={(e) => setReason(e.target.value)} />
            </div>
            <Button size="sm" disabled={busy} onClick={fulfil}>
              {o.status === "paid" ? "重试开通" : "人工确认收款"}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {o.status === "paid" && !o.refunded_at && <RefundForm order={o} />}
        <div className="overflow-x-auto">
          <Table label="支付事件">
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>来源</TableHead>
                <TableHead>验签</TableHead>
                <TableHead>结果</TableHead>
                <TableHead>交易状态</TableHead>
                <TableHead>来源地址</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(detail.data?.events ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{fmt(e.created_at)}</TableCell>
                  <TableCell>{e.source}</TableCell>
                  <TableCell>{e.verified ? "通过" : "未通过"}</TableCell>
                  <TableCell>{e.outcome}</TableCell>
                  <TableCell>{e.trade_status ?? "—"}</TableCell>
                  <TableCell>{e.ip ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          关闭
        </Button>
      </CardContent>
    </Card>
  );
}

// W16: refund a paid order. The balance part always returns to the
// balance; "退到余额" also credits the Alipay amount (otherwise it was
// refunded in the Alipay console). A pending invite commission is reversed;
// the plan is not touched.
function RefundForm({ order: o }: { order: AdminOrder }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [reason, setReason] = useState("");
  const [toBalance, setToBalance] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refund() {
    if (!reason.trim()) return setError("请填写退款原因（写入审计）");
    const back = (o.balance_state === "held" ? o.balance_cents : 0) + (toBalance ? o.amount_cents : 0);
    const how = toBalance ? "支付宝实付部分也退到用户余额" : "支付宝实付部分请在支付宝商家后台退款";
    if (
      !(await confirm({
        title: `退款：订单 ${o.out_trade_no}，退回余额 ¥${yuan(back)}；${how}。套餐不会自动取消。确定吗？`,
        confirmLabel: "退款",
        destructive: true,
      }))
    )
      return;
    setError(null);
    try {
      await post(`/orders/${o.id}/refund`, { reason: reason.trim(), to_balance: toBalance });
      setReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["order-detail", o.id] }),
        queryClient.invalidateQueries({ queryKey: ["orders"] }),
      ]);
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label htmlFor="refund-reason">退款原因（必填，写入审计）</Label>
        <Input id="refund-reason" className="w-80" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={toBalance} onChange={(e) => setToBalance(e.target.checked)} />
        支付宝实付 ¥{yuan(o.amount_cents)} 也退到余额
      </label>
      <Button size="sm" variant="outline" onClick={() => void refund()}>
        退款
      </Button>
      {error && (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
