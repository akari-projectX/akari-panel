<script lang="ts">
  import type { LedgerEntry } from '@/api';
  import { formatDateTime, formatMoney, signedMoney } from '@/lib/format';
  import Empty from '../Empty.svelte';
  import { t } from '$lib/i18n.svelte';
  import { LEDGER_TEXT } from '$lib/wallet';

  /*
   * 收支流水（同 React 门户 wallet.tsx）：时间、类型、说明（订单号或原因）、变动（正绿负红）、变动后的余额。
   * 宽屏表格、窄屏一行一笔；按 id 倒序翻页（「加载更早的记录」，翻页在 Wallet.svelte）。
   */
  let { entries, more, busy, onmore, narrow }: {
    entries: LedgerEntry[];
    more: boolean;
    busy: boolean;
    onmore: () => void;
    narrow: boolean;
  } = $props();

  const tone = (cents: number) => (cents < 0 ? 'neg' : 'pos');
</script>

{#if entries.length === 0}
  <Empty title={t('还没有收支记录')} desc={t('佣金入账、余额支付、退款到余额、提现都会记在这里。')} />
{:else if narrow}
  <div class="list">
    {#each entries as e (e.id)}
      <div class="li">
        <div class="main">
          <div class="t"><span>{t(LEDGER_TEXT[e.kind])}</span></div>
          <p class="s num">{[formatDateTime(e.created_at), e.out_trade_no ?? e.reason ?? ''].filter(Boolean).join(' · ')}</p>
        </div>
        <span class="right">
          <b class="num {tone(e.amount_cents)}">{signedMoney(e.amount_cents)}</b>
          <span class="num">{formatMoney(e.balance_after_cents)}</span>
        </span>
      </div>
    {/each}
  </div>
{:else}
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th>{t('时间')}</th>
          <th>{t('类型')}</th>
          <th>{t('说明')}</th>
          <th class="n">{t('变动')}</th>
          <th class="n">{t('余额')}</th>
        </tr>
      </thead>
      <tbody>
        {#each entries as e (e.id)}
          <tr>
            <td class="when">{formatDateTime(e.created_at)}</td>
            <td class="kind">{t(LEDGER_TEXT[e.kind])}</td>
            <td class="q why">{#if e.out_trade_no}<code>{e.out_trade_no}</code>{:else}{e.reason ?? ''}{/if}</td>
            <td class="n"><b class="amt {tone(e.amount_cents)}">{signedMoney(e.amount_cents)}</b></td>
            <td class="n q">{formatMoney(e.balance_after_cents)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if entries.length > 0 && more}
  <div class="more">
    <button type="button" class="btn sm" disabled={busy} onclick={onmore}>{t('加载更早的记录')}</button>
  </div>
{/if}

<style>
  .kind { white-space: nowrap; }
  .why { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .why code { font-family: var(--font-mono); font-size: 12.5px; }
  .right { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 2px; }
  .right b, .amt { font-weight: 500; }
  .right span { font-size: 12px; color: var(--muted); }
  .more { display: flex; justify-content: center; margin-top: 20px; }
</style>
