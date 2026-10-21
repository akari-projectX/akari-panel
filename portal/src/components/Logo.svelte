<script lang="ts">
  import { brandUrl } from '@/api';
  import { site, siteName } from '$lib/auth.svelte';
  import { tp } from '$lib/i18n.svelte';
  import Wordmark from './Wordmark.svelte';

  /* 站长上传了品牌 Logo（PNG）就用图片，否则是默认的 akari 字标 */
  const logo = $derived(site.options?.branding?.logo_url);
</script>

<a class="logo" href="/" aria-label={tp('{site} 首页', { site: siteName() })}>
  {#if logo}<img src={brandUrl(logo)} alt="" />{:else}<Wordmark />{/if}
</a>
