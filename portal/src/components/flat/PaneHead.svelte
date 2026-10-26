<script lang="ts">
  import type { Snippet } from 'svelte';

  /* 分栏标题（v1.4.0 PaneHead）：微标签 + 说明 + 右侧操作，保证两栏内容起始线对齐 */
  let { title, desc, extra }: { title: Snippet; desc: Snippet; extra?: Snippet } = $props();
</script>

<div class="pane-head">
  <div>
    <h3 class="sec-title">{@render title()}</h3>
    <div class="pane-desc">{@render desc()}</div>
  </div>
  {#if extra}<div class="pane-x">{@render extra()}</div>{/if}
</div>
