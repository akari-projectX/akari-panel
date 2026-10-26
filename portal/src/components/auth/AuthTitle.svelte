<script lang="ts">
  import type { Snippet } from 'svelte';

  /* 标题 + 一行说明（v1.4.0 的 Title：27px / 600，说明 14.5px 辅助灰）；icon = 标题上面的图标方块 */
  let { title, lead, icon }: { title: string; lead?: string; icon?: Snippet } = $props();
</script>

{#if icon}<div class="au-icon">{@render icon()}</div>{/if}
<div class="au-title">
  <h1>{title}</h1>
  {#if lead}<p>{lead}</p>{/if}
</div>
