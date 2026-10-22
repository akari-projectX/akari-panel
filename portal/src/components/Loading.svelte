<script lang="ts">
  import { t } from '$lib/i18n.svelte';

  /* 一块内容在取数：几道灰条（aria-busy：测速脚本等它消失才算内容就绪）；height 预留高度，数据到了不跳 */
  let { rows = 3, height }: { rows?: number; height?: number } = $props();
</script>

<div class="lines" aria-busy="true" aria-label={t('加载中')} style:min-height={height ? `${height}px` : undefined}>
  {#each { length: rows }, i (i)}<i></i>{/each}
</div>
