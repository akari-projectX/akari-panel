<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import type { Withdrawal } from '@/api';
  import { formatDateTime, formatMoney } from '@/lib/format';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { W_STATUS, chainName, shorten } from '$lib/wallet';

  /*
   * 提现记录（同 React 门户 wallet.tsx）：申请时间、去向（网络 + 地址（+ Memo），通过后是实付 USDT 与交易哈希、管理员备注）、
   * 金额、状态（色点 + 文字），待审核的可以撤回（金额退回余额）。宽屏表格、窄屏一行一笔。
   */
  let { withdrawals, cancelling, oncancel, narrow }: {
    withdrawals: Resource<Withdrawal[]>;
    cancelling: boolean;
    oncancel: (id: string) => void;
    narrow: boolean;
  } = $props();

  const copied = new Copied(1800);
  const list = $derived(withdrawals.data ?? []);
</script>

{#snippet mono(value: string, label: string)}
  <span class="mono">
    <span title={value}>{shorten(value)}</span>
    <button type="button" aria-label="{t('复制')} {t(label)}" onclick={() => copied.copy(value, value)}>
      {#if copied.which === value}<Check size={13} strokeWidth={2} aria-hidden="true" />{:else}<Copy size={13} strokeWidth={1.75} aria-hidden="true" />{/if}
    </button>
  </span>
{/snippet}

{#snippet detail(w: Withdrawal)}
  <span class="detail">
    <span class="row"><span class="chain">{chainName(w.chain)}</span>{@render mono(w.address, '收款地址')}</span>
    {#if w.memo}<span>Memo <span class="m">{w.memo}</span></span>{/if}
    {#if w.usdt_amount}<span class="num">{t('实付')} {w.usdt_amount} USDT</span>{/if}
    {#if w.txid}<span class="row">{t('交易哈希')} {@render mono(w.txid, '交易哈希')}</span>{/if}
    {#if w.note}<span class="note-t" title={w.note}>{w.note}</span>{/if}
  </span>
{/snippet}

{#snippet status(w: Withdrawal)}
  <span class="st {W_STATUS[w.status].tone}">{t(W_STATUS[w.status].text)}</span>
{/snippet}

{#if withdrawals.loading && !withdrawals.data}
  <Loading rows={2} />
{:else if withdrawals.error && !withdrawals.data}
  <LoadError error={withdrawals.error} onretry={withdrawals.reload} />
{:else if list.length === 0}
  <Empty title={t('还没有提现记录')} />
{:else if narrow}
  <div class="list">
    {#each list as w (w.id)}
      <div class="li top">
        <div class="main">
          <div class="t"><span class="num">{formatMoney(w.amount_cents)}</span></div>
          <p class="when-m num">{formatDateTime(w.created_at)}</p>
          {@render detail(w)}
        </div>
        <span class="right">
          {@render status(w)}
          {#if w.status === 'pending'}
            <button type="button" class="btn sm" disabled={cancelling} onclick={() => oncancel(w.id)}>{t('撤回')}</button>
          {/if}
        </span>
      </div>
    {/each}
  </div>
{:else}
  <div class="tbl-wrap">
    <table class="tbl">
      <thead>
        <tr>
          <th>{t('申请时间')}</th>
          <th>{t('收款地址')}</th>
          <th class="n">{t('金额')}</th>
          <th>{t('状态')}</th>
          <th class="n">{t('操作')}</th>
        </tr>
      </thead>
      <tbody>
        {#each list as w (w.id)}
          <tr>
            <td class="when">{formatDateTime(w.created_at)}</td>
            <td class="to">{@render detail(w)}</td>
            <td class="n strong">{formatMoney(w.amount_cents)}</td>
            <td>{@render status(w)}</td>
            <td class="n">
              {#if w.status === 'pending'}
                <button type="button" class="link" disabled={cancelling} onclick={() => oncancel(w.id)}>{t('撤回')}</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .detail { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 12.5px; color: var(--muted); }
  .detail .row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .chain { flex: none; color: var(--fg); }
  .m { font-family: var(--font-mono); }
  .note-t { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .to { max-width: 340px; }
  .li.top { align-items: flex-start; }
  .when-m { margin: 2px 0 4px; font-size: 12.5px; color: var(--muted); }
  .right { display: flex; flex: none; align-items: center; gap: 8px; }
  button.link:disabled { opacity: .5; cursor: not-allowed; }
</style>
