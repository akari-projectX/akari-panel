<script lang="ts">
  import type { Snippet } from 'svelte';

  /*
   * 访客页的标题（外观 A，同用户中心的页头）：可选一行小字眉标（eyebrow），大号 h1，下面一行说明；icon = 标题上面的图标方块。
   * h1 的文字就是页名（e2e 的 ready(page, 标题) 读它）。
   */
  let { title, lead, eyebrow, icon }: { title: string; lead?: string; eyebrow?: string; icon?: Snippet } = $props();
</script>

{#if icon}<div class="au-icon">{@render icon()}</div>{/if}
<div class="au-title">
  {#if eyebrow}<p class="au-eye">{eyebrow}</p>{/if}
  <h1>{title}</h1>
  {#if lead}<p>{lead}</p>{/if}
</div>
