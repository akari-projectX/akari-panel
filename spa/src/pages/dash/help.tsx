import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, BookOpen, Calendar, Check, ChevronDown, ChevronRight, Clock,
  Copy, Download, Headphones, Search, X,
} from 'lucide-react';
import { DUR, NUDGE, stagger, useEnter } from '@/lib/motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/flat';
import { PageNotices } from '@/components/account-banners';
import { Empty, LoadError, Loading } from '@/components/data-state';
import ServerHtml from '@/components/server-html';
import DocCategoryIcon from '@/components/doc-category-icon';
import PlatformIcon from '@/components/platform-icon';
import { docCategories, pick, type DocCategory, type KbArticle } from '@/lib/doc-categories';
import { detectPlatform } from '@/data/platforms';
import { useAuth } from '@/lib/auth';
import { useSite } from '@/lib/site';
import { mySubUrl } from '@/lib/sub-links';
import { contentApi } from '@/api';
import { R } from '@/lib/routes';
import { useApi } from '@/hooks/use-api';
import { useCopy } from '@/hooks/use-copy';
import { toast } from '@/lib/toast';
import { K } from '@/lib/cache';
import { outline, textLength } from '@/lib/content-text';
import { markRead, useReadState } from '@/lib/read-state';
import { formatDate, formatMonthDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useLocale, useT, useTp } from '@/i18n';

/**
 * 文档/使用手册页面。
 * 提供列表浏览（平台分类卡片、当前设备推荐、全文搜索）与文章阅读模式。
 */
export default function Guide() {
  const [params] = useSearchParams();
  const id = params.get('id');
  return id ? <ArticleView key={id} id={id} /> : <ListView />;
}

/* 知识库列表（面板 GET /me/help，q 在服务端搜）；按界面语言整理成分类 */
function useKnowledge(search = '') {
  const { locale } = useLocale();
  const tr = useT();
  const res = useApi(() => contentApi.help(search || undefined), [search], { key: K.help(search) });
  const chapters = useMemo(() => docCategories(res.data, locale, tr('其他'), { mineFirst: false }), [res.data, locale, tr]);
  return { ...res, chapters };
}

/* ───────────────────────── 列表视图 ───────────────────────── */

function ListView() {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const currentCategory = params.get('cat') ?? 'all';

  const [kw, setKw] = useState(q);
  const [kwFor, setKwFor] = useState(q);
  if (kwFor !== q) {
    setKwFor(q);
    setKw(q);
  }

  const { me } = useAuth();
  const subUrl = mySubUrl(me);
  const [copied, copyText] = useCopy();

  const all = useKnowledge();
  const found = useKnowledge(q);
  const chapters = all.chapters;
  const totalArticles = chapters.reduce((n, c) => n + c.articles.length, 0);

  const hits = useMemo(
    () => (q ? new Set(found.chapters.flatMap((c) => c.articles.map((a) => a.id))) : null),
    [q, found.chapters],
  );

  /* 按当前选中的分类或者搜索筛选 */
  const displayChapters = useMemo(() => {
    let list = chapters;
    if (currentCategory !== 'all') {
      list = list.filter((c) => c.name === currentCategory);
    }
    return list
      .map((c) => ({
        ...c,
        articles: hits ? c.articles.filter((a) => hits.has(a.id)) : c.articles,
      }))
      .filter((c) => c.articles.length > 0);
  }, [chapters, currentCategory, hits]);

  const displayArticles = useMemo(() => {
    return displayChapters.flatMap((c) =>
      c.articles.map((a) => ({ article: a, category: c })),
    );
  }, [displayChapters]);

  const totalHitCount = displayArticles.length;

  const { isUnread } = useReadState();
  const site = useSite();
  const device = detectPlatform();
  const download = site.downloads.find((d) => d.platform === device.id);

  const setCategoryFilter = (catName: string) => {
    const next: Record<string, string> = {};
    if (catName !== 'all') next.cat = catName;
    if (q) next.q = q;
    setParams(next);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const next: Record<string, string> = {};
    const trimmed = kw.trim();
    if (trimmed) next.q = trimmed;
    if (currentCategory !== 'all') next.cat = currentCategory;
    setParams(next);
  };

  const clearSearch = () => {
    setKw('');
    const next: Record<string, string> = {};
    if (currentCategory !== 'all') next.cat = currentCategory;
    setParams(next);
  };

  const openArticle = (a: KbArticle) => {
    const next: Record<string, string> = { id: a.id, cat: a.category };
    if (q) next.q = q;
    setParams(next);
  };

  const handleCopySubscribe = async () => {
    if (!subUrl) return;
    if (await copyText(subUrl, 'sub')) {
      toast.success(tr('订阅地址已复制到剪贴板'));
    }
  };

  /* 当前设备：有同名分类就给「看教程」，站长配了下载地址就给「下载」；都没有就不占位置 */
  const deviceChapter = chapters.find((c) => c.platform?.id === device.id);

  return (
    <div className="pb-16">
      <PageTitle
        title={tr('使用手册')}
        sub={tr('客户端下载、连接指南与常见问题。')}
        extra={
          subUrl && (
            <Button variant="outline" className="h-9" onClick={handleCopySubscribe}>
              {copied === 'sub' ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              {copied === 'sub' ? tr('已复制') : tr('复制订阅地址')}
            </Button>
          )
        }
      />

      {/* ── 顶部：搜索独占一行，分类在下面换行排开（不截断、不横向滚动），当前设备的捷径单独一行 ── */}
      <div {...enter({ delay: 0.05 })} className="mt-8 space-y-4">
        <form onSubmit={handleSearchSubmit} role="search" className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label={tr('搜索文档')}
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            placeholder={tr('搜索文档标题或内容…')}
            className="h-11 rounded-xl pr-10 pl-10"
          />
          {kw && (
            <button
              type="button"
              aria-label={tr('清除搜索')}
              onClick={clearSearch}
              className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </form>

        {chapters.length > 0 && (
          <nav aria-label={tr('文档分类')} className="flex flex-wrap gap-2">
            <CategoryChip
              active={currentCategory === 'all'}
              onClick={() => setCategoryFilter('all')}
              icon={<BookOpen className="size-3.5" />}
              label={tr('全部')}
              count={totalArticles}
            />
            {chapters.map((c) => (
              <CategoryChip
                key={c.name}
                active={currentCategory === c.name}
                onClick={() => setCategoryFilter(c.name)}
                icon={<DocCategoryIcon name={c.name} platform={c.platform} className="size-3.5" />}
                label={c.name}
                count={c.articles.length}
              />
            ))}
          </nav>
        )}

        {(deviceChapter || download?.url) && !q && currentCategory === 'all' && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13.5px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <PlatformIcon name={device.icon} className="size-4 text-brand" />
              {tp('你正在使用 {p}', { p: device.name })}
            </span>
            {deviceChapter && (
              <button
                type="button"
                onClick={() => setCategoryFilter(deviceChapter.name)}
                className="inline-flex items-center gap-1 font-medium text-brand underline-offset-4 hover:underline"
              >
                {tp('查看 {p} 教程', { p: deviceChapter.name })}<ArrowRight className="size-3.5" />
              </button>
            )}
            {download?.url && (
              <a
                href={download.url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 font-medium text-brand underline-offset-4 hover:underline"
              >
                <Download className="size-3.5" />{tp('下载 {p} 客户端', { p: device.name })}
              </a>
            )}
          </div>
        )}

        {q && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/50 px-4 py-2.5 text-[13px] text-muted-foreground">
            <span>{tp('关于「{q}」的搜索结果：找到 {n} 篇匹配文档', { q, n: totalHitCount })}</span>
            <Button variant="ghost" size="sm" onClick={clearSearch} className="h-7 px-2 text-brand hover:text-brand-deep">
              {tr('清除搜索')}
            </Button>
          </div>
        )}
      </div>

      <div className="mt-8">
      {/* ── 文档卡片区 ── */}
      {all.loading && !all.data ? (
        <Loading rows={4} />
      ) : all.error && !all.data ? (
        <LoadError error={all.error} onRetry={all.reload} />
      ) : totalArticles === 0 ? (
        <Empty title={tr('暂无文档')} desc={tr('站点知识库尚未发布使用指南。')} />
      ) : totalHitCount === 0 ? (
        <Empty title={tr('未找到相关文档')} desc={tr('请尝试使用其他关键词，或在上方选择不同的平台分类。')} />
      ) : (
        <div className="grid grid-cols-1 gap-4.5 md:grid-cols-2 lg:grid-cols-3">
          {displayArticles.map(({ article, category }, idx) => (
            <GuideCard
              key={article.id}
              article={article}
              category={category}
              index={idx}
              unread={isUnread(article.id)}
              onClick={() => openArticle(article)}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

/** 分类筛选：一枚胶囊，名字完整显示（换行排列，不截断） */
function CategoryChip({
  active, onClick, icon, label, count,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition-colors',
        active
          ? 'border-brand bg-brand text-white dark:text-primary-foreground'
          : 'border-border bg-card text-muted-foreground hover:border-brand/40 hover:text-foreground',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 break-words text-left">{label}</span>
      <span className={cn('tnum shrink-0 rounded-full px-1.5 text-[11px]', active ? 'bg-white/20' : 'bg-muted')}>{count}</span>
    </button>
  );
}

/* ───────────────────────── 现代指南卡片 ───────────────────────── */

function GuideCard({
  article,
  category,
  index,
  unread,
  onClick,
}: {
  article: KbArticle;
  category: DocCategory;
  index: number;
  unread: boolean;
  onClick: () => void;
}) {
  const enter = useEnter();
  const tr = useT();

  return (
    <button
      type="button"
      onClick={onClick}
      {...enter({ delay: stagger(index, 0.04), y: NUDGE, duration: DUR.fast })}
      className="group relative flex hover:-translate-y-[3px] active:scale-[.99] flex-col justify-between rounded-2xl border border-border/80 bg-card p-4 sm:p-5 text-left transition-all duration-200 hover:border-brand/40 hover:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.08)] cursor-pointer"
    >
      <div>
        {/* 卡片顶部元信息 */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <DocCategoryIcon name={category.name} platform={category.platform} className="size-3.5 text-brand" />
            <span>{category.name}</span>
          </div>

          <div className="flex items-center gap-1.5">
            {unread && (
              <span className="size-2 rounded-full bg-brand" title={tr('未读')} />
            )}
          </div>
        </div>

        {/* 标题 */}
        <h4 className="mt-3 text-[15px] font-semibold text-foreground group-hover:text-brand transition-colors line-clamp-2 leading-snug">
          {article.title}
        </h4>

      </div>

      {/* 底部信息 */}
      <div className="mt-4 flex items-center justify-between border-t border-border/50 pt-3 text-xs text-muted-foreground">
        <span>{formatMonthDay(article.updated_at)}</span>
        <span className="flex items-center gap-1 font-medium text-brand group-hover:translate-x-0.5 transition-transform">
          {tr('阅读教程')}
          <ArrowRight className="size-3.5" />
        </span>
      </div>
    </button>
  );
}

/* ───────────────────────── 文章阅读视图 ───────────────────────── */

function ArticleView({ id }: { id: string }) {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const [params, setParams] = useSearchParams();

  const { locale } = useLocale();
  const article = useApi(() => contentApi.article(id), [id], { key: K.article(id) });
  useEffect(() => {
    markRead(id);
  }, [id]);

  const list = useKnowledge();
  const raw = article.data;
  /* 按界面语言取标题、正文、分类名（英文为空回落中文） */
  const a = useMemo(() => raw && {
    id: raw.id,
    title: pick(locale, raw.title_zh, raw.title_en),
    body: pick(locale, raw.html_zh, raw.html_en),
    category: raw.category_zh ? pick(locale, raw.category_zh, raw.category_en) : tr('其他'),
    updated_at: raw.updated_at,
  }, [raw, locale, tr]);
  const body = a?.body;

  const { me } = useAuth();
  const subUrl = mySubUrl(me);
  const [copied, copyText] = useCopy();

  const minutes = useMemo(() => Math.max(1, Math.round(textLength(body) / 400)), [body]);

  /* 提取目录标题 */
  const toc = useMemo(() => {
    const hs = outline(body);
    const h2 = hs.filter((h) => h.level === 2);
    return h2.length ? h2 : hs;
  }, [body]);

  /* 同分类文章（用于上一篇/下一篇和侧边栏） */
  const siblings = useMemo(() => (a ? list.chapters.find((c) => c.name === a.category)?.articles ?? [] : []), [a, list.chapters]);
  const at = siblings.findIndex((x) => x.id === id);
  const prev = at > 0 ? siblings[at - 1] : null;
  const next = at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null;

  /* 滚动高亮当前章节 */
  const [activeHeading, setActiveHeading] = useState<string | null>(null);
  useEffect(() => {
    if (toc.length < 2) return;
    const els = toc.map((h) => document.getElementById(h.id)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        const hit = entries.find((e) => e.isIntersecting);
        if (hit) setActiveHeading(hit.target.id);
      },
      { rootMargin: '-90px 0px -70% 0px' },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [toc]);

  /* 换文章时回到顶部 */
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [id]);

  const toList = (cat?: string) => {
    setParams(cat ? { cat } : {});
  };

  const goToArticle = (target: KbArticle) => {
    const nextParams: Record<string, string> = { id: target.id };
    if (params.get('cat')) nextParams.cat = params.get('cat')!;
    setParams(nextParams);
  };

  const handleCopySub = async () => {
    if (!subUrl) return;
    if (await copyText(subUrl, 'art-sub')) {
      toast.success(tr('订阅链接已复制'));
    }
  };

  if (article.loading && !a) return <Loading rows={5} />;
  if (article.error && !a) return <LoadError error={article.error} onRetry={article.reload} />;
  if (!a) return null;

  return (
    <div className="pb-20">
      {/* ── 页首：与其它页面同一套页首（同样的上边距与标题样式），上方一行面包屑，下方一行元信息 ── */}
      <header {...enter()} className="pt-12 pb-2">
        <nav aria-label={tr('使用手册')} className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted-foreground">
          <button
            type="button"
            onClick={() => toList()}
            className="inline-flex items-center gap-1 rounded-md transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            {tr('使用手册')}
          </button>
          <ChevronRight aria-hidden className="size-3.5 opacity-50" />
          <button
            type="button"
            onClick={() => toList(a.category)}
            className="min-w-0 rounded-md break-words transition-colors hover:text-foreground"
          >
            {a.category}
          </button>
        </nav>

        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 max-w-[48rem]">
            <h1 className="page-title text-balance break-words">{a.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Clock className="size-3.5" />{tp('约 {n} 分钟读完', { n: minutes })}</span>
              <span className="inline-flex items-center gap-1.5"><Calendar className="size-3.5" />{formatDate(a.updated_at)}</span>
            </div>
          </div>
          {subUrl && (
            <Button variant="outline" className="h-9" onClick={handleCopySub}>
              {copied === 'art-sub' ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              {copied === 'art-sub' ? tr('已复制') : tr('复制订阅链接')}
            </Button>
          )}
        </div>
      </header>
      <PageNotices />

      <div className="mt-8 space-y-6">
      {/* 移动端目录折叠抽屉 */}
      {toc.length > 1 && (
        <div className="lg:hidden">
          <details className="group rounded-xl border border-border/70 bg-card p-3 shadow-2xs">
            <summary className="flex cursor-pointer list-none items-center justify-between text-xs font-medium text-foreground">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <BookOpen className="size-3.5 text-brand" />
                {tr('本页目录')}
                <span className="rounded-full bg-muted px-1.5 py-0.2 text-[10px] text-muted-foreground">
                  {toc.length}
                </span>
              </span>
              <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <nav className="mt-2.5 flex flex-col gap-1 border-t border-border/50 pt-2">
              {toc.map((heading) => (
                <a
                  key={heading.id}
                  href={`#${heading.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth' });
                    setActiveHeading(heading.id);
                  }}
                  className={cn(
                    'line-clamp-1 rounded-lg px-2 py-1.5 text-xs transition-colors',
                    activeHeading === heading.id
                      ? 'bg-brand/10 font-medium text-brand'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {heading.text}
                </a>
              ))}
            </nav>
          </details>
        </div>
      )}

      {/* ── 正文与目录两栏结构 ── */}
      <div className="grid gap-8 lg:gap-12 lg:grid-cols-[minmax(0,1fr)_260px] pt-1 sm:pt-2">
        {/* 正文区域 */}
        <article {...enter({ delay: 0.1 })} className="min-w-0">
          <div className="rounded-2xl border border-border/70 bg-card p-4.5 sm:p-7 lg:p-8 shadow-xs overflow-hidden">
            <ServerHtml html={a.body} headings className="rich-article break-words" />
          </div>

          {/* 上一篇 / 下一篇 */}
          {(prev || next) && (
            <div className="mt-6 sm:mt-8 grid gap-3 sm:grid-cols-2">
              {prev ? (
                <button
                  type="button"
                  onClick={() => goToArticle(prev)}
                  className="group flex flex-col justify-between rounded-xl border border-border/80 bg-card p-3.5 sm:p-4 text-left transition-all hover:border-brand/40 hover:shadow-xs cursor-pointer"
                >
                  <span className="flex items-center gap-1 text-xs text-muted-foreground group-hover:text-brand transition-colors">
                    <ArrowLeft className="size-3.5 transition-transform group-hover:-translate-x-1" />
                    {tr('上一篇')}
                  </span>
                  <span className="mt-1.5 text-sm font-medium text-foreground group-hover:text-brand line-clamp-1 transition-colors">
                    {prev.title}
                  </span>
                </button>
              ) : <div className="hidden sm:block" />}

              {next && (
                <button
                  type="button"
                  onClick={() => goToArticle(next)}
                  className="group flex flex-col justify-between rounded-xl border border-border/80 bg-card p-3.5 sm:p-4 text-right transition-all hover:border-brand/40 hover:shadow-xs cursor-pointer"
                >
                  <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground group-hover:text-brand transition-colors">
                    {tr('下一篇')}
                    <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-1" />
                  </span>
                  <span className="mt-1.5 text-sm font-medium text-foreground group-hover:text-brand line-clamp-1 transition-colors">
                    {next.title}
                  </span>
                </button>
              )}
            </div>
          )}

          {/* 底部求助卡片 */}
          <div className="mt-6 sm:mt-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 rounded-xl border border-border/70 bg-muted/30 p-4 sm:p-5 text-sm">
            <div className="flex items-center gap-2.5 sm:gap-3 text-muted-foreground text-xs sm:text-sm">
              <Headphones className="size-4 sm:size-5 shrink-0 text-brand" />
              <span>{tr('按步骤操作仍遇到问题？提交工单联系我们。')}</span>
            </div>
            <Button size="sm" variant="outline" asChild className="shrink-0 rounded-xl self-end sm:self-auto">
              <Link to={R.tickets}>{tr('提交工单')}</Link>
            </Button>
          </div>
        </article>

        {/* 侧边大纲栏 */}
        <aside className="hidden lg:block space-y-6">
          <div className="sticky top-[88px] space-y-6">
            {/* 本页目录 */}
            {toc.length > 1 && (
              <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-xs">
                <div className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {tr('本页目录')}
                </div>
                <nav className="mt-3.5 flex flex-col gap-1.5">
                  {toc.map((heading) => {
                    const active = activeHeading === heading.id;
                    return (
                      <a
                        key={heading.id}
                        href={`#${heading.id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth' });
                          setActiveHeading(heading.id);
                        }}
                        className={cn(
                          'line-clamp-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                          active
                            ? 'bg-brand/10 font-medium text-brand'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        {heading.text}
                      </a>
                    );
                  })}
                </nav>
              </div>
            )}

            {/* 同分类其它文章 */}
            {siblings.length > 1 && (
              <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-xs">
                <div className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {tp('同类文档 · {c}', { c: a.category })}
                </div>
                <div className="mt-3.5 flex flex-col gap-1 max-h-[300px] overflow-y-auto pr-1">
                  {siblings.map((item) => {
                    const isCurrent = String(item.id) === id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => goToArticle(item)}
                        className={cn(
                          'line-clamp-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors cursor-pointer',
                          isCurrent
                            ? 'bg-brand/10 font-medium text-brand'
                            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                        )}
                      >
                        {item.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
      </div>
    </div>
  );
}
