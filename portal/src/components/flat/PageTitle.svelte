<script lang="ts">
  import type { Snippet } from 'svelte';

  /* 页面大标题（v1.4.0 PageTitle）：标题 + 一行说明 + 右侧操作；下面是本页的提醒区（notices，空时不占位） */
  let { title, sub, extra, notices }: { title: string; sub?: string; extra?: Snippet; notices?: Snippet } = $props();
</script>

<div class="pt-row">
  <div>
    <h1 class="page-title">{title}</h1>
    {#if sub}<p class="page-sub">{sub}</p>{/if}
  </div>
  {@render extra?.()}
</div>
<div class="page-notices" data-page-notices>{@render notices?.()}</div>
