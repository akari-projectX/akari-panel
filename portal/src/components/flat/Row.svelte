<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';

  /*
   * 行式列表项（v1.4.0 Row）：头像 + 标题 / 说明 + 右侧；给 onclick 就是整行可点（悬停铺浅底）。
   * 组件上的 {@attach}（如 lib/dialogs 的 intent）落在可点的那个按钮上。
   */
  let { avatar, title, desc, extra, onclick, first = false, off = false, ...attach }: {
    avatar?: Snippet; title: Snippet; desc?: Snippet; extra?: Snippet; onclick?: () => void; first?: boolean; off?: boolean;
    [attachment: symbol]: Attachment<HTMLElement>;
  } = $props();
  const cls = $derived(['rowline', first && !onclick && 'first', onclick && 'hov', off && 'is-off']);
</script>

{#snippet inner()}
  {@render avatar?.()}
  <div class="rowline-main">
    <div class="rowline-t">{@render title()}</div>
    {#if desc}<div class="rowline-d">{@render desc()}</div>{/if}
  </div>
  {#if extra}<div class="rowline-x">{@render extra()}</div>{/if}
{/snippet}

{#if onclick}
  <button type="button" class={cls} {onclick} {...attach}>{@render inner()}</button>
{:else}
  <div class={cls}>{@render inner()}</div>
{/if}
