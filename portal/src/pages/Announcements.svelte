<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Pin from '@lucide/svelte/icons/pin';
  import { contentApi, type Announcement, type Announcements } from '@/api';
  import { K } from '@/lib/cache';
  import { summarize } from '@/lib/content-text';
  import { fromNow, siteParts, siteTimeZone } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import { announcementText, tagsOf } from '$lib/announcement';
  import { att } from '$lib/attention.svelte';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';

  /*
   * 公告与动态（行为同 React 门户 pages/dash/announcements.tsx）：面板一次给全部（置顶的在前），按界面语言取中 / 英文；
   * 已读由面板记（POST /me/announcements/{id}/read，换设备也一致），打开 = 标记已读，导航上的未读点跟着变。
   * 最新一条是头条（大号日期 + 标题 + 摘要 + 「阅读全文」），其余按月（站点时区）分组成细线时间轴：日期、圆点（未读 = 品牌蓝）、标题（未读加粗）、摘要。
   * 标签（实底）只在面板给了时画（数据模型是单独的后端任务），没有就不占位。详情对话框第一次打开时才下载。
   */
  const NEW_WITHIN = 7 * 86_400_000;
  const pad = (n: number) => String(n).padStart(2, '0');

  const res = resource(() => ({ key: K.announcements, fetch: () => contentApi.announcements() }));
  const data = $derived(res.data?.announcements ?? []);
  const unread = $derived(res.data?.unread ?? 0);
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

<div class="ph">
  <div>
    <h1>{t('公告与动态')}</h1>
    <p>{t('节点变更、维护计划与活动通知。没看过的会标出来。')}</p>
  </div>
  {#if data.length > 0}
    <span class="count">
      {#if unread > 0}<b class="num">{unread}</b> {t('条未读')} · {/if}{tp('共 {n} 条', { n: data.length })}
    </span>
  {/if}
</div>

{#if res.loading && !res.data}
  <Loading />
{:else if res.error && !res.data}
  <LoadError error={res.error} onretry={res.reload} />
{:else if data.length === 0}
  <Empty title={t('暂时没有公告')} desc={t('站点发布公告后会出现在这里。')} />
{:else}
  {#if featured}
    {@const f = text(featured)}
    {@const d = siteParts(featured.created_at)}
    <article class="feat">
      <div class="when">
        <span class="latest">{t('最新')}</span>
        <span class="big num">{pad(d.month)}.{pad(d.day)}</span>
        <span class="wd">{weekday.format(new Date(featured.created_at))} · {fromNow(featured.created_at, tp)}</span>
      </div>
      <div class="what">
        <div class="flags">
          {#if featured.pinned}<span class="pin"><Pin size={13} strokeWidth={1.75} aria-hidden="true" />{t('置顶')}</span>{/if}
          {#each tagsOf(featured) as tg (tg.name)}<span class="tg {tg.cls}">{tg.name}</span>{/each}
          {#if !featured.read && now - new Date(featured.created_at).getTime() < NEW_WITHIN}<span class="new">{t('新')}</span>{/if}
        </div>
        <h2>{f.title}</h2>
        <p>{summarize(f.html, 140)}</p>
        <button type="button" class="link more" onclick={() => open(featured)}>{t('阅读全文')}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></button>
      </div>
    </article>
  {/if}

  {#each months as m (m.key)}
    <section class="month" aria-label={m.key}>
      <h3 class="mh num">{m.key}</h3>
      {#each m.items as n (n.id)}
        {@const x = text(n)}
        {@const d = siteParts(n.created_at)}
        <button type="button" class="item" class:unread={!n.read} onclick={() => open(n)}>
          <span class="day"><b class="num">{pad(d.day)}</b><i>{weekday.format(new Date(n.created_at))}</i></span>
          <span class="dot" aria-hidden="true"></span>
          <span class="body">
            <span class="tt">
              {#if n.pinned}<span class="pin"><Pin size={13} strokeWidth={1.75} aria-hidden="true" />{t('置顶')}</span>{/if}
              {#each tagsOf(n) as tg (tg.name)}<span class="tg {tg.cls}">{tg.name}</span>{/each}
              <span class="title">{x.title}</span>
              {#if !n.read}<span class="sr">{t('未读')}</span>{/if}
            </span>
            <span class="sm">{summarize(x.html, 90)}</span>
          </span>
          <ChevronRight class="go" size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/each}
    </section>
  {/each}
{/if}

{#if dialogLoaded}
  {#await import('../components/AnnouncementDialog.svelte') then m}<m.default item={detail} onclose={() => (detail = null)} />{/await}
{/if}

<style>
  .count { flex: none; margin-bottom: 4px; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .count b { color: var(--brand); font-weight: 600; }

  .feat { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 40px; padding: 8px 0 40px; border-bottom: 1px solid var(--line); }
  .when { display: flex; flex-direction: column; align-items: flex-start; }
  .latest { font-size: 12.5px; font-weight: 600; color: var(--brand); letter-spacing: .04em; }
  .big { margin-top: 12px; font-size: 52px; line-height: 1; font-weight: 600; letter-spacing: -.04em; color: var(--fg); }
  .wd { margin-top: 10px; font-size: 13px; color: var(--muted); }
  .flags { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 20px; }
  .new { font-size: 12px; font-weight: 600; color: var(--brand); }
  .what h2 { margin-top: 10px; font-size: 24px; line-height: 1.35; font-weight: 600; letter-spacing: -.02em; color: var(--fg); overflow-wrap: anywhere; }
  .what p { margin-top: 10px; max-width: 640px; font-size: 15px; line-height: 1.85; color: var(--body); overflow-wrap: anywhere; }
  .more { margin-top: 14px; font-size: 14px; }

  .month { padding-top: 28px; }
  .mh { display: flex; align-items: center; gap: 14px; margin-bottom: 4px; font-size: 13px; font-weight: 500; letter-spacing: .06em; color: var(--fg); }
  .mh::after { content: ''; flex: 1; height: 1px; background: var(--line); }

  .item {
    display: grid; grid-template-columns: 136px 12px minmax(0, 1fr) 16px; gap: 20px; align-items: start; width: 100%;
    padding: 16px 0; border: 0; border-bottom: 1px solid var(--line); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
  }
  .item:last-child { border-bottom: 0; }
  .day { display: flex; align-items: baseline; gap: 10px; }
  .day b { font-size: 24px; line-height: 1; font-weight: 500; letter-spacing: -.03em; color: var(--fg); }
  .day i { font-style: normal; font-size: 13px; color: var(--muted); }
  .dot { width: 7px; height: 7px; margin-top: 8px; border-radius: 50%; background: var(--line2); }
  .unread .dot { background: var(--brand); }
  .body { display: flex; flex-direction: column; min-width: 0; }
  .tt { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
  .title { font-size: 15px; line-height: 1.5; color: var(--fg); overflow-wrap: anywhere; }
  .unread .title { font-weight: 600; }
  .item:hover .title { color: var(--brand); }
  .sm { margin-top: 4px; font-size: 13.5px; line-height: 1.75; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .item :global(.go) { margin-top: 4px; color: var(--faint); }
  .item:hover :global(.go) { color: var(--brand); }

  @media (max-width: 720px) {
    .ph { flex-wrap: wrap; align-items: flex-start; }
    .feat { grid-template-columns: 1fr; gap: 12px; padding-bottom: 32px; }
    .when { flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
    .big { margin-top: 0; font-size: 32px; }
    .wd { margin-top: 0; }
    .what h2 { font-size: 21px; }
    .item { grid-template-columns: 40px 10px minmax(0, 1fr); gap: 12px; }
    .day { flex-direction: column; align-items: flex-end; gap: 4px; }
    .day b { font-size: 20px; }
    .day i { font-size: 11.5px; }
    .item :global(.go) { display: none; }
  }
</style>
