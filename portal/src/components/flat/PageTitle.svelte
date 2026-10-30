<script lang="ts">
  import type { Snippet } from 'svelte';

  /*
   * 页头（外观 A 的 .ph）：给了 lead 时，页名（h1）是一行小字眉标，下面一句大字说明这一页现在的状况（「4 条线路，3 条在线」），
   * 再下面可选一行说明；右侧是操作或刷新时间（extra）。没给 lead 时退回大标题 + 一行说明。
   * 下面是本页的提醒区（notices，空时不占位）。
   */
  let { title, lead, sub, extra, notices }: { title: string; lead?: string; sub?: string; extra?: Snippet; notices?: Snippet } = $props();
</script>

<div class={['pt-row', lead && 'ph']}>
  <div class="pt-main">
    {#if lead}
      <h1 class="page-eyebrow">{title}</h1>
      <p class="page-lead">{lead}</p>
    {:else}
      <h1 class="page-title">{title}</h1>
    {/if}
    {#if sub}<p class="page-sub">{sub}</p>{/if}
  </div>
  {#if extra}<div class="pt-extra">{@render extra()}</div>{/if}
</div>
<div class="page-notices" data-page-notices>{@render notices?.()}</div>
