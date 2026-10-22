<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Clock from '@lucide/svelte/icons/clock';
  import Copy from '@lucide/svelte/icons/copy';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { ChainNetwork, ChainPay } from '@/api';
  import { formatDateTime } from '@/lib/format';
  import Qr from '../dash/Qr.svelte';
  import ChainStatus from './ChainStatus.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { mmss } from '$lib/shop';

  /*
   * USDT 链上付款（订单待支付时；React 门户 components/chain-payment.tsx）：网络提醒、精确金额（识别尾数突出显示）、
   * 共用的收款地址（可复制、二维码）、倒计时、看到的转账与确认数。收款地址是这个支付方式所有订单共用的，面板只按
   * 「精确金额」认出是哪一单——所以文案说「金额最后几位识别你的订单」，不说「这个地址只给这一单」。
   */
  let { pay, expiresAt }: { pay: ChainPay; expiresAt: string } = $props();

  /** 网络的显示名（与面板 billing::chain::CHAINS 一致） */
  const CHAIN_NAME: Record<ChainNetwork, string> = { polygon: 'Polygon (PoS)', plasma: 'Plasma' };
  /** 识别订单用的尾数：6 位小数里的最后 4 位 */
  const SUFFIX = 4;

  const copied = new Copied<'amount' | 'address'>();
  const net = $derived(CHAIN_NAME[pay.chain] ?? pay.chain);
  const head = $derived(pay.amount.slice(0, -SUFFIX));
  const tail = $derived(pay.amount.slice(-SUFFIX));

  /* 每秒走一次的倒计时（只在这块挂着时走） */
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });
  const left = $derived(new Date(expiresAt).getTime() - now);
</script>

<div class="chain">
  <p class="net" role="note">
    <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
    <span>{tp('只能通过 {n} 网络转 USDT。转到其他网络、或转其他代币，都无法到账。', { n: net })}</span>
  </p>

  <div>
    <div class="k">{t('转账金额（USDT）')}</div>
    <div class="amount-row">
      <span class="amount num" data-testid="chain-amount">{head}<span>{tail}</span></span>
      <button type="button" class="iconbtn" aria-label={t('复制金额')} onclick={() => copied.copy(pay.amount, 'amount')}>
        {#if copied.which === 'amount'}<Check size={16} strokeWidth={1.75} aria-hidden="true" class="ok" />{:else}<Copy size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
      </button>
    </div>
    <p class="fine-print">
      {tp('金额的最后 {k} 位小数用来识别你的订单，请一分不差地转账（含尾数）。从交易所提币时，请确认扣除手续费后到账的仍是这个数。', { k: SUFFIX })}
    </p>
  </div>

  <div class="addr-row">
    <div class="addr">
      <div class="k">{tp('收款地址（{n}）', { n: net })}</div>
      <div class="amount-row">
        <code data-testid="chain-address">{pay.address}</code>
        <button type="button" class="iconbtn" aria-label={t('复制收款地址')} onclick={() => copied.copy(pay.address, 'address')}>
          {#if copied.which === 'address'}<Check size={16} strokeWidth={1.75} aria-hidden="true" class="ok" />{:else}<Copy size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
        </button>
      </div>
      <p class="fine-print">{t('这是本站共用的收款地址，订单按上面的精确金额识别。')}</p>
      <p class="fine-print break">{tp('USDT 合约：{c}', { c: pay.token })}</p>
    </div>
    <!-- 只有地址：多数钱包与交易所不认带金额的链接，金额要照抄 -->
    <div class="qr"><Qr value={pay.address} label={t('收款地址二维码')} /></div>
  </div>

  <p class="count">
    <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
    <span>
      {#if left > 0}{t('剩余时间')} <b class="num" data-testid="chain-countdown">{mmss(left)}</b>{:else}{t('订单即将超时')}{/if}
      <span class="line">{tp('超时后订单会关闭，但 {t} 前到账的这笔金额仍会自动开通。', { t: formatDateTime(pay.reserved_until) })}</span>
    </span>
  </p>

  <ChainStatus {pay} />
</div>

<style>
  .chain { display: flex; flex-direction: column; gap: 20px; }
  .net { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 1.8; color: var(--warn); }
  .net :global(svg) { flex: none; margin-top: 4px; }
  .k { font-size: 12.5px; color: var(--muted); }
  .amount-row { display: flex; align-items: center; gap: 4px; margin-top: 4px; }
  .amount { font-family: var(--font-mono); font-size: 26px; line-height: 1.1; font-weight: 500; color: var(--fg); letter-spacing: -.02em; }
  .amount span { padding: 0 2px; border-radius: 4px; color: var(--brand); background: var(--brand-soft); }
  .amount-row :global(.ok) { color: var(--ok); }
  code { min-width: 0; font-family: var(--font-mono); font-size: 13px; line-height: 1.7; color: var(--fg); overflow-wrap: anywhere; }
  .fine-print { margin-top: 8px; font-size: 12.5px; line-height: 1.8; color: var(--muted); }
  .fine-print + .fine-print { margin-top: 2px; }
  .fine-print.break { overflow-wrap: anywhere; }
  .addr-row { display: flex; align-items: flex-start; gap: 24px; }
  .addr { flex: 1; min-width: 0; }
  .qr { flex: none; width: 156px; height: 156px; padding: 12px; border-radius: 8px; background: var(--qr-paper); }
  .count { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; line-height: 1.8; color: var(--muted); }
  .count :global(svg) { flex: none; margin-top: 4px; }
  .count b { font-weight: 600; color: var(--fg); }
  .line { display: block; }

  @media (max-width: 720px) {
    .addr-row { flex-direction: column; align-items: center; }
    .addr { align-self: stretch; }
  }
</style>
