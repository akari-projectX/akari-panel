<script lang="ts">
  import '../styles/pages/traffic.css';
  import CloudDownload from '@lucide/svelte/icons/cloud-download';
  import PieIcon from '@lucide/svelte/icons/chart-pie';
  import { meApi } from '@/api';
  import { K } from '@/lib/cache';
  import { addDays, daysLeft, formatDate, monthStart, siteToday, toGB, trafficUsage } from '@/lib/format';
  import { ruleText, trafficByEntrance, trafficDays } from '@/lib/traffic';
  import AreaChart from '../components/charts/AreaChart.svelte';
  import BarChart from '../components/charts/BarChart.svelte';
  import Donut from '../components/charts/Donut.svelte';
  import DashSkeleton from '../components/DashSkeleton.svelte';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import PaneHead from '../components/flat/PaneHead.svelte';
  import Section from '../components/flat/Section.svelte';
  import Split from '../components/flat/Split.svelte';
  import StatRow, { type Stat } from '../components/flat/StatRow.svelte';
  import Tabs from '../components/flat/Tabs.svelte';
  import { auth } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { downloadCsv, usageCsv } from '$lib/usage-csv';

  /*
   * 使用明细（只有 full 范围）。指标行 → 流量走势（面积图，本月 / 近 7 天 / 近 30 天）→
   * 线路分布（环形图）| 每日计费流量（柱状图）→ 按线路 → 明细记录。数据：GET /me/traffic，日界按全站时区，换范围时先留着上一段。
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

  /* 明细记录的「导出 CSV」：就是页面上这段时间的每日数据（浏览器里生成，不另开接口） */
  function exportCsv() {
    const header = [t('日期'), t('下行（字节）'), t('上行（字节）'), t('合计（字节）'), t('计费（字节）'), t('合计（GB）'), t('计费（GB）')];
    downloadCsv(`usage-${from}-${to}.csv`, usageCsv(days, header));
  }

  const days = $derived(trafficDays(logs.data));
  const lines = $derived(trafficByEntrance(logs.data, t('其他（已隐藏或删除的线路）')));
  const totalDown = $derived(days.reduce((n, d) => n + d.down, 0));
  const totalUp = $derived(days.reduce((n, d) => n + d.up, 0));
  const sum = $derived(totalDown + totalUp);
  const maxDay = $derived(Math.max(1, ...days.map((d) => d.down + d.up)));

  const plan = $derived(auth.plan);
  const usage = $derived(trafficUsage(plan?.traffic_used_bytes ?? auth.me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? null));
  const nextReset = $derived(plan?.plan?.next_reset_at ?? null);
  const resetIn = $derived(daysLeft(nextReset));
  const billed = $derived(toGB(logs.data?.total.billed_bytes));

  const stats = $derived<Stat[]>([
    {
      k: t('套餐已用流量'), v: usage.used.toFixed(1), unit: usage.unlimited ? 'GB' : `/ ${Math.round(usage.total)} GB`,
      ...(usage.unlimited ? { x: t('套餐不限流量') } : { bar: { pct: usage.usedPct, low: false } }),
    },
    { k: t('下行'), v: totalDown.toFixed(1), unit: 'GB', arrow: 'down', x: t('占总流量'), x2: `${sum > 0 ? ((totalDown / sum) * 100).toFixed(0) : 0}%` },
    { k: t('上行'), v: totalUp.toFixed(1), unit: 'GB', arrow: 'up', x: t('日均'), x2: `${(totalUp / Math.max(1, days.length)).toFixed(1)} GB` },
    resetIn !== null
      ? { k: t('距离重置'), v: String(resetIn), unit: t('天'), x: tp('{d} 重置，计费 {b}', { d: formatDate(nextReset), b: `${billed.toFixed(1)}\u00a0GB` }) }
      : { k: t('计费流量'), v: billed.toFixed(1), unit: 'GB', x: t('（上行 + 下行）× 倍率') },
  ]);

  /* 表格里的流量一律两位小数，列才对得齐 */
  const gb2 = (v: number) => `${v.toFixed(2)} GB`;
</script>

{#if logs.loading && !logs.data}
  <DashSkeleton hold={false} />
{:else if logs.error && !logs.data}
  <PageTitle title={t('使用明细')} />
  <LoadError error={logs.error} onretry={logs.reload} />
{:else}
  <PageTitle
    title={t('使用明细')}
    lead={tp('这段时间用了 {v} GB', { v: sum.toFixed(1) })}
    sub={logs.data ? tp('上下行流量走势、线路分布与每日用量。日期按 {tz} 计算。', { tz: logs.data.timezone }) : t('上下行流量走势、线路分布与每日用量。')}
  />

  <Section><StatRow items={stats} /></Section>

  {#if logs.data?.daily_since && logs.data.daily_since > from}
    <p class="kept">{tp('按天的明细只保留到 {d}，更早的日子显示为 0。', { d: logs.data.daily_since })}</p>
  {/if}

  {#if sum <= 0}
    <Section>
      {#snippet title()}{t('流量走势')}{/snippet}
      <Empty title={t('这段时间还没有流量记录')} desc={t('连接节点并产生流量后，这里会按天统计出来。')} />
    </Section>
  {:else}
    <Section>
      {#snippet title()}<CloudDownload size={16} strokeWidth={1.75} aria-hidden="true" />{t('流量走势')}{/snippet}
      {#snippet desc()}<span>{tp('{a} 至 {b}，按天统计', { a: from, b: to })}</span>{/snippet}
      {#snippet extra()}
        <Tabs inline idPrefix="range" label={t('时间范围')} value={range} onchange={(k) => (range = k as Range)} tabs={RANGES.map((r) => ({ key: r.id, label: t(r.label) }))} />
      {/snippet}
      {#key range}
        <AreaChart rows={days.map((d) => ({ x: d.date, down: d.down, up: d.up }))} downLabel={t('下行流量')} upLabel={t('上行流量')} />
      {/key}
    </Section>

    <Section>
      <Split>
        {#snippet left()}
          <PaneHead>
            {#snippet title()}<PieIcon size={16} strokeWidth={1.75} aria-hidden="true" />{t('线路分布')}{/snippet}
            {#snippet desc()}{t('这段时间的流量落在各条线路上的比例（原始流量）')}{/snippet}
          </PaneHead>
          <Donut slices={lines.map((l) => ({ name: l.name, value: l.value }))} />
        {/snippet}
        {#snippet right()}
          <PaneHead>
            {#snippet title()}{t('每日计费流量')}{/snippet}
            {#snippet desc()}{t('（上行 + 下行）× 倍率，也就是真正扣掉的量')}{/snippet}
            {#snippet extra()}<span class="sec-x">{t('单位 GB')}</span>{/snippet}
          </PaneHead>
          <BarChart rows={days.map((d) => ({ x: d.date, v: d.billed }))} label={t('计费流量')} />
        {/snippet}
      </Split>
    </Section>

    {#if lines.length > 0}
      <Section>
        {#snippet title()}{t('按线路')}{/snippet}
        {#snippet desc()}{t('当前倍率是此刻生效的倍率；有时段倍率的线路按全站时区的时段计费')}{/snippet}
        <div class="tbl-w">
          <table class="tbl flat-head">
            <thead>
              <tr>
                <th>{t('线路')}</th>
                <th style="width: 128px">{t('原始')}</th>
                <th style="width: 128px">{t('计费')}</th>
                <th style="width: 160px">{t('当前倍率')}</th>
              </tr>
            </thead>
            <tbody>
              {#each lines as l (l.name)}
                <tr>
                  <td>{l.name}</td>
                  <td class="tnum">{gb2(l.value)}</td>
                  <td class="tnum">{gb2(l.billed)}</td>
                  <td class="tnum">
                    {l.rate != null ? `×${l.rate}` : '—'}
                    {#each l.rules as r, i (i)}<div class="rule-x">{ruleText(r, t)}</div>{/each}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </Section>
    {/if}

    <Section>
      {#snippet title()}{t('明细记录')}{/snippet}
      {#snippet desc()}{tp('{d} 天的每日上下行流量', { d: days.length })}{/snippet}
      {#snippet extra()}
        <button type="button" class="btn sm" onclick={exportCsv}>{t('导出 CSV')}</button>
      {/snippet}
      <div class="tbl-w">
        <table class="tbl flat-head">
          <thead>
            <tr>
              <th style="width: 128px">{t('日期')}</th>
              <th class="hide-sm-cell" style="width: 128px">{t('下行')}</th>
              <th class="hide-sm-cell" style="width: 128px">{t('上行')}</th>
              <th style="width: 128px">{t('合计')}</th>
              <th style="width: 128px">{t('计费')}</th>
              <th>{t('占比')}</th>
            </tr>
          </thead>
          <tbody>
            {#each [...days].reverse() as d (d.day)}
              <tr>
                <td class="tnum">{d.day}</td>
                <td class="tnum hide-sm-cell">{gb2(d.down)}</td>
                <td class="tnum hide-sm-cell">{gb2(d.up)}</td>
                <td class="tnum" style="font-weight: var(--fw-strong)">{gb2(d.down + d.up)}</td>
                <td class="tnum">{gb2(d.billed)}</td>
                <td>
                  <!-- 条长按当期最大单日归一，与右侧真实占比同向可比 -->
                  <div class="share-c">
                    <span class="prog hide-sm-cell" style="height: 6px; max-width: 180px" role="progressbar" aria-label={t('占比')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(((d.down + d.up) / maxDay) * 100)}><i style:transform="translateX(-{100 - ((d.down + d.up) / maxDay) * 100}%)"></i></span>
                    <span class="bdg brandbadge">{sum > 0 ? (((d.down + d.up) / sum) * 100).toFixed(1) : '0.0'}%</span>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Section>
  {/if}
{/if}

<style>
  .kept { margin: 0 0 0; padding-top: 16px; font-size: 12.5px; color: var(--muted); }
  .rule-x { font-size: 12px; color: var(--muted); }
  .share-c { display: flex; align-items: center; gap: 10px; }
  .share-c .prog { flex: 1; }
</style>
