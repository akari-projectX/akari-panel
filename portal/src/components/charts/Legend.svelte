<script lang="ts">
  /* 图例（v1.4.0 ChartLegendContent）：居中一行，窄屏换行 */
  let { items }: { items: { color: string; name: string }[] } = $props();
</script>

<div class="clg" aria-hidden="true">
  {#each items as it, i (i)}<div><i style:background={it.color}></i>{it.name}</div>{/each}
</div>
