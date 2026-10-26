<script lang="ts" module>
  export type Stat = { k: string; v: string; unit?: string; x?: string; x2?: string; bar?: { pct: number; low: boolean }; arrow?: 'down' | 'up' };
</script>
<script lang="ts">
  import ArrowDown from '@lucide/svelte/icons/arrow-down';
  import ArrowUp from '@lucide/svelte/icons/arrow-up';
  /* 指标行（v1.4.0 StatRow）：大数字 + 小单位、标签、一行说明；bar = 剩余流量的进度条 */
  let { items }: { items: Stat[] } = $props();
</script>

<div class={['statrow', items.length === 3 && 'n3', items.length === 2 && 'n2']}>
  {#each items as s (s.k)}
    <div>
      <div class="stat-v">{s.v}{#if s.unit}<span class="stat-unit">{s.unit}</span>{/if}</div>
      <div class="stat-k">{s.k}</div>
      <div class="stat-x">
        {#if s.bar}<span class={['stat-bar', s.bar.low && 'low']} role="meter" aria-label={s.k} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(s.bar.pct)}><i style:width="{s.bar.pct}%"></i></span>{/if}
        {#if s.arrow}<span class="stat-arrow">{#if s.arrow === 'down'}<ArrowDown size={12} class="brand" aria-hidden="true" />{:else}<ArrowUp size={12} class="brand-light" aria-hidden="true" />{/if}{s.x ?? ''}{#if s.x2}<span>{s.x2}</span>{/if}</span>{:else}{s.x ?? ''}{/if}
      </div>
    </div>
  {/each}
</div>
