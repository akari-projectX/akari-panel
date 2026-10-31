<script lang="ts">
  import type { MyTraffic } from '@/api';
  import { formatBytes } from '@/lib/format';
  import type { TrafficDay } from '@/lib/traffic';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import WeekChart from './WeekChart.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { thumb } from '$lib/thumb';

  /*
   * 仪表盘的「流量」（外观 A）：小标题 + 合计（↓ 下行 · ↑ 上行 · 计费）+ 7 / 30 天切换，下面一张柱图。
   * 数据由 Overview 取（默认 7 天，就是预取的那一份；切到 30 天才取 30 天）。
   */
  let { traffic, days, range = $bindable() }: { traffic: Resource<MyTraffic>; days: TrafficDay[]; range: 7 | 30 } = $props();

  const down = $derived(days.reduce((n, d) => n + d.downBytes, 0));
  const up = $derived(days.reduce((n, d) => n + d.upBytes, 0));
  const RANGES = [7, 30] as const;
</script>

<section class="dsec flow" aria-labelledby="h-flow">
  <div class="dsh">
    <h2 id="h-flow">{t('流量')}</h2>
    {#if traffic.data}
      <span class="wk-sum" title={tp('合计 {t}，其中下行 {d}、上行 {u}', { t: formatBytes(down + up), d: formatBytes(down), u: formatBytes(up) })}>{formatBytes(down + up)} · ↓ {formatBytes(down)} · ↑ {formatBytes(up)} · {t('计费')} {formatBytes(traffic.data.total.billed_bytes)}</span>
    {/if}
    <div class="seg-t" {@attach thumb} role="group" aria-label={t('时间范围')}>
      {#each RANGES as r (r)}
        <button type="button" aria-pressed={range === r} onclick={() => (range = r)}>{tp('{n} 天', { n: r })}</button>
      {/each}
    </div>
  </div>
  {#if traffic.loading && !traffic.data}
    <Loading block={200} />
  {:else if traffic.error && !traffic.data}
    <LoadError error={traffic.error} onretry={traffic.reload} />
  {:else if down + up === 0}
    <Empty title={tp('近 {n} 天还没有流量记录', { n: range })} desc={t('连上节点跑一会儿，这里就会有走势了。')} />
  {:else}
    <WeekChart week={days} />
  {/if}
</section>
