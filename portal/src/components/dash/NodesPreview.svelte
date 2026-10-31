<script lang="ts">
  import type { MyNode } from '@/api';
  import { nodeLatency, nodeUp } from '@/lib/node';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import NodeTable from '../NodeTable.svelte';
  import Pager from '../flat/Pager.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 仪表盘的「线路」（外观 A，整宽）：线路表（components/NodeTable，与线路页共用），每页 5 条，至多两个入口标签。
   * 能连的排前面（延迟低的在上），维护中 / 离线的沉底置灰。
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
</script>

<section class="dsec dlines" aria-labelledby="h-lines">
  <div class="dsh">
    <h2 id="h-lines">{t('线路')}</h2>
    {#if full && nodes.data}<span class="dsh-sum tnum">{tp('{on} / {n} 在线', { on: online, n: nodes.data.length })}</span>{/if}
    {#if full}<a class="dsh-more" href={R.nodes}>{t('全部线路')} →</a>{/if}
  </div>

  {#if !full}
    <Empty title={t('线路暂不可用')} desc={t('续费或购买流量重置包后，线路会自动恢复。')} />
  {:else if nodes.loading && !nodes.data}
    <Loading />
  {:else if nodes.error && !nodes.data}
    <LoadError error={nodes.error} onretry={nodes.reload} />
  {:else if list.length === 0}
    <Empty title={t('订阅里还没有可用线路')} desc={t('套餐生效后线路会自动出现。')} />
  {:else}
    <NodeTable rows={paged} />
    {#if pages > 1}<Pager page={cur} {pages} onchange={(p) => (page = p)} meta={tp('第 {a} / {b} 页 · 共 {n} 条线路', { a: cur, b: pages, n: list.length })} />{/if}
  {/if}
</section>
