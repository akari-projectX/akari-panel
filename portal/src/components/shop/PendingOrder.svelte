<script lang="ts">
  import Clock from '@lucide/svelte/icons/clock';
  import { orderApi, type MyOrder } from '@/api';
  import { formatMoney, formatTime, periodText } from '@/lib/format';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 待支付订单的提醒细行：「取消订单 / 去支付」。商店页头下面一条，
   * 确认订单对话框里也有一条（有这样一笔订单时面板拒绝再下新单，order.in_progress）。截止时间 = 订单的 expires_at。
   */
  let { order, onchange, compact = false, className }: { order: MyOrder; onchange: () => void; compact?: boolean; className?: string } = $props();

  const cancelling = new Pending();
  /* 挂载时取一次「现在」就够：这条提醒不需要秒级倒计时，进订单页才有 */
  const now = Date.now();
  const expired = $derived(new Date(order.expires_at).getTime() <= now);
  const summary = $derived([order.plan_name, periodText(order.period, order.period_days, t, tp), formatMoney(order.amount_cents)].join(' · '));

  function cancel() {
    void cancelling.run(async () => {
      try {
        await orderApi.cancel(order.id);
        toast.success(t('订单已取消'));
      } catch (e) {
        toast.error(errorText(e));
      }
      onchange();
    });
  }
</script>

<div role="status" class={['notice', 'warn-bg', compact && 'compact', className]}>
  <Clock size={16} strokeWidth={1.75} class="ic-warn" aria-hidden="true" />
  <div class="grow">
    <div class="nt">{t('你有一笔待支付的订单')}</div>
    <div class="nd">{summary} · {expired ? t('即将自动关闭') : tp('{t} 前未支付将自动关闭', { t: formatTime(order.expires_at) })}</div>
  </div>
  <div class="nx">
    <button type="button" class="btn sm ghost muted" disabled={cancelling.busy} onclick={cancel}>{t('取消订单')}</button>
    <a class="btn sm pri" href={R.order(order.id)}>{t('去支付')}</a>
  </div>
</div>
