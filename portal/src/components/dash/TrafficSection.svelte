<script lang="ts">
  import { meApi } from '@/api';
  import { K } from '@/lib/cache';
  import { addDays, formatBytes, siteToday } from '@/lib/format';
  import { trafficDays } from '@/lib/traffic';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import TrafficChart from './TrafficChart.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 流量走势（只有 full 范围：续费范围的账户面板不给流量记录）。7 天 / 30 天两档，都是 GET /me/traffic 的真实按天数据
   * （全站时区的日历日，今天算一天；面板允许 ≤ 366 天），缓存键与 React 门户相同（K.traffic(from, to)）。
   */
  let range = $state<7 | 30>(7);
  const to = siteToday();
  const from = $derived(addDays(to, -(range - 1)));
  const traffic = resource(() => ({ key: K.traffic(from, to), fetch: () => meApi.traffic(from, to) }));

  const days = $derived(trafficDays(traffic.data));
  const down = $derived(days.reduce((s, d) => s + d.downBytes, 0));
  const up = $derived(days.reduce((s, d) => s + d.upBytes, 0));
</script>

<section class="sec" aria-labelledby="h-traffic">
  <div class="sh">
    <div>
      <h2 id="h-traffic">{range === 7 ? t('近 7 日流量') : t('近 30 日流量')}</h2>
      {#if traffic.data}
        <p class="num">{tp('合计 {t}，其中下行 {d}、上行 {u}', { t: formatBytes(down + up), d: formatBytes(down), u: formatBytes(up) })}</p>
      {/if}
    </div>
    <div class="rng" role="group" aria-label={t('时间范围')}>
      <button type="button" aria-pressed={range === 7} onclick={() => (range = 7)}>{t('7 天')}</button>
      <button type="button" aria-pressed={range === 30} onclick={() => (range = 30)}>{t('30 天')}</button>
    </div>
  </div>

  {#if traffic.loading && !traffic.data}
    <Loading rows={4} height={240} />
  {:else if traffic.error && !traffic.data}
    <LoadError error={traffic.error} onretry={traffic.reload} />
  {:else if down + up === 0}
    <Empty
      title={range === 7 ? t('近 7 天还没有流量记录') : t('近 30 天还没有流量记录')}
      desc={t('连上节点跑一会儿，这里就会有走势了。')}
    />
  {:else}
    <TrafficChart {days} />
  {/if}

  {#if traffic.data}
    <p class="foot num">
      {t('计费')} <b>{formatBytes(traffic.data.total.billed_bytes)}</b> · {t('线路倍率已计入计费流量，见')}
      <a class="link" href={R.traffic}>{t('用量明细')}</a>
    </p>
  {/if}
</section>

<style>
  .rng { display: inline-flex; flex: none; gap: 2px; padding: 2px; border-radius: 8px; background: var(--chart-switch-bg); font-size: 12.5px; }
  .rng button { border: 0; background: none; padding: 2px 10px; border-radius: 6px; color: var(--muted); font: inherit; }
  .rng button:hover { color: var(--fg); }
  .rng button[aria-pressed='true'] { background: var(--chart-switch-on); color: var(--fg); box-shadow: var(--chart-switch-shadow); }
  .foot { margin-top: 20px; font-size: 12.5px; color: var(--faint); }
  .foot b { color: var(--body); font-weight: 500; }
  .foot .link { font-size: 12.5px; }
</style>
