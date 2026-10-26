<script lang="ts">
  import { niceTicks, tickMask } from '$lib/rechart';
  import { t } from '$lib/i18n.svelte';
  import ChartTip from './ChartTip.svelte';

  /* 每日计费流量（v1.4.0 recharts BarChart 的手写 SVG 版）：每天一根柱（上圆角 6），虚线网格，悬停时整列淡蓝底 + 提示。键盘同面积图。 */
  type Row = { x: string; v: number };
  let { rows, label }: { rows: Row[]; label: string } = $props();

  let width = $state(0);
  let active = $state<number | null>(null);
  let box: HTMLDivElement | undefined = $state();
  let pt = $state({ x: 0, y: 0 });

  const H = 272;
  const ML = 40;
  const MR = 5;
  const MT = 8;
  const MB = 30;
  const n = $derived(rows.length);
  const ticks = $derived(niceTicks(Math.max(0, ...rows.map((r) => r.v))));
  const top = $derived(ticks[ticks.length - 1]);
  const pw = $derived(Math.max(0, width - ML - MR));
  const ph = H - MT - MB;
  const band = $derived(n > 0 ? pw / n : 0);
  const Y = (v: number) => MT + ph - (v / top) * ph;
  const base = MT + ph;
  const bw = $derived(band * 0.8);
  const show = $derived(tickMask(n, band, 33));

  /* 上圆角 6（柱比 12 窄时取一半宽） */
  function bar(i: number, v: number) {
    const x = ML + band * i + band * 0.1;
    const h = base - Y(v);
    if (h <= 0) return '';
    const r = Math.min(6, bw / 2, h);
    return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + bw - r} Q${x + bw},${base - h} ${x + bw},${base - h + r} V${base} Z`;
  }
  function at(e: PointerEvent) {
    const r = box?.getBoundingClientRect();
    if (!r || n === 0) return;
    const i = Math.floor((e.clientX - r.left - ML) / band);
    active = i < 0 || i >= n ? null : i;
    pt = { x: e.clientX - r.left + 10, y: Math.max(0, e.clientY - r.top - 10) };
  }
  function key(e: KeyboardEvent) {
    const cur = active ?? n - 1;
    const next = e.key === 'ArrowLeft' ? cur - 1 : e.key === 'ArrowRight' ? cur + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (e.key === 'Escape') { active = null; return; }
    if (next === null) return;
    e.preventDefault();
    active = Math.max(0, Math.min(n - 1, next));
    pt = { x: ML + band * (active + 0.5) + 10, y: Y(rows[active].v) };
  }
</script>

<div
  class="rch rc-bar" bind:this={box} bind:clientWidth={width} role="slider" tabindex="0" aria-valuemin={1} aria-valuemax={n} aria-valuenow={(active ?? n - 1) + 1}
  aria-label={t('每日计费流量，用左右方向键逐日查看')}
  onkeydown={key} onblur={() => { active = null; }}
  onpointermove={at} onpointerdown={at} onpointerleave={(e) => { if (e.pointerType === 'mouse') active = null; }}
>
  {#if width > 0}
    <svg viewBox="0 0 {width} {H}" height={H} aria-hidden="true">
      {#each ticks as v (v)}
        <line class="rc-grid" x1={ML} x2={width - MR} y1={Y(v)} y2={Y(v)} />
        <text class="rc-t" x={ML - 8} y={Y(v) + 4} text-anchor="end">{v}</text>
      {/each}
      {#if active !== null}<rect x={ML + band * active} y={MT} width={band} height={ph} style="fill: color-mix(in srgb, var(--brand) 5%, transparent)" />{/if}
      {#each rows as r, i (i)}
        <path d={bar(i, r.v)} fill="var(--chart-1)" />
        {#if show[i]}<text class="rc-t" x={ML + band * (i + 0.5)} y={base + 18} text-anchor="middle">{r.x}</text>{/if}
      {/each}
    </svg>
    {#if active !== null && rows[active]}
      <ChartTip label={rows[active].x} x={pt.x} y={pt.y} {width} items={[{ color: 'var(--chart-1)', name: label, value: rows[active].v.toLocaleString() }]} />
    {/if}
  {/if}
</div>
