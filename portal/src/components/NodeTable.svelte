<script lang="ts">
  import type { MyNode } from '@/api';
  import { formatRate } from '@/lib/format';
  import { LOAD_TEXT, STATUS_TEXT, nodeCC, nodeKey, nodeLatency, nodeUp, rateTone, sortTags, stripFlag } from '@/lib/node';
  import Flag from './Flag.svelte';
  import { i18n, t } from '$lib/i18n.svelte';

  /*
   * 线路表（外观 A）：仪表盘的线路预览与线路页共用。一张细线表格：线路（国旗 + 名称 + 标签；按界面语言的地区名是国旗的读屏名称与悬停提示）、
   * 负载（小条 + 字）、延迟（五格信号 + ms）、倍率（颜色只看倍率）、状态（最右）。维护中 / 离线的置灰。窄屏收起负载列与标签（common.css）。
   * 行的顺序由调用处定；给了 sort 时「倍率」列头是一个切换升降序的按钮（aria-sort）。
   */
  let { rows, tags = 2, sort }: {
    rows: MyNode[];
    /** 每行至多显示几个入口标签 */
    tags?: number;
    sort?: { asc: boolean; flip: () => void };
  } = $props();

  const regionNames = $derived.by(() => {
    try {
      return new Intl.DisplayNames([i18n.locale === 'en' ? 'en' : 'zh-CN'], { type: 'region' });
    } catch {
      return null;
    }
  });
  const regionName = (cc: string, n: MyNode) => {
    try {
      return regionNames?.of(cc.toUpperCase()) ?? n.region ?? cc;
    } catch {
      return n.region ?? cc;
    }
  };

  /* 延迟的五格信号：越快格越多（只是直观参考，数字在旁边） */
  const bars = (ms: number | null) => (ms == null ? 0 : ms < 60 ? 5 : ms < 120 ? 4 : ms < 200 ? 3 : ms < 350 ? 2 : 1);
</script>

<table class="ntbl">
  <thead>
    <tr>
      <th>{t('线路')}</th><th class="nl">{t('负载')}</th><th>{t('延迟')}</th>
      {#if sort}
        <th class="nr" aria-sort={sort.asc ? 'ascending' : 'descending'}>
          <button type="button" class="sortbtn" onclick={sort.flip}>{t('倍率')} <span aria-hidden="true">{sort.asc ? '↑' : '↓'}</span></button>
        </th>
      {:else}
        <th class="nr">{t('倍率')}</th>
      {/if}
      <th class="nr">{t('状态')}</th>
    </tr>
  </thead>
  <tbody>
    {#each rows as n, i (nodeKey(n, i))}
      {@const cc = nodeCC(n)}
      {@const up = nodeUp(n)}
      {@const ms = up ? nodeLatency(n) : null}
      {@const region = cc ? regionName(cc, n) : undefined}
      {@const tg = sortTags(n.tags).slice(0, tags)}
      <tr class={[!up && 'is-off']}>
        <td>
          <span class="nname">
            <span class="nflag" role={cc ? 'img' : undefined} aria-label={region}>{#if cc}<Flag {cc} w={18} h={12} label={region} />{/if}</span>
            <span class="trunc">{stripFlag(n.entrance)}</span>
            {#if tg.length}<span class="ntags">{#each tg as x (x)}<span>{x}</span>{/each}</span>{/if}
          </span>
        </td>
        <td class="nl">{#if up && n.load}<span class="dload" data-node-load={n.load}><i aria-hidden="true"><b></b></i>{t(LOAD_TEXT[n.load])}</span>{:else}—{/if}</td>
        <td><span class="nlat" aria-label={ms != null ? `${ms} ms` : t('未测')}><span class="sig" aria-hidden="true">{#each { length: 5 } as _, k (k)}<i class={k < bars(ms) ? 'on' : ''}></i>{/each}</span>{ms != null ? `${ms} ms` : up && n.latency_status === 'timeout' ? t('超时') : '—'}</span></td>
        <td class="nr"><span class={['nrate', rateTone(n.rate)]}>×{formatRate(n.rate)}</span></td>
        <td class="nr"><span class="nstate" data-node-status={n.status}><i></i>{t(STATUS_TEXT[n.status])}</span></td>
      </tr>
    {/each}
  </tbody>
</table>
