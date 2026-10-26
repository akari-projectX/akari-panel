<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { t, tp } from '$lib/i18n.svelte';

  /* 翻页条（v1.4.0 Pager）：「第 2 / 5 页」+ 上一页 / 下一页；只有一页时不渲染 */
  let { page, pages, onchange, disabled = false, meta }: { page: number; pages: number; onchange: (p: number) => void; disabled?: boolean; meta?: string } = $props();
</script>

{#if pages > 1}
  <div class="pager">
    <span>{meta ?? tp('第 {a} / {b} 页', { a: page, b: pages })}</span>
    <div>
      <button type="button" class="btn sm" disabled={disabled || page <= 1} onclick={() => onchange(page - 1)}><ChevronLeft size={14} strokeWidth={1.75} aria-hidden="true" />{t('上一页')}</button>
      <button type="button" class="btn sm" disabled={disabled || page >= pages} onclick={() => onchange(page + 1)}>{t('下一页')}<ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /></button>
    </div>
  </div>
{/if}
