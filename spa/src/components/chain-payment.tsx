import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { AlertTriangle, Check, CircleCheck, Clock, Copy, Loader2 } from 'lucide-react';
import type { ChainNetwork, ChainPay } from '@/api';
import { useCopy } from '@/hooks/use-copy';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

/** 网络的显示名（与面板 billing::chain::CHAINS 一致） */
const CHAIN_NAME: Record<ChainNetwork, string> = { polygon: 'Polygon (PoS)', plasma: 'Plasma' };

const chainName = (c: ChainNetwork) => CHAIN_NAME[c] ?? c;

/** 识别订单用的尾数：6 位小数里的最后 4 位 */
const SUFFIX = 4;

/** 每秒走一次的「现在」（倒计时用；只在组件挂着时走） */
function useNow(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/**
 * USDT 链上付款（订单待支付时）：网络提醒、精确金额（识别尾数突出显示）、共用的收款地址（可复制、二维码）、
 * 倒计时，以及看到的转账与确认数。收款地址是这个支付方式所有订单共用的，面板只按「精确金额」认出是哪一单——
 * 所以文案说的是「金额最后几位识别你的订单」，不说「这个地址只给这一单」。
 */
export default function ChainPayment({ pay, expiresAt }: { pay: ChainPay; expiresAt: string }) {
  const tr = useT();
  const tp = useTp();
  const [copied, copy] = useCopy<'amount' | 'address'>(1600);
  const net = chainName(pay.chain);
  const head = pay.amount.slice(0, -SUFFIX);
  const tail = pay.amount.slice(-SUFFIX);
  const now = useNow(true);
  const left = new Date(expiresAt).getTime() - now;

  return (
    <div className="flex flex-col gap-5">
      <div role="note" className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-[13px] leading-[1.8] text-warning">
        <AlertTriangle className="mt-1 size-4 shrink-0" />
        <span>{tp('只能通过 {n} 网络转 USDT。转到其他网络、或转其他代币，都无法到账。', { n: net })}</span>
      </div>

      <div>
        <div className="text-[12.5px] text-muted-foreground">{tr('转账金额（USDT）')}</div>
        <div className="mt-1 flex items-center gap-2">
          <span data-testid="chain-amount" className="tnum font-mono text-[26px] leading-none font-medium tracking-[-0.02em]">
            {head}<span className="rounded-md bg-brand/12 px-0.5 text-brand">{tail}</span>
          </span>
          <button
            type="button" aria-label={tr('复制金额')} onClick={() => copy(pay.amount, 'amount')}
            className="hit-44 text-muted-foreground transition-colors hover:text-brand"
          >
            {copied === 'amount' ? <Check className="pop-in size-4 text-success" /> : <Copy className="size-4" />}
          </button>
        </div>
        <p className="mt-2 text-[12.5px] leading-[1.8] text-muted-foreground">
          {tp('金额的最后 {k} 位小数用来识别你的订单，请一分不差地转账（含尾数）。从交易所提币时，请确认扣除手续费后到账的仍是这个数。', { k: SUFFIX })}
        </p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-muted-foreground">{tp('收款地址（{n}）', { n: net })}</div>
          <div className="mt-1 flex items-start gap-2">
            <code data-testid="chain-address" className="min-w-0 font-mono text-[13px] leading-[1.7] break-all">{pay.address}</code>
            <button
              type="button" aria-label={tr('复制收款地址')} onClick={() => copy(pay.address, 'address')}
              className="hit-44 shrink-0 text-muted-foreground transition-colors hover:text-brand"
            >
              {copied === 'address' ? <Check className="pop-in size-4 text-success" /> : <Copy className="size-4" />}
            </button>
          </div>
          <p className="mt-2 text-[12px] leading-[1.7] text-muted-foreground">
            {tr('这是本站共用的收款地址，订单按上面的精确金额识别。')}
          </p>
          <p className="mt-1 text-[12px] leading-[1.7] break-all text-muted-foreground">
            {tp('USDT 合约：{c}', { c: pay.token })}
          </p>
        </div>
        <div className="self-center rounded-2xl bg-white p-3 sm:self-start">
          {/* 只有地址：多数钱包与交易所不认带金额的链接，金额要照抄 */}
          <QRCodeSVG value={pay.address} size={132} level="M" fgColor="#0d1526" bgColor="#ffffff" marginSize={0} aria-label={tr('收款地址二维码')} />
        </div>
      </div>

      <div className="flex items-start gap-2 text-[12.5px] leading-[1.8] text-muted-foreground">
        <Clock className="mt-1 size-3.5 shrink-0" />
        <span>
          {left > 0
            ? <>{tr('剩余时间')} <span data-testid="chain-countdown" className="tnum font-medium text-foreground">{mmss(left)}</span></>
            : tr('订单即将超时')}
          <span className="block">{tp('超时后订单会关闭，但 {t} 前到账的这笔金额仍会自动开通。', { t: formatDateTime(pay.reserved_until) })}</span>
        </span>
      </div>

      <ChainStatus pay={pay} />
    </div>
  );
}

/** 链上进度：等待转账 → 已收到 → 确认中 x/N → 已确认 */
export function ChainStatus({ pay, className }: { pay: ChainPay; className?: string }) {
  const tr = useT();
  const tp = useTp();
  const t = pay.transfer;
  const need = pay.confirmations_required;
  const have = t ? Math.min(t.confirmations, need) : 0;
  return (
    <div role="status" data-testid="chain-status" className={cn('rounded-xl border border-border px-4 py-3 text-[13px] leading-[1.8]', className)}>
      {!t ? (
        <div className="flex items-start gap-2">
          <Loader2 className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground" />
          <span className="text-muted-foreground">
            {tp('等待转账。到账并达到 {n} 个确认后自动开通，本页会自己更新。', { n: need })}
          </span>
        </div>
      ) : t.status === 'pending' ? (
        <div className="flex items-start gap-2">
          <Loader2 className="mt-1 size-4 shrink-0 animate-spin text-brand" />
          <div className="min-w-0 flex-1">
            <div>{tp('已收到转账，确认中 {c}/{n}', { c: have, n: need })}</div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div className="h-full origin-left rounded-full bg-brand transition-transform duration-200" style={{ transform: `scaleX(${have / need})` }} />
            </div>
            <div className="mt-1 text-[12px] break-all text-muted-foreground">{tp('交易 {h}', { h: t.tx_hash })}</div>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <CircleCheck className="mt-1 size-4 shrink-0 text-success" />
          <span>{tr('转账已确认')}</span>
        </div>
      )}
    </div>
  );
}

/**
 * 订单已超时 / 取消、还没看到转账：说清楚接下来怎么办。保留期（reserved_until）内到账的这笔金额仍会开通；
 * 还没转的不要再转这个金额，重新下单会拿到新的金额；过了保留期再转的，要找客服。
 */
export function ChainLateNote({ pay }: { pay: ChainPay }) {
  const tr = useT();
  const tp = useTp();
  const now = useNow(false);
  const open = new Date(pay.reserved_until).getTime() > now;
  return (
    <div data-testid="chain-late" className="flex flex-col gap-2 text-[13px] leading-[1.8]">
      {open ? (
        <>
          <p>{tp('如果你已经按这个金额转了账：{t} 前到账的仍会自动开通，不用做任何事，本页会自己更新。', { t: formatDateTime(pay.reserved_until) })}</p>
          <p className="text-muted-foreground">{tr('还没转账：请不要再转这个金额，回商店重新下单，新订单会给你新的金额。')}</p>
        </>
      ) : (
        <p className="text-muted-foreground">{tr('这个金额的保留期已过。如果你在此之后才转账，请提交工单，附上交易哈希。')}</p>
      )}
    </div>
  );
}
