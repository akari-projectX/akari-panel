<script lang="ts">
  import Zap from '@lucide/svelte/icons/zap';
  import type { MyNode } from '@/api';
  import { LOAD_TEXT, STATUS_TEXT, nodeCC, nodeKey, nodeLatency, nodeUp, sortTags, stripFlag } from '@/lib/node';
  import Empty from '../Empty.svelte';
  import Flag from '../Flag.svelte';
  import RateChip from '../RateChip.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import PaneHead from '../flat/PaneHead.svelte';
  import Pager from '../flat/Pager.svelte';
  import Row from '../flat/Row.svelte';
  import NodeLegend from '../NodeLegend.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 订阅内的线路（v1.4.0 pages/dash/dashboard.tsx 的右栏）：汇总三格（可用 / 平均延迟 / 覆盖地区）、状态图例、
   * 每页 5 条的线路行（国旗 + 名称 + 标签、状态 · 延迟 · 负载、倍率徽标）。能连的排前面（延迟低的在上），维护中 / 离线的沉底置灰。
   * 每 30 秒刷新（Overview 里的 autoReload）。续费范围：线路暂不可用。
   */
  let { nodes, full }: { nodes: Resource<MyNode[]>; full: boolean } = $props();

  const PAGE = 5;
  let page = $state(1);

  const list = $derived.by(() => {
    const all = nodes.data ?? [];
    const lat = (n: MyNode) => nodeLatency(n) ?? Number.POSITIVE_INFINITY;
    return [...all.filter(nodeUp).sort((a, b) => lat(a) - lat(b)), ...all.filter((n) => !nodeUp(n))];
  });
  const online = $derived(list.filter(nodeUp).length);
  const pages = $derived(Math.max(1, Math.ceil(list.length / PAGE)));
  const cur = $derived(Math.min(page, pages));
  const paged = $derived(list.slice((cur - 1) * PAGE, cur * PAGE));
  const regions = $derived([...new Set(list.map(nodeCC).filter((c): c is string => !!c))]);
  const avg = $derived.by(() => {
    const xs = list.filter(nodeUp).map(nodeLatency).filter((x): x is number => x != null);
    return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  });
</script>

<PaneHead>
  {#snippet title()}<Zap size={16} strokeWidth={1.75} aria-hidden="true" />{t('订阅内的线路')}{/snippet}
  {#snippet desc()}{full && nodes.data ? tp('{on} 条可用，共 {n} 条', { on: online, n: nodes.data.length }) : t('订阅可用的线路')}{/snippet}
  {#snippet extra()}{#if full}<a class="btn link-btn" href={R.nodes}>{t('全部线路')}</a>{/if}{/snippet}
</PaneHead>

{#if !full}
  <Empty title={t('线路暂不可用')} desc={t('续费或购买流量重置包后，线路会自动恢复。')} />
{:else if nodes.loading && !nodes.data}
  <Loading />
{:else if nodes.error && !nodes.data}
  <LoadError error={nodes.error} onretry={nodes.reload} />
{:else if list.length === 0}
  <Empty title={t('订阅里还没有可用线路')} desc={t('套餐生效后线路会自动出现。')} />
{:else}
  <div class="ns">
    <div>
      <div class="ns-n">{online}<span class="stat-unit">/ {list.length}</span></div>
      <div class="ns-k">{t('可用')}</div>
      {#if list.length <= 24}
        <div class="ns-bars">{#each list as n, i (nodeKey(n, i))}<i class={nodeUp(n) ? 'on' : ''}></i>{/each}</div>
      {:else}
        <div class="ns-prog"><i style:width="{(online / list.length) * 100}%"></i></div>
      {/if}
    </div>
    <div>
      <div class="ns-n">{avg ?? '—'}{#if avg != null}<span class="stat-unit">ms</span>{/if}</div>
      <div class="ns-k">{t('平均延迟')}</div>
    </div>
    <div>
      <div class="ns-n">{regions.length}<span class="stat-unit">{t('地区')}</span></div>
      <div class="ns-k">{t('覆盖')}</div>
      <div class="ns-flags">
        {#each regions.slice(0, 6) as cc (cc)}<Flag {cc} w={18} h={12} />{/each}
        {#if regions.length > 6}<span class="tnum">+{regions.length - 6}</span>{/if}
      </div>
    </div>
  </div>
  <NodeLegend />
  {#each paged as n, i (nodeKey(n, i))}
    {@const cc = nodeCC(n)}
    {@const up = nodeUp(n)}
    <Row off={!up}>
      {#snippet avatar()}{#if cc}<Flag {cc} w={22} h={15} />{:else}<span class="flag ph" style:width="22px" style:height="15px"></span>{/if}{/snippet}
      {#snippet title()}
        <span class="nt">{stripFlag(n.entrance)}{#if n.tags.length}<span class="tags">{#each sortTags(n.tags) as tg (tg)}<span>{tg}</span>{/each}</span>{/if}</span>
      {/snippet}
      {#snippet desc()}
        <span class="nd">
          <span class="nstate" data-node-status={n.status}><i></i>{t(STATUS_TEXT[n.status])}</span>
          {#if up && nodeLatency(n) != null}<span class="tnum">· {nodeLatency(n)} ms</span>{/if}
          {#if up && n.load}<span class={['nload', n.load]} data-node-load={n.load}>{t(LOAD_TEXT[n.load])}</span>{/if}
        </span>
      {/snippet}
      {#snippet extra()}<RateChip rate={n.rate} />{/snippet}
    </Row>
  {/each}
  <Pager page={cur} {pages} onchange={(p) => (page = p)} meta={tp('第 {a} / {b} 页 · 共 {n} 条线路', { a: cur, b: pages, n: list.length })} />
{/if}
