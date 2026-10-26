<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import type { Withdrawal } from '@/api';
  import { formatDateTime, formatMoney } from '@/lib/format';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import Row from '../flat/Row.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { W_STATUS, bdgTone, chainName, shorten } from '$lib/wallet';

  /*
   * 提现记录（v1.4.0 wallet.tsx）：申请时间、去向（网络 + 地址（+ Memo），通过后是实付 USDT 与交易哈希、管理员备注）、
   * 金额、状态，待审核的可以撤回（金额退回余额）。宽屏表格、窄屏一行一笔。
   */
  let { withdrawals, cancelling, oncancel }: { withdrawals: Resource<Withdrawal[]>; cancelling: boolean; oncancel: (id: string) => void } = $props();

  const copied = new Copied(1800);
  const list = $derived(withdrawals.data ?? []);
</script>

{#snippet mono(value: string, label: string)}
  <span class="wmono">
    <span title={value}>{shorten(value)}</span>
    <button type="button" aria-label="{t('复制')} {t(label)}" onclick={() => copied.copy(value, value)}>
      {#if copied.which === value}<Check size={14} strokeWidth={2} aria-hidden="true" class="ic-ok" />{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{/if}
    </button>
  </span>
{/snippet}

{#snippet detail(w: Withdrawal)}
  <span class="wdet">
    <span><span class="fg">{chainName(w.chain)}</span>{@render mono(w.address, '收款地址')}</span>
    {#if w.memo}<span style="display: block">Memo <span style="font-family: var(--font-mono)">{w.memo}</span></span>{/if}
    {#if w.usdt_amount}<span class="tnum" style="display: block">{t('实付')} {w.usdt_amount} USDT</span>{/if}
    {#if w.txid}<span>{t('交易哈希')} {@render mono(w.txid, '交易哈希')}</span>{/if}
    {#if w.note}<span class="wnote" title={w.note}>{w.note}</span>{/if}
  </span>
{/snippet}

{#if withdrawals.loading && !withdrawals.data}
  <Loading rows={2} />
{:else if withdrawals.error && !withdrawals.data}
  <LoadError error={withdrawals.error} onretry={withdrawals.reload} />
{:else if list.length === 0}
  <Empty title={t('还没有提现记录')} />
{:else}
  <div class="md-hide">
    {#each list as w, i (w.id)}
      <Row first={i === 0}>
        {#snippet title()}<span class="tnum">{formatMoney(w.amount_cents)}</span>{/snippet}
        {#snippet desc()}<span class="tnum">{formatDateTime(w.created_at)}</span>{@render detail(w)}{/snippet}
        {#snippet extra()}
          <span style="display: flex; align-items: center; gap: 8px">
            <span class={['bdg', bdgTone(W_STATUS[w.status].tone)]}>{t(W_STATUS[w.status].text)}</span>
            {#if w.status === 'pending'}
              <!-- 手机上的点击区至少 32px 高 -->
              <button type="button" class="btn sm" disabled={cancelling} onclick={() => oncancel(w.id)}>{t('撤回')}</button>
            {/if}
          </span>
        {/snippet}
      </Row>
    {/each}
  </div>
  <div class="md-only" style="overflow-x: auto">
    <table class="wtbl" style="min-width: 640px">
      <thead>
        <tr><th>{t('申请时间')}</th><th>{t('收款地址')}</th><th class="r">{t('金额')}</th><th class="pl6">{t('状态')}</th><th class="r">{t('操作')}</th></tr>
      </thead>
      <tbody>
        {#each list as w (w.id)}
          <tr>
            <td class="tnum nw mu">{formatDateTime(w.created_at)}</td>
            <td style="max-width: 320px">{@render detail(w)}</td>
            <td class="tnum r fw">{formatMoney(w.amount_cents)}</td>
            <td class="pl6"><span class={['bdg', bdgTone(W_STATUS[w.status].tone)]}>{t(W_STATUS[w.status].text)}</span></td>
            <td class="r">
              {#if w.status === 'pending'}
                <button type="button" class="btn link-btn" disabled={cancelling} onclick={() => oncancel(w.id)}>{t('撤回')}</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
