<script lang="ts">
  import Inbox from '@lucide/svelte/icons/inbox';
  import type { Snippet } from 'svelte';
  /* 空状态（v1.4.0 data-state 的 Empty）：图标 + 一句标题 + 可选的一句说明 + 可选的动作（文字由调用处 t() 好） */
  let { title, desc, action }: { title: string; desc?: string; action?: Snippet } = $props();
</script>

<div class="state-in st-box st-empty">
  <Inbox class="st-ic" size={24} strokeWidth={1.75} aria-hidden="true" />
  <div>
    <p class="st-t">{title}</p>
    {#if desc}<p class="st-d st-dn">{desc}</p>{/if}
  </div>
  {@render action?.()}
</div>
