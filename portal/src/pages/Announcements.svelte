<script module lang="ts">
  const Detail = () => import('../components/AnnouncementDialog.svelte');
</script>

<script lang="ts">
  import { contentApi, type Announcement, type Announcements } from '@/api';
  import { K } from '@/lib/cache';
  import { summarize } from '@/lib/content-text';
  import { formatDate, formatMonthDay, siteParts } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import { chunk, intent, preloadDialogs } from '$lib/dialogs';
  import { announcementText, tagFilters, tagOf } from '$lib/announcement';
  import { att } from '$lib/attention.svelte';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';

  /*
   * 公告与动态（外观 A，同仪表盘的「公告」）：面板一次给全部（置顶的在前），按界面语言取中 / 英文；
   * 已读由面板记（POST /me/announcements/{id}/read，换设备也一致），打开 = 标记已读，导航上的未读点跟着变。
   * 页头一句话说还有几条没看；用到的标签多于一个时下面是按标签筛选的分段胶囊；最新一条是头条（标签 · 日期、大号标题、摘要、「阅读全文」），
   * 其余是细线列表（`.drow`，与仪表盘同一套）：日期、标签、标题（未读加粗 + 蓝点）、一句摘要、→。标签是实底小标签（面板给的名称与预设色）。
   * 详情对话框第一次打开时才下载。
   */
  const res = resource(() => ({ key: K.announcements, fetch: () => contentApi.announcements() }));
  const all = $derived(res.data?.announcements ?? []);
  const unread = $derived(res.data?.unread ?? 0);
  const filters = $derived(tagFilters(all, i18n.locale));
  let tagId = $state<string | null>(null);
  const data = $derived(tagId && filters.some((f) => f.id === tagId) ? all.filter((a) => a.tag?.id === tagId) : all);
  const featured = $derived(data[0]);
  const rest = $derived(data.slice(1));
  const thisYear = siteParts(new Date()).year;
  /* 列表的日期：今年的写月-日，往年的写全 */
  const day = (v: string) => (siteParts(v).year === thisYear ? formatMonthDay(v) : formatDate(v));
  const text = (a: Announcement) => announcementText(a, i18n.locale);

  let detail = $state<Announcement | null>(null);
  let dialogLoaded = $state(false);
  /* 详情对话框第一次打开时才挂载；分包在空闲时与按钮上的意图预载（lib/dialogs） */
  preloadDialogs(Detail);

  function open(n: Announcement) {
    dialogLoaded = true;
    detail = n;
    const d = res.data;
    if (n.read || !d) return;
    contentApi.markRead(n.id).catch(() => {});
    const next: Announcements = {
      unread: Math.max(0, d.unread - 1),
      announcements: d.announcements.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
    };
    res.set(next);
    att.announcements = next;
  }
</script>

<PageTitle title={t('公告与动态')} lead={unread > 0 ? tp('{n} 条公告还没看', { n: unread }) : t('最新动态')}>
  {#snippet extra()}
    {#if all.length > 0}
      <span class="an-count">{#if unread > 0}<b>{unread}</b> {t('条未读')}{' · '}{/if}{tp('共 {n} 条', { n: all.length })}</span>
    {/if}
  {/snippet}
</PageTitle>

{#if res.loading && !res.data}
  <Loading />
{:else if res.error && !res.data}
  <LoadError error={res.error} onretry={res.reload} />
{:else if all.length === 0}
  <div class="an-empty"><Empty title={t('暂时没有公告')} desc={t('站点发布公告后会出现在这里。')} /></div>
{:else}
  {#if filters.length > 0}
    <div class="tabs-pill an-filter" role="group" aria-label={t('按标签筛选')}>
      <button type="button" aria-pressed={tagId === null} onclick={() => (tagId = null)}>{t('全部')} <span class="n tnum">{all.length}</span></button>
      {#each filters as f (f.id)}
        <button type="button" class={f.cls} aria-pressed={tagId === f.id} onclick={() => (tagId = f.id)}><i></i>{f.name} <span class="n tnum">{f.n}</span></button>
      {/each}
    </div>
  {/if}
  {#if featured}
    {@const f = text(featured)}
    {@const ftg = tagOf(featured, i18n.locale)}
    <article class="an-feat">
      <div class="an-meta">
        {#if featured.pinned}<span class="dtag pin">{t('置顶')}</span>{/if}
        {#if ftg}<span class="tg {ftg.cls}">{ftg.name}</span>{/if}
        <time class="tnum" datetime={featured.created_at}>{formatDate(featured.created_at)}</time>
        {#if !featured.read}<span class="an-new">{t('未读')}</span>{/if}
      </div>
      <h2>{f.title}</h2>
      {#if f.html}<p>{summarize(f.html, 160)}</p>{/if}
      <button type="button" class="an-more" {@attach intent(Detail)} onclick={() => open(featured)}>{t('阅读全文')} →</button>
    </article>
  {/if}
  {#if rest.length > 0}
    <div class="dlist an-list">
      {#each rest as n (n.id)}
        {@const x = text(n)}
        {@const tg = tagOf(n, i18n.locale)}
        <button type="button" class={['drow', 'an-row', !n.read && 'unread']} {@attach intent(Detail)} onclick={() => open(n)}>
          <time class="tnum" datetime={n.created_at}>{day(n.created_at)}</time>
          <span class="drow-m">
            <span class="an-tt">
              {#if !n.read}<i class="an-dot" aria-hidden="true"></i><span class="sr">{t('未读')}</span>{/if}
              {#if n.pinned}<span class="dtag pin">{t('置顶')}</span>{/if}
              {#if tg}<span class="tg {tg.cls}">{tg.name}</span>{/if}
              <b>{x.title}</b>
            </span>
            {#if x.html}<small>{summarize(x.html, 90)}</small>{/if}
          </span>
          <span class="drow-go" aria-hidden="true">→</span>
        </button>
      {/each}
    </div>
  {/if}
{/if}

{#if dialogLoaded}
  {#await chunk(Detail) then m}<m.default item={detail} onclose={() => (detail = null)} />{/await}
{/if}

<style>
  .an-count { font-size: 13px; color: var(--muted); }
  .an-count b { font-weight: var(--fw-strong); color: var(--brand); }
  .an-empty { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line); }

  /* 按标签筛选：分段胶囊（与其他页的切换同一套），标签色的小圆点 + 条数；放不下时横向滑动 */
  .an-filter { max-width: 100%; margin: 28px 0 8px; overflow-x: auto; scrollbar-width: none; }
  .an-filter > button { flex: none; }
  .an-filter i { width: 6px; height: 6px; border-radius: 50%; background: var(--c); }
  .an-filter .n { font-size: 11.5px; opacity: .7; }

  /* 头条：标签 · 日期一行、大号标题、摘要、阅读全文；下面一道细线接列表 */
  .an-feat { margin-top: 20px; padding: 32px 0 28px; border-top: 1px solid var(--line); }
  .an-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: 13px; color: var(--faint); }
  .an-meta .dtag { margin-right: 0; }
  .an-new { color: var(--brand); font-size: 12px; font-weight: var(--fw-strong); }
  .an-feat h2 { margin-top: 14px; font-size: 26px; line-height: 1.3; font-weight: var(--fw-strong); letter-spacing: -.02em; color: var(--fg); overflow-wrap: anywhere; }
  .an-feat p { margin-top: 12px; max-width: 720px; font-size: 15px; line-height: 1.8; color: var(--body); overflow-wrap: anywhere; }
  .an-more { margin-top: 14px; padding: 0; border: 0; background: none; font: inherit; font-size: 13.5px; font-weight: var(--fw-strong); color: var(--brand); cursor: pointer; }
  .an-more:hover { text-decoration: underline; text-underline-offset: 3px; }

  /* 列表：仪表盘的细线行，日期栏宽一点放得下往年的完整日期 */
  .an-row { grid-template-columns: 88px minmax(0, 1fr) auto; padding-block: 16px; font-size: 14px; }
  .an-tt { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .an-tt .dtag { margin-right: 0; }
  .an-row .drow-m > small { margin-top: 4px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .an-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--brand); }

  @media (max-width: 640px) {
    .an-feat { padding-top: 24px; }
    .an-feat h2 { font-size: 21px; }
    .an-row { grid-template-columns: minmax(0, 1fr) auto; row-gap: 4px; }
    .an-row > time { grid-column: 1 / -1; }
  }
</style>
