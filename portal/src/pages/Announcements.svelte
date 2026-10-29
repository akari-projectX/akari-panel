<script module lang="ts">
  const Detail = () => import('../components/AnnouncementDialog.svelte');
</script>

<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Pin from '@lucide/svelte/icons/pin';
  import { contentApi, type Announcement, type Announcements } from '@/api';
  import { K } from '@/lib/cache';
  import { summarize } from '@/lib/content-text';
  import { fromNow, siteParts, siteTimeZone } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Section from '../components/flat/Section.svelte';
  import { chunk, intent, preloadDialogs } from '$lib/dialogs';
  import { announcementText, tagFilters, tagOf } from '$lib/announcement';
  import { att } from '$lib/attention.svelte';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';

  /*
   * 公告与动态：面板一次给全部（置顶的在前），按界面语言取中 / 英文；
   * 已读由面板记（POST /me/announcements/{id}/read，换设备也一致），打开 = 标记已读，导航上的未读点跟着变。
   * 最新一条是头条（大号日期 + 标题 + 摘要 + 「阅读全文」），其余按月（站点时区）分组成细线时间轴：日期、圆点（未读 = 品牌蓝）、标题（未读加粗）、摘要。
   * 标签（实底，面板给的名称与预设色）画在标题前，没有标签就不占位；用到的标签多于一个时，列表上方出现按标签筛选。详情对话框第一次打开时才下载。
   */
  const NEW_WITHIN = 7 * 86_400_000;
  const pad = (n: number) => String(n).padStart(2, '0');

  const res = resource(() => ({ key: K.announcements, fetch: () => contentApi.announcements() }));
  const all = $derived(res.data?.announcements ?? []);
  const unread = $derived(res.data?.unread ?? 0);
  /* 按标签筛选：用到的标签多于一个才出现；筛选后的列表照旧「头条 + 按月时间轴」 */
  const filters = $derived(tagFilters(all, i18n.locale));
  let tagId = $state<string | null>(null);
  const data = $derived(tagId && filters.some((f) => f.id === tagId) ? all.filter((a) => a.tag?.id === tagId) : all);
  const featured = $derived(data[0]);
  const months = $derived.by(() => {
    const out: { key: string; items: Announcement[] }[] = [];
    for (const n of data.slice(1)) {
      const d = siteParts(n.created_at);
      const key = `${d.year} · ${pad(d.month)}`;
      if (out.at(-1)?.key !== key) out.push({ key, items: [] });
      out[out.length - 1].items.push(n);
    }
    return out;
  });
  const weekday = $derived(new Intl.DateTimeFormat(i18n.locale, { weekday: 'short', timeZone: siteTimeZone() }));
  const now = Date.now();
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

<PageTitle title={t('公告与动态')} sub={t('节点变更、维护计划与活动通知。没看过的会标出来。')}>
  {#snippet extra()}
    {#if data.length > 0}
      <span class="an-count">
        {#if unread > 0}<b>{unread}</b> {t('条未读')}{' · '}{/if}{tp('共 {n} 条', { n: data.length })}
      </span>
    {/if}
  {/snippet}
</PageTitle>

<Section>
  {#if res.loading && !res.data}
    <Loading />
  {:else if res.error && !res.data}
    <LoadError error={res.error} onretry={res.reload} />
  {:else if data.length === 0}
    <Empty title={t('暂时没有公告')} desc={t('站点发布公告后会出现在这里。')} />
  {:else}
    {#if filters.length > 0}
      <div class="an-filter" role="group" aria-label={t('按标签筛选')}>
        <button type="button" class="fchip" aria-pressed={tagId === null} onclick={() => (tagId = null)}>{t('全部')} <span class="n tnum">{all.length}</span></button>
        {#each filters as f (f.id)}
          <button type="button" class="fchip {f.cls}" aria-pressed={tagId === f.id} onclick={() => (tagId = f.id)}><i></i>{f.name} <span class="n tnum">{f.n}</span></button>
        {/each}
      </div>
    {/if}
    {#if featured}
      {@const f = text(featured)}
      {@const ftg = tagOf(featured, i18n.locale)}
      {@const d = siteParts(featured.created_at)}
      <article class="an-feat">
        <div class="an-when">
          <span class="an-latest"><i></i>{t('最新')}</span>
          <span class="an-big tnum">{pad(d.month)}.{pad(d.day)}</span>
          <span class="an-wd">{weekday.format(new Date(featured.created_at))} · {fromNow(featured.created_at, tp)}</span>
        </div>
        <div class="an-what">
          <div class="an-flags">
            {#if featured.pinned}<span class="bdg brandbadge an-pinb2"><Pin size={12} strokeWidth={1.75} aria-hidden="true" />{t('置顶')}</span>{/if}
            {#if ftg}<span class="tg {ftg.cls}">{ftg.name}</span>{/if}
            {#if !featured.read && now - new Date(featured.created_at).getTime() < NEW_WITHIN}<span class="bdg an-newb">{t('新')}</span>{/if}
          </div>
          <h2>{f.title}</h2>
          <p>{summarize(f.html, 140)}</p>
          <button type="button" class="an-more" {@attach intent(Detail)} onclick={() => open(featured)}>{t('阅读全文')}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
      </article>
    {/if}

    {#each months as m (m.key)}
      <div class="an-month" role="group" aria-label={m.key}>
        <div class="an-mh"><span class="tnum">{m.key}</span><span class="an-ml"></span></div>
        {#each m.items as n, i (n.id)}
          {@const x = text(n)}
          {@const tg = tagOf(n, i18n.locale)}
          {@const d = siteParts(n.created_at)}
          <button type="button" class="an-item" {@attach intent(Detail)} onclick={() => open(n)}>
            <div class="an-day"><div class="an-dn tnum">{pad(d.day)}</div><div class="an-dw">{weekday.format(new Date(n.created_at))}</div></div>
            <div class="an-rail">
              <i class={['an-dot', !n.read && 'an-on']}></i>
              <i class={['an-ln', i < m.items.length - 1 && 'an-join']}></i>
            </div>
            <div class="an-bd">
              <div class="an-tt">
                {#if n.pinned}<span class="bdg brandbadge an-pinb2"><Pin size={12} strokeWidth={1.75} aria-hidden="true" />{t('置顶')}</span>{/if}
                {#if tg}<span class="tg {tg.cls}">{tg.name}</span>{/if}
                <span class={['an-title', !n.read && 'an-mid']}>{x.title}</span>
                {#if !n.read}<span class="sr">{t('未读')}</span>{/if}
              </div>
              <p class="an-sm">{summarize(x.html, 90)}</p>
            </div>
            <ArrowRight class="go" size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        {/each}
      </div>
    {/each}
  {/if}
</Section>

{#if dialogLoaded}
  {#await chunk(Detail) then m}<m.default item={detail} onclose={() => (detail = null)} />{/await}
{/if}

<style>
  .an-count { font-size: 13px; color: var(--muted); }
  .an-count b { font-weight: var(--fw-strong); color: var(--brand); }

  .an-filter { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  .fchip {
    display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border: 1px solid var(--line2); border-radius: 999px;
    background: var(--surface); color: var(--body); font: inherit; font-size: 13px; cursor: pointer; transition: border-color var(--dur-fast), color var(--dur-fast);
  }
  .fchip:hover { border-color: var(--muted); }
  .fchip i { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
  .fchip .n { font-size: 12px; color: var(--faint); }
  .fchip[aria-pressed='true'] { border-color: var(--fg); color: var(--fg); font-weight: var(--fw-strong); }

  .an-feat { display: grid; gap: 14px; padding-bottom: 36px; border-bottom: 1px solid var(--line); }
  .an-when { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 10px; }
  .an-latest { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: var(--fw-strong); letter-spacing: .055em; color: var(--brand); }
  .an-latest i { width: 10px; height: 1px; background: var(--brand); }
  .an-big { font-size: 34px; line-height: 1.02; font-weight: var(--fw-strong); letter-spacing: -.038em; }
  .an-wd { font-size: 13px; color: var(--muted); }
  .an-what { min-width: 0; }
  .an-flags { display: flex; align-items: center; gap: 8px; }
  .an-flags:empty { display: none; }
  .an-what h2 { margin-top: 14px; font-size: 22px; line-height: 1.3; font-weight: var(--fw-strong); overflow-wrap: anywhere; }
  .an-what p { margin-top: 12px; max-width: 640px; font-size: 15px; line-height: 1.85; color: var(--body); overflow-wrap: anywhere; }
  .an-more { display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; padding: 0; border: 0; background: none; font: inherit; font-size: 14px; font-weight: var(--fw-strong); color: var(--brand); cursor: pointer; }
  .an-more:hover { text-decoration: underline; }
  .an-pinb2 { gap: 4px; }
  .an-newb { background: var(--brand); color: var(--on-brand); }

  .an-mh { display: flex; align-items: center; gap: 14px; padding: 30px 0 10px; }
  .an-mh .tnum { font-size: 13px; font-weight: var(--fw-strong); letter-spacing: .06em; }
  .an-ml { flex: 1; height: 1px; background: var(--line); }

  .an-item {
    display: grid; grid-template-columns: 44px 14px minmax(0, 1fr); gap: 10px; width: calc(100% + 28px); margin-inline: -14px; padding: 14px;
    border: 0; border-radius: 12px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color .15s;
  }
  .an-item:hover { background: color-mix(in srgb, var(--hover) 60%, transparent); }
  .an-day { text-align: right; }
  .an-dn { font-size: 22px; line-height: 1; font-weight: var(--fw-strong); letter-spacing: -.03em; }
  .an-dw { margin-top: 4px; font-size: 11.5px; color: var(--muted); }
  .an-rail { position: relative; display: flex; flex-direction: column; align-items: center; }
  .an-dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: color-mix(in srgb, var(--muted) 30%, transparent); }
  .an-dot.an-on { background: var(--brand); box-shadow: 0 0 0 4px color-mix(in srgb, var(--brand) 14%, transparent); }
  .an-ln { position: absolute; top: 22px; left: calc(50% - .5px); bottom: 0; width: 1px; background: var(--line); }
  .an-ln.an-join { bottom: -34px; }
  .an-bd { min-width: 0; }
  .an-tt { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
  .an-title { letter-spacing: normal; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
  .an-title.an-mid { font-weight: var(--fw-strong); }
  .an-sm { margin-top: 6px; font-size: 13px; line-height: 1.7; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .an-item :global(.go) { display: none; margin-top: 4px; color: var(--faint); transition: color .15s; }
  .an-item:hover :global(.go) { color: var(--brand); }

  @media (min-width: 768px) {
    .an-feat { grid-template-columns: 140px minmax(0, 1fr); gap: 40px; padding-bottom: 44px; }
    .an-when { flex-direction: column; align-items: flex-start; gap: 0; }
    .an-big { margin-top: 14px; font-size: 56px; }
    .an-wd { margin-top: 8px; }
    .an-what h2 { font-size: 26px; font-weight: var(--fw-strong); }
    .an-item { grid-template-columns: 140px 20px minmax(0, 1fr) 24px; gap: 20px; padding-block: 18px; }
    .an-day { display: flex; align-items: baseline; gap: 10px; text-align: left; }
    .an-dn { font-size: 28px; }
    .an-dw { margin-top: 0; font-size: 13px; }
    .an-dot { margin-top: 9px; }
    .an-ln { top: 27px; }
    .an-ln.an-join { bottom: -45px; }
    .an-sm { font-size: 13.5px; line-height: 1.75; }
    .an-item :global(.go) { display: block; }
  }
</style>
