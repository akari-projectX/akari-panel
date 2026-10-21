<script lang="ts">
  import { brandUrl } from '@/api';
  import { site, siteName } from '$lib/auth.svelte';
  import { tp } from '$lib/i18n.svelte';

  /* 站长上传了品牌 Logo（PNG）就用图片，否则是站点名的文字 Logo（样稿的深色小块） */
  const logo = $derived(site.options?.branding?.logo_url);
</script>

{#if logo}
  <a class="logo-img" href="/" aria-label={tp('{site} 首页', { site: siteName() })}><img src={brandUrl(logo)} alt={siteName()} /></a>
{:else}
  <a class="logo" href="/" aria-label={tp('{site} 首页', { site: siteName() })}>{siteName()}</a>
{/if}
