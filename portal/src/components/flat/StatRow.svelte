<script lang="ts" module>
  export type Stat = { k: string; v: string; unit?: string; x?: string; bar?: { pct: number; low: boolean } };
</script>
<script lang="ts">
  /* 指标行（v1.4.0 StatRow）：大数字 + 小单位、标签、一行说明；bar = 剩余流量的进度条 */
  let { items }: { items: Stat[] } = $props();
</script>

<div class="statrow">
  {#each items as s (s.k)}
    <div>
      <div class="stat-v">{s.v}{#if s.unit}<span class="stat-unit">{s.unit}</span>{/if}</div>
      <div class="stat-k">{s.k}</div>
      <div class="stat-x">
        {#if s.bar}<span class={['stat-bar', s.bar.low && 'low']} role="meter" aria-label={s.k} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.bar.pct)}><i style:width="{s.bar.pct}%"></i></span>{/if}
        {s.x ?? ''}
      </div>
    </div>
  {/each}
</div>
