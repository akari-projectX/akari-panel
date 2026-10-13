import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResultDialog } from '@/components/ui/panels';
import type { MyOrder } from '@/api';
import { useAuth } from '@/lib/auth';
import type { PayOutcome } from '@/lib/shop';
import { formatDate, formatMoney } from '@/lib/format';
import { DUR, useReducedMotion } from '@/lib/motion';
import { R } from '@/lib/routes';
import { useT } from '@/i18n';


/**
 * 付款结果弹窗。订单页轮询到状态变化时打开；余额 / 优惠 / 折算全额抵扣的订单（当场付清、免费订单）
 * 由商店跳到订单页时带上 `state.paid`，订单页一进来就打开——两条路是同一个样子。
 *
 *   成功   对勾描画（圆环 → 对勾）+ 一次性小撒花（lib/confetti，按需加载，约 0.8 秒）+ 金额 / 套餐 / 到期 + 「查看订阅」「返回仪表盘」
 *   退回   付款时套餐开不了（售罄、下架…），款项已退回余额：琥珀色的退回图标弹出，按钮「查看钱包」
 *   超时   时钟轻轻摇两下，说明超过时限、已扣款请提交工单，按钮「重新选购」
 *
 * 系统要求减少动效时：不撒花，对勾直接画好、不摇（index.css 的 reduced-motion 一节）。
 */
export default function PayResult({ order, outcome, onClose }: { order: MyOrder; outcome: PayOutcome | null; onClose: () => void }) {
  const tr = useT();
  const nav = useNavigate();
  const { plan } = useAuth();
  const still = useReducedMotion();
  const mark = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (outcome !== 'success' || still) return;
    let cancelled = false;
    /* 圆环画完、对勾开始落下的那一刻炸开 */
    const t = setTimeout(() => {
      void import('@/lib/confetti').then((m) => {
        if (!cancelled && mark.current) m.default(mark.current, DUR.celebrate * 1000);
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [outcome, still]);

  const go = (to: string) => { onClose(); nav(to); };
  const paid = order.amount_cents + order.balance_cents;
  const expires = plan?.plan?.expires_at;

  if (!outcome) return null;
  const view = {
    success: {
      mark: (
        <span ref={mark} className="result-mark is-success">
          <svg viewBox="0 0 56 56" aria-hidden>
            <circle className="draw-in ring" cx="28" cy="28" r="25" pathLength={1} />
            <path className="draw-in tick" d="M17 29.5l7.5 7.5L39.5 21" pathLength={1} />
          </svg>
        </span>
      ),
      title: tr('支付成功'),
      description: tr('支付成功，套餐已生效'),
      actions: (
        <>
          <Button variant="outline" className="h-10" onClick={() => go(`${R.dashboard}#subscribe`)}>{tr('查看订阅')}</Button>
          <Button className="h-10" onClick={() => go(R.dashboard)}>{tr('返回仪表盘')}</Button>
        </>
      ),
    },
    refunded: {
      mark: <span className="result-mark is-warning"><Undo2 className="size-7" /></span>,
      title: tr('已收到付款'),
      description: tr('付款时套餐已售罄、已下架，或你已经换了别的套餐。款项会退回账户余额，可以用来重新下单或申请提现；有疑问请提交工单。'),
      actions: (
        <>
          <Button variant="outline" className="h-10" onClick={() => go(R.walletTab('ledger'))}>{tr('查看钱包')}</Button>
          <Button className="h-10" onClick={() => go(R.dashboard)}>{tr('返回仪表盘')}</Button>
        </>
      ),
    },
    expired: {
      mark: <span className="result-mark is-muted shake-x"><Clock className="size-7" /></span>,
      title: tr('订单已超时关闭'),
      description: tr('超过支付时限仍未收到付款。如果已经扣款，请提交工单处理'),
      actions: (
        <>
          <Button variant="outline" className="h-10" onClick={() => go(R.dashboard)}>{tr('返回仪表盘')}</Button>
          <Button className="h-10" onClick={() => go(R.shop)}>{tr('重新选购')}</Button>
        </>
      ),
    },
  }[outcome];

  return (
    <ResultDialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      mark={view.mark}
      title={view.title}
      description={view.description}
      actions={view.actions}
    >
      {outcome !== 'expired' && (
        <dl className="result-summary mt-6 rounded-xl bg-muted/60 px-4 text-left text-[13px]">
          <div><dt>{tr('金额')}</dt><dd className="tnum">{formatMoney(paid)}</dd></div>
          <div><dt>{tr('订购套餐')}</dt><dd>{order.plan_name}</dd></div>
          {outcome === 'success' && plan?.plan && (
            <div><dt>{tr('到期时间')}</dt><dd className="tnum">{expires ? formatDate(expires) : tr('长期')}</dd></div>
          )}
        </dl>
      )}
    </ResultDialog>
  );
}
