<script lang="ts">
  import { t } from '$lib/i18n.svelte';

  /* PR 1：每个路由先是这一页（页面名 + 一行安静的说明），后续 PR 换成真页面 */
  let { title }: { title: string; params?: Record<string, string> } = $props();
</script>

<div class="ph">
  <div>
    <h1>{t(title)}</h1>
    <p class="quiet">{t('此页面迁移中')}</p>
  </div>
</div>
