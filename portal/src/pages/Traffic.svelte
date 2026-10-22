<script lang="ts">
  import { meApi } from '@/api';
  import { K } from '@/lib/cache';
  import { addDays, daysLeft, formatDate, monthStart, siteToday, toGB, trafficUsage } from '@/lib/format';
  import { ruleText, trafficByEntrance, trafficDays } from '@/lib/traffic';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import TrafficChart from '../components/dash/TrafficChart.svelte';
  import { auth } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';

  /*
   * 用量明细（只有 full 范围）。数据与行为同 React 门户 pages/dash/traffic.tsx：范围 本月（默认，全站时区的自然月）/ 近 7 天 / 近 30 天，
   * GET /me/traffic（日界按全站时区，接口带 timezone），换范围时先留着上一段的数据（keep）。
   * 结构按新设计：关键数字 → 流量走势（仪表盘同一个平滑面积图，提示里有下行 / 上行 / 计费）→ 按线路（原始、占比细条、计费、
   * 此刻的倍率与时段规则；代替 React 的环形图与「线路分布」）→ 每日明细（合计、计费、占比）。每日计费量在明细表与图的提示里，不另画柱图。
   */
  type Range = 'month' | '7' | '30';
  const RANGES: { id: Range; label: string }[] = [
    { id: 'month', label: '本月' },
    { id: '7', label: '近 7 天' },
    { id: '30', label: '近 30 天' },
  ];

  let range = $state<Range>('month');
  const to = siteToday();
  const from = $derived(range === 'month' ? monthStart() : addDays(to, -(Number(range) - 1)));

  const logs = resource(() => ({ key: K.traffic(from, to), fetch: () => meApi.traffic(from, to), keep: true }));

  const days = $derived(trafficDays(logs.data));
  const lines = $derived(trafficByEntrance(logs.data, t('其他（已隐藏或删除的线路）')));
  const totalDown = $derived(days.reduce((n, d) => n + d.down, 0));
  const totalUp = $derived(days.reduce((n, d) => n + d.up, 0));
  const sum = $derived(totalDown + totalUp);
  const maxDay = $derived(Math.max(1, ...days.map((d) => d.down + d.up)));
  const linesTotal = $derived(lines.reduce((n, l) => n + l.value, 0));

  const plan = $derived(auth.plan);
  const usage = $derived(trafficUsage(plan?.traffic_used_bytes ?? auth.me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? null));
  const nextReset = $derived(plan?.plan?.next_reset_at ?? null);
  const resetIn = $derived(daysLeft(nextReset));
  const billed = $derived(toGB(logs.data?.total.billed_bytes));

  /* 表格里的流量一律两位小数，列才对得齐 */
  const gb2 = (v: number) => `${v.toFixed(2)} GB`;
  const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
</script>

<div class="ph">
  <div>
    <h1>{t('使用明细')}</h1>
    <p>{logs.data ? tp('上下行流量走势、线路分布与每日用量。日期按 {tz} 计算。', { tz: logs.data.timezone }) : t('上下行流量走势、线路分布与每日用量。')}</p>
  </div>
  <div class="rng" role="group" aria-label={t('时间范围')}>
    {#each RANGES as r (r.id)}
      <button type="button" aria-pressed={range === r.id} onclick={() => (range = r.id)}>{t(r.label)}</button>
    {/each}
  </div>
</div>

{#if logs.loading && !logs.data}
  <Loading rows={6} height={320} />
{:else if logs.error && !logs.data}
  <LoadError error={logs.error} onretry={logs.reload} />
{:else}
  <section class="kpis" aria-label={t('用量概况')}>
    <div class="kpi">
      <div class="lb">{t('套餐已用流量')}</div>
      <div class="v">{usage.used.toFixed(1)}<small>{usage.unlimited ? 'GB' : `/ ${Math.round(usage.total)} GB`}</small></div>
      {#if usage.unlimited}
        <div class="sub">{t('套餐不限流量')}</div>
      {:else}
        <div class="meter" role="meter" aria-label={t('套餐已用流量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.usedPct)}>
          <i style:width="{usage.usedPct}%"></i>
        </div>
      {/if}
    </div>
    <div class="kpi">
      <div class="lb">{t('下行')}</div>
      <div class="v">{totalDown.toFixed(1)}<small>GB</small></div>
      <div class="sub">{t('占总流量')} {pct(totalDown, sum).toFixed(0)}%</div>
    </div>
    <div class="kpi">
      <div class="lb">{t('上行')}</div>
      <div class="v">{totalUp.toFixed(1)}<small>GB</small></div>
      <div class="sub">{t('日均')} {(totalUp / Math.max(1, days.length)).toFixed(1)} GB</div>
    </div>
    {#if resetIn !== null}
      <div class="kpi">
        <div class="lb">{t('距离重置')}</div>
        <div class="v">{resetIn}<small>{t('天')}</small></div>
        <div class="sub">{tp('{d} 重置，计费 {b} GB', { d: formatDate(nextReset), b: billed.toFixed(1) })}</div>
      </div>
    {:else}
      <div class="kpi">
        <div class="lb">{t('计费流量')}</div>
        <div class="v">{billed.toFixed(1)}<small>GB</small></div>
        <div class="sub">{t('（上行 + 下行）× 倍率')}</div>
      </div>
    {/if}
  </section>

  {#if logs.data?.daily_since && logs.data.daily_since > from}
    <p class="kept">{tp('按天的明细只保留到 {d}，更早的日子显示为 0。', { d: logs.data.daily_since })}</p>
  {/if}

  <section class="sec" aria-labelledby="h-trend">
    <div class="sh">
      <div>
        <h2 id="h-trend">{t('流量走势')}</h2>
        <p class="num">{tp('{a} 至 {b}，按天统计', { a: from, b: to })}</p>
      </div>
    </div>
    {#if sum > 0}
      <TrafficChart {days} />
    {:else}
      <Empty title={t('这段时间还没有流量记录')} desc={t('连接节点并产生流量后，这里会按天统计出来。')} />
    {/if}
  </section>

  {#if sum > 0}
    {#if lines.length > 0}
      <section class="sec" aria-labelledby="h-lines">
        <div class="sh">
          <div>
            <h2 id="h-lines">{t('按线路')}</h2>
            <p>{t('当前倍率是此刻生效的倍率；有时段倍率的线路按全站时区的时段计费')}</p>
          </div>
        </div>
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>{t('线路')}</th>
                <th class="n d-only">{t('原始')}</th>
                <th class="n d-only">{t('占比')}</th>
                <th class="n">{t('计费')}</th>
                <th>{t('当前倍率')}</th>
              </tr>
            </thead>
            <tbody>
              {#each lines as l (l.name)}
                <tr>
                  <td class="strong">{l.name}</td>
                  <td class="n d-only">{gb2(l.value)}</td>
                  <td class="n d-only">
                    <span class="share"><span class="track"><i style:width="{pct(l.value, linesTotal)}%"></i></span>{pct(l.value, linesTotal).toFixed(1)}%</span>
                  </td>
                  <td class="n">{gb2(l.billed)}</td>
                  <td class="num">
                    {l.rate != null ? `×${l.rate}` : '—'}
                    {#each l.rules as r, i (i)}<div class="sub-l">{ruleText(r, t)}</div>{/each}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}

    <section class="sec" aria-labelledby="h-days">
      <div class="sh">
        <div>
          <h2 id="h-days">{t('明细记录')}</h2>
          <p>{tp('{d} 天的每日上下行流量', { d: days.length })}</p>
        </div>
      </div>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>{t('日期')}</th>
              <th class="n d-only">{t('下行')}</th>
              <th class="n d-only">{t('上行')}</th>
              <th class="n">{t('合计')}</th>
              <th class="n">{t('计费')}</th>
              <th class="n">{t('占比')}</th>
            </tr>
          </thead>
          <tbody>
            {#each [...days].reverse() as d (d.day)}
              <tr class={d.down + d.up > 0 ? '' : 'dim'}>
                <td class="when">{d.day}</td>
                <td class="n d-only">{gb2(d.down)}</td>
                <td class="n d-only">{gb2(d.up)}</td>
                <td class="n strong">{gb2(d.down + d.up)}</td>
                <td class="n">{gb2(d.billed)}</td>
                <td class="n">
                  <!-- 细条按当期最大单日归一，百分比是占这段时间合计的比例 -->
                  <span class="share"><span class="track d-only"><i style:width="{pct(d.down + d.up, maxDay)}%"></i></span>{pct(d.down + d.up, sum).toFixed(1)}%</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
{/if}

<style>
  .ph .rng { margin-bottom: 4px; }
  .kept { margin: -16px 0 24px; font-size: 12.5px; color: var(--muted); }
  @media (max-width: 720px) {
    .ph { flex-direction: column; align-items: flex-start; }
  }
</style>
