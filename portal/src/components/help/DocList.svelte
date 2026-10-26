<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import BookOpen from '@lucide/svelte/icons/book-open';
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
  import PageTitle from '../flat/PageTitle.svelte';
  import { iconOf, platformIcon } from '$lib/doc-icons';
  import DocIcon from '../DocIcon.svelte';
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
  const deviceIcon = platformIcon(device.icon);
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

<PageTitle title={t('使用手册')} sub={t('各设备的连接教程与常见问题。')} />

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
      <button type="button" aria-pressed={cat === 'all'} onclick={() => filter('all')}><BookOpen size={14} strokeWidth={1.75} aria-hidden="true" /><span>{t('全部')}</span><em class="tnum">{total}</em></button>
      {#each chapters as c (c.name)}
        <button type="button" aria-pressed={cat === c.name} onclick={() => filter(c.name)}><DocIcon spec={iconOf(c)} size={14} /><span>{c.name}</span><em class="tnum">{c.articles.length}</em></button>
      {/each}
    </nav>
  {/if}

  {#if deviceChapter && !q && cat === 'all'}
    <p class="device">
      <DocIcon spec={deviceIcon} size={15} />
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
      <button type="button" class="btn ghost sm clr" onclick={clearSearch}>{t('清除搜索')}</button>
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
    <h2 class="sub-title docs-h" data-testid="docs-heading">
      {tp('{c} · {n} 篇', { c: q ? t('搜索结果') : cat === 'all' ? t('全部文档') : cat, n: shown.length })}
    </h2>
    <div class="grid">
      {#each shown as { a, c } (a.id)}
        {@const unread = isUnread(a.id)}
        <button type="button" class="card" onclick={() => open(a)}>
          <div>
            <div class="ct">
              <span class="cn"><DocIcon spec={iconOf(c)} size={14} class="ci" />{c.name}</span>
              {#if unread}<i class="ud" title={t('未读')}></i>{/if}
            </div>
            <h4>{a.title}</h4>
          </div>
          <div class="cf">
            <span>{formatMonthDay(a.updated_at)}</span>
            <span class="rd">{t('阅读教程')}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
          </div>
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

  .cats { display: flex; flex-wrap: wrap; gap: 8px; }
  .cats button {
    display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 6px 14px; border: 1px solid var(--line); border-radius: 9999px;
    background: var(--surface); color: var(--muted); font: inherit; font-size: 13px; font-weight: var(--fw-strong); text-align: left; cursor: pointer; transition: color .15s, border-color .15s;
  }
  .cats button:hover { color: var(--fg); border-color: color-mix(in srgb, var(--brand) 40%, transparent); }
  .cats button[aria-pressed='true'] { border-color: var(--brand); background: var(--brand); color: var(--on-brand); }
  .cats span { min-width: 0; overflow-wrap: anywhere; }
  .cats em { flex: none; padding: 0 6px; border-radius: 9999px; background: var(--hover); font-style: normal; font-size: 11px; font-weight: var(--fw-regular); }
  .cats button[aria-pressed='true'] em { background: color-mix(in srgb, var(--on-brand) 20%, transparent); }

  .device { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 13.5px; color: var(--muted); }
  .device :global(svg) { flex: none; }
  .dot-sep { color: var(--faint); }
  .found { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; border-radius: calc(var(--radius) * 1.4); background: color-mix(in srgb, var(--hover) 50%, transparent); font-size: 13px; color: var(--muted); }
  .found .clr { height: 28px; padding: 0 8px; color: var(--brand); }
  .found .clr:hover { color: var(--brand-ink); }

  .top-tools { margin-top: 36px; }
  .docs { margin-top: 40px; }
  @media (min-width: 640px) { .docs { margin-top: 48px; } }
  .docs-h { margin-bottom: 16px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
  @media (min-width: 768px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 1024px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .card {
    display: flex; flex-direction: column; justify-content: space-between; padding: 16px; border: 1px solid color-mix(in srgb, var(--line) 80%, transparent); border-radius: 16px;
    background: var(--surface); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: transform .2s, box-shadow .2s, border-color .2s;
  }
  @media (min-width: 640px) { .card { padding: 20px; } }
  .card:hover { transform: translateY(-3px); border-color: color-mix(in srgb, var(--brand) 35%, transparent); box-shadow: var(--shadow-plan); }
  .ct { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .cn { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--muted); }
  .cn :global(.ci) { color: var(--brand); }
  .ud { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); }
  .card h4 { margin-top: 12px; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 15px; font-weight: var(--fw-strong); line-height: 1.375; transition: color .15s; }
  .card:hover h4 { color: var(--brand); }
  .cf { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; padding-top: 12px; border-top: 1px solid color-mix(in srgb, var(--line) 50%, transparent); font-size: 12px; line-height: 16px; color: var(--muted); }
  .rd { display: flex; align-items: center; gap: 4px; font-weight: var(--fw-strong); color: var(--brand); transition: transform .15s; }
  .card:hover .rd { transform: translateX(2px); }
</style>
