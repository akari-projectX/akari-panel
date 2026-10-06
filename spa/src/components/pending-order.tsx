import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import { orderApi, type MyOrder } from '@/api';
import { usePending } from '@/hooks/use-api';
import { useErrorText } from '@/lib/errors';
import { formatMoney, formatTime, periodText } from '@/lib/format';
import { R } from '@/lib/routes';
import { cn } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

/**
 * 待支付订单的提醒条：「去支付 / 取消订单」。放在仪表盘与商店的页头下面；compact 用在下单弹窗里。
 * 截止时间是面板订单的 expires_at（超时没付会被自动关闭）。
 */
export default function OpenOrderNotice({
  order, onChanged, compact, className,
}: { order: MyOrder; onChanged?: () => void; compact?: boolean; className?: string }) {
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const nav = useNavigate();
  const [cancelling, run] = usePending();
  /* 挂载时取一次「现在」就够：这条提醒不需要秒级倒计时，进订单页才有 */
  const [now] = useState(() => Date.now());
  const expired = new Date(order.expires_at).getTime() <= now;

  const cancel = () => run(async () => {
    try {
      await orderApi.cancel(order.id);
      toast.success(tr('订单已取消'));
      onChanged?.();
    } catch (e) {
      toast.error(errText(e));
      onChanged?.();
    }
  });

  const summary = [order.plan_name, periodText(order.period, order.period_days, tr, tp), formatMoney(order.amount_cents)].join(' · ');

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl bg-amber-500/[.08] dark:bg-amber-500/[.12]',
        compact ? 'px-4 py-3.5' : 'px-5.5 py-4',
        className,
      )}
    >
      <Clock className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className={cn('font-medium', compact ? 'text-[13.5px]' : 'text-[14.5px]')}>{tr('你有一笔待支付的订单')}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-muted-foreground">
          {summary}
          {' · '}
          {expired ? tr('即将自动关闭') : tp('{t} 前未支付将自动关闭', { t: formatTime(order.expires_at) })}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="ghost" disabled={cancelling} onClick={cancel} className="text-muted-foreground">
          {tr('取消订单')}
        </Button>
        <Button size="sm" onClick={() => nav(R.order(order.id))}>{tr('去支付')}</Button>
      </div>
    </div>
  );
}
