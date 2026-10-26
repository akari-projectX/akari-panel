<script lang="ts">
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { t } from '$lib/i18n.svelte';

  /*
   * 重置订阅（危险操作，二次确认；与 React 门户 reset-subscription.tsx 相同）。仪表盘与设置页共用。
   * 确认对话框（ResetSubscriptionDialog，含 bits-ui）第一次点按钮时才下载，不进页面首屏。
   * look：link = 区块头上的文字按钮（仪表盘），button = 设置行里的描边按钮。
   */
  let { look = 'link' }: { look?: 'link' | 'button' } = $props();

  let open = $state(false);
  let loaded = $state(false);

  function show() {
    loaded = true;
    open = true;
  }
</script>

{#if look === 'link'}
  <button type="button" class="btn link-btn warn-link" onclick={show}>
    <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />{t('重置订阅')}
  </button>
{:else}
  <button type="button" class="btn warn-btn" onclick={show}>
    <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />{t('重置')}
  </button>
{/if}

{#if loaded}
  {#await import('./ResetSubscriptionDialog.svelte') then m}<m.default bind:open />{/await}
{/if}

<style>
  .warn-btn { color: var(--warn); }
</style>
