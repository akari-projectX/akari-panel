<script lang="ts">
  import { site, siteName } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';

  /*
   * 页脚（外观 A · F1b）：一行巨大的空心站点名（只描边，装饰，读屏不念），下面一道细线 + 一行：
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
    <div class="bigw" aria-hidden="true" style:--n={Math.max(5, [...name].length)}>{name.toUpperCase()}</div>
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
