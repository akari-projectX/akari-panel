<script lang="ts">
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Search from '@lucide/svelte/icons/search';
  import { MediaQuery } from 'svelte/reactivity';
  import { meApi, type MyNode } from '@/api';
  import { K } from '@/lib/cache';
  import { formatRate, fromNow } from '@/lib/format';
  import { LOAD_TEXT, NODES_REFRESH_MS, STATUS_TEXT, nodeCC, nodeKey, nodeLatency, nodeUp, sortTags, stripFlag } from '@/lib/node';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import { auth } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { multClass, stClass } from '$lib/lines';
  import { autoReload, resource } from '$lib/resource.svelte';

  /*
   * 线路（只有 full 范围，门禁在 App）。数据与行为同 React 门户 pages/dash/nodes.tsx：/me/nodes 每行是「节点 + 入口」，
   * 只有入口名、地区、标签、此刻的倍率、状态（在线 / 离线 / 维护中）、负载等级、延迟——不给节点或服务器名；每 30 秒刷新。
   * 默认按倍率从低到高（「哪条最省流量」最有用），宽屏点「流量倍率」列头切换；关键词搜入口名、地区、标签。
   * 设计：地区码等宽灰字代替国旗，状态 = 色点 + 文字，倍率纯文字右对齐；宽屏表格，窄屏一行一条。
   */
  const nodes = resource(() => ({ key: K.nodes, fetch: () => meApi.nodes() }));
  autoReload(() => nodes.reload(), NODES_REFRESH_MS, () => true);

  const narrow = new MediaQuery('max-width: 720px');
  let kw = $state('');
  let asc = $state(true);

  const all = $derived(nodes.data ?? []);
  const shown = $derived.by(() => {
    const k = kw.trim().toLowerCase();
    return all
      .filter((n) => !k
        || n.entrance.toLowerCase().includes(k)
        || (n.region ?? '').toLowerCase().includes(k)
        || n.tags.some((x) => x.toLowerCase().includes(k)))
      .sort((a, b) => (asc ? 1 : -1) * (a.rate - b.rate));
  });

  const up = $derived(all.filter(nodeUp).length);
  const down = $derived(all.length - up);
  const cheapest = $derived(all.length ? Math.min(...all.map((n) => n.rate)) : 0);
  const lastProbe = $derived(all.reduce<string | null>(
    (max, n) => (n.latency_measured_at && (!max || n.latency_measured_at > max) ? n.latency_measured_at : max), null,
  ));
  const probeMinutes = $derived(auth.me ? Math.max(1, Math.round(auth.me.probe_interval_secs / 60)) : null);

  const latency = (n: MyNode) => {
    const ms = nodeLatency(n);
    return nodeUp(n) && ms != null ? `${ms} ms` : null;
  };
</script>

{#snippet state(n: MyNode)}
  <span class="st {stClass(n)}" data-node-status={n.status}>{t(STATUS_TEXT[n.status])}</span>
{/snippet}

{#snippet load(n: MyNode)}
  {#if nodeUp(n) && n.load}<span class="ld load-{n.load}" data-node-load={n.load}>{t(LOAD_TEXT[n.load])}</span>{/if}
{/snippet}

<div class="ph">
  <div>
    <h1>{t('节点状态')}</h1>
    <p>{t('订阅内所有线路的实时状态。倍率越低，同样的流量能用得越久。')}</p>
  </div>
  <button type="button" class="btn sm refresh" disabled={nodes.loading} onclick={() => nodes.reload()}>
    <RefreshCw class={nodes.loading ? 'turning' : ''} size={14} strokeWidth={1.75} aria-hidden="true" />{t('刷新')}
  </button>
</div>

<section class="kpis" aria-label={t('线路概况')}>
  <div class="kpi">
    <div class="lb">{t('可用线路')}</div>
    <div class="v">{nodes.data ? up : '—'}<small>{t('条')}</small></div>
    <div class="sub">{t('可以直接连接')}</div>
  </div>
  <div class="kpi">
    <div class="lb">{t('不可用')}</div>
    <div class="v">{nodes.data ? down : '—'}<small>{t('条')}</small></div>
    <div class="sub">{down > 0 ? t('客户端会自动跳过') : t('全部线路正常')}</div>
  </div>
  <div class="kpi">
    <div class="lb">{t('最低倍率')}</div>
    <div class="v">{formatRate(cheapest)}<small>×</small></div>
    <div class="sub">{t('按此刻生效的倍率')}</div>
  </div>
  <div class="kpi">
    <div class="lb">{t('延迟测速')}</div>
    <div class="v">{probeMinutes ?? '—'}{#if probeMinutes}<small>{t('分钟一次')}</small>{/if}</div>
    <div class="sub">{lastProbe ? tp('最近一次 {t}', { t: fromNow(lastProbe, tp) }) : t('暂无测速记录')}</div>
  </div>
</section>

<section class="sec" aria-labelledby="h-all">
  <div class="sh">
    <div>
      <h2 id="h-all">{t('全部线路')}</h2>
      {#if shown.length}
        <p>
          {narrow.current
            ? tp('共 {n} 条线路，按倍率从低到高排列', { n: shown.length })
            : tp('共 {n} 条线路，点击「倍率」列可切换排序', { n: shown.length })}
        </p>
      {/if}
    </div>
  </div>

  <div class="legend" data-node-legend>
    <p class="states">
      <span class="st ok">{t('在线')}</span>
      <span class="st off">{t('离线')}</span>
      <span><span class="st warn">{t('维护中')}</span>{t('（暂停使用，订阅里暂时没有它）')}</span>
    </p>
    <p>
      {t('负载按节点的 CPU 与带宽占用分为低 / 中 / 高；延迟是面板到线路的连接测速，仅供参考。')}{tp('每 {n} 秒自动刷新。', { n: NODES_REFRESH_MS / 1000 })}
    </p>
  </div>

  <label class="search">
    <Search size={15} strokeWidth={1.75} aria-hidden="true" />
    <input class="input" type="search" bind:value={kw} placeholder={t('搜索线路、地区或标签')} aria-label={t('搜索线路、地区或标签')} />
  </label>

  {#if nodes.loading && !nodes.data}
    <Loading rows={5} />
  {:else if nodes.error && !nodes.data}
    <LoadError error={nodes.error} onretry={nodes.reload} />
  {:else if all.length === 0}
    <Empty title={t('订阅里还没有线路')} desc={t('套餐生效后线路会自动出现。')} />
  {:else if shown.length === 0}
    <Empty title={t('没有匹配的线路')} desc={t('换个关键词试试。')} />
  {:else if narrow.current}
    <div class="list">
      {#each shown as n, i (nodeKey(n, i))}
        {@const ok = nodeUp(n)}
        {@const meta = [...sortTags(n.tags), ...(n.region ? [n.region] : [])].join(' · ')}
        <div class={ok ? 'li' : 'li dim'}>
          <span class="rc">{nodeCC(n) ?? '—'}</span>
          <div class="main">
            <div class="t"><span>{stripFlag(n.entrance)}</span></div>
            <p class="s m-meta">
              {#if meta}<span class="m-tags">{meta}</span>{/if}
              {@render state(n)}{#if latency(n)}<span class="num">{latency(n)}</span>{/if}{@render load(n)}
            </p>
          </div>
          <span class="mult {ok ? multClass(n.rate) : ''}">×{formatRate(n.rate)}</span>
        </div>
      {/each}
    </div>
  {:else}
    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>{t('线路')}</th>
            <th>{t('标签')}</th>
            <th>{t('延迟')}</th>
            <th class="n" aria-sort={asc ? 'ascending' : 'descending'}>
              <button type="button" class="sort" onclick={() => (asc = !asc)}>{t('流量倍率')} <span aria-hidden="true">{asc ? '↑' : '↓'}</span></button>
            </th>
            <th>{t('状态')}</th>
          </tr>
        </thead>
        <tbody>
          {#each shown as n, i (nodeKey(n, i))}
            {@const ok = nodeUp(n)}
            <tr class={ok ? '' : 'dim'}>
              <td>
                <div class="line">
                  <span class="rc">{nodeCC(n) ?? '—'}</span>
                  <div>
                    <div class="strong">{stripFlag(n.entrance)}</div>
                    {#if n.region}<div class="sub-l">{n.region}</div>{/if}
                  </div>
                </div>
              </td>
              <td>
                {#if n.tags.length}
                  <span class="tags">{#each sortTags(n.tags) as tag (tag)}<i class="ntag">{tag}</i>{/each}</span>
                {:else}<span class="q">—</span>{/if}
              </td>
              <td class="num">{latency(n) ?? (n.latency_status === 'timeout' ? t('超时') : '—')}</td>
              <td class="n"><span class="mult {ok ? multClass(n.rate) : ''}">×{formatRate(n.rate)}</span></td>
              <td><span class="state">{@render state(n)}{@render load(n)}</span></td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .ph .refresh { flex: none; margin-bottom: 4px; }
  .ph .refresh :global(.turning) { animation: spin .9s linear infinite; }

  .legend { display: flex; flex-direction: column; gap: 4px; margin: -8px 0 16px; font-size: 12.5px; line-height: 1.7; color: var(--muted); }
  .states { display: flex; flex-wrap: wrap; gap: 4px 16px; }
  .states .st { margin-right: 4px; }

  .search { position: relative; display: block; max-width: 480px; margin-bottom: 8px; color: var(--faint); }
  .search :global(svg) { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; }
  .search .input { height: 36px; padding-left: 36px; }

  .line { display: flex; align-items: flex-start; gap: 12px; }
  .line .rc { padding-top: 4px; }
  .tags { display: inline-flex; flex-wrap: wrap; gap: 6px; }
  .ntag { font-style: normal; }
  .state { display: inline-flex; flex-direction: column; gap: 2px; }
  .ld { font-size: 12.5px; white-space: nowrap; }
  .tbl .mult { width: auto; }

  .m-meta { display: flex; align-items: center; gap: 8px; }
  .m-tags { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .m-meta > :global(*) { flex: none; }
  .m-meta > .m-tags { flex: 0 1 auto; }

  @media (prefers-reduced-motion: reduce) {
    .ph .refresh :global(.turning) { animation-duration: 2s; }
  }
  @media (max-width: 720px) {
    .search { max-width: none; }
  }
</style>
