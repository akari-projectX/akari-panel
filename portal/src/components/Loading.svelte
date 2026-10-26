<script lang="ts">
  import { t } from '$lib/i18n.svelte';

  /*
   * 区块加载中（v1.4.0 data-state 的 Loading）：几行和列表行同样高的骨架（圆头像 + 两道条 + 右侧一道），而不是转菊花：
   * 数据到了只是「填进去」，整页不跳。block = 图表这类整块区域，height 给和真实内容一样的高度。
   */
  let { rows = 3, block, height }: { rows?: number; block?: number; height?: number } = $props();
  const h = $derived(block ?? height);
</script>

<div class="load-in ld" aria-busy="true" aria-label={t('加载中')}>
  <span class="sr">{t('加载中')}</span>
  {#if block}
    <i class="sk ld-block" style:height="{block}px"></i>
  {:else}
    {#each { length: rows } as _, i (i)}
      <div class="ld-row" style:min-height={h ? `${h / rows}px` : undefined}>
        <i class="sk ld-dot"></i>
        <div class="ld-bars"><i class="sk" style:width="{58 - i * 9}%"></i><i class="sk ld-b2" style:width="{36 - i * 5}%"></i></div>
        <i class="sk ld-r"></i>
      </div>
    {/each}
  {/if}
</div>
