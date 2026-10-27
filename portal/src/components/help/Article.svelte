<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Calendar from '@lucide/svelte/icons/calendar';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Clock from '@lucide/svelte/icons/clock';
  import Copy from '@lucide/svelte/icons/copy';
  import BookOpen from '@lucide/svelte/icons/book-open';
  import Headphones from '@lucide/svelte/icons/headphones';
  import { contentApi } from '@/api';
  import { K } from '@/lib/cache';
  import { outline, textLength } from '@/lib/content-text';
  import { docCategories, type KbArticle } from '@/lib/doc-categories';
  import { formatDate } from '@/lib/format';
  import { mySubUrl } from '@/lib/sub-links';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import RichHtml from '../RichHtml.svelte';
  import { auth } from '$lib/auth.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { markRead } from '$lib/read-state.svelte';
  import { resource } from '$lib/resource.svelte';
  import { param, setParams } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { pick } from '$lib/site';
  import { toast } from '$lib/toast.svelte';

  /*
   * 文章阅读：面包屑（使用手册 › 分类）、标题、阅读时长与更新日期、「复制订阅链接」、
   * 正文（面板渲染并清洗好的 HTML，RichHtml 给 h3 / h4 补目录锚点）、上一篇 / 下一篇（同分类）、「提交工单」一行；
   * 宽屏右侧吸顶的「本页目录」（滚动高亮当前章节）与「同类文档」，窄屏目录折叠在正文上方。打开即记为已读（本机）。
   * 版式同 v1.4.0：正文在卡片里，右侧目录与同类文档各一张卡片，当前项是品牌色浅底。
   */
  let { id }: { id: string } = $props();

  // svelte-ignore state_referenced_locally
  const art = resource(() => ({ key: K.article(id), fetch: () => contentApi.article(id) }));
  const list = resource(() => ({ key: K.help(), fetch: () => contentApi.help() }));
  const chapters = $derived(docCategories(list.data, i18n.locale, t('其他'), { mineFirst: false }));

  const a = $derived.by(() => {
    const raw = art.data;
    if (!raw) return null;
    return {
      title: pick(i18n.locale, raw.title_zh, raw.title_en),
      body: pick(i18n.locale, raw.html_zh, raw.html_en),
      category: raw.category_zh ? pick(i18n.locale, raw.category_zh, raw.category_en) : t('其他'),
      updated_at: raw.updated_at,
    };
  });

  const minutes = $derived(Math.max(1, Math.round(textLength(a?.body) / 400)));
  /* 目录：有 h3（章节）只列章节，没有就列 h4 */
  const toc = $derived.by(() => {
    const hs = outline(a?.body);
    const h2 = hs.filter((h) => h.level === 2);
    return h2.length ? h2 : hs;
  });

  const siblings = $derived(a ? (chapters.find((c) => c.name === a.category)?.articles ?? []) : []);
  const at = $derived(siblings.findIndex((x) => x.id === id));
  const prev = $derived(at > 0 ? siblings[at - 1] : null);
  const next = $derived(at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null);

  const subUrl = $derived(mySubUrl(auth.me));
  const copied = new Copied();

  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // svelte-ignore state_referenced_locally
  markRead(id);
  /* 换文章时回到页首 */
  $effect(() => { window.scrollTo({ top: 0, behavior: still() ? 'auto' : 'smooth' }); });

  /* 滚动高亮当前章节（正文画出来、RichHtml 补上 id 之后再观察） */
  let active = $state<string | null>(null);
  $effect(() => {
    const ids = toc.map((h) => h.id);
    if (ids.length < 2) return;
    let io: IntersectionObserver | undefined;
    const raf = requestAnimationFrame(() => {
      io = new IntersectionObserver((entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit) active = hit.target.id;
      }, { rootMargin: '-90px 0px -70% 0px' });
      ids.forEach((x) => { const el = document.getElementById(x); if (el) io?.observe(el); });
    });
    return () => { cancelAnimationFrame(raf); io?.disconnect(); };
  });

  function jump(e: MouseEvent, target: string) {
    e.preventDefault();
    document.getElementById(target)?.scrollIntoView({ behavior: still() ? 'auto' : 'smooth' });
    active = target;
  }

  const toList = (cat?: string) => setParams(cat ? { cat } : {});
  const goTo = (x: KbArticle) => setParams({ id: x.id, cat: param('cat') ?? undefined });

  async function copySub() {
    if (!subUrl) return;
    await copied.copy(subUrl, 'art-sub');
    if (copied.which === 'art-sub') toast.success(t('订阅链接已复制'));
  }
</script>

{#if art.loading && !a}
  <Loading rows={5} />
{:else if art.error && !a}
  <LoadError error={art.error} onretry={art.reload} />
{:else if a}
  <div class="pg">
  <header class="head">
    <nav aria-label={t('使用手册')} class="crumbs">
      <button type="button" onclick={() => toList()}><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />{t('使用手册')}</button>
      <ChevronRight class="sep" size={14} strokeWidth={1.75} aria-hidden="true" />
      <button type="button" onclick={() => toList(a.category)}>{a.category}</button>
    </nav>
    <div class="title-row">
      <div class="title">
        <h1 class="page-title">{a.title}</h1>
        <p class="meta">
          <span><Clock size={14} strokeWidth={1.75} aria-hidden="true" />{tp('约 {n} 分钟读完', { n: minutes })}</span>
          <span><Calendar size={14} strokeWidth={1.75} aria-hidden="true" />{formatDate(a.updated_at)}</span>
        </p>
      </div>
      {#if subUrl}
        <button type="button" class="btn cp" onclick={copySub}>
          {#if copied.which === 'art-sub'}<Check class="pop-in ok" size={14} strokeWidth={1.75} aria-hidden="true" />{t('已复制')}{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{t('复制订阅链接')}{/if}
        </button>
      {/if}
    </div>
  </header>

  <div class="stack">
  {#if toc.length > 1}
    <div class="toc-m">
      <details>
        <summary><span class="sm-l"><BookOpen class="bk" size={14} strokeWidth={1.75} aria-hidden="true" />{t('本页目录')}<span class="cnt">{toc.length}</span></span><ChevronDown class="chev" size={16} strokeWidth={1.75} aria-hidden="true" /></summary>
        <nav aria-label={t('本页目录')}>
          {#each toc as h (h.id)}
            <a href="#{h.id}" class:on={active === h.id} onclick={(e) => jump(e, h.id)}>{h.text}</a>
          {/each}
        </nav>
      </details>
    </div>
  {/if}

  <div class="body">
    <article class="art">
      <div class="doc"><RichHtml html={a.body} headings article /></div>

      {#if prev || next}
        <nav class="pn" aria-label={t('上一篇 / 下一篇')}>
          {#if prev}
            <button type="button" class="prev" onclick={() => goTo(prev)}>
              <span class="lb"><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />{t('上一篇')}</span>
              <span class="tt">{prev.title}</span>
            </button>
          {:else}<span class="pn-gap"></span>{/if}
          {#if next}
            <button type="button" class="next" onclick={() => goTo(next)}>
              <span class="lb">{t('下一篇')}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
              <span class="tt">{next.title}</span>
            </button>
          {/if}
        </nav>
      {/if}

      <div class="ask">
        <div class="ask-t"><Headphones size={20} strokeWidth={1.75} aria-hidden="true" /><span>{t('按步骤操作仍遇到问题？提交工单联系我们。')}</span></div>
        <a class="btn sm ask-b" href={R.tickets}>{t('提交工单')}</a>
      </div>
    </article>

    <aside class="side">
      <div class="stick">
      {#if toc.length > 1}
        <div class="blk">
          <div class="cap">{t('本页目录')}</div>
          <nav aria-label={t('本页目录')}>
            {#each toc as h (h.id)}
              <a href="#{h.id}" class:on={active === h.id} onclick={(e) => jump(e, h.id)}>{h.text}</a>
            {/each}
          </nav>
        </div>
      {/if}
      {#if siblings.length > 1}
        <div class="blk">
          <div class="cap">{tp('同类文档 · {c}', { c: a.category })}</div>
          <div class="sib">
            {#each siblings as s (s.id)}
              <button type="button" class:on={s.id === id} aria-current={s.id === id ? 'page' : undefined} onclick={() => goTo(s)}>{s.title}</button>
            {/each}
          </div>
        </div>
      {/if}
      </div>
    </aside>
  </div>
  </div>
  </div>
{/if}

<style>
  .pg { padding-bottom: 80px; }
  .head { padding-top: 48px; padding-bottom: 8px; }
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 13px; color: var(--muted); }
  .crumbs button { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: inherit; font: inherit; overflow-wrap: anywhere; text-align: left; cursor: pointer; transition: color .15s; }
  .crumbs button:hover { color: var(--fg); }
  .crumbs :global(.sep) { opacity: .5; }
  .title-row { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px 24px; margin-top: 16px; }
  .title { min-width: 0; max-width: 48rem; }
  .title h1 { overflow-wrap: anywhere; text-wrap: balance; }
  .meta { display: flex; line-height: 1.6; flex-wrap: wrap; gap: 6px 16px; margin-top: 12px; font-size: 13px; color: var(--muted); }
  .meta span { display: inline-flex; align-items: center; gap: 6px; }
  .btn.cp { height: 36px; flex: none; gap: 6px; padding: 0 10px; line-height: 20px; box-shadow: none; }
  .btn.cp :global(.ok) { color: var(--ok); }

  .stack { margin-top: 32px; }
  .stack > * + * { margin-top: 24px; }
  .body { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 48px; padding-top: 8px; }
  .art { min-width: 0; }
  .doc { padding: 32px; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow-xs); overflow: hidden; }

  .pn { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 32px; }
  .pn button {
    display: flex; flex-direction: column; justify-content: space-between; min-width: 0; padding: 16px; border: 1px solid color-mix(in srgb, var(--line) 80%, transparent); border-radius: 12px;
    background: var(--surface); font: inherit; text-align: left; cursor: pointer; transition: border-color .15s, box-shadow .15s;
  }
  .pn button:hover { border-color: color-mix(in srgb, var(--brand) 40%, transparent); box-shadow: var(--shadow-xs); }
  .pn .next { text-align: right; }
  .pn .lb { display: flex; align-items: center; gap: 4px; font-size: 12px; line-height: 16px; color: var(--muted); transition: color .15s; }
  .pn .next .lb { justify-content: flex-end; }
  .pn .lb :global(svg) { transition: transform .15s; }
  .pn .prev:hover .lb :global(svg) { transform: translateX(-4px); }
  .pn .next:hover .lb :global(svg) { transform: translateX(4px); }
  .pn button:hover .lb, .pn button:hover .tt { color: var(--brand); }
  .pn .tt { margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; font-size: 14px; line-height: 20px; font-weight: var(--fw-strong); color: var(--fg); transition: color .15s; }

  .ask { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 32px; padding: 20px; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--hover) 30%, transparent); font-size: 14px; }
  .ask-t { line-height: 20px; display: flex; align-items: center; gap: 12px; color: var(--muted); }
  .ask-t :global(svg) { flex: none; color: var(--brand); }
  .ask-b { flex: none; border-radius: calc(var(--radius) * 1.4); }

  .side { min-width: 0; }
  .stick { position: sticky; top: 88px; }
  .blk { padding: 20px; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 16px; background: var(--surface); box-shadow: var(--shadow-xs); }
  .blk + .blk { margin-top: 24px; }
  .cap { font-size: 12px; line-height: 16px; font-weight: var(--fw-strong); letter-spacing: .05em; text-transform: uppercase; color: var(--muted); }
  .side nav { display: flex; flex-direction: column; gap: 6px; margin-top: 14px; }
  .sib { display: flex; flex-direction: column; gap: 4px; max-height: 300px; margin-top: 14px; padding-right: 4px; overflow-y: auto; }
  .side nav a, .sib button, .toc-m nav a {
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; line-clamp: 1; overflow: hidden; padding: 6px 10px; border: 0; border-radius: 8px; background: none;
    color: var(--muted); font: inherit; font-size: 12px; line-height: 16px; text-align: left; cursor: pointer; transition: color .15s, background-color .15s;
  }
  .sib button { -webkit-line-clamp: 2; line-clamp: 2; }
  .side nav a:hover, .sib button:hover, .toc-m nav a:hover { background: var(--hover); color: var(--fg); }
  .side nav a.on, .sib button.on, .toc-m nav a.on { background: color-mix(in srgb, var(--brand) 10%, transparent); color: var(--brand); font-weight: var(--fw-strong); }

  .toc-m { display: none; }
  .toc-m details { padding: 12px; border: 1px solid color-mix(in srgb, var(--line) 70%, transparent); border-radius: 12px; background: var(--surface); }
  .toc-m summary { display: flex; align-items: center; justify-content: space-between; font-size: 12px; line-height: 16px; font-weight: var(--fw-strong); color: var(--fg); list-style: none; cursor: pointer; }
  .toc-m summary::-webkit-details-marker { display: none; }
  .sm-l { display: flex; align-items: center; gap: 6px; color: var(--muted); }
  .sm-l :global(.bk) { color: var(--brand); }
  .cnt { padding: 0 6px; border-radius: 9999px; background: var(--hover); font-size: 10px; line-height: 16px; }
  .toc-m :global(.chev) { color: var(--muted); transition: transform .15s; }
  .toc-m details[open] :global(.chev) { transform: rotate(180deg); }
  .toc-m nav { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--line) 50%, transparent); }

  @media (max-width: 1023px) {
    .body { grid-template-columns: minmax(0, 1fr); gap: 32px; }
    .side { display: none; }
    .toc-m { display: block; }
  }
  @media (max-width: 639px) {
    .body { padding-top: 4px; }
    .doc { padding: 18px; }
    .pn { grid-template-columns: 1fr; margin-top: 24px; }
    .ask { margin-top: 24px; }
    .pn button { padding: 14px; }
    .pn-gap { display: none; }
    .ask { flex-direction: column; align-items: stretch; padding: 16px; }
    .ask-t { font-size: 12px; line-height: 16px; gap: 10px; }
    .ask-t :global(svg) { width: 16px; height: 16px; }
    .ask-b { align-self: flex-end; }
  }
  @media (min-width: 640px) and (max-width: 1023px) { .body { padding-top: 8px; } .doc { padding: 28px; } }
  @media (prefers-reduced-motion: reduce) {
    .toc-m :global(.chev), .pn .lb :global(svg) { transition: none; }
  }
</style>
