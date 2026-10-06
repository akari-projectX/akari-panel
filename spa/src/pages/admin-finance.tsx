// W16 后台（仅中文）：资金。邀请返利设置、提现审核（R46：只付 USDT——在交易所
// 人工打款后填写实付 USDT 与交易哈希通过，或填写原因拒绝——金额退回余额）、返利记录、用户余额与余额明细、
// 人工调整余额（必须填写原因，写审计）。所有金额为整数分，界面换算为元。
import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { get, post, put } from "../lib/api";
import {
  parseYuan,
  signedYuan,
  yuan,
  type BalanceRow,
  type Commission,
  type CommissionSettings,
  type CommissionStatus,
  type LedgerKind,
  type UserBalance,
  type Withdrawal,
  type WithdrawalStatus,
  type UsdtChain,
  USDT_CHAINS,
  chainName,
  usdtEstimate,
} from "../lib/billing";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDateTime } from "../lib/datetime";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

const fmt = (s: string | null) => fmtDateTime(s);
const errText = (err: unknown) => (err instanceof Error ? adminErrorText(err) : "失败");

export const LEDGER_ZH: Record<LedgerKind, string> = {
  commission: "邀请返利",
  admin_adjust: "人工调整",
  order_payment: "订单支付",
  refund_to_balance: "退回余额",
  withdrawal: "提现",
  withdrawal_reversal: "提现退回",
  commission_clawback: "返利追回",
};
const W_STATUS_ZH: Record<WithdrawalStatus, string> = {
  pending: "待审核",
  approved: "已打款",
  rejected: "已拒绝",
  cancelled: "用户撤销",
};
const C_STATUS_ZH: Record<CommissionStatus, string> = { pending: "冻结中", credited: "已入账", reversed: "已撤销" };

export function AdminFinance() {
  return (
    <div className="space-y-6">
      <WithdrawalsCard />
      <BalancesCard />
      <CommissionsCard />
      <SettingsCard />
    </div>
  );
}

function SettingsCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["commission-settings"],
    queryFn: () => get<CommissionSettings>("/commission-settings"),
  });
  const [form, setForm] = useState({
    enabled: false,
    rate: "",
    hold: "",
    min: "",
    first: true,
    chains: [] as UsdtChain[],
    usdtRate: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const s = settings.data;
    if (s)
      setForm({
        enabled: s.enabled,
        rate: String(s.rate_percent),
        hold: String(s.hold_days),
        min: yuan(s.min_withdrawal_cents),
        first: s.first_order_only,
        chains: s.usdt_chains,
        usdtRate: s.usdt_rate_cents == null ? "" : yuan(s.usdt_rate_cents),
      });
  }, [settings.data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const rate = /^\d{1,3}$/.test(form.rate.trim()) ? Number(form.rate) : NaN;
    const hold = /^\d{1,3}$/.test(form.hold.trim()) ? Number(form.hold) : NaN;
    const min = parseYuan(form.min);
    if (!(rate >= 0 && rate <= 100)) return setError("返利比例须为 0–100 的整数");
    if (!(hold >= 0 && hold <= 365)) return setError("冻结天数须为 0–365 的整数");
    if (min == null) return setError("最低提现金额无效（元，最多两位小数）");
    const usdtRate = form.usdtRate.trim() ? parseYuan(form.usdtRate) : null;
    if (form.usdtRate.trim() && !usdtRate) return setError("参考汇率无效（每 1 USDT 多少元，最多两位小数）");
    setError(null);
    try {
      await put("/commission-settings", {
        enabled: form.enabled,
        rate_percent: rate,
        first_order_only: form.first,
        hold_days: hold,
        min_withdrawal_cents: min,
        usdt_chains: form.chains,
        usdt_rate_cents: usdtRate,
      });
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ["commission-settings"] });
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>邀请返利设置</h2>
        </CardTitle>
        <CardDescription>
          被邀请用户付款后，按订单的支付宝实付金额（不含优惠券、换套餐抵扣与余额部分）计算返利，冻结期满后计入邀请人余额；
          冻结期内退款则撤销。修改只影响之后付款的订单。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={save}>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            启用邀请返利
          </label>
          <div className="space-y-1">
            <Label htmlFor="s-rate">返利比例（%）</Label>
            <Input
              id="s-rate"
              className="w-24"
              value={form.rate}
              onChange={(e) => setForm({ ...form, rate: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="s-hold">冻结天数</Label>
            <Input
              id="s-hold"
              className="w-24"
              value={form.hold}
              onChange={(e) => setForm({ ...form, hold: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="s-min">最低提现（元）</Label>
            <Input
              id="s-min"
              className="w-28"
              value={form.min}
              onChange={(e) => setForm({ ...form, min: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.first}
              onChange={(e) => setForm({ ...form, first: e.target.checked })}
            />
            仅首单返利
          </label>
          <fieldset className="flex flex-wrap items-center gap-3 text-sm">
            <legend className="mb-1 text-sm">提现网络（USDT）</legend>
            {USDT_CHAINS.map((c) => (
              <label key={c.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={form.chains.includes(c.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      chains: e.target.checked ? [...form.chains, c.id] : form.chains.filter((x) => x !== c.id),
                    })
                  }
                />
                {c.name}
              </label>
            ))}
          </fieldset>
          <div className="space-y-1">
            <Label htmlFor="s-usdt-rate">参考汇率（元/USDT，可空）</Label>
            <Input
              id="s-usdt-rate"
              className="w-28"
              value={form.usdtRate}
              onChange={(e) => setForm({ ...form, usdtRate: e.target.value })}
            />
          </div>
          <Button type="submit" size="sm">
            保存设置
          </Button>
        </form>
        {saved && (
          <p role="status" className="mt-2 text-sm text-muted-foreground">
            已保存
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function WithdrawalsCard() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [status, setStatus] = useState<"" | WithdrawalStatus>("pending");
  const list = useQuery({
    queryKey: ["withdrawals", status],
    queryFn: () => get<Withdrawal[]>(status ? `/withdrawals?status=${status}` : "/withdrawals"),
    refetchInterval: 15_000,
  });
  const settings = useQuery({
    queryKey: ["commission-settings"],
    queryFn: () => get<CommissionSettings>("/commission-settings"),
  });
  const rate = settings.data?.usdt_rate_cents ?? null;
  const [ref, setRef] = useState<Record<string, string>>({});
  const [usdt, setUsdt] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function decide(w: Withdrawal, approve: boolean) {
    setError(null);
    const text = (ref[w.id] ?? "").trim();
    const sent = (usdt[w.id] ?? "").trim();
    if (approve && !sent) return setError("请先填写实付 USDT 数量");
    if (!text) return setError(approve ? "请先填写交易哈希（txid）" : "请先填写拒绝原因");
    const what = approve
      ? `确认已在 ${chainName(w.chain)} 上向 ${w.address} 支付 ${sent} USDT（申请 ¥${yuan(w.amount_cents)}）？`
      : `拒绝并退回 ¥${yuan(w.amount_cents)} 到余额？`;
    if (!(await confirm({ title: what, confirmLabel: approve ? "确认已打款" : "拒绝", destructive: !approve }))) return;
    try {
      if (approve) await post(`/withdrawals/${w.id}/approve`, { usdt_amount: sent, txid: text });
      else await post(`/withdrawals/${w.id}/reject`, { reason: text });
      setRef({ ...ref, [w.id]: "" });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["withdrawals"] }),
        queryClient.invalidateQueries({ queryKey: ["balances"] }),
      ]);
    } catch (err) {
      setError(errText(err));
    }
  }

  const rows = list.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>提现审核</h1>
        </CardTitle>
        <CardDescription>
          用户申请时金额（人民币）已从余额扣出。提现只付 USDT：请核对网络与地址，在交易所（如 OKX）人工打款后，填写实付
          USDT 数量与交易哈希通过（写入审计）；拒绝会把金额退回用户余额。收款地址只对用户本人与管理员可见。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="w-status">状态</Label>
          <select
            id="w-status"
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="pending">待审核</option>
            <option value="approved">已打款</option>
            <option value="rejected">已拒绝</option>
            <option value="cancelled">用户撤销</option>
            <option value="">全部</option>
          </select>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="overflow-x-auto">
          <Table label="提现申请">
            <TableHeader>
              <TableRow>
                <TableHead>申请时间</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>金额</TableHead>
                <TableHead>网络与地址</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>凭证 / 原因</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>{fmt(w.created_at)}</TableCell>
                  <TableCell>{w.user_email ?? w.user_label}</TableCell>
                  <TableCell>
                    ¥{yuan(w.amount_cents)}
                    {usdtEstimate(w.amount_cents, rate) && (
                      <span className="block text-xs text-muted-foreground">
                        参考 ≈ {usdtEstimate(w.amount_cents, rate)} USDT
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">
                    {chainName(w.chain)}
                    <span className="block break-all font-mono">{w.address}</span>
                    {w.memo && <span className="block">Memo：{w.memo}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={w.status === "approved" ? "default" : "secondary"}>{W_STATUS_ZH[w.status]}</Badge>
                  </TableCell>
                  <TableCell>
                    {w.status === "pending" ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <Input
                          aria-label={`提现 ${w.user_email ?? w.user_label} 的实付 USDT`}
                          placeholder="实付 USDT"
                          inputMode="decimal"
                          className="w-28"
                          value={usdt[w.id] ?? ""}
                          onChange={(e) => setUsdt({ ...usdt, [w.id]: e.target.value })}
                        />
                        <Input
                          aria-label={`提现 ${w.user_email ?? w.user_label} 的交易哈希或拒绝原因`}
                          placeholder="交易哈希 / 拒绝原因"
                          className="w-56"
                          value={ref[w.id] ?? ""}
                          onChange={(e) => setRef({ ...ref, [w.id]: e.target.value })}
                        />
                        <Button size="sm" onClick={() => void decide(w, true)}>
                          已打款
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void decide(w, false)}>
                          拒绝
                        </Button>
                      </div>
                    ) : (
                      <span className="text-xs">
                        {w.txid ? `${w.usdt_amount} USDT · ${w.txid}` : (w.note ?? "—")}
                        {w.decided_by && `（${w.decided_by}，${fmt(w.decided_at)}）`}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                    没有提现申请
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function BalancesCard() {
  const [email, setEmail] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["balances", search],
    queryFn: () => get<BalanceRow[]>(search ? `/balances?email=${encodeURIComponent(search)}` : "/balances"),
  });
  const rows = list.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>用户余额</h2>
        </CardTitle>
        <CardDescription>余额 = 余额明细之和，且不会为负；人工调整须填写原因并写入审计。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(email.trim());
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="b-email">用户邮箱（精确）</Label>
            <Input id="b-email" className="w-48" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Button type="submit" size="sm" variant="outline">
            查找
          </Button>
        </form>
        <div className="overflow-x-auto">
          <Table label="用户余额">
            <TableHeader>
              <TableRow>
                <TableHead>用户</TableHead>
                <TableHead>余额</TableHead>
                <TableHead>最近变动</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.user_id}>
                  <TableCell>{b.email}</TableCell>
                  <TableCell>¥{yuan(b.balance_cents)}</TableCell>
                  <TableCell>{fmt(b.updated_at)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" onClick={() => setSelected(b.user_id)}>
                      明细与调整
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    {search ? "没有这个用户" : "还没有用户有余额"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {selected && <LedgerPanel id={selected} onClose={() => setSelected(null)} />}
      </CardContent>
    </Card>
  );
}

function LedgerPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const data = useQuery({ queryKey: ["user-balance", id], queryFn: () => get<UserBalance>(`/users/${id}/balance`) });
  const [sign, setSign] = useState<"+" | "-">("+");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const b = data.data;
  if (!b) return null;

  async function adjust(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    const cents = parseYuan(amount);
    if (cents == null) return setError("金额无效（元，最多两位小数）");
    if (!reason.trim()) return setError("请填写原因（写入审计）");
    const signed = sign === "+" ? cents : -cents;
    if (
      !(await confirm({
        title: `${b?.email} 余额 ${signedYuan(signed)} 元，原因：${reason.trim()}。确定吗？`,
        confirmLabel: "确认调整",
      }))
    )
      return;
    setError(null);
    try {
      await post(`/users/${id}/balance`, { amount_cents: signed, reason: reason.trim() });
      setAmount("");
      setReason("");
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["user-balance", id] }),
        queryClient.invalidateQueries({ queryKey: ["balances"] }),
      ]);
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="text-sm font-medium">
        {b.email}：余额 ¥{yuan(b.balance_cents)}，可提现 ¥{yuan(b.withdrawable_cents)}
      </p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={adjust}>
        <div className="space-y-1">
          <Label htmlFor="a-sign">方向</Label>
          <select
            id="a-sign"
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
            value={sign}
            onChange={(e) => setSign(e.target.value as "+" | "-")}
          >
            <option value="+">增加</option>
            <option value="-">扣减</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="a-amount">调整金额（元）</Label>
          <Input id="a-amount" className="w-28" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="a-reason">调整原因（必填）</Label>
          <Input id="a-reason" className="w-64" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button type="submit" size="sm">
          调整余额
        </Button>
      </form>
      {saved && (
        <p role="status" className="text-sm text-muted-foreground">
          余额已调整
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="overflow-x-auto">
        <Table label="余额明细">
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>金额</TableHead>
              <TableHead>变动后</TableHead>
              <TableHead>关联 / 原因</TableHead>
              <TableHead>操作人</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {b.entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{fmt(e.created_at)}</TableCell>
                <TableCell>{LEDGER_ZH[e.kind]}</TableCell>
                <TableCell className={e.amount_cents < 0 ? "text-destructive" : ""}>
                  ¥{signedYuan(e.amount_cents)}
                </TableCell>
                <TableCell>¥{yuan(e.balance_after_cents)}</TableCell>
                <TableCell className="text-xs">
                  {[e.out_trade_no, e.reason].filter(Boolean).join(" · ") || "—"}
                </TableCell>
                <TableCell>{e.actor_label}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <Button size="sm" variant="ghost" onClick={onClose}>
        关闭
      </Button>
    </div>
  );
}

function CommissionsCard() {
  const [status, setStatus] = useState<"" | CommissionStatus>("");
  const list = useQuery({
    queryKey: ["commissions", status],
    queryFn: () => get<Commission[]>(status ? `/commissions?status=${status}` : "/commissions"),
  });
  const rows = list.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>返利记录</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label htmlFor="c-status">状态</Label>
          <select
            id="c-status"
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm"
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="">全部</option>
            <option value="pending">冻结中</option>
            <option value="credited">已入账</option>
            <option value="reversed">已撤销</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <Table label="返利记录">
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>邀请人</TableHead>
                <TableHead>被邀请人</TableHead>
                <TableHead>订单</TableHead>
                <TableHead>实付</TableHead>
                <TableHead>返利</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>入账时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{fmt(c.created_at)}</TableCell>
                  <TableCell>{c.inviter_email ?? c.inviter_label}</TableCell>
                  <TableCell>{c.invitee_email ?? c.invitee_label}</TableCell>
                  <TableCell className="font-mono text-xs">{c.out_trade_no}</TableCell>
                  <TableCell>¥{yuan(c.base_cents)}</TableCell>
                  <TableCell>
                    ¥{yuan(c.amount_cents)}（{c.rate_percent}%）
                  </TableCell>
                  <TableCell>
                    {C_STATUS_ZH[c.status]}
                    {c.reverse_reason && <span className="ml-1 text-xs text-muted-foreground">{c.reverse_reason}</span>}
                  </TableCell>
                  <TableCell>{fmt(c.status === "credited" ? c.credited_at : c.available_at)}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                    暂无返利
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
