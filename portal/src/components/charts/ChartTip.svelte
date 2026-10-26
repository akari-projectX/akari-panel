<script lang="ts">
  /* 提示框（v1.4.0 ChartTooltipContent）：标题 + 每个系列一行（色块、名称、等宽数值）。x / y = 容器内的位置，靠右时翻到指针左边 */
  let { label, items, x, y, width }: {
    label?: string; items: { color: string; name: string; value: string }[]; x: number; y: number; width: number;
  } = $props();
  const flip = $derived(x > width - 170);
</script>

<div class="ctip" role="status" style:left="{x}px" style:top="{y}px" style:transform={flip ? 'translateX(calc(-100% - 20px))' : undefined}>
  {#if label}<div class="ctip-l">{label}</div>{/if}
  <div class="ctip-i">
    {#each items as it, i (i)}
      <div class="ctip-r">
        <span class="ctip-k" style:background={it.color}></span>
        <div class="ctip-v"><span class="ctip-n">{it.name}</span><span class="ctip-m">{it.value}</span></div>
      </div>
    {/each}
  </div>
</div>
