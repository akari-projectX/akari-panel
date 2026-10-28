<script lang="ts">
  import { formatRate } from '@/lib/format';
  import { rateTone } from '@/lib/node';
  /* 倍率徽标（线路页与仪表盘的线路预览共用）：颜色只看倍率；不可用的线路由所在行整体置灰 */
  let { rate }: { rate: number } = $props();
</script>

<span class={['rate', rateTone(rate)]}>×{formatRate(rate)}</span>
