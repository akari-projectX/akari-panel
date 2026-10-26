<script lang="ts">
  import type { Snippet } from 'svelte';

  /* 两栏分区（v1.4.0 Split）：靠间距，不画竖线；窄屏一栏 */
  let { left, right }: { left: Snippet; right: Snippet } = $props();
</script>

<div class="split2">
  <div class="pane">{@render left()}</div>
  <div class="pane">{@render right()}</div>
</div>
