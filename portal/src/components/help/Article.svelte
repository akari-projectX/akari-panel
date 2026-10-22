<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import Calendar from '@lucide/svelte/icons/calendar';
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Clock from '@lucide/svelte/icons/clock';
  import Copy from '@lucide/svelte/icons/copy';
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
   * 文章阅读（行为同 React 门户 help.tsx 的 ArticleView）：面包屑（使用手册 › 分类）、标题、阅读时长与更新日期、「复制订阅链接」、
   * 正文（面板渲染并清洗好的 HTML，RichHtml 给 h3 / h4 补目录锚点）、上一篇 / 下一篇（同分类）、「提交工单」一行；
   * 宽屏右侧吸顶的「本页目录」（滚动高亮当前章节）与「同类文档」，窄屏目录折叠在正文上方。打开即记为已读（本机）。
   * 版式：正文不套卡片，阅读栏 + 细线分隔；当前目录项是品牌色文字 + 左侧 2px 竖线。
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
  <header class="head">
    <nav aria-label={t('使用手册')} class="crumbs">
      <button type="button" onclick={() => toList()}><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />{t('使用手册')}</button>
      <ChevronRight class="sep" size={14} strokeWidth={1.75} aria-hidden="true" />
      <button type="button" onclick={() => toList(a.category)}>{a.category}</button>
    </nav>
    <div class="title-row">
      <div class="title">
        <h1>{a.title}</h1>
        <p class="meta">
          <span><Clock size={14} strokeWidth={1.75} aria-hidden="true" />{tp('约 {n} 分钟读完', { n: minutes })}</span>
          <span class="num"><Calendar size={14} strokeWidth={1.75} aria-hidden="true" />{formatDate(a.updated_at)}</span>
        </p>
      </div>
      {#if subUrl}
        <button type="button" class="btn" onclick={copySub}>
          {#if copied.which === 'art-sub'}<Check size={14} strokeWidth={1.75} aria-hidden="true" />{t('已复制')}{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{t('复制订阅链接')}{/if}
        </button>
      {/if}
    </div>
  </header>

  {#if toc.length > 1}
    <details class="toc-m">
      <summary>{t('本页目录')}<em class="num">{toc.length}</em><ChevronDown class="chev" size={16} strokeWidth={1.75} aria-hidden="true" /></summary>
      <nav aria-label={t('本页目录')}>
        {#each toc as h (h.id)}
          <a href="#{h.id}" class:on={active === h.id} onclick={(e) => jump(e, h.id)}>{h.text}</a>
        {/each}
      </nav>
    </details>
  {/if}

  <div class="body">
    <article class="art">
      <RichHtml html={a.body} headings />

      {#if prev || next}
        <nav class="pn" aria-label={t('上一篇 / 下一篇')}>
          {#if prev}
            <button type="button" class="prev" onclick={() => goTo(prev)}>
              <span class="lb"><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />{t('上一篇')}</span>
              <span class="tt">{prev.title}</span>
            </button>
          {:else}<span></span>{/if}
          {#if next}
            <button type="button" class="next" onclick={() => goTo(next)}>
              <span class="lb">{t('下一篇')}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></span>
              <span class="tt">{next.title}</span>
            </button>
          {/if}
        </nav>
      {/if}

      <div class="ask">
        <span>{t('按步骤操作仍遇到问题？提交工单联系我们。')}</span>
        <a class="btn sm" href={R.tickets}>{t('提交工单')}</a>
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
{/if}

<style>
  .crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 13px; color: var(--muted); }
  .crumbs button { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; color: inherit; font: inherit; overflow-wrap: anywhere; text-align: left; cursor: pointer; }
  .crumbs button:hover { color: var(--fg); }
  .crumbs :global(.sep) { color: var(--faint); }
  .title-row { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 16px 24px; margin-top: 16px; }
  .title { min-width: 0; max-width: 48rem; }
  h1 { font-size: 28px; line-height: 36px; font-weight: 700; color: var(--fg); letter-spacing: -.01em; overflow-wrap: anywhere; text-wrap: balance; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 10px; font-size: 13px; color: var(--muted); }
  .meta span { display: inline-flex; align-items: center; gap: 6px; }
  .head .btn { flex: none; }

  .body { display: grid; grid-template-columns: minmax(0, 1fr) 240px; gap: 56px; margin-top: 32px; padding-top: 28px; border-top: 1px solid var(--line); }
  .art { min-width: 0; max-width: 46rem; }

  .pn { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); }
  .pn button { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 0; border: 0; background: none; font: inherit; text-align: left; cursor: pointer; }
  .pn .next { text-align: right; align-items: flex-end; }
  .pn .lb { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; color: var(--muted); }
  .pn .tt { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-weight: 500; }
  .pn button:hover .tt { color: var(--brand); }

  .ask { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px; margin-top: 32px; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 13.5px; color: var(--muted); }

  .side { min-width: 0; }
  .stick { position: sticky; top: 88px; }
  .blk + .blk { margin-top: 28px; }
  .cap { font-size: 12.5px; font-weight: 600; color: var(--fg); margin-bottom: 10px; }
  .side nav, .sib { display: flex; flex-direction: column; border-left: 1px solid var(--line); }
  .side nav a, .sib button, .toc-m nav a {
    display: block; margin-left: -1px; padding: 5px 0 5px 12px; border: 0; border-left: 2px solid transparent; background: none;
    color: var(--muted); font: inherit; font-size: 13px; line-height: 1.5; text-align: left; overflow-wrap: anywhere; cursor: pointer;
  }
  .side nav a:hover, .sib button:hover, .toc-m nav a:hover { color: var(--fg); }
  .side nav a.on, .sib button.on, .toc-m nav a.on { color: var(--brand); border-left-color: var(--brand); font-weight: 500; }
  .sib { max-height: 300px; overflow-y: auto; }

  .toc-m { display: none; margin-top: 24px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .toc-m summary { display: flex; align-items: center; gap: 8px; padding: 12px 0; font-size: 13.5px; font-weight: 500; color: var(--fg); list-style: none; cursor: pointer; }
  .toc-m summary::-webkit-details-marker { display: none; }
  .toc-m em { font-style: normal; font-weight: 400; font-size: 12px; color: var(--faint); }
  .toc-m :global(.chev) { margin-left: auto; color: var(--muted); transition: transform var(--dur-hover) var(--ease-out); }
  .toc-m[open] :global(.chev) { transform: rotate(180deg); }
  .toc-m nav { display: flex; flex-direction: column; padding-bottom: 12px; border-left: 1px solid var(--line); }

  @media (max-width: 1080px) {
    .body { grid-template-columns: minmax(0, 1fr); }
    .side { display: none; }
    .toc-m { display: block; }
    .body { margin-top: 0; border-top: 0; }
    .art { max-width: none; }
  }
  @media (max-width: 720px) {
    h1 { font-size: 24px; line-height: 32px; }
    .pn { grid-template-columns: 1fr; gap: 16px; }
    .pn .next { text-align: left; align-items: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) {
    .toc-m :global(.chev) { transition: none; }
  }
</style>
