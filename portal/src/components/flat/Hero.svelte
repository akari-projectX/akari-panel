<script lang="ts">
  import type { Snippet } from 'svelte';

  /*
   * 首屏大数字（仪表盘「剩余流量」、商店「当前套餐」共用，design/portal-polish-2026-10）：
   * 左边 = 一行小标题（套餐名 + 状态）、等宽大数字 + 单位、40 格分段条、一行说明；右边 = 无边框的几行信息（细线分隔）。
   * meter 为空 = 不画分段条（不限流量 / 没有套餐）。
   */
  let { head, value, unit, meter, label, capL, capR, facts }: {
    head: Snippet;
    value: string;
    unit?: string;
    meter?: { pct: number; low: boolean } | null;
    /** 分段条的无障碍名字 */
    label?: string;
    capL?: string;
    capR?: string;
    facts?: Snippet;
  } = $props();

  const CELLS = 40;
  const filled = $derived(meter ? Math.round((Math.min(100, Math.max(0, meter.pct)) / 100) * CELLS) : 0);
</script>

<div class="hx">
  <div class="hx-main">
    <div class="hx-head">{@render head()}</div>
    <div class="hx-big"><span class="hx-v">{value}</span>{#if unit}<span class="hx-u">{unit}</span>{/if}</div>
    {#if meter}
      <div class={['hx-meter', meter.low && 'low']} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(meter.pct)}>
        {#each { length: CELLS } as _, i (i)}<i class={i < filled ? 'on' : ''}></i>{/each}
      </div>
    {/if}
    {#if capL || capR}<div class="hx-cap"><span>{capL ?? ''}</span><span>{capR ?? ''}</span></div>{/if}
  </div>
  {#if facts}<div class="facts">{@render facts()}</div>{/if}
</div>
