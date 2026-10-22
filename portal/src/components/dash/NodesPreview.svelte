<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { MyNode } from '@/api';
  import { formatRate } from '@/lib/format';
  import { LOAD_TEXT, NODES_REFRESH_MS, STATUS_TEXT, nodeCC, nodeKey, nodeLatency, nodeUp, sortTags, stripFlag } from '@/lib/node';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 订阅内的线路（样稿：地区码等宽灰字代替国旗、状态 = 色点 + 文字、倍率纯文字右对齐）。
   * 行为同 React 门户：能连的排前面（延迟低的在上），维护中 / 离线的沉底、置灰——也列出来，用户才知道哪条暂时用不了；
   * 每页 6 条可翻页；每 30 秒刷新（Overview 里的 autoReload）。续费范围：线路暂不可用。
   */
  let { nodes, full }: { nodes: Resource<MyNode[]>; full: boolean } = $props();

  const PAGE = 6;
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

  const stClass = (n: MyNode) => (n.status === 'online' ? 'ok' : n.status === 'maintenance' ? 'warn' : 'off');
  const multClass = (r: number) => (r <= 0.5 ? 'lo' : r > 1 ? 'hi' : '');
</script>

<section class="sec" aria-labelledby="h-lines">
  <div class="sh">
    <div>
      <h2 id="h-lines">{t('订阅内的线路')}</h2>
      <p>
        {#if full && nodes.data}
          {tp('{on} 条可用，共 {n} 条', { on: online, n: nodes.data.length })} · {tp('延迟为面板测得，每 {n} 秒刷新', { n: NODES_REFRESH_MS / 1000 })}
        {:else}
          {t('订阅可用的线路')}
        {/if}
      </p>
    </div>
    {#if full}<a class="link" href={R.nodes}>{t('全部线路')}<ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /></a>{/if}
  </div>

  {#if !full}
    <Empty title={t('线路暂不可用')} desc={t('续费或购买流量重置包后，线路会自动恢复。')} />
  {:else if nodes.loading && !nodes.data}
    <Loading rows={4} />
  {:else if nodes.error && !nodes.data}
    <LoadError error={nodes.error} onretry={nodes.reload} />
  {:else if list.length === 0}
    <Empty title={t('订阅里还没有可用线路')} desc={t('套餐生效后线路会自动出现。')} />
  {:else}
    <div class="list">
      {#each paged as n, i (nodeKey(n, (cur - 1) * PAGE + i))}
        {@const up = nodeUp(n)}
        {@const ms = nodeLatency(n)}
        <div class={up ? 'li' : 'li dim'} data-node-status={n.status}>
          <span class="rc">{nodeCC(n) ?? '—'}</span>
          <div class="main">
            <div class="t"><span>{stripFlag(n.entrance)}</span>{#each sortTags(n.tags) as tag (tag)}<i class="ntag">{tag}</i>{/each}</div>
          </div>
          <span class="st {stClass(n)}">
            {t(STATUS_TEXT[n.status])}{#if up && ms != null}&nbsp;· {ms} ms{/if}{#if up && n.load}<span class="ld">&nbsp;· <span class="load-{n.load}" data-node-load={n.load}>{t(LOAD_TEXT[n.load])}</span></span>{/if}
          </span>
          <span class="mult {up ? multClass(n.rate) : ''}">×{formatRate(n.rate)}</span>
        </div>
      {/each}
    </div>
    {#if pages > 1}
      <div class="pager">
        <span class="num">{tp('第 {a} / {b} 页 · 共 {n} 条线路', { a: cur, b: pages, n: list.length })}</span>
        <div>
          <button type="button" class="btn sm" disabled={cur <= 1} onclick={() => (page = cur - 1)}>{t('上一页')}</button>
          <button type="button" class="btn sm" disabled={cur >= pages} onclick={() => (page = cur + 1)}>{t('下一页')}</button>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .t .ntag { font-style: normal; }
  /* 窄屏：线路名优先，标签与负载让位（线路页有完整信息） */
  @media (max-width: 720px) {
    .t .ntag, .ld { display: none; }
  }
</style>
