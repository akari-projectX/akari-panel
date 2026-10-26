<script lang="ts">
  import { NODES_REFRESH_MS, STATUS_TEXT } from '@/lib/node';
  import { t, tp } from '$lib/i18n.svelte';

  /* 图例（v1.4.0 NodeLegend）：三种状态的含义、负载与延迟怎么来的、多久刷新一次 */
  let { plain = false }: { plain?: boolean } = $props();
</script>

<div class={['nlegend', plain && 'plain']} data-node-legend>
  <div>
    <span class="nstate" data-node-status="online"><i></i>{t(STATUS_TEXT.online)}</span>
    <span class="nstate" data-node-status="offline"><i></i>{t(STATUS_TEXT.offline)}</span>
    <span class="nstate-w"><span class="nstate" data-node-status="maintenance"><i></i>{t(STATUS_TEXT.maintenance)}</span><span>{t('（暂停使用，订阅里暂时没有它）')}</span></span>
  </div>
  <p>{t('负载按节点的 CPU 与带宽占用分为低 / 中 / 高；延迟是面板到线路的连接测速，仅供参考。')}{tp('每 {n} 秒自动刷新。', { n: NODES_REFRESH_MS / 1000 })}</p>
</div>
