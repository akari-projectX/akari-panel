<script lang="ts">
  import { monotonePath, niceTicks, tickMask } from '$lib/rechart';
  import { t } from '$lib/i18n.svelte';
  import ChartTip from './ChartTip.svelte';
  import Legend from './Legend.svelte';

  /*
   * 流量走势（v1.4.0 pages/dash/traffic.tsx 的 recharts AreaChart 的手写 SVG 版）：下行 / 上行两条 monotone 曲线 + 渐变面积，
   * 虚线网格、纵轴带单位 G、横轴首尾保留的标签、悬停出竖线 + 提示、底部图例。键盘：Tab 到图，← → Home End 逐日看，Esc 收起。
   */
  type Row = { x: string; down: number; up: number };
  let { rows, downLabel, upLabel, unit = 'G' }: { rows: Row[]; downLabel: string; upLabel: string; unit?: string } = $props();

  const uid = $props.id();
  let width = $state(0);
  let active = $state<number | null>(null);
  let box: HTMLDivElement | undefined = $state();
  let pt = $state({ x: 0, y: 0 });

  const H = 272; // 300 - 图例 28
  const ML = 40; // 纵轴 60 宽 + 左边距 -20
  const MR = 10;
  const MT = 8;
  const MB = 30;
  const n = $derived(rows.length);
  const ticks = $derived(niceTicks(Math.max(0, ...rows.flatMap((r) => [r.down, r.up]))));
  const top = $derived(ticks[ticks.length - 1]);
  const pw = $derived(Math.max(0, width - ML - MR));
  const ph = H - MT - MB;
  const X = (i: number) => (n > 1 ? ML + (pw / (n - 1)) * i : ML + pw / 2);
  const Y = (v: number) => MT + ph - (v / top) * ph;
  const base = MT + ph;
  const dl = $derived(monotonePath(rows.map((r, i) => [X(i), Y(r.down)] as const)));
  const ul = $derived(monotonePath(rows.map((r, i) => [X(i), Y(r.up)] as const)));
  const show = $derived(tickMask(n, n > 1 ? pw / (n - 1) : pw, 33));

  function at(e: PointerEvent) {
    const r = box?.getBoundingClientRect();
    if (!r || n === 0) return;
    const step = n > 1 ? pw / (n - 1) : pw;
    active = Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - ML) / step)));
    pt = { x: e.clientX - r.left + 10, y: Math.max(0, e.clientY - r.top - 10) };
  }
  function key(e: KeyboardEvent) {
    const cur = active ?? n - 1;
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (e.key === 'Escape') { active = null; return; }
    if (next === null) return;
    e.preventDefault();
    active = Math.max(0, Math.min(n - 1, next));
    pt = { x: X(active) + 10, y: Y(rows[active].down) };
  }
  const f2 = (v: number) => v.toLocaleString();
</script>

<div
  class="rch rc-area" bind:this={box} bind:clientWidth={width} role="slider" tabindex="0" aria-valuemin={1} aria-valuemax={n} aria-valuenow={(active ?? n - 1) + 1}
  aria-label={t('流量走势，用左右方向键逐日查看')}
  onkeydown={key} onblur={() => { active = null; }}
  onpointermove={at} onpointerdown={at} onpointerleave={(e) => { if (e.pointerType === 'mouse') active = null; }}
>
  {#if width > 0}
    <svg viewBox="0 0 {width} {H}" height={H} aria-hidden="true">
      <defs>
        <linearGradient id="{uid}-d" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--chart-1)" stop-opacity=".38" /><stop offset="100%" stop-color="var(--chart-1)" stop-opacity="0" /></linearGradient>
        <linearGradient id="{uid}-u" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--chart-2)" stop-opacity=".34" /><stop offset="100%" stop-color="var(--chart-2)" stop-opacity="0" /></linearGradient>
      </defs>
      {#each ticks as v (v)}
        <line class="rc-grid" x1={ML} x2={width - MR} y1={Y(v)} y2={Y(v)} />
        <text class="rc-t" x={ML - 8} y={Y(v) + 4} text-anchor="end">{v}{unit}</text>
      {/each}
      {#if active !== null}<line class="rc-cur" x1={X(active)} x2={X(active)} y1={MT} y2={base} />{/if}
      <path d="{ul} L{X(n - 1)},{base} L{X(0)},{base} Z" fill="url(#{uid}-u)" fill-opacity=".6" />
      <path d="{dl} L{X(n - 1)},{base} L{X(0)},{base} Z" fill="url(#{uid}-d)" fill-opacity=".6" />
      <path class="rc-ln" d={ul} stroke="var(--chart-2)" />
      <path class="rc-ln" d={dl} stroke="var(--chart-1)" />
      {#if active !== null}
        <circle cx={X(active)} cy={Y(rows[active].down)} r="4" fill="var(--chart-1)" />
        <circle cx={X(active)} cy={Y(rows[active].up)} r="4" fill="var(--chart-2)" />
      {/if}
      {#each rows as r, i (i)}
        {#if show[i]}<text class="rc-t" x={X(i)} y={base + 18} text-anchor="middle">{r.x}</text>{/if}
      {/each}
    </svg>
    <Legend items={[{ color: 'var(--chart-1)', name: downLabel }, { color: 'var(--chart-2)', name: upLabel }]} />
    {#if active !== null && rows[active]}
      <ChartTip
        label={rows[active].x} x={pt.x} y={pt.y} {width}
        items={[{ color: 'var(--chart-1)', name: downLabel, value: f2(rows[active].down) }, { color: 'var(--chart-2)', name: upLabel, value: f2(rows[active].up) }]}
      />
    {/if}
  {/if}
</div>
