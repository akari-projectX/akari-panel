<script lang="ts">
  import { sector } from '$lib/rechart';
  import ChartTip from './ChartTip.svelte';
  import Legend from './Legend.svelte';

  /* 线路分布（v1.4.0 recharts 环形图的手写 SVG 版）：内半径 60、外半径 94、扇区之间留 3 度，从 3 点钟起逆时针；图例在下面。 */
  type Slice = { name: string; value: number };
  let { slices }: { slices: Slice[] } = $props();

  const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];
  const H = 244; // 272 - 图例（一行 28）
  let width = $state(0);
  let active = $state<number | null>(null);
  let box: HTMLDivElement | undefined = $state();
  let pt = $state({ x: 0, y: 0 });

  const total = $derived(slices.reduce((s, x) => s + x.value, 0));
  const pad = $derived(slices.length > 1 ? 3 : 0);
  const arcs = $derived.by(() => {
    const room = 360 - slices.length * pad;
    let a = 0;
    return slices.map((s) => {
      const sweep = total > 0 ? (room * s.value) / total : 0;
      /* recharts：从 3 点钟起逆时针；sector() 的角度是从 3 点钟起逆时针 */
      const d = { a0: 90 - (a + sweep), a1: 90 - a };
      a += sweep + pad;
      return d;
    });
  });
  const cx = $derived(width / 2);
  const cy = H / 2;

  function over(e: PointerEvent, i: number) {
    const r = box?.getBoundingClientRect();
    if (!r) return;
    active = i;
    pt = { x: e.clientX - r.left + 10, y: Math.max(0, e.clientY - r.top - 10) };
  }
</script>

<div class="rch rc-pie" bind:this={box} bind:clientWidth={width}>
  {#if width > 0}
    <svg viewBox="0 0 {width} {H}" height={H} role="img" aria-label={slices.map((s) => s.name).join(', ')}>
      {#each slices as s, i (s.name)}
        <path
          d={sector(cx, cy, 60, 94, arcs[i].a0, Math.max(arcs[i].a0 + 0.01, arcs[i].a1))} fill={COLORS[i % COLORS.length]}
          onpointermove={(e) => over(e, i)} onpointerdown={(e) => over(e, i)} onpointerleave={() => { active = null; }}
          role="presentation"
        />
      {/each}
    </svg>
    <Legend items={slices.map((s, i) => ({ color: COLORS[i % COLORS.length], name: s.name }))} />
    {#if active !== null && slices[active]}
      <ChartTip label={slices[active].name} x={pt.x} y={pt.y} {width} items={[{ color: COLORS[active % COLORS.length], name: slices[active].name, value: slices[active].value.toLocaleString() }]} />
    {/if}
  {/if}
</div>
