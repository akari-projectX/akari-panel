<script lang="ts">
  import { formatBytes } from '@/lib/format';
  import type { TrafficDay } from '@/lib/traffic';
  import { chartAxis, inUnit, labelled, smoothPath } from '$lib/chart';
  import { i18n, t, tp } from '$lib/i18n.svelte';

  /*
   * 流量走势：平滑面积图（用户 2026-10-22 选定，样稿 design/portal-v2-2026-10/chart.js + styles.css 的 .tchart）。
   * 手写 SVG，不用图表库：一条 2px 平滑的合计曲线、品牌色 16% → 0 的面积、今天的端点 + 数值、最高一天的数值、
   * 0 / 一半 / 顶三条细线、悬停（鼠标）或点按（触屏）出竖线 + 提示（下行 / 上行，另有合计、计费）。
   * 键盘：图本身是一个 slider（Tab 到它，← → Home End 逐日看，Esc 收起），读屏读每一天的说明。
   * 7 天与 30 天是同一个组件；日子是全站时区的日历日（面板切好），最后一天是今天。
   */
  let { days }: { days: TrafficDay[] } = $props();

  const uid = $props.id();
  let width = $state(0);
  let active = $state<number | null>(null);
  let svg: SVGSVGElement | undefined = $state();

  const mobile = $derived(width > 0 && width < 600);
  const H = $derived(mobile ? 200 : 240);
  const L = 28;
  const T = 28;
  const B = 36;
  const R = $derived(mobile ? 24 : 36);
  const W = $derived(Math.max(width, 240));
  const pw = $derived(W - L - R);
  const ph = $derived(H - B - T);

  const n = $derived(days.length);
  const totals = $derived(days.map((d) => d.upBytes + d.downBytes));
  const max = $derived(Math.max(0, ...totals));
  const axis = $derived(chartAxis(max));
  const X = (i: number) => (n > 1 ? L + (pw / (n - 1)) * i : L + pw / 2);
  const Y = (bytes: number) => T + ph - (axis.top > 0 ? bytes / axis.size / axis.top : 0) * ph;

  const line = $derived(smoothPath(totals.map((v, i) => [X(i), Y(v)] as const)));
  const area = $derived(n ? `${line} L${X(n - 1)},${Y(0)} L${X(0)},${Y(0)} Z` : '');
  const peak = $derived(totals.indexOf(max));
  const today = $derived(n - 1);
  const show = $derived(labelled(n, n <= 7 ? 1 : mobile ? 7 : 5));

  /* 日子是 YYYY-MM-DD 的日历日：按 UTC 取星期，不再换算时区 */
  const weekday = $derived(new Intl.DateTimeFormat(i18n.locale === 'en' ? 'en-US' : 'zh-CN', {
    weekday: mobile ? 'narrow' : 'short', timeZone: 'UTC',
  }));
  const dayName = (i: number) => (i === today ? t('今天') : weekday.format(new Date(`${days[i].day}T00:00:00Z`)));
  const xLabel = (i: number) => {
    if (n > 7) return i === today ? t('今天') : days[i].date;
    return mobile ? dayName(i) : `${dayName(i)} ${days[i].date}`;
  };
  const dayText = (i: number) => {
    const d = days[i];
    return tp('{d}：下行 {down}，上行 {up}，合计 {total}', {
      d: `${dayName(i)} ${d.date}`, down: formatBytes(d.downBytes), up: formatBytes(d.upBytes), total: formatBytes(totals[i]),
    });
  };

  function pick(e: PointerEvent) {
    const box = svg?.getBoundingClientRect();
    if (!box || n === 0) return;
    const step = n > 1 ? pw / (n - 1) : pw;
    active = Math.max(0, Math.min(n - 1, Math.round((e.clientX - box.left - L) / step)));
  }

  function leave(e: PointerEvent) {
    if (e.pointerType === 'mouse') active = null;
  }

  function key(e: KeyboardEvent) {
    const cur = active ?? today;
    const next = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? cur - 1
      : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? cur + 1
      : e.key === 'Home' ? 0 : e.key === 'End' ? today : null;
    if (e.key === 'Escape') { active = null; return; }
    if (next === null) return;
    e.preventDefault();
    active = Math.max(0, Math.min(today, next));
  }

  /* 提示框靠近右边时往左翻，靠近左边时往右翻（不出图） */
  const tipEdge = $derived(active === null ? '' : X(active) > W - 170 ? 'end' : X(active) < 150 ? 'start' : '');
</script>

<div
  class="tchart"
  bind:clientWidth={width}
  role="slider"
  tabindex="0"
  aria-label={t('流量走势，用左右方向键逐日查看')}
  aria-valuemin={1}
  aria-valuemax={n}
  aria-valuenow={(active ?? today) + 1}
  aria-valuetext={n ? dayText(active ?? today) : ''}
  onkeydown={key}
  onfocus={() => { active ??= today; }}
  onblur={() => { active = null; }}
>
  {#if width > 0 && n > 0}
    <svg bind:this={svg} viewBox="0 0 {W} {H}" height={H} aria-hidden="true">
      <defs>
        <linearGradient id="{uid}-wash" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" class="wash-top" />
          <stop offset="1" class="wash-end" />
        </linearGradient>
      </defs>
      {#each axis.ticks as v, k (k)}
        <line class={v === 0 ? 'base' : 'gridline'} x1={L} x2={W} y1={Y(v * axis.size)} y2={Y(v * axis.size)} />
        <text x={L - 8} y={Y(v * axis.size) + 4} text-anchor="end">{v}</text>
      {/each}
      <path d={area} fill="url(#{uid}-wash)" />
      <path class="curve" d={line} />
      {#if active !== null}
        <line class="cross" x1={X(active)} x2={X(active)} y1={T} y2={T + ph} />
        <circle class="dot" cx={X(active)} cy={Y(totals[active])} r="4.5" />
      {/if}
      <circle class="dot" cx={X(today)} cy={Y(totals[today])} r="4.5" />
      <text class="now" x={X(today)} y={Y(totals[today]) - 12} text-anchor="middle">{inUnit(totals[today], axis.size)} {axis.unit}</text>
      {#if peak !== today && max > 0}
        <text x={X(peak)} y={Y(max) - 12} text-anchor="middle">{inUnit(max, axis.size)}</text>
      {/if}
      {#each days as d, i (d.day)}
        {#if show[i]}
          <text class={i === today ? 'x now' : 'x'} x={X(i)} y={H - B + 22} text-anchor={i === today && n > 7 ? 'end' : 'middle'}>{xLabel(i)}</text>
        {/if}
      {/each}
      <rect
        class="hit" x={L} y={T} width={pw} height={ph} role="presentation"
        onpointermove={pick} onpointerdown={pick} onpointerleave={leave}
      />
    </svg>
  {/if}

  {#if active !== null && days[active]}
    {@const d = days[active]}
    <div class="ttip" role="status" data-edge={tipEdge || undefined} style:left="{X(active)}px" style:top="{Math.max(0, Y(totals[active]) - 16)}px">
      <div class="h"><b>{dayName(active)} {d.date}</b><span class="val">{formatBytes(totals[active])}</span></div>
      <div><i class="k-down"></i><span>{t('下行')}</span><span class="val">{formatBytes(d.downBytes)}</span></div>
      <div><i class="k-up"></i><span>{t('上行')}</span><span class="val">{formatBytes(d.upBytes)}</span></div>
      <div class="billed"><span>{t('计费')}</span><span class="val">{formatBytes(d.billedBytes)}</span></div>
    </div>
  {/if}
</div>

<style>
  .tchart { position: relative; margin-top: 4px; min-height: 200px; border-radius: 6px; touch-action: pan-y; }
  .tchart:focus-visible { outline: none; box-shadow: var(--focus); }
  svg { display: block; width: 100%; overflow: visible; }
  text { font: 12px var(--font-sans); fill: var(--chart-text); font-variant-numeric: tabular-nums; }
  text.now { fill: var(--fg); font-weight: var(--fw-strong); }
  .gridline { stroke: var(--chart-grid); stroke-width: 1; }
  .base { stroke: var(--chart-axis); stroke-width: 1; }
  .wash-top { stop-color: var(--chart-area); stop-opacity: var(--chart-area-opacity); }
  .wash-end { stop-color: var(--chart-area); stop-opacity: 0; }
  .curve { fill: none; stroke: var(--chart-line); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .cross { stroke: var(--chart-axis); stroke-width: 1; }
  .dot { fill: var(--chart-line); stroke: var(--chart-dot-ring); stroke-width: 2; }
  .hit { fill: transparent; cursor: crosshair; }

  .ttip {
    position: absolute; z-index: 5; pointer-events: none; transform: translate(-50%, -100%);
    min-width: 150px; padding: 8px 10px; border-radius: 8px; box-shadow: var(--pop-shadow);
    background: var(--chart-tip-bg); color: var(--chart-tip-fg); font-size: 12.5px; line-height: 1.6;
    white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  .ttip[data-edge='end'] { transform: translate(calc(-100% + 12px), -100%); }
  .ttip[data-edge='start'] { transform: translate(-12px, -100%); }
  .ttip div { display: flex; align-items: center; gap: 6px; }
  .ttip .val { margin-left: auto; padding-left: 16px; }
  .ttip .h { gap: 12px; margin-bottom: 2px; }
  .ttip b { font-weight: var(--fw-strong); }
  .ttip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
  .ttip .k-down { background: var(--chart-line); }
  .ttip .k-up { background: var(--chart-up); }
  .ttip .billed { opacity: .75; padding-left: 14px; }
</style>
