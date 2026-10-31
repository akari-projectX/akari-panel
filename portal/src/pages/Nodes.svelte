<script lang="ts">
  import '../styles/pages/nodes.css';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import { meApi } from '@/api';
  import { K } from '@/lib/cache';
  import { fromNow } from '@/lib/format';
  import { NODES_REFRESH_MS, nodeUp, sortTags } from '@/lib/node';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import NodeTable from '../components/NodeTable.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { autoReload, resource } from '$lib/resource.svelte';

  /*
   * 线路（外观 A，与仪表盘同一套零件；只有 full 范围，门禁在 App）。数据：/me/nodes 每行是「节点 + 入口」，
   * 只有入口名、地区、标签、此刻的倍率、状态（在线 / 离线 / 维护中）、负载等级、延迟——不给节点或服务器名；每 30 秒刷新。
   * 页头一句大字「N 条线路，M 条在线」，右侧刷新时间；下面一行标签筛选（全部 + 订阅里出现的入口标签）与倍率说明；
   * 一张线路表（components/NodeTable，与仪表盘的线路预览共用），默认按倍率从低到高（「哪条最省流量」最有用），点「倍率」列头切换；表下一行负载图例。
   */
  const nodes = resource(() => ({ key: K.nodes, fetch: () => meApi.nodes() }));
  autoReload(() => nodes.reload(), NODES_REFRESH_MS, () => true);

  /* 「刚刚 / N 分钟前刷新」：每次取回数据记一下时间，每 15 秒重画一次相对时间 */
  let syncedAt = $state<string | null>(null);
  let now = $state(Date.now());
  $effect(() => {
    if (nodes.data) syncedAt = new Date().toISOString();
  });
  $effect(() => {
    const id = setInterval(() => (now = Date.now()), 15_000);
    return () => clearInterval(id);
  });

  let tag = $state<string | null>(null);
  let asc = $state(true);

  const all = $derived(nodes.data ?? []);
  const up = $derived(all.filter(nodeUp).length);
  /* 筛选项 = 订阅里出现的入口标签（按标签的固定顺序），至多 6 个 */
  const tags = $derived(sortTags([...new Set(all.flatMap((n) => n.tags))]).slice(0, 6));
  const shown = $derived(
    all.filter((n) => !tag || n.tags.includes(tag)).sort((a, b) => (asc ? 1 : -1) * (a.rate - b.rate)),
  );
</script>

<PageTitle title={t('节点状态')} lead={nodes.data ? tp('{n} 条线路，{on} 条在线', { n: all.length, on: up }) : undefined}>
  {#snippet extra()}
    <span class="tnum">{tp('每 {n} 秒自动刷新', { n: NODES_REFRESH_MS / 1000 })}{#if syncedAt}{' · '}{fromNow(syncedAt, tp, now)}{/if}</span>
    <button type="button" class="ln-refresh" disabled={nodes.loading} onclick={() => nodes.reload()} aria-label={t('刷新')} title={t('刷新')}>
      <RefreshCw class={nodes.loading ? 'turning' : ''} size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
  {/snippet}
</PageTitle>

<div class="abar">
  {#if tags.length > 0}
    <div class="seg-t" role="group" aria-label={t('按标签筛选')}>
      <button type="button" aria-pressed={tag === null} onclick={() => (tag = null)}>{t('全部')}</button>
      {#each tags as x (x)}<button type="button" aria-pressed={tag === x} onclick={() => (tag = x)}>{x}</button>{/each}
    </div>
  {/if}
  <span class="abar-hint">{t('倍率 = 每 1 GB 实际计费多少 GB')}</span>
</div>

{#if nodes.loading && !nodes.data}
  <Loading />
{:else if nodes.error && !nodes.data}
  <LoadError error={nodes.error} onretry={nodes.reload} />
{:else if all.length === 0}
  <Empty title={t('订阅里还没有线路')} desc={t('套餐生效后线路会自动出现。')} />
{:else}
  <div class="ln-tbl">
    <NodeTable rows={shown} tags={3} sort={{ asc, flip: () => (asc = !asc) }} />
  </div>
  <div class="ln-legend" data-node-legend>
    <span><i class="lo"></i>{t('负载低')}</span>
    <span><i class="mid"></i>{t('负载中')}</span>
    <span><i class="hi"></i>{t('负载高')}</span>
    <span class="grow"></span>
    <span>{t('维护中的线路不会出现在订阅里')}</span>
  </div>
{/if}
