<script lang="ts">
  import { encode } from 'uqr';
  import { t } from '$lib/i18n.svelte';

  /*
   * 订阅二维码：在浏览器里本地生成（uqr，几 kB，不出浏览器），画成一条 SVG path（同一行相邻的深色格子合成一段）。
   * 明暗两套主题都是白底深色码（--qr-paper / --qr-ink），扫码器只认得这种。<title> 给读屏（e2e 也用它找二维码）；
   * 订单页的付款码、收款地址码也用它（label 换成各自的说法）。
   */
  let { value, label, mark = false }: { value: string; label?: string; mark?: boolean } = $props();

  // mark：中心品牌标（v1.4.0 的 QR_MARK，26/112 大小、纠错 H、挖空对应格子）；直接画成内联 SVG 形状，不走 img（CSP img-src 'self'）。
  const qr = $derived(encode(value, { ecc: mark ? 'H' : 'M', border: 0 }));
  const hole = $derived.by(() => {
    if (!mark) return null;
    const n = qr.size, scale = 112 / n, w = 26 / scale, x = Math.floor((n - w) / 2), side = Math.ceil(w + ((n - w) / 2 - x));
    return { x, y: x, side, mx: (n - w) / 2, mw: w };
  });
  const inHole = (x: number, y: number) => !!hole && x >= hole.x && x < hole.x + hole.side && y >= hole.y && y < hole.y + hole.side;
  const d = $derived.by(() => {
    let out = '';
    qr.data.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (!row[x] || inHole(x, y)) continue;
        let w = 1;
        while (row[x + w] && !inHole(x + w, y)) w++;
        out += `M${x} ${y}h${w}v1h-${w}z`;
        x += w - 1;
      }
    });
    return out;
  });
</script>

<svg viewBox="0 0 {qr.size} {qr.size}" shape-rendering="crispEdges" role="img">
  <title>{label ?? t('订阅二维码')}</title>
  <path class="qr-d" {d} />
  {#if hole}
    <svg x={hole.mx} y={hole.mx} width={hole.mw} height={hole.mw} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" rx="7" fill="var(--qr-mark)" />
      <path d="M12 5 6.5 7.4v4.3c0 3.4 2.3 6.6 5.5 7.1 3.2-.5 5.5-3.7 5.5-7.1V7.4L12 5Z" fill="var(--qr-paper)" fill-opacity=".35" />
      <path d="m9.6 12.1 1.6 1.7 3.3-3.4" stroke="var(--qr-paper)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none" />
    </svg>
  {/if}
</svg>

<style>
  svg { display: block; width: 100%; height: 100%; }
  .qr-d { fill: var(--qr-ink); }
  svg svg { display: inline; width: auto; height: auto; }
</style>
