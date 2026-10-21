<script lang="ts">
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import { t, tp } from '$lib/i18n.svelte';
  import { cycleTheme, theme } from '$lib/theme.svelte';

  let { class: cls = '' }: { class?: string } = $props();

  /* 浅色 → 深色 → 跟随系统；图标显示当前的选择 */
  const LABEL = { light: '浅色', dark: '深色', system: '跟随系统' } as const;
  const label = $derived(t(LABEL[theme.mode]));
</script>

<button type="button" class="iconbtn {cls}" onclick={cycleTheme} aria-label={tp('切换明暗模式（当前：{mode}）', { mode: label })} title={label}>
  {#if theme.mode === 'light'}
    <Sun class="i" size={16} strokeWidth={1.75} aria-hidden="true" />
  {:else if theme.mode === 'dark'}
    <Moon class="i" size={16} strokeWidth={1.75} aria-hidden="true" />
  {:else}
    <Monitor class="i" size={16} strokeWidth={1.75} aria-hidden="true" />
  {/if}
</button>
