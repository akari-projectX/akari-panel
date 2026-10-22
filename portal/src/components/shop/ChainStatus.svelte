<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import type { ChainPay } from '@/api';
  import { t, tp } from '$lib/i18n.svelte';

  /* 链上进度（React 门户 components/chain-payment.tsx 的 ChainStatus）：等待转账 → 已收到，确认中 x/N（细进度线）→ 已确认 */
  let { pay }: { pay: ChainPay } = $props();

  const tr = $derived(pay.transfer);
  const need = $derived(pay.confirmations_required);
  const have = $derived(tr ? Math.min(tr.confirmations, need) : 0);
</script>

<div class="chain-status" role="status" data-testid="chain-status">
  {#if !tr}
    <span class="spin" aria-hidden="true"></span>
    <p class="muted">{tp('等待转账。到账并达到 {n} 个确认后自动开通，本页会自己更新。', { n: need })}</p>
  {:else if tr.status === 'pending'}
    <span class="spin brand" aria-hidden="true"></span>
    <div class="body">
      <p>{tp('已收到转账，确认中 {c}/{n}', { c: have, n: need })}</p>
      <div class="bar" aria-hidden="true"><i style:transform="scaleX({have / need})"></i></div>
      <p class="hash">{tp('交易 {h}', { h: tr.tx_hash })}</p>
    </div>
  {:else}
    <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" class="ok" />
    <p>{t('转账已确认')}</p>
  {/if}
</div>

<style>
  .chain-status { display: flex; align-items: flex-start; gap: 10px; padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 13px; line-height: 1.8; color: var(--body); }
  .chain-status > :global(svg) { flex: none; margin-top: 4px; }
  .chain-status :global(.ok) { color: var(--ok); }
  .spin { width: 14px; height: 14px; margin-top: 5px; color: var(--faint); }
  .spin.brand { color: var(--brand); }
  .body { flex: 1; min-width: 0; }
  .muted { color: var(--muted); }
  .bar { height: 3px; margin-top: 6px; border-radius: 2px; overflow: hidden; background: var(--secondary); }
  .bar i { display: block; height: 100%; background: var(--brand); transform-origin: left; transition: transform var(--dur-base) var(--ease-out); }
  .hash { margin-top: 4px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  @media (prefers-reduced-motion: reduce) {
    .bar i { transition: none; }
  }
</style>
