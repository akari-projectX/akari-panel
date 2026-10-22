<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import { contentApi } from '@/api';
  import { detectPlatform } from '@/data/platforms';
  import { K } from '@/lib/cache';
  import { docCategories, guideLinkKey, type KbArticle } from '@/lib/doc-categories';
  import { formatMonthDay } from '@/lib/format';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import { PLATFORM_ICON } from '$lib/doc-icons';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { isUnread } from '$lib/read-state.svelte';
  import { resource } from '$lib/resource.svelte';
  import { loc, setParams } from '$lib/router.svelte';

  /*
   * 文档列表（行为同 React 门户 pages/dash/help.tsx 的 ListView）：搜索（面板 GET /me/help?q= 在服务端搜）、分类筛选（换行排开，
   * 不截断）、当前设备的捷径（有同名分类才出现；分类名已以「教程」结尾时不再重复）、「全部文档 · N 篇」小标题、文章列表。
   * 状态全在地址里：?cat= 分类、?q= 搜索词、?id= 打开文章（pages/Help.svelte 切到 Article）。
   * 版式按样稿的克制排版：筛选是文字 + 下划线，文章是细线分隔的行（标题、分类、更新日期，没读过的标蓝点），不用卡片。
   */
  const params = $derived(new URLSearchParams(loc.search));
  const q = $derived(params.get('q') ?? '');
  const cat = $derived(params.get('cat') ?? 'all');

  let kw = $state('');
  $effect(() => { kw = q; });

  const all = resource(() => ({ key: K.help(), fetch: () => contentApi.help() }));
  const found = resource(() => ({ key: K.help(q), fetch: () => contentApi.help(q || undefined), enabled: !!q }));
  const chapters = $derived(docCategories(all.data, i18n.locale, t('其他'), { mineFirst: false }));
  const total = $derived(chapters.reduce((n, c) => n + c.articles.length, 0));

  const hits = $derived(
    q ? new Set(docCategories(found.data, i18n.locale, t('其他')).flatMap((c) => c.articles.map((a) => a.id))) : null,
  );
  const shown = $derived(
    chapters
      .filter((c) => cat === 'all' || c.name === cat)
      .flatMap((c) => c.articles.filter((a) => !hits || hits.has(a.id)).map((a) => ({ a, c }))),
  );

  const device = detectPlatform();
  const DeviceIcon = PLATFORM_ICON[device.id];
  /* 当前设备：有同名分类就给「查看教程」；没有就不占位置（客户端下载在仪表盘） */
  const deviceChapter = $derived(chapters.find((c) => c.platform?.id === device.id));

  /* 筛选、搜索换的是同一页的一块：不回到页首 */
  const go = (next: Record<string, string | undefined>) => setParams(next, { keepScroll: true });
  const filter = (name: string) => go({ cat: name === 'all' ? undefined : name, q: q || undefined });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    go({ q: kw.trim() || undefined, cat: cat === 'all' ? undefined : cat });
  }

  function clearSearch() {
    kw = '';
    go({ cat: cat === 'all' ? undefined : cat });
  }

  const open = (a: KbArticle) => setParams({ id: a.id, cat: a.category, q: q || undefined });
</script>

<div class="ph">
  <div>
    <h1>{t('使用手册')}</h1>
    <p>{t('各设备的连接教程与常见问题。')}</p>
  </div>
</div>

<div class="top-tools">
  <form novalidate role="search" class="search" onsubmit={submit}>
    <Search class="search-i" size={16} strokeWidth={1.75} aria-hidden="true" />
    <input
      class="input"
      type="search"
      aria-label={t('搜索文档')}
      placeholder={t('搜索文档标题或内容…')}
      bind:value={kw}
    />
    {#if kw}
      <button type="button" class="iconbtn clear" aria-label={t('清除搜索')} onclick={clearSearch}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    {/if}
  </form>

  {#if chapters.length > 0}
    <nav aria-label={t('文档分类')} class="cats">
      <button type="button" aria-pressed={cat === 'all'} onclick={() => filter('all')}>{t('全部')}<em class="num">{total}</em></button>
      {#each chapters as c (c.name)}
        <button type="button" aria-pressed={cat === c.name} onclick={() => filter(c.name)}>{c.name}<em class="num">{c.articles.length}</em></button>
      {/each}
    </nav>
  {/if}

  {#if deviceChapter && !q && cat === 'all'}
    <p class="device">
      {#if DeviceIcon}<DeviceIcon size={15} strokeWidth={1.75} aria-hidden="true" />{/if}
      <span>{tp('你正在使用 {p}', { p: device.name })}</span>
      <span class="dot-sep" aria-hidden="true">·</span>
      <button type="button" class="link" onclick={() => filter(deviceChapter.name)}>
        {tp(guideLinkKey(deviceChapter.name), { p: deviceChapter.name })}<ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </p>
  {/if}

  {#if q}
    <div role="status" class="found">
      <span>{tp('关于「{q}」的搜索结果：找到 {n} 篇匹配文档', { q, n: found.data ? shown.length : 0 })}</span>
      <button type="button" class="link" onclick={clearSearch}>{t('清除搜索')}</button>
    </div>
  {/if}
</div>

<section aria-label={t('文档列表')} class="docs">
  {#if (all.loading && !all.data) || (q && found.loading && !found.data)}
    <Loading rows={4} />
  {:else if all.error && !all.data}
    <LoadError error={all.error} onretry={all.reload} />
  {:else if q && found.error && !found.data}
    <LoadError error={found.error} onretry={found.reload} />
  {:else if total === 0}
    <Empty title={t('暂无文档')} desc={t('站点知识库尚未发布使用指南。')} />
  {:else if shown.length === 0}
    <Empty title={t('未找到相关文档')} desc={t('请尝试使用其他关键词，或在上方选择不同的平台分类。')} />
  {:else}
    <h2 class="docs-h" data-testid="docs-heading">
      {tp('{c} · {n} 篇', { c: q ? t('搜索结果') : cat === 'all' ? t('全部文档') : cat, n: shown.length })}
    </h2>
    <div class="list">
      {#each shown as { a, c } (a.id)}
        {@const unread = isUnread(a.id)}
        <button type="button" class="li" onclick={() => open(a)}>
          <div class="main">
            <div class="t">
              <span class:read={!unread}>{a.title}</span>
              {#if unread}<i class="unread-dot" title={t('未读')}></i>{/if}
            </div>
            <p class="s">{c.name}</p>
          </div>
          <span class="r">{formatMonthDay(a.updated_at)}</span>
          <ChevronRight class="go" size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/each}
    </div>
  {/if}
</section>

<style>
  .top-tools { display: flex; flex-direction: column; gap: 16px; }
  .search { position: relative; max-width: 560px; }
  .search :global(.search-i) { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--faint); pointer-events: none; }
  .search .input { padding-left: 36px; padding-right: 40px; }
  .search .input::-webkit-search-cancel-button { display: none; }
  .clear { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); }

  .cats { display: flex; flex-wrap: wrap; gap: 6px 22px; padding-bottom: 2px; border-bottom: 1px solid var(--line); }
  .cats button {
    position: relative; display: inline-flex; align-items: baseline; gap: 6px; max-width: 100%; padding: 0 0 10px; border: 0; border-radius: 0;
    background: none; color: var(--muted); font: inherit; font-size: 13.5px; text-align: left; overflow-wrap: anywhere; cursor: pointer;
  }
  .cats button:hover { color: var(--fg); }
  .cats button[aria-pressed='true'] { color: var(--fg); font-weight: 600; }
  .cats button[aria-pressed='true']::after { content: ''; position: absolute; left: 0; right: 0; bottom: -3px; height: 2px; background: var(--brand); }
  .cats em { flex: none; font-style: normal; font-weight: 400; font-size: 12px; color: var(--faint); }

  .device { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 13.5px; color: var(--muted); }
  .device :global(svg) { flex: none; }
  .dot-sep { color: var(--faint); }
  .found { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; font-size: 13px; color: var(--muted); }

  .docs { margin-top: 40px; }
  .docs-h { margin-bottom: 12px; font-size: 15px; line-height: 24px; font-weight: 600; color: var(--fg); }
  .li :global(.go) { flex: none; color: var(--faint); }
  .li:hover :global(.go) { color: var(--brand); }
  .li .s { white-space: normal; }

  @media (max-width: 720px) {
    .docs { margin-top: 32px; }
    .li :global(.go) { display: none; }
  }
</style>
