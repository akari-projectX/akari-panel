<script lang="ts">
  import type { Snippet } from 'svelte';
  /* 空状态：一句标题 + 可选的一句说明 + 可选的动作（文字由调用处 t() 好） */
  let { title, desc, action }: { title: string; desc?: string; action?: Snippet } = $props();
</script>

<div class="empty">
  <b>{title}</b>
  {#if desc}<p>{desc}</p>{/if}
  {@render action?.()}
</div>
