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
  import { R } from '$lib/routes';

  /*
   * 文档列表：搜索（面板 GET /me/help?q= 在服务端搜）、分类筛选（换行排开，
   * 不截断）、当前设备的捷径（有同名分类才出现；分类名已以「教程」结尾时不再重复）、「全部文档 · N 篇」小标题、文章列表。
   * 状态全在地址里：?cat= 分类、?q= 搜索词、?id= 打开文章（pages/Help.svelte 切到 Article）。
   * 版式（外观 A）：大号搜索框、分类胶囊（换行排开）、「全部」是每个分类一栏的细线格子，选了分类或搜索时是文章格子（没读过的标蓝点）；最下面一行「找不到答案？提交工单」。
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

<PageTitle title={t('使用指南')} lead={t('有什么可以帮你？')} />

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
    {#if !q && cat === 'all'}
      <!-- 全部文档（外观 A）：每个分类一栏，栏头是分类名，下面是文章标题；栏与栏之间细线 -->
      <div class="cols">
        {#each chapters as c (c.name)}
          <div class="col">
            <h3 class="col-h"><DocIcon spec={iconOf(c)} size={14} class="ci" />{c.name}</h3>
            {#each c.articles as a (a.id)}
              <button type="button" class="card col-a" onclick={() => open(a)}>
                <span>{a.title}</span>{#if isUnread(a.id)}<i class="ud" title={t('未读')}></i>{/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
    {:else}
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
  {/if}
</section>

<!-- 找不到答案就去提交工单（工单对所有能进这一页的账户都开着） -->
<p class="ask">{t('找不到答案？')}<a href={R.tickets}>{t('提交工单')}</a></p>

<style>
  .ask { margin-top: 28px; font-size: 13.5px; color: var(--muted); }
  .ask a { margin-left: 4px; font-weight: var(--fw-strong); color: var(--brand); }
  .ask a:hover { text-decoration: underline; text-underline-offset: 3px; }
  .top-tools { display: flex; flex-direction: column; gap: 16px; }
  .search { position: relative; }
  .search :global(.search-i) { position: absolute; left: 16px; top: 50%; transform: translateY(-50%); color: var(--faint); pointer-events: none; }
  .search .input { height: 56px; padding-left: 40px; padding-right: 44px; border-radius: 999px; background: none; font-size: 15px; }
  .search .input::-webkit-search-cancel-button { display: none; }
  .clear { position: absolute; right: 4px; top: 50%; transform: translateY(-50%); }

  .cats { display: flex; flex-wrap: wrap; gap: 8px; }
  .cats button {
    display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 6px 14px; border: 1px solid var(--line); border-radius: 9999px;
    background: none; color: var(--muted); font: inherit; font-size: 13px; font-weight: var(--fw-regular); text-align: left; cursor: pointer; transition: color var(--dur-hover), border-color var(--dur-hover);
  }
  .cats button:hover { color: var(--fg); border-color: var(--line2); }
  .cats button[aria-pressed='true'] { border-color: var(--fg); background: var(--fg); color: var(--bg); }
  .cats span { min-width: 0; overflow-wrap: anywhere; }
  .cats em { flex: none; padding: 0 6px; border-radius: 9999px; background: var(--hover); font-style: normal; font-size: 11px; font-weight: var(--fw-regular); }
  .cats button[aria-pressed='true'] em { background: color-mix(in srgb, var(--bg) 20%, transparent); }

  .device { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: 13.5px; color: var(--muted); }
  .device :global(svg) { flex: none; }
  .dot-sep { color: var(--faint); }
  .found { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 0; border-block: 1px solid var(--line); font-size: 13px; color: var(--muted); }
  .found .clr { height: 28px; padding: 0 8px; color: var(--brand); }
  .found .clr:hover { color: var(--brand-ink); }

  .top-tools { margin-top: 36px; }
  .docs { margin-top: 40px; }
  @media (min-width: 640px) { .docs { margin-top: 48px; } }
  .docs-h { margin-bottom: 16px; }
  /* 外观 A：文章是细线格子（不画卡片），格与格之间竖细线，行与行之间横细线 */
  .grid { display: grid; grid-template-columns: minmax(0, 1fr); border-top: 1px solid var(--line); }
  @media (min-width: 768px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 1024px) { .grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .card {
    display: flex; flex-direction: column; justify-content: space-between; padding: 20px 0; border: 0; border-bottom: 1px solid var(--line);
    background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  @media (min-width: 768px) {
    .card { padding: 22px 24px 20px; }
    .card:nth-child(2n + 1) { padding-left: 0; }
    .card:nth-child(2n) { border-left: 1px solid var(--line); }
  }
  @media (min-width: 1024px) {
    .card:nth-child(n) { padding-left: 24px; border-left: 1px solid var(--line); }
    .card:nth-child(3n + 1) { padding-left: 0; border-left: 0; }
  }
  .ct { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .cn { display: flex; align-items: center; gap: 6px; font-size: 12px; line-height: 16px; color: var(--muted); }
  .cn :global(.ci) { color: var(--muted); }
  .ud { width: 8px; height: 8px; border-radius: 50%; background: var(--brand); }
  .card h4 { margin-top: 12px; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 15px; font-weight: var(--fw-strong); line-height: 1.375; transition: color var(--dur-hover); }
  .card:hover h4 { color: var(--fg); text-decoration: underline; text-decoration-color: var(--line2); text-underline-offset: 3px; }
  .cf { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; font-size: 12px; line-height: 16px; color: var(--muted); }
  .rd { display: flex; align-items: center; gap: 4px; color: var(--muted); transition: transform var(--dur-hover); }
  .card:hover .rd { transform: translateX(2px); color: var(--fg); }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); border-top: 1px solid var(--line); }
  @media (min-width: 768px) { .cols { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (min-width: 1024px) { .cols { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  .col { display: flex; flex-direction: column; gap: 2px; padding: 24px 0 28px; border-bottom: 1px solid var(--line); }
  @media (min-width: 768px) {
    .col { padding-inline: 28px; border-left: 1px solid var(--line); }
    .col:nth-child(2n + 1) { padding-left: 0; border-left: 0; }
  }
  @media (min-width: 1024px) {
    .col:nth-child(n) { padding-left: 28px; border-left: 1px solid var(--line); }
    .col:nth-child(3n + 1) { padding-left: 0; border-left: 0; }
  }
  .col-h { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; font-size: 12.5px; font-weight: var(--fw-strong); letter-spacing: .06em; color: var(--muted); }
  .col-h :global(.ci) { color: var(--faint); }
  .cols .col-a {
    display: flex; flex-direction: row; align-items: center; justify-content: flex-start; gap: 8px; padding: 6px 0; border: 0;
    font-size: 15px; line-height: 1.5; color: var(--fg);
  }
  .cols .col-a > span { min-width: 0; overflow-wrap: anywhere; }
  .cols .col-a:hover > span { text-decoration: underline; text-decoration-color: var(--line2); text-underline-offset: 3px; }
  .cols .col-a .ud { flex: none; }
</style>
