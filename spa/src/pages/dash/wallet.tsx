import { useMemo, useState } from 'react';
import { ArrowDownToLine, History, Wallet as WalletIcon } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { FlowDialog, FlowFooter } from '@/components/ui/panels';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageTitle, Row, Section, StatRow } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import StatusTag from '@/components/status-tag';
import {
  WITHDRAW_METHODS, inviteApi, walletApi, type LedgerEntry, type LedgerKind, type WithdrawMethod, type WithdrawalStatus,
} from '@/api';
import { useApi, usePending } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import { formatDateTime, formatMoney, parseYuan, signedMoney, type StatusTone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

const LEDGER_TEXT: Record<LedgerKind, string> = {
  commission: '邀请佣金入账',
  admin_adjust: '管理员调整',
  order_payment: '订单支付',
  refund_to_balance: '退款到余额',
  withdrawal: '提现',
  withdrawal_reversal: '提现退回',
  commission_clawback: '佣金追回',
};

const METHOD_TEXT: Record<WithdrawMethod, string> = {
  alipay: '支付宝',
  wechat: '微信',
  bank: '银行卡',
  other: '其他',
};

const W_STATUS: Record<WithdrawalStatus, { text: string; tone: StatusTone }> = {
  pending: { text: '待审核', tone: 'warning' },
  approved: { text: '已打款', tone: 'success' },
  rejected: { text: '已驳回', tone: 'danger' },
  cancelled: { text: '已撤回', tone: 'neutral' },
};

const PAGE = 30;

/**
 * 钱包：面板只有一个余额（佣金入账就进余额，下单可以抵扣），其中「可提现」的部分可以申请提现。
 * 佣金被追回（中-4）时余额可以是负数，下次结算佣金时抵扣——照实显示，不截成 0。
 * 提现记录与申请只对正常账户开放（面板 AuthUser）；过期 / 流量用完的账户仍能看余额和流水。
 */
export default function Wallet() {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const { scope } = useAuth();
  const full = scope === 'full';

  const balance = useApi(() => walletApi.balance({ limit: PAGE }), [], { key: K.balance });
  const withdrawals = useApi(() => walletApi.withdrawals(), [], { key: K.withdrawals, enabled: full });
  const invite = useApi(() => inviteApi.get(), [], { key: K.invite, enabled: full });

  /* 流水按 id 倒序翻页（keyset：before = 已显示的最小 id） */
  const [older, setOlder] = useState<LedgerEntry[]>([]);
  const [more, setMore] = useState(true);
  const [loadingMore, runMore] = usePending();
  const entries = useMemo(() => [...(balance.data?.entries ?? []), ...older], [balance.data, older]);
  const hasMore = more && (balance.data?.entries.length ?? 0) >= PAGE;
  const loadMore = () => runMore(async () => {
    const last = entries[entries.length - 1];
    if (!last) return;
    try {
      const page = await walletApi.balance({ before: last.id, limit: PAGE });
      setOlder((xs) => [...xs, ...page.entries]);
      if (page.entries.length < PAGE) setMore(false);
    } catch (e) {
      toast.error(errText(e));
    }
  });

  const pendingW = (withdrawals.data ?? []).filter((w) => w.status === 'pending');
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<WithdrawMethod>('alipay');
  const [account, setAccount] = useState('');
  const [submitting, runSubmit] = usePending();
  const [cancelling, runCancel] = usePending();
  const cents = parseYuan(amount);
  const withdrawable = balance.data?.withdrawable_cents ?? 0;
  const min = invite.data?.min_withdrawal_cents ?? 0;

  const refresh = () => {
    setOlder([]);
    setMore(true);
    balance.reload();
    withdrawals.reload();
  };

  const submit = () => runSubmit(async () => {
    if (!cents) return;
    try {
      await walletApi.withdraw(cents, method, account.trim());
      setOpen(false);
      setAmount('');
      setAccount('');
      toast.success(tr('提现申请已提交'), { description: tr('金额已从余额扣除，审核通过后打款；撤回或驳回会退回余额') });
      refresh();
    } catch (e) {
      toast.error(errText(e));
    }
  });

  const cancel = (id: string) => runCancel(async () => {
    try {
      await walletApi.cancelWithdrawal(id);
      toast.success(tr('提现申请已撤回'), { description: tr('金额已退回余额') });
      refresh();
    } catch (e) {
      toast.error(errText(e));
      refresh();
    }
  });

  if (balance.loading && !balance.data) return <><PageTitle title={tr('钱包')} /><Loading /></>;
  if (balance.error && !balance.data) return <LoadError error={balance.error} onRetry={balance.reload} className="py-32" />;
  const b = balance.data;

  return (
    <>
      <PageTitle title={tr('钱包')} sub={tr('账户余额、收支流水与提现。余额可以在下单时抵扣。')} />

      <Section>
        <StatRow
          items={[
            {
              k: tr('账户余额'), v: formatMoney(b?.balance_cents),
              x: (b?.balance_cents ?? 0) < 0 ? tr('佣金被追回后为负，之后的佣金会先抵扣它') : tr('下单时可以选择抵扣'),
            },
            { k: tr('可提现'), v: formatMoney(withdrawable), x: min > 0 ? tp('最低提现 {v}', { v: formatMoney(min) }) : tr('佣金过了冻结期即可提现') },
            ...(full ? [{
              k: tr('审核中的提现'), v: formatMoney(pendingW.reduce((n, w) => n + w.amount_cents, 0)),
              x: pendingW.length ? tp('{n} 笔待审核', { n: pendingW.length }) : tr('没有待审核的申请'),
            }] : []),
          ]}
        />
        {full && (
          <div className="mt-8">
            <Button className="h-11 px-6" disabled={withdrawable <= 0 || pendingW.length > 0} onClick={() => setOpen(true)}>
              <ArrowDownToLine />{tr('申请提现')}
            </Button>
            {pendingW.length > 0 && <p className="mt-2 text-[12.5px] text-muted-foreground">{tr('同一时间只能有一笔待审核的提现申请。')}</p>}
          </div>
        )}
      </Section>

      {full && (
        <Section title={<><WalletIcon className="size-4 text-brand" />{tr('提现记录')}</>}>
          {withdrawals.loading && !withdrawals.data ? <Loading rows={2} />
            : withdrawals.error && !withdrawals.data ? <LoadError error={withdrawals.error} onRetry={withdrawals.reload} />
            : (withdrawals.data ?? []).length === 0 ? <Empty title="还没有提现记录" />
            : (
              <>
              {/* 窄屏：一行一笔 */}
              <div className="md:hidden">
                {(withdrawals.data ?? []).map((w, i) => (
                  <Row
                    key={w.id} index={i}
                    title={<span className="tnum">{formatMoney(w.amount_cents)}</span>}
                    desc={`${tr(METHOD_TEXT[w.method])} · ${formatDateTime(w.created_at)}`}
                    extra={
                      <span className="flex items-center gap-2">
                        <StatusTag {...W_STATUS[w.status]} />
                        {w.status === 'pending' && (
                          <Button variant="link" size="xs" disabled={cancelling} onClick={() => cancel(w.id)}>{tr('撤回')}</Button>
                        )}
                      </span>
                    }
                  />
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[640px] text-[14px]">
                  <thead>
                    <tr className="border-b border-border text-[12.5px] text-muted-foreground">
                      <th className="py-3 text-left font-normal">{tr('申请时间')}</th>
                      <th className="py-3 text-left font-normal">{tr('方式')}</th>
                      <th className="py-3 text-left font-normal">{tr('收款账号')}</th>
                      <th className="py-3 text-right font-normal">{tr('金额')}</th>
                      <th className="py-3 pl-6 text-left font-normal">{tr('状态')}</th>
                      <th className="py-3 text-right font-normal">{tr('操作')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(withdrawals.data ?? []).map((w) => (
                      <tr key={w.id} className="border-b border-border last:border-b-0">
                        <td className="tnum py-3.5 whitespace-nowrap text-muted-foreground">{formatDateTime(w.created_at)}</td>
                        <td className="py-3.5">{tr(METHOD_TEXT[w.method])}</td>
                        <td className="max-w-[220px] truncate py-3.5 font-mono text-[13px]">{w.account}</td>
                        <td className="tnum py-3.5 text-right font-medium">{formatMoney(w.amount_cents)}</td>
                        <td className="py-3.5 pl-6">
                          <StatusTag {...W_STATUS[w.status]} />
                          {(w.note || w.payout_reference) && (
                            <div className="mt-1 max-w-[260px] truncate text-[12px] text-muted-foreground">{w.note ?? w.payout_reference}</div>
                          )}
                        </td>
                        <td className="py-3.5 text-right">
                          {w.status === 'pending' && (
                            <Button variant="link" size="xs" disabled={cancelling} onClick={() => cancel(w.id)}>{tr('撤回')}</Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              </>
            )}
        </Section>
      )}

      <Section title={<><History className="size-4 text-brand" />{tr('收支流水')}</>}>
        {entries.length === 0 ? <Empty title="还没有收支记录" desc="佣金入账、余额支付、退款到余额、提现都会记在这里。" />
          : (
            <>
              <div className="md:hidden">
                {entries.map((e, i) => (
                  <Row
                    key={e.id} index={i}
                    title={tr(LEDGER_TEXT[e.kind])}
                    desc={[formatDateTime(e.created_at), e.out_trade_no ?? e.reason ?? ''].filter(Boolean).join(' · ')}
                    extra={
                      <span className="flex flex-col items-end gap-0.5">
                        <span className={cn('tnum font-medium', e.amount_cents < 0 ? 'text-destructive' : 'text-success')}>{signedMoney(e.amount_cents)}</span>
                        <span className="tnum text-[12px] text-muted-foreground">{formatMoney(e.balance_after_cents)}</span>
                      </span>
                    }
                  />
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[560px] text-[14px]">
                  <thead>
                    <tr className="border-b border-border text-[12.5px] text-muted-foreground">
                      <th className="py-3 text-left font-normal">{tr('时间')}</th>
                      <th className="py-3 text-left font-normal">{tr('类型')}</th>
                      <th className="py-3 text-left font-normal">{tr('说明')}</th>
                      <th className="py-3 text-right font-normal">{tr('变动')}</th>
                      <th className="py-3 text-right font-normal">{tr('余额')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => (
                      <tr key={e.id} className="border-b border-border last:border-b-0">
                        <td className="tnum py-3.5 whitespace-nowrap text-muted-foreground">{formatDateTime(e.created_at)}</td>
                        <td className="py-3.5 whitespace-nowrap">{tr(LEDGER_TEXT[e.kind])}</td>
                        <td className="max-w-[260px] truncate py-3.5 text-muted-foreground">
                          {e.out_trade_no ? <code className="text-[12.5px]">{e.out_trade_no}</code> : e.reason ?? ''}
                        </td>
                        <td className={cn('tnum py-3.5 text-right font-medium', e.amount_cents < 0 ? 'text-destructive' : 'text-success')}>
                          {signedMoney(e.amount_cents)}
                        </td>
                        <td className="tnum py-3.5 text-right text-muted-foreground">{formatMoney(e.balance_after_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {hasMore && (
                <div className="mt-5 flex justify-center">
                  <Button variant="outline" size="sm" disabled={loadingMore} onClick={loadMore}>{tr('加载更早的记录')}</Button>
                </div>
              )}
            </>
          )}
      </Section>

      <FlowDialog
        open={open} onOpenChange={setOpen}
        icon={<ArrowDownToLine />}
        title={tr('申请提现')}
        description={tr('提交后金额立即从余额扣除，管理员核对后手动打款')}
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="w-amount">{tr('提现金额（元）')}</Label>
            <Input
              id="w-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder={formatMoney(withdrawable).replace('¥', '')}
            />
            {amount && !cents && <p className="text-[12px] text-destructive">{tr('请输入正确的金额，最多两位小数')}</p>}
            {cents !== null && cents > withdrawable && <p className="text-[12px] text-destructive">{tr('超过了可提现金额')}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="w-method">{tr('收款方式')}</Label>
            <Select value={method} onValueChange={(v) => setMethod(v as WithdrawMethod)}>
              <SelectTrigger id="w-method" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {WITHDRAW_METHODS.map((m) => <SelectItem key={m} value={m}>{tr(METHOD_TEXT[m])}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="w-account">{tr('收款账号')}</Label>
            <Input
              id="w-account" value={account} maxLength={200} onChange={(e) => setAccount(e.target.value)}
              placeholder={tr('账号与实名，例如：138xxxx 张三')}
            />
          </div>
        </div>
        <FlowFooter summary={<>{tr('可提现')} <b className="tnum text-[15px] font-normal text-foreground">{formatMoney(withdrawable)}</b></>}>
          <Button variant="outline" onClick={() => setOpen(false)}>{tr('取消')}</Button>
          <Button disabled={submitting || !cents || cents > withdrawable || !account.trim()} onClick={submit}>
            {submitting ? tr('提交中') : tr('提交申请')}
          </Button>
        </FlowFooter>
      </FlowDialog>
    </>
  );
}
