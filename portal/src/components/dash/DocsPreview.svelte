<script lang="ts">
  import BookOpen from '@lucide/svelte/icons/book-open';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { contentApi } from '@/api';
  import { K } from '@/lib/cache';
  import { docCategories } from '@/lib/doc-categories';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import PaneHead from '../flat/PaneHead.svelte';
  import { iconOf } from '$lib/doc-icons';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { navigate } from '$lib/router.svelte';
  import { resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 使用文档（v1.4.0 pages/dash/dashboard.tsx 的左栏）：第一个分类（当前设备的排第一）画成一张大卡（图标、名字、「当前设备」、篇数、
   * 「查看教程」、前三篇文章），其余分类（最多 6 个）三列图标格。数据与顺序与 lib/doc-categories 相同。
   */
  const docs = resource(() => ({ key: K.help(), fetch: () => contentApi.help() }));
  const categories = $derived(docCategories(docs.data, i18n.locale, t('其他')));
  const featured = $derived(categories[0]);
  const open = (name: string) => navigate(`${R.help}?cat=${encodeURIComponent(name)}`);
  const FIcon = $derived(featured ? iconOf(featured) : null);
</script>

<PaneHead>
  {#snippet title()}<BookOpen size={16} strokeWidth={1.75} aria-hidden="true" />{t('使用文档')}{/snippet}
  {#snippet desc()}{categories.length ? tp('{n} 个分类', { n: categories.length }) : t('接入步骤与常见问题')}{/snippet}
  {#snippet extra()}<a class="btn link-btn" href={R.help}>{t('全部文档')}</a>{/snippet}
</PaneHead>

{#if docs.loading && !docs.data}
  <Loading rows={3} />
{:else if docs.error && !docs.data}
  <LoadError error={docs.error} onretry={docs.reload} />
{:else if !featured || !FIcon}
  <Empty title={t('站点还没有发布文档')} desc={t('站长在后台的「知识库」里发布文章后，这里就会有入口。')} />
{:else}
  <button type="button" class="feat" onclick={() => open(featured.name)}>
    <div class="feat-h">
      <FIcon size={28} strokeWidth={1.75} aria-hidden="true" />
      <div class="feat-m">
        <div class="feat-t"><span>{featured.name}</span>{#if featured.mine}<i class="cur">{t('当前设备')}</i>{/if}</div>
        <div class="feat-s">
          {featured.articles.length === 1 ? t('1 篇') : tp('{n} 篇', { n: featured.articles.length })}{#if featured.mine && featured.platform} · {t(featured.platform.client)}{/if}
        </div>
      </div>
      <span class="feat-go">{t('查看教程')}<ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
    </div>
    <ol>
      {#each featured.articles.slice(0, 3) as a, i (a.id)}<li><span class="tnum">{i + 1}</span><span>{a.title}</span></li>{/each}
      {#if featured.articles.length > 3}<li class="more">{tp('还有 {n} 篇', { n: featured.articles.length - 3 })}</li>{/if}
    </ol>
  </button>

  {#if categories.length > 1}
    <div class="oth">
      <div class="oth-h">{t('其他分类')}</div>
      <div class="oth-g">
        {#each categories.slice(1, 7) as c (c.name)}
          {@const CIcon = iconOf(c)}
          <button type="button" onclick={() => open(c.name)}><CIcon size={20} strokeWidth={1.75} aria-hidden="true" /><span>{c.name}</span></button>
        {/each}
      </div>
    </div>
  {/if}
{/if}
