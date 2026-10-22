<script lang="ts">
  import { encode } from 'uqr';
  import { t } from '$lib/i18n.svelte';

  /*
   * 订阅二维码：在浏览器里本地生成（uqr，几 kB，不出浏览器），画成一条 SVG path（同一行相邻的深色格子合成一段）。
   * 明暗两套主题都是白底深色码（--qr-paper / --qr-ink），扫码器只认得这种。<title> 给读屏（e2e 也用它找二维码）。
   */
  let { value }: { value: string } = $props();

  const qr = $derived(encode(value, { ecc: 'M', border: 0 }));
  const d = $derived.by(() => {
    let out = '';
    qr.data.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (!row[x]) continue;
        let w = 1;
        while (row[x + w]) w++;
        out += `M${x} ${y}h${w}v1h-${w}z`;
        x += w - 1;
      }
    });
    return out;
  });
</script>

<svg viewBox="0 0 {qr.size} {qr.size}" shape-rendering="crispEdges" role="img">
  <title>{t('订阅二维码')}</title>
  <path {d} />
</svg>

<style>
  svg { display: block; width: 100%; height: 100%; }
  path { fill: var(--qr-ink); }
</style>
