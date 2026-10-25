<script lang="ts">
  import { brandUrl } from '@/api';
  import { site, siteName } from '$lib/auth.svelte';
  import { tp } from '$lib/i18n.svelte';
  import Wordmark from './Wordmark.svelte';

  /*
   * 站长上传了品牌 Logo（PNG）就用图片（高 28px、最宽 200px，换标不会把导航撑变形；图片加载失败退回默认字标），
   * 否则是默认的 akari 字标。位置与 v1.4.0 相同：占 146px 宽、左对齐——导航不因换标而挪位置。
   */
  const logo = $derived(site.options?.branding?.logo_url);
  let broken = $state(false);
  $effect(() => { void logo; broken = false; });
</script>

<a class="logo" href="/" aria-label={tp('{site} 首页', { site: siteName() })}>
  {#if logo && !broken}<img src={brandUrl(logo)} alt="" onerror={() => (broken = true)} />{:else}<Wordmark />{/if}
</a>
