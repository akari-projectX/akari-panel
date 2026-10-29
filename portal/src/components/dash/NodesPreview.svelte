<script lang="ts">
  import Zap from '@lucide/svelte/icons/zap';
  import type { MyNode } from '@/api';
  import { formatRate } from '@/lib/format';
  import { LOAD_TEXT, STATUS_TEXT, nodeCC, nodeKey, nodeLatency, nodeUp, rateTone, stripFlag } from '@/lib/node';
  import Empty from '../Empty.svelte';
  import Flag from '../Flag.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import PaneHead from '../flat/PaneHead.svelte';
  import Pager from '../flat/Pager.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 订阅内的线路（design/portal-polish-2026-10）：一张细线表格，每页 5 条——线路（国旗 + 名称；地区名是国旗的读屏名称与悬停提示，认不出地区时留出国旗的位置）、状态、延迟（五格信号 + ms）、
   * 负载、倍率（颜色只看倍率）。能连的排前面（延迟低的在上），维护中 / 离线的沉底置灰。窄屏收起负载列。
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
  /* 延迟的五格信号：越快格越多（只是直观参考，数字在旁边） */
  const bars = (ms: number | null) => (ms == null ? 0 : ms < 60 ? 5 : ms < 120 ? 4 : ms < 200 ? 3 : ms < 350 ? 2 : 1);
</script>

<PaneHead>
  {#snippet title()}<Zap size={16} strokeWidth={1.75} aria-hidden="true" />{t('订阅内的线路')}{/snippet}
  {#snippet desc()}{full && nodes.data ? tp('{on} / {n} 在线', { on: online, n: nodes.data.length }) : t('订阅可用的线路')}{/snippet}
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
  <table class="ntbl">
    <thead><tr><th>{t('线路')}</th><th>{t('状态')}</th><th>{t('延迟')}</th><th class="nl">{t('负载')}</th><th class="nr">{t('倍率')}</th></tr></thead>
    <tbody>
      {#each paged as n, i (nodeKey(n, i))}
        {@const cc = nodeCC(n)}
        {@const up = nodeUp(n)}
        {@const ms = up ? nodeLatency(n) : null}
        <tr class={[!up && 'is-off']}>
          <td><span class="nname"><span class="nflag" role={cc ? 'img' : undefined} aria-label={cc ? (n.region ?? cc) : undefined} title={n.region ?? undefined}>{#if cc}<Flag {cc} w={18} h={12} />{/if}</span><span class="trunc">{stripFlag(n.entrance)}</span></span></td>
          <td><span class="nstate" data-node-status={n.status}><i></i>{t(STATUS_TEXT[n.status])}</span></td>
          <td><span class="nlat" aria-label={ms != null ? `${ms} ms` : t('未测')}><span class="sig" aria-hidden="true">{#each { length: 5 } as _, k (k)}<i class={k < bars(ms) ? 'on' : ''}></i>{/each}</span>{ms != null ? `${ms} ms` : '—'}</span></td>
          <td class="nl">{#if up && n.load}<span data-node-load={n.load}>{t(LOAD_TEXT[n.load])}</span>{:else}—{/if}</td>
          <td class="nr"><span class={['nrate', rateTone(n.rate)]}>×{formatRate(n.rate)}</span></td>
        </tr>
      {/each}
    </tbody>
  </table>
  <Pager page={cur} {pages} onchange={(p) => (page = p)} meta={tp('第 {a} / {b} 页 · 共 {n} 条线路', { a: cur, b: pages, n: list.length })} />
{/if}
