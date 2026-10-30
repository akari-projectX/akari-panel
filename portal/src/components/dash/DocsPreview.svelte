<script lang="ts">
  import { contentApi } from '@/api';
  import { K } from '@/lib/cache';
  import { docCategories } from '@/lib/doc-categories';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import { i18n, t } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 仪表盘的「教程」（外观 A，右栏）：细线列表，四篇文章，每行左边是分类名、右边是标题、→，点进文章。
   * 顺序同文档页：当前设备的分类排第一（lib/doc-categories），其余照后台的顺序。
   */
  const docs = resource(() => ({ key: K.help(), fetch: () => contentApi.help() }));
  const rows = $derived(docCategories(docs.data, i18n.locale, t('其他')).flatMap((c) => c.articles.map((a) => ({ a, c }))).slice(0, 4));
</script>

<section class="dsec" aria-labelledby="h-docs">
  <div class="dsh">
    <h2 id="h-docs">{t('教程')}</h2>
    <a class="dsh-more" href={R.help}>{t('全部教程')} →</a>
  </div>
  {#if docs.loading && !docs.data}
    <Loading rows={3} />
  {:else if docs.error && !docs.data}
    <LoadError error={docs.error} onretry={docs.reload} />
  {:else if rows.length === 0}
    <Empty title={t('站点还没有发布文档')} desc={t('站长在后台的「知识库」里发布文章后，这里就会有入口。')} />
  {:else}
    <div class="dlist">
      {#each rows as { a, c } (a.id)}
        <a class="drow doc" href={`${R.help}?id=${encodeURIComponent(a.id)}`}>
          <span class={['drow-k', c.mine && 'mine']} title={c.mine ? t('当前设备') : undefined}>{c.name}</span>
          <span class="drow-m"><b>{a.title}</b></span>
          <span class="drow-go" aria-hidden="true">→</span>
        </a>
      {/each}
    </div>
  {/if}
</section>
