<script lang="ts">
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import { t } from '$lib/i18n.svelte';
  import { theme, toggleTheme } from '$lib/theme.svelte';

  let { class: cls = '' }: { class?: string } = $props();

  /* v1.4.0：明 ↔ 暗互换，图标是「点了会变成的那一边」（亮色界面显示月亮） */
</script>

<button type="button" class="ibtn {cls}" onclick={toggleTheme} aria-label={t('切换明暗模式')} title={t('切换明暗模式')}>
  {#if theme.dark}
    <Sun size={16} strokeWidth={1.75} aria-hidden="true" />
  {:else}
    <Moon size={16} strokeWidth={1.75} aria-hidden="true" />
  {/if}
</button>
