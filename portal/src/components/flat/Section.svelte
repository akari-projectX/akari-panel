<script lang="ts">
  import type { Snippet } from 'svelte';

  /* 区块（v1.4.0 flat.tsx 的 Section）：标题（微标签）+ 说明 + 右侧操作 + 顶部细分隔线。id = 锚点 */
  let { id, title, desc, extra, children }: { id?: string; title?: Snippet; desc?: Snippet; extra?: Snippet; children: Snippet } = $props();
</script>

<section {id} class="sec">
  {#if title || extra}
    <div class="sec-head">
      <div>
        {#if title}<h2 class="sec-title">{@render title()}</h2>{/if}
        {#if desc}<div class="sec-desc">{@render desc()}</div>{/if}
      </div>
      {@render extra?.()}
    </div>
  {/if}
  {@render children()}
</section>
