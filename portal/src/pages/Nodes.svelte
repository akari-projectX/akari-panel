<script lang="ts">
  import '../styles/pages/nodes.css';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Search from '@lucide/svelte/icons/search';
  import { meApi, type MyNode } from '@/api';
  import { K } from '@/lib/cache';
  import { formatRate, fromNow } from '@/lib/format';
  import { LOAD_TEXT, NODES_REFRESH_MS, STATUS_TEXT, nodeCC, nodeKey, nodeLatency, nodeUp, rateTone, sortTags, stripFlag } from '@/lib/node';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Flag from '../components/Flag.svelte';
  import Loading from '../components/Loading.svelte';
  import NodeLegend from '../components/NodeLegend.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Row from '../components/flat/Row.svelte';
  import Section from '../components/flat/Section.svelte';
  import StatRow from '../components/flat/StatRow.svelte';
  import { auth } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
    import { autoReload, resource } from '$lib/resource.svelte';

  /*
   * 线路（只有 full 范围，门禁在 App）。数据与行为同 React 门户 pages/dash/nodes.tsx：/me/nodes 每行是「节点 + 入口」，
   * 只有入口名、地区、标签、此刻的倍率、状态（在线 / 离线 / 维护中）、负载等级、延迟——不给节点或服务器名；每 30 秒刷新。
   * 默认按倍率从低到高（「哪条最省流量」最有用），宽屏点「流量倍率」列头切换；关键词搜入口名、地区、标签。
   * 设计：地区码等宽灰字代替国旗，状态 = 色点 + 文字，倍率纯文字右对齐；宽屏表格，窄屏一行一条。
   */
  const nodes = resource(() => ({ key: K.nodes, fetch: () => meApi.nodes() }));
  autoReload(() => nodes.reload(), NODES_REFRESH_MS, () => true);

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
  <span class="nstate" data-node-status={n.status}><i></i>{t(STATUS_TEXT[n.status])}</span>
{/snippet}

{#snippet load(n: MyNode)}
  {#if nodeUp(n) && n.load}<span class={['nload', n.load]} data-node-load={n.load}>{t(LOAD_TEXT[n.load])}</span>{/if}
{/snippet}

{#snippet rate(n: MyNode)}
  <span class={['rate', rateTone(n.rate)]}>×{formatRate(n.rate)}</span>
{/snippet}

<PageTitle title={t('节点状态')} sub={t('订阅内所有线路的实时状态。倍率越低，同样的流量能用得越久。')}>
  {#snippet extra()}
    <button type="button" class="btn" style="height: 36px" disabled={nodes.loading} onclick={() => nodes.reload()}>
      <RefreshCw class={nodes.loading ? 'turning' : ''} size={14} strokeWidth={1.75} aria-hidden="true" />{t('刷新')}
    </button>
  {/snippet}
</PageTitle>

<Section>
  <StatRow items={[
    { k: t('可用线路'), v: String(up), unit: t(' 条').trim(), x: t('可以直接连接') },
    { k: t('不可用'), v: String(down), unit: t(' 条').trim(), x: down > 0 ? t('客户端会自动跳过') : t('全部线路正常') },
    { k: t('最低倍率'), v: formatRate(cheapest), unit: '×', x: t('按此刻生效的倍率') },
    { k: t('延迟测速'), v: probeMinutes ? String(probeMinutes) : '—', unit: probeMinutes ? t(' 分钟一次').trim() : undefined, x: lastProbe ? tp('最近一次 {t}', { t: fromNow(lastProbe, tp) }) : t('暂无测速记录') },
  ]} />
</Section>

<Section>
  {#snippet title()}{t('全部线路')}{/snippet}
  <!-- 「点倍率列排序」只对宽屏的表格成立：手机上是列表，没有列头 -->
  {#snippet desc()}{#if shown.length}
    <span class="md-hide-i">{tp('共 {n} 条线路，按倍率从低到高排列', { n: shown.length })}</span>
    <span class="md-only-i">{tp('共 {n} 条线路，点击「倍率」列可切换排序', { n: shown.length })}</span>
  {/if}{/snippet}
  <NodeLegend plain />
  <div class="srch">
    <Search size={16} strokeWidth={1.75} aria-hidden="true" />
    <input class="input" type="text" bind:value={kw} placeholder={t('搜索线路、地区或标签')} aria-label={t('搜索线路、地区或标签')} />
  </div>

  {#if nodes.loading && !nodes.data}
    <Loading />
  {:else if nodes.error && !nodes.data}
    <LoadError error={nodes.error} onretry={nodes.reload} />
  {:else if all.length === 0}
    <Empty title={t('订阅里还没有线路')} desc={t('套餐生效后线路会自动出现。')} />
  {:else if shown.length === 0}
    <Empty title={t('没有匹配的线路')} desc={t('换个关键词试试。')} />
  {:else}
    <!-- 窄屏：一行一条线路，左边国旗 + 入口名 + 标签，右边倍率（不显示节点、服务器名） -->
    <div class="md-hide">
      {#each shown as n, i (nodeKey(n, i))}
        {@const cc = nodeCC(n)}
        {@const ok = nodeUp(n)}
        <Row first={i === 0} off={!ok}>
          {#snippet avatar()}{#if cc}<Flag {cc} w={22} h={15} />{:else}<span class="flag ph" style:width="22px" style:height="15px"></span>{/if}{/snippet}
          {#snippet title()}{stripFlag(n.entrance)}{/snippet}
          {#snippet desc()}
            <span style="display: flex; min-width: 0; align-items: center; gap: 8px">
              {#if n.tags.length > 0 || n.region}<span class="trunc">{[...sortTags(n.tags), ...(n.region ? [n.region] : [])].join(' · ')}</span>{/if}
              {@render state(n)}
              {#if ok}{@render load(n)}{/if}
            </span>
          {/snippet}
          {#snippet extra()}{@render rate(n)}{/snippet}
        </Row>
      {/each}
    </div>
    <div class="md-only tbl-w">
      <table class="tbl flat-head">
        <thead>
          <tr>
            <th style="min-width: 200px">{t('线路')}</th>
            <th style="width: 208px">{t('标签')}</th>
            <th style="width: 112px">{t('延迟')}</th>
            <th style="width: 112px" aria-sort={asc ? 'ascending' : 'descending'}>
              <button type="button" class="sortbtn" onclick={() => (asc = !asc)}>{t('流量倍率')} <span aria-hidden="true">{asc ? '↑' : '↓'}</span></button>
            </th>
            <th style="width: 96px">{t('状态')}</th>
          </tr>
        </thead>
        <tbody>
          {#each shown as n, i (nodeKey(n, i))}
            {@const cc = nodeCC(n)}
            <tr style:opacity={nodeUp(n) ? undefined : '.55'}>
              <td>
                <div style="display: flex; align-items: center; gap: 12px">
                  {#if cc}<Flag {cc} w={24} h={16} />{:else}<span class="flag ph" style:width="24px" style:height="16px"></span>{/if}
                  <div style="min-width: 0">
                    <div class="trunc" style="font-weight: 500">{stripFlag(n.entrance)}</div>
                    {#if n.region}<div style="font-size: 12.5px; color: var(--muted)">{n.region}</div>{/if}
                  </div>
                </div>
              </td>
              <td>
                {#if n.tags.length}<span class="tags">{#each sortTags(n.tags) as tg (tg)}<span>{tg}</span>{/each}</span>{:else}<span style="font-size: 13px; color: var(--muted)">—</span>{/if}
              </td>
              <td class="tnum" style="font-size: 14px">{#if latency(n)}{latency(n)}{:else}<span style="color: var(--muted)">{n.latency_status === 'timeout' ? t('超时') : '—'}</span>{/if}</td>
              <td>{@render rate(n)}</td>
              <td>
                <span style="display: flex; flex-direction: column; gap: 2px">
                  {@render state(n)}
                  {#if nodeUp(n)}{@render load(n)}{/if}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Section>
