<script lang="ts">
  import type { LedgerEntry } from '@/api';
  import { formatDateTime, formatMoney, signedMoney } from '@/lib/format';
  import Empty from '../Empty.svelte';
  import Row from '../flat/Row.svelte';
  import { t } from '$lib/i18n.svelte';
  import { LEDGER_TEXT } from '$lib/wallet';

  /*
   * 收支流水（v1.4.0 wallet.tsx）：时间、类型、说明（订单号或原因）、变动（正绿负红）、变动后的余额。
   * 宽屏表格、窄屏一行一笔；按 id 倒序翻页（「加载更早的记录」，翻页在 Wallet.svelte）。
   */
  let { entries, more, busy, onmore }: { entries: LedgerEntry[]; more: boolean; busy: boolean; onmore: () => void } = $props();
</script>

{#if entries.length === 0}
  <Empty title={t('还没有收支记录')} desc={t('佣金入账、余额支付、退款到余额、提现都会记在这里。')} />
{:else}
  <div class="md-hide">
    {#each entries as e, i (e.id)}
      <Row first={i === 0}>
        {#snippet title()}{t(LEDGER_TEXT[e.kind])}{/snippet}
        {#snippet desc()}{[formatDateTime(e.created_at), e.out_trade_no ?? e.reason ?? ''].filter(Boolean).join(' · ')}{/snippet}
        {#snippet extra()}
          <span class="wcol">
            <span class={['tnum', e.amount_cents < 0 ? 'amt-neg' : 'amt-pos']} style="font-weight: 500">{signedMoney(e.amount_cents)}</span>
            <span class="tnum" style="font-size: 12px; color: var(--muted)">{formatMoney(e.balance_after_cents)}</span>
          </span>
        {/snippet}
      </Row>
    {/each}
  </div>
  <div class="md-only" style="overflow-x: auto">
    <table class="wtbl" style="min-width: 560px">
      <thead>
        <tr><th>{t('时间')}</th><th>{t('类型')}</th><th>{t('说明')}</th><th class="r">{t('变动')}</th><th class="r">{t('余额')}</th></tr>
      </thead>
      <tbody>
        {#each entries as e (e.id)}
          <tr>
            <td class="tnum nw mu">{formatDateTime(e.created_at)}</td>
            <td class="nw">{t(LEDGER_TEXT[e.kind])}</td>
            <td class="clip mu">{#if e.out_trade_no}<code>{e.out_trade_no}</code>{:else}{e.reason ?? ''}{/if}</td>
            <td class={['tnum r fw', e.amount_cents < 0 ? 'amt-neg' : 'amt-pos']}>{signedMoney(e.amount_cents)}</td>
            <td class="tnum r mu">{formatMoney(e.balance_after_cents)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if more}
    <div style="display: flex; justify-content: center; margin-top: 20px">
      <button type="button" class="btn sm" disabled={busy} onclick={onmore}>{t('加载更早的记录')}</button>
    </div>
  {/if}
{/if}
