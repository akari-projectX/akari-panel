<script lang="ts">
  import type { ChainPay } from '@/api';
  import { formatDateTime } from '@/lib/format';
  import { t, tp } from '$lib/i18n.svelte';

  /*
   * 订单已超时 / 取消、还没看到转账（React 门户 components/chain-payment.tsx 的 ChainLateNote）：保留期（reserved_until）内
   * 到账的这笔金额仍会开通；还没转的不要再转这个金额，重新下单会拿到新的金额；过了保留期再转的，要找客服。
   */
  let { pay }: { pay: ChainPay } = $props();

  const open = $derived(new Date(pay.reserved_until).getTime() > Date.now());
</script>

<div class="late" data-testid="chain-late">
  {#if open}
    <p>{tp('如果你已经按这个金额转了账：{t} 前到账的仍会自动开通，不用做任何事，本页会自己更新。', { t: formatDateTime(pay.reserved_until) })}</p>
    <p class="muted">{t('还没转账：请不要再转这个金额，回商店重新下单，新订单会给你新的金额。')}</p>
  {:else}
    <p class="muted">{t('这个金额的保留期已过。如果你在此之后才转账，请提交工单，附上交易哈希。')}</p>
  {/if}
</div>

<style>
  .late { display: flex; flex-direction: column; gap: 8px; font-size: 13.5px; line-height: 1.8; color: var(--body); }
  .muted { color: var(--muted); }
</style>
