<script lang="ts">
  import '../styles/pages/traffic.css';
  import { meApi } from '@/api';
  import { K } from '@/lib/cache';
  import { addDays, formatBytes, monthStart, siteToday, trafficUsage } from '@/lib/format';
  import { ruleText, trafficByEntrance, trafficDays } from '@/lib/traffic';
  import WeekChart from '../components/dash/WeekChart.svelte';
  import DashSkeleton from '../components/DashSkeleton.svelte';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Section from '../components/flat/Section.svelte';
  import StatRow, { type Stat } from '../components/flat/StatRow.svelte';
  import Tabs from '../components/flat/Tabs.svelte';
  import { auth } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { downloadCsv, usageCsv } from '$lib/usage-csv';

  /*
   * 用量（只有 full 范围，外观 A，与仪表盘同一套零件）：页头一句「本期已用 X / Y GB」+ 右侧范围切换（本月 / 近 7 天 / 近 30 天）→
   * 三个数（今日、这段时间、计费）→ 每日柱图（仪表盘的 WeekChart：下行在下、上行叠在上面，今天加深）→ 按线路（此刻的倍率与时段规则）→
   * 明细（每天一行，右上「导出 CSV」）。数据：GET /me/traffic，日界按全站时区，换范围时先留着上一段。
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

  /* 明细的「导出 CSV」：就是页面上这段时间的每日数据（浏览器里生成，不另开接口） */
  function exportCsv() {
    const header = [t('日期'), t('下行（字节）'), t('上行（字节）'), t('合计（字节）'), t('计费（字节）'), t('合计（GB）'), t('计费（GB）')];
    downloadCsv(`usage-${from}-${to}.csv`, usageCsv(days, header));
  }

  const days = $derived(trafficDays(logs.data));
  const lines = $derived(trafficByEntrance(logs.data, t('其他（已隐藏或删除的线路）')));
  const total = (d: { upBytes: number; downBytes: number }) => d.upBytes + d.downBytes;
  const sum = $derived(days.reduce((n, d) => n + total(d), 0));

  const plan = $derived(auth.plan);
  const usage = $derived(trafficUsage(plan?.traffic_used_bytes ?? auth.me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? null));
  const lead = $derived(usage.unlimited
    ? tp('本期已用 {u} GB', { u: usage.used.toFixed(1) })
    : tp('本期已用 {u} / {t} GB', { u: usage.used.toFixed(1), t: Math.round(usage.total) }));

  /* 今天 = 范围的最后一天（范围总是截止到全站时区的今天）；和昨天比 */
  const today = $derived(days.at(-1));
  const yesterday = $derived(days.at(-2));
  const diffText = $derived.by(() => {
    if (!today || !yesterday) return '';
    const d = total(today) - total(yesterday);
    if (d === 0) return t('和昨天一样');
    return d > 0 ? tp('比昨天多 {v}', { v: formatBytes(d) }) : tp('比昨天少 {v}', { v: formatBytes(-d) });
  });
  const rangeLabel = $derived(t((RANGES.find((r) => r.id === range) ?? RANGES[0]).label));

  const stats = $derived<Stat[]>([
    { k: t('今日'), v: formatBytes(today ? total(today) : 0), x: diffText },
    { k: rangeLabel, v: formatBytes(sum), x: tp('日均 {v}', { v: formatBytes(sum / Math.max(1, days.length)) }) },
    {
      k: t('计费（含倍率）'), v: formatBytes(logs.data?.total.billed_bytes ?? 0),
      x: lines.length ? lines.slice(0, 2).map((l) => `${l.name} ×${l.rate ?? '—'}`).join(' · ') : t('（上行 + 下行）× 倍率'),
    },
  ]);

  /* 表格里的流量一律两位小数，列才对得齐 */
  const gb2 = (v: number) => `${v.toFixed(2)} GB`;
</script>

{#if logs.loading && !logs.data}
  <DashSkeleton hold={false} />
{:else if logs.error && !logs.data}
  <PageTitle title={t('流量明细')} />
  <LoadError error={logs.error} onretry={logs.reload} />
{:else}
  <PageTitle title={t('流量明细')} {lead} sub={logs.data ? tp('日期按 {tz} 计算。', { tz: logs.data.timezone }) : undefined}>
    {#snippet extra()}
      <Tabs inline idPrefix="range" label={t('时间范围')} value={range} onchange={(k) => (range = k as Range)} tabs={RANGES.map((r) => ({ key: r.id, label: t(r.label) }))} />
    {/snippet}
  </PageTitle>

  <div class="us-stats"><StatRow items={stats} /></div>

  {#if logs.data?.daily_since && logs.data.daily_since > from}
    <p class="kept">{tp('按天的明细只保留到 {d}，更早的日子显示为 0。', { d: logs.data.daily_since })}</p>
  {/if}

  <Section>
    {#snippet title()}{t('每日')}{/snippet}
    {#if sum <= 0}
      <Empty title={t('这段时间还没有流量记录')} desc={t('连接节点并产生流量后，这里会按天统计出来。')} />
    {:else}
      <div class="us-week">{#key range}<WeekChart week={days} />{/key}</div>
    {/if}
  </Section>

  {#if sum > 0 && lines.length > 0}
    <Section>
      {#snippet title()}{t('按线路')}{/snippet}
      {#snippet extra()}<span class="sec-x">{t('倍率是此刻生效的倍率')}</span>{/snippet}
      <div class="tbl-w">
        <table class="tbl flat-head">
          <thead>
            <tr>
              <th>{t('线路')}</th>
              <th class="r" style="width: 128px">{t('原始')}</th>
              <th class="r" style="width: 128px">{t('计费')}</th>
              <th class="r" style="width: 200px">{t('当前倍率')}</th>
            </tr>
          </thead>
          <tbody>
            {#each lines as l (l.name)}
              <tr>
                <td>{l.name}</td>
                <td class="tnum r">{gb2(l.value)}</td>
                <td class="tnum r">{gb2(l.billed)}</td>
                <td class="tnum r">
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

  {#if sum > 0}
    <Section>
      {#snippet title()}{t('明细')}<span class="sec-n">{tp('{d} 天的每日上下行流量', { d: days.length })}</span>{/snippet}
      {#snippet extra()}<button type="button" class="btn sm" onclick={exportCsv}>{t('导出 CSV')}</button>{/snippet}
      <div class="tbl-w">
        <table class="tbl flat-head">
          <thead>
            <tr>
              <th>{t('日期')}</th>
              <th class="r hide-sm-cell">{t('下行')}</th>
              <th class="r hide-sm-cell">{t('上行')}</th>
              <th class="r">{t('合计')}</th>
              <th class="r">{t('计费')}</th>
            </tr>
          </thead>
          <tbody>
            {#each [...days].reverse() as d (d.day)}
              <tr>
                <td class="tnum">{d.day}</td>
                <td class="tnum r hide-sm-cell">{gb2(d.down)}</td>
                <td class="tnum r hide-sm-cell">{gb2(d.up)}</td>
                <td class="tnum r">{gb2(d.down + d.up)}</td>
                <td class="tnum r" style="font-weight: var(--fw-strong)">{gb2(d.billed)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Section>
  {/if}
{/if}

<style>
  .us-stats { margin-top: 36px; }
  .kept { padding-top: 16px; font-size: 12.5px; color: var(--muted); }
  .rule-x { font-size: 12px; color: var(--muted); }
  .sec-n { margin-left: 12px; font-size: 12.5px; font-weight: var(--fw-regular); letter-spacing: 0; color: var(--faint); }
</style>
