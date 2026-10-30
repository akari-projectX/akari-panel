<script lang="ts">
  import { formatBytes } from '@/lib/format';
  import { weekAxis, type TrafficDay } from '@/lib/traffic';
  import { i18n, t, tp } from '$lib/i18n.svelte';

  /*
   * 仪表盘的流量柱图（7 / 30 天）：每天一根柱子，下行在下、上行叠在上面；7 天时柱顶写当天合计。
   * 纵轴有刻度和单位（按最大一天自动选 GB / MB / KB）；横轴每天两行：星期 + 月-日，最后一天写「今天」（30 天时每 5 天标一次）；
   * 悬停（鼠标）或点按（手机）一天出提示，键盘可以 Tab 到每一天。纯 HTML/CSS，不用图表库。
   */
  let { week }: { week: TrafficDay[] } = $props();

  let active = $state<number | null>(null);
  const max = $derived(Math.max(0, ...week.map((d) => d.upBytes + d.downBytes)));
  const axis = $derived(weekAxis(max));
  const top = $derived(axis.top * axis.size);
  const pct = (b: number) => (top > 0 ? (b / top) * 100 : 0);
  const n = $derived(week.length);

  /* 只用于显示：轴单位下的数值，最多一位小数 */
  const inUnit = (bytes: number, size: number) => {
    const v = bytes / size;
    return v >= 100 || v === 0 ? Math.round(v).toString() : (+v.toFixed(1)).toString();
  };
  /* 日子是 YYYY-MM-DD 的日历日：按 UTC 取星期，不再换算时区 */
  const weekday = $derived(new Intl.DateTimeFormat(i18n.locale === 'en' ? 'en-US' : 'zh-CN', { weekday: 'short', timeZone: 'UTC' }));
  const dayName = (d: TrafficDay, i: number) => (i === week.length - 1 ? t('今天') : weekday.format(new Date(`${d.day}T00:00:00Z`)));
  const tip = $derived(active !== null ? week[active] : null);
  /* 30 天时横轴太挤：只标今天和往前每 5 天，柱顶不写数 */
  const dense = $derived(n > 10);
  const labelled = (i: number) => !dense || (n - 1 - i) % 5 === 0;
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class={['wk', dense && 'dense']} onpointerleave={(e) => { if (e.pointerType === 'mouse') active = null; }}>
  <div class="wk-legend" aria-hidden="true">
    <span><i class="wk-key is-down"></i>{t('下行')}</span>
    <span><i class="wk-key is-up"></i>{t('上行')}</span>
    <span class="wk-unit">{tp('单位 {u}', { u: axis.unit })}</span>
  </div>

  <div class="wk-body">
    <div class="wk-y" aria-hidden="true">
      {#each axis.ticks as k (k)}<span style:bottom="{(k / axis.top) * 100}%">{k}</span>{/each}
    </div>

    <div class="wk-plot">
      {#each axis.ticks as k (k)}<i class={['wk-grid', k === 0 && 'is-base']} style:bottom="{(k / axis.top) * 100}%"></i>{/each}

      <div class="wk-cols" role="group" aria-label={tp('近 {n} 日流量，每天一项', { n })}>
        {#each week as d, i (d.day)}
          {@const total = d.upBytes + d.downBytes}
          <button
            type="button" class="wk-col" data-active={active === i || undefined} aria-pressed={active === i}
            aria-label={tp('{d}：下行 {down}，上行 {up}，合计 {total}', { d: `${dayName(d, i)} ${d.date}`, down: formatBytes(d.downBytes), up: formatBytes(d.upBytes), total: formatBytes(total) })}
            onpointerenter={(e) => { if (e.pointerType === 'mouse') active = i; }}
            onfocus={() => (active = i)}
            onblur={() => { if (active === i) active = null; }}
            onclick={() => (active = i)}
          >
            <span class="wk-stack" style:height="{pct(total)}%">
              {#if total > 0 && !dense}<small class="wk-total">{inUnit(total, axis.size)}</small>{/if}
              {#if d.upBytes > 0}<span class="wk-bar is-up" style:flex-grow={d.upBytes}></span>{/if}
              {#if d.downBytes > 0}<span class="wk-bar is-down" style:flex-grow={d.downBytes}></span>{/if}
            </span>
          </button>
        {/each}
      </div>

      {#if tip && active !== null}
        <div class="wk-tip" role="status" data-edge={active === 0 ? 'start' : active === n - 1 ? 'end' : undefined} style:left="{((active + 0.5) / n) * 100}%">
          <div class="wk-tip-h">{dayName(tip, active)} · {tip.date}</div>
          <dl>
            <div><dt><i class="wk-key is-down"></i>{t('下行')}</dt><dd>{formatBytes(tip.downBytes)}</dd></div>
            <div><dt><i class="wk-key is-up"></i>{t('上行')}</dt><dd>{formatBytes(tip.upBytes)}</dd></div>
            <div class="is-sum"><dt>{t('合计')}</dt><dd>{formatBytes(tip.upBytes + tip.downBytes)}</dd></div>
            <div><dt>{t('计费')}</dt><dd>{formatBytes(tip.billedBytes)}</dd></div>
          </dl>
        </div>
      {/if}
    </div>
  </div>

  <div class="wk-x" aria-hidden="true">
    {#each week as d, i (d.day)}
      <span class={[i === n - 1 && 'is-today', active === i && 'is-active']}>{#if labelled(i)}<b>{dayName(d, i)}</b><span>{d.date}</span>{/if}</span>
    {/each}
  </div>
</div>
