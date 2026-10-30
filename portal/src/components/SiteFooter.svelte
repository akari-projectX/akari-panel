<script lang="ts">
  import { site, siteName } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';

  /*
   * 页脚（外观 A · F1b）：一行巨大的空心站点名（只描边，装饰，读屏不念），下面一道细线 + 一行：
   * 站点名就是默认的 Akari 时画 SVG 轮廓（Inter Black 的字形，门户不加载外部字体，系统字体又没有这么粗的字重）；
   * 站长改了站点名就用系统字体加粗描边的文字，跟着站点名变。
   * © 年份 站点名、站长写的页脚文字；条款 / 隐私（站长配了外链就用外链）与站长加的链接。
   */
  const b = $derived(site.options?.branding);
  const year = new Date().getFullYear();
  const name = $derived(siteName());
  const links = $derived([
    { label: t('服务条款'), url: b?.tos_url || R.terms },
    { label: t('隐私政策'), url: b?.privacy_url || R.privacy },
    ...(b?.footer_links ?? []),
  ]);
  const external = (url: string) => /^https?:\/\//i.test(url);
</script>

<footer class="site">
  <div class="wrap">
    {#if name.trim().toLowerCase() === 'akari'}
      <!-- 「AKARI」：Inter Black（SIL OFL 1.1）的字形轮廓，字距 −0.035em，由 fontTools + HarfBuzz 导出 -->
      <svg class="bigw-svg" viewBox="-8 -1498 6362 1506" aria-hidden="true" focusable="false">
        <path d="M0 0H452L534 -286H992L1078 0H1536L1035 -1490H483ZM620 -588C672 -770 714 -964 755 -1159C800 -964 848 -770 902 -588Z M1606 0H2010V-372L2194 -583L2543 0H3019L2470 -849L2991 -1490H2512L2216 -1107C2117 -978 2055 -887 2003 -791L2010 -1170V-1490H1606Z M3040 0H3492L3574 -286H4032L4118 0H4576L4075 -1490H3523ZM3660 -588C3712 -770 3754 -964 3795 -1159C3840 -964 3888 -770 3942 -588Z M4646 0H5050V-492H5190L5452 0H5892L5588 -556C5747 -632 5842 -777 5842 -984C5842 -1300 5620 -1490 5288 -1490H4646ZM5050 -806V-1166H5192C5335 -1166 5420 -1111 5420 -984C5420 -856 5335 -806 5192 -806Z M6346 -1490H5942V0H6346Z" />
      </svg>
    {:else}
      <div class="bigw" aria-hidden="true" style:--n={Math.max(5, [...name].length)}>{name.toUpperCase()}</div>
    {/if}
  </div>
  <div class="wrap"><div class="rule" aria-hidden="true"></div></div>
  <div class="wrap row2">
    <!-- 版权署站点名称（后台系统设置）。不显示后端版本号：等于告诉别人后端是什么 -->
    <span class="copy"><span>© {year} {name}</span>{#if b?.footer_text}<span class="extra">{b.footer_text}</span>{/if}</span>
    <nav aria-label={t('页脚')}>
      {#each links as l, i (l.url + l.label)}
        <span>
          {#if i > 0}<i aria-hidden="true"></i>{/if}
          {#if external(l.url)}
            <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>
          {:else}
            <a href={l.url}>{l.label}</a>
          {/if}
        </span>
      {/each}
    </nav>
  </div>
</footer>
