<script lang="ts">
  import type { Snippet } from 'svelte';
  import SiteFooter from '../components/SiteFooter.svelte';
  import TopBar from '../components/TopBar.svelte';
  import { t } from '$lib/i18n.svelte';

  let { children }: { children: Snippet } = $props();
</script>

<a class="skip" href="#main">{t('跳到主要内容')}</a>
<TopBar />
<main id="main" class="wrap" tabindex="-1">
  {@render children()}
</main>
<SiteFooter />
