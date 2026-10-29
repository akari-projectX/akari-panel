<script module lang="ts">
  const Reset = () => import('./ResetSubscriptionDialog.svelte');
</script>

<script lang="ts">
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { chunk, intent, preloadDialogs } from '$lib/dialogs';
  import { t } from '$lib/i18n.svelte';

  /*
   * 重置订阅（危险操作，二次确认）。仪表盘与设置页共用。
   * 确认对话框（ResetSubscriptionDialog，含 bits-ui）不进页面首屏：空闲时与按钮上的意图预载（lib/dialogs），第一次点按钮时挂载。
   * look：link = 区块头上的文字按钮（仪表盘），button = 设置行里的描边按钮。
   */
  let { look = 'link' }: { look?: 'link' | 'button' } = $props();

  preloadDialogs(Reset);
  let open = $state(false);
  let loaded = $state(false);

  function show() {
    loaded = true;
    open = true;
  }
</script>

{#if look === 'link'}
  <button type="button" class="btn link-btn warn-link" {@attach intent(Reset)} onclick={show}>
    <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />{t('重置订阅')}
  </button>
{:else}
  <button type="button" class="btn warn-btn" {@attach intent(Reset)} onclick={show}>
    <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />{t('重置')}
  </button>
{/if}

{#if loaded}
  {#await chunk(Reset) then m}<m.default bind:open />{/await}
{/if}

<style>
  .warn-btn { color: var(--warn); }
</style>
