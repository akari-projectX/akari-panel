<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { contentApi } from '@/api';
  import { K } from '@/lib/cache';
  import { docCategories } from '@/lib/doc-categories';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import { iconOf } from '$lib/doc-icons';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 使用文档：知识库的分类入口（与 React 门户相同的数据与顺序：lib/doc-categories，当前设备的分类排第一并标「当前设备」，
   * 没有分类的文章归到「其他」）。版式按样稿：两列细线列表，单色线性图标 + 分类名 + 篇数，点进文档页的该分类。最多 8 个。
   */
  const docs = resource(() => ({ key: K.help(), fetch: () => contentApi.help() }));
  const categories = $derived(docCategories(docs.data, i18n.locale, t('其他')));
</script>

<section class="sec" aria-labelledby="h-docs">
  <div class="sh">
    <div>
      <h2 id="h-docs">{t('使用文档')}</h2>
      <p>{categories.length ? tp('{n} 个分类', { n: categories.length }) : t('接入步骤与常见问题')}</p>
    </div>
    <a class="link" href={R.help}>{t('全部文档')}<ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /></a>
  </div>

  {#if docs.loading && !docs.data}
    <Loading rows={3} />
  {:else if docs.error && !docs.data}
    <LoadError error={docs.error} onretry={docs.reload} />
  {:else if categories.length === 0}
    <Empty title={t('站点还没有发布文档')} desc={t('站长在后台的「知识库」里发布文章后，这里就会有入口。')} />
  {:else}
    <div class="docs">
      {#each categories.slice(0, 8) as c (c.name)}
        {@const CatIcon = iconOf(c)}
        <a href="{R.help}?cat={encodeURIComponent(c.name)}">
          <CatIcon size={16} strokeWidth={1.75} aria-hidden="true" />
          <span>{c.name}{#if c.mine}<i class="here">{t('当前设备')}</i>{/if}</span>
          <em class="num">{c.articles.length === 1 ? t('1 篇') : tp('{n} 篇', { n: c.articles.length })}</em>
        </a>
      {/each}
    </div>
  {/if}
</section>

<style>
  .docs { display: grid; grid-template-columns: 1fr 1fr; column-gap: 24px; border-top: 1px solid var(--line); }
  .docs a { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 12px 0; border-bottom: 1px solid var(--line); color: var(--fg); }
  .docs a :global(svg) { flex: none; color: var(--muted); }
  .docs span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .docs em { flex: none; font-style: normal; font-size: 12.5px; color: var(--faint); }
  .docs a:hover span { color: var(--brand); }
  .here { margin-left: 6px; font-style: normal; font-size: 12px; color: var(--brand); }
  @media (max-width: 720px) {
    .docs { grid-template-columns: 1fr; }
  }
</style>
