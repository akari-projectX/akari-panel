import { useMemo, useState } from 'react';
import { ArrowDownToLine, Check, Copy, History, Wallet as WalletIcon } from 'lucide-react';
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
  inviteApi, walletApi, type LedgerEntry, type LedgerKind, type UsdtChain, type Withdrawal, type WithdrawalStatus,
} from '@/api';
import { useCopy } from '@/hooks/use-copy';
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

/** USDT 网络的显示名（历史记录里可能出现后台后来关掉的网络，所以不只靠 /me/invite 给的那份） */
const CHAIN_NAME: Record<UsdtChain, string> = {
  trc20: 'TRC20 (Tron)',
  plasma: 'Plasma',
  polygon: 'Polygon',
  arbitrum: 'Arbitrum One',
  solana: 'Solana',
  xlayer: 'X Layer',
  ton: 'TON',
};

/** 每个网络的地址格式提示（面板按网络严格校验，这里只帮用户别填错网络） */
const ADDRESS_HINT: Record<UsdtChain, { hint: string; placeholder: string }> = {
  trc20: { hint: 'T 开头的 34 位 Tron 地址', placeholder: 'T…' },
  plasma: { hint: '0x 开头的 42 位地址（EVM）', placeholder: '0x…' },
  polygon: { hint: '0x 开头的 42 位地址（EVM）', placeholder: '0x…' },
  arbitrum: { hint: '0x 开头的 42 位地址（EVM）', placeholder: '0x…' },
  xlayer: { hint: '0x 开头的 42 位地址（EVM）', placeholder: '0x…' },
  solana: { hint: 'Base58 编码的 Solana 地址（32–44 位）', placeholder: '' },
  ton: { hint: 'TON 地址（UQ / EQ 开头）；转到交易所时请填写 Memo', placeholder: 'UQ…' },
};

const chainName = (c: string) => CHAIN_NAME[c as UsdtChain] ?? c;

/** 参考折合 USDT（只用于显示，两位小数）；没设参考汇率为 null */
function usdtEstimate(cents: number, rateCents: number | null | undefined): string | null {
  return rateCents && rateCents > 0 ? (cents / rateCents).toFixed(2) : null;
}

/** 长地址 / 交易哈希：等宽、中间省略，带复制按钮 */
function Mono({ value, label }: { value: string; label: string }) {
  const tr = useT();
  const [copied, copy] = useCopy(1800);
  const short = value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
  return (
    <span className="inline-flex max-w-full items-center gap-1 font-mono text-[12.5px]">
      <span title={value} className="truncate">{short}</span>
      <button
        type="button" aria-label={`${tr('复制')} ${tr(label)}`}
        onClick={() => void copy(value, value)}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        {copied === value ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </span>
  );
}

/** 一笔提现的去向与结果：网络 + 地址（+ Memo），通过后是实付 USDT 与交易哈希 */
function WithdrawalDetail({ w }: { w: Withdrawal }) {
  const tr = useT();
  return (
    <span className="flex min-w-0 flex-col gap-0.5 text-[12.5px] text-muted-foreground">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-foreground">{chainName(w.chain)}</span>
        <Mono value={w.address} label="收款地址" />
      </span>
      {w.memo && <span>Memo <span className="font-mono">{w.memo}</span></span>}
      {w.usdt_amount && <span className="tnum">{tr('实付')} {w.usdt_amount} USDT</span>}
      {w.txid && <span className="flex min-w-0 items-center gap-1.5">{tr('交易哈希')} <Mono value={w.txid} label="交易哈希" /></span>}
      {w.note && <span className="max-w-[320px] truncate">{w.note}</span>}
    </span>
  );
}

const W_STATUS: Record<WithdrawalStatus, { text: string; tone: StatusTone }> = {
  pending: { text: '待审核', tone: 'warning' },
  approved: { text: '已打款', tone: 'success' },
  rejected: { text: '已驳回', tone: 'danger' },
  cancelled: { text: '已撤回', tone: 'neutral' },
};

const PAGE = 30;

/**
 * 钱包：面板只有一个余额（佣金入账就进余额，下单可以抵扣），其中「可提现」的部分可以申请提现。
 * 佣金被追回（中-4）时余额够就当场扣回，不够只扣到 0，差额记为欠款，之后的佣金入账时先抵扣（余额本身永不为负）。
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
  const chains = invite.data?.usdt_chains ?? [];
  const [picked, setChain] = useState<UsdtChain | null>(null);
  const chain = picked && chains.some((c) => c.id === picked) ? picked : chains[0]?.id ?? null;
  const [address, setAddress] = useState('');
  const [memo, setMemo] = useState('');
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
    if (!cents || !chain) return;
    try {
      await walletApi.withdraw({
        amount_cents: cents, chain, address: address.trim(),
        ...(chain === 'ton' && memo.trim() ? { memo: memo.trim() } : {}),
      });
      setOpen(false);
      setAmount('');
      setAddress('');
      setMemo('');
      toast.success(tr('提现申请已提交'), { description: tr('金额已从余额扣除，审核通过后以 USDT 打款；撤回或驳回会退回余额') });
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
              x: tr('下单时可以选择抵扣'),
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
            <Button className="h-11 px-6" disabled={withdrawable <= 0 || pendingW.length > 0 || chains.length === 0} onClick={() => setOpen(true)}>
              <ArrowDownToLine />{tr('申请提现')}
            </Button>
            {pendingW.length > 0 && <p className="mt-2 text-[12.5px] text-muted-foreground">{tr('同一时间只能有一笔待审核的提现申请。')}</p>}
            {invite.data && chains.length === 0 && <p className="mt-2 text-[12.5px] text-muted-foreground">{tr('暂未开放提现。')}</p>}
            <p className="mt-2 text-[12.5px] text-muted-foreground">{tr('提现以 USDT 打款到你填写的链上地址。')}</p>
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
                    desc={<><span className="tnum">{formatDateTime(w.created_at)}</span><WithdrawalDetail w={w} /></>}
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
                      <th className="py-3 text-left font-normal">{tr('收款地址')}</th>
                      <th className="py-3 text-right font-normal">{tr('金额')}</th>
                      <th className="py-3 pl-6 text-left font-normal">{tr('状态')}</th>
                      <th className="py-3 text-right font-normal">{tr('操作')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(withdrawals.data ?? []).map((w) => (
                      <tr key={w.id} className="border-b border-border last:border-b-0">
                        <td className="tnum py-3.5 whitespace-nowrap text-muted-foreground">{formatDateTime(w.created_at)}</td>
                        <td className="max-w-[320px] py-3.5"><WithdrawalDetail w={w} /></td>
                        <td className="tnum py-3.5 text-right font-medium">{formatMoney(w.amount_cents)}</td>
                        <td className="py-3.5 pl-6">
                          <StatusTag {...W_STATUS[w.status]} />
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
        description={tr('提交后金额立即从余额扣除，管理员核对后以 USDT 打款到你的地址')}
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
            {cents !== null && cents > 0 && usdtEstimate(cents, invite.data?.usdt_rate_cents) && (
              <p className="tnum text-[12px] text-muted-foreground">
                {tp('约 {v} USDT（按参考汇率，以实际打款为准）', { v: usdtEstimate(cents, invite.data?.usdt_rate_cents) ?? '' })}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="w-chain">{tr('USDT 网络')}</Label>
            <Select value={chain ?? ''} onValueChange={(v) => setChain(v as UsdtChain)}>
              <SelectTrigger id="w-chain" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {chains.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[12px] text-muted-foreground">{tr('网络选错资金无法找回：请和收款方（钱包或交易所充值页）显示的网络保持一致。')}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="w-address">{tr('收款地址')}</Label>
            <Input
              id="w-address" value={address} maxLength={200} spellCheck={false} autoComplete="off"
              className="font-mono text-[13px]" onChange={(e) => setAddress(e.target.value)}
              placeholder={chain ? ADDRESS_HINT[chain].placeholder : ''}
            />
            {chain && <p className="text-[12px] text-muted-foreground">{tr(ADDRESS_HINT[chain].hint)}</p>}
          </div>
          {chain === 'ton' && (
            <div className="space-y-2">
              <Label htmlFor="w-memo">{tr('Memo（选填）')}</Label>
              <Input id="w-memo" value={memo} maxLength={120} spellCheck={false} autoComplete="off" onChange={(e) => setMemo(e.target.value)} />
            </div>
          )}
        </div>
        <FlowFooter summary={<>{tr('可提现')} <b className="tnum text-[15px] font-normal text-foreground">{formatMoney(withdrawable)}</b></>}>
          <Button variant="outline" onClick={() => setOpen(false)}>{tr('取消')}</Button>
          <Button disabled={submitting || !cents || cents > withdrawable || !chain || !address.trim()} onClick={submit}>
            {submitting ? tr('提交中') : tr('提交申请')}
          </Button>
        </FlowFooter>
      </FlowDialog>
    </>
  );
}
