<script lang="ts">
  import AlertCircle from '@lucide/svelte/icons/circle-alert';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import { errorText } from '$lib/errors';
  import { t } from '$lib/i18n.svelte';

  /* 一块内容没取到（v1.4.0 data-state 的 LoadError）：图标 + 标题 + 按错误码给的一句话原因 + 「重试」；页面其余部分照常可用 */
  let { error, onretry }: { error?: unknown; onretry?: () => void } = $props();
</script>

<div class="state-in st-box" role="alert">
  <AlertCircle class="st-ic" size={24} strokeWidth={1.75} aria-hidden="true" />
  <div>
    <p class="st-t">{t('这一块没能加载出来')}</p>
    <p class="st-d">{error ? errorText(error) : t('请稍后重试。')}</p>
  </div>
  {#if onretry}
    <button type="button" class="btn sm" onclick={onretry}><RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />{t('重试')}</button>
  {/if}
</div>
