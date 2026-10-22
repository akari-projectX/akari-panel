<script lang="ts">
  import Clock from '@lucide/svelte/icons/clock';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import type { MyOrder } from '@/api';
  import { formatDate, formatMoney } from '@/lib/format';
  import type { PayOutcome } from '@/lib/shop';
  import Dialog from '../ui/Dialog.svelte';
  import { auth } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';

  /*
   * 付款结果（React 门户 components/pay-result.tsx）。订单页轮询到状态变化时打开；当场付清的订单（余额 / 优惠 / 折算全额抵扣、
   * 免费订单）由商店带着 paid 跳到订单页时打开——两条路同一个样子：
   *   成功   圆环 → 对勾描画 + 一次性的小撒花（@/lib/confetti，按需加载，约 0.8 秒，只用品牌色）+ 金额 / 套餐 / 到期，「查看订阅」「返回仪表盘」
   *   退回   付款时套餐开不了（售罄、下架…），款项已退回余额，「查看钱包」
   *   超时   超过时限、已扣款请提交工单，「重新选购」
   * 减少动效时不撒花，对勾直接画好。第一次需要时才下载（含 bits-ui）。
   */
  let { order, outcome, onclose }: { order: MyOrder; outcome: PayOutcome | null; onclose: () => void } = $props();

  let mark = $state<HTMLElement | null>(null);

  $effect(() => {
    if (outcome !== 'success' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let cancelled = false;
    /* 圆环画完、对勾开始落下的那一刻炸开 */
    const timer = setTimeout(() => {
      void import('@/lib/confetti').then((m) => {
        if (!cancelled && mark) m.default(mark, 800);
      });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  });

  function go(to: string) {
    onclose();
    navigate(to);
  }

  const paid = $derived(order.amount_cents + order.balance_cents);
  const plan = $derived(auth.plan);
  const VIEW = {
    success: { title: '支付成功', description: '支付成功，套餐已生效' },
    refunded: {
      title: '已收到付款',
      description: '付款时套餐已售罄、已下架，或你已经换了别的套餐。款项会退回账户余额，可以用来重新下单或申请提现；有疑问请提交工单。',
    },
    expired: { title: '订单已超时关闭', description: '超过支付时限仍未收到付款。如果已经扣款，请提交工单处理' },
  } as const;
</script>

{#if outcome}
  <Dialog open onOpenChange={(o) => { if (!o) onclose(); }} title={t(VIEW[outcome].title)} description={t(VIEW[outcome].description)}>
    {#snippet icon()}
      <span class={['result-mark', outcome]} bind:this={mark}>
        {#if outcome === 'success'}
          <svg viewBox="0 0 56 56" aria-hidden="true">
            <circle class="arc" cx="28" cy="28" r="25" pathLength="1" />
            <path class="tick" d="M17 29.5l7.5 7.5L39.5 21" pathLength="1" />
          </svg>
        {:else if outcome === 'refunded'}
          <Undo2 size={26} strokeWidth={1.75} aria-hidden="true" />
        {:else}
          <Clock size={26} strokeWidth={1.75} aria-hidden="true" />
        {/if}
      </span>
    {/snippet}

    {#if outcome !== 'expired'}
      <dl class="result-sum">
        <div><dt>{t('金额')}</dt><dd class="num">{formatMoney(paid)}</dd></div>
        <div><dt>{t('订购套餐')}</dt><dd>{order.plan_name}</dd></div>
        {#if outcome === 'success' && plan?.plan}
          <div><dt>{t('到期时间')}</dt><dd class="num">{plan.expires_at ? formatDate(plan.expires_at) : t('长期')}</dd></div>
        {/if}
      </dl>
    {/if}

    {#snippet footer()}
      {#if outcome === 'success'}
        <button type="button" class="btn" onclick={() => go(`${R.dashboard}#subscribe`)}>{t('查看订阅')}</button>
        <button type="button" class="btn pri" onclick={() => go(R.dashboard)}>{t('返回仪表盘')}</button>
      {:else if outcome === 'refunded'}
        <button type="button" class="btn" onclick={() => go(R.walletTab('ledger'))}>{t('查看钱包')}</button>
        <button type="button" class="btn pri" onclick={() => go(R.dashboard)}>{t('返回仪表盘')}</button>
      {:else}
        <button type="button" class="btn" onclick={() => go(R.dashboard)}>{t('返回仪表盘')}</button>
        <button type="button" class="btn pri" onclick={() => go(R.shop)}>{t('重新选购')}</button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .result-mark { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; color: var(--muted); }
  .result-mark.success { color: var(--ok); }
  .result-mark.refunded { color: var(--warn); }
  .result-mark svg { width: 44px; height: 44px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
  .arc, .tick { stroke-dasharray: 1; stroke-dashoffset: 1; animation: draw var(--dur-base) var(--ease-out) forwards; }
  .tick { stroke-width: 3; animation-delay: 180ms; }
  .result-sum { padding: 4px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .result-sum div { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; }
  .result-sum dt { color: var(--muted); }
  .result-sum dd { min-width: 0; color: var(--fg); text-align: right; overflow-wrap: anywhere; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .arc, .tick { animation: none; stroke-dashoffset: 0; }
  }
</style>
