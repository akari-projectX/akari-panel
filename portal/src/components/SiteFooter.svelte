<script lang="ts">
  import { site, siteName } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';

  /* 页脚：© 年份 站点名、站长写的页脚文字；条款 / 隐私（站长配了外链就用外链）与站长加的链接 */
  const b = $derived(site.options?.branding);
  const year = new Date().getFullYear();
  const links = $derived([
    { label: t('服务条款'), url: b?.tos_url || R.terms },
    { label: t('隐私政策'), url: b?.privacy_url || R.privacy },
    ...(b?.footer_links ?? []),
  ]);
  const external = (url: string) => /^https?:\/\//i.test(url);
</script>

<footer class="site">
  <div class="wrap">
    <span>© {year} {siteName()}{#if b?.footer_text} · {b.footer_text}{/if}</span>
    <nav aria-label={t('页脚')}>
      {#each links as l (l.url + l.label)}
        {#if external(l.url)}
          <a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>
        {:else}
          <a href={l.url}>{l.label}</a>
        {/if}
      {/each}
    </nav>
  </div>
</footer>
