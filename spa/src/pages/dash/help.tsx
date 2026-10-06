import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, BookOpen, Calendar, Check, ChevronDown, ChevronRight, Clock,
  Copy, Download, Headphones, Search, Sparkles, X,
} from 'lucide-react';
import { DUR, NUDGE, stagger, useEnter } from '@/lib/motion';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/flat';
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

  return (
    <div className="space-y-8 pb-16">
      <PageTitle
        title={tr('使用手册')}
        sub={tr('全平台客户端下载、连接指南与常见问题排查。')}
        extra={
          subUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopySubscribe}
              className="gap-2 rounded-xl text-xs"
            >
              {copied === 'sub' ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              {copied === 'sub' ? tr('已复制') : tr('复制订阅地址')}
            </Button>
          )
        }
      />

      {/* ── 当前设备快速连接横幅 ── */}
      <div
        {...enter({ delay: 0.05 })}
        className="relative overflow-hidden rounded-2xl border border-border/80 bg-gradient-to-br from-card via-card to-brand/5 p-4 sm:p-6 shadow-xs"
      >
        <div className="flex flex-col justify-between gap-4.5 sm:gap-6 lg:flex-row lg:items-center">
          <div className="flex items-start gap-3.5 sm:gap-4">
            <div className="flex size-11 sm:size-12 shrink-0 items-center justify-center rounded-xl sm:rounded-2xl bg-brand/10 text-brand shadow-inner">
              <PlatformIcon name={device.icon} className="size-5.5 sm:size-6" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                <h2 className="text-[15px] sm:text-[17px] font-semibold text-foreground">
                  {tp('推荐快速接入 · {p}', { p: device.name })}
                </h2>
                <Badge variant="secondary" className="rounded-full bg-brand/10 text-[10px] sm:text-[11px] font-medium text-brand-ink">
                  <Sparkles className="mr-1 size-2.5 sm:size-3" />
                  {tr('当前设备')}
                </Badge>
              </div>
              <p className="mt-1 text-[12.5px] sm:text-[13.5px] text-muted-foreground leading-relaxed">
                {tp('推荐选用 {client} 客户端，配合全协议节点提供极速无缝体验。', { client: device.client })}
              </p>

              {/* 4步指引微步骤 - 移动端支持水平滑移 */}
              <div className="mt-3.5 flex items-center gap-1.5 sm:gap-2 text-[11px] sm:text-xs overflow-x-auto no-scrollbar pb-0.5">
                {device.steps.map((step, idx) => (
                  <div key={idx} className="flex shrink-0 items-center gap-1.5 rounded-lg bg-background/80 px-2.5 py-1 text-muted-foreground border border-border/60">
                    <span className="font-mono text-brand font-semibold">{idx + 1}</span>
                    <span className="whitespace-nowrap">{step}</span>
                    {idx < device.steps.length - 1 && (
                      <ChevronRight className="size-3 text-muted-foreground/40 ml-1 shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-2.5 pt-2 sm:pt-0 border-t border-border/60 sm:border-0">
            {download?.url && (
              <Button asChild size="sm" className="gap-1.5 rounded-xl shadow-xs justify-center w-full sm:w-auto">
                <a href={download.url} target="_blank" rel="noreferrer noopener">
                  <Download className="size-4" />
                  {tp('下载 {p} 客户端', { p: device.name })}
                </a>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCategoryFilter(device.name)}
              className="gap-1.5 rounded-xl justify-center w-full sm:w-auto"
            >
              <BookOpen className="size-4 text-brand" />
              {tp('查看 {p} 教程', { p: device.name })}
            </Button>
          </div>
        </div>
      </div>

      {/* ── 搜索与分类筛选控制栏 ── */}
      <div {...enter({ delay: 0.1 })} className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {/* 分类标签胶囊栏 - 移动端横向滑动滑轨 */}
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1 -mx-4 px-4 sm:mx-0 sm:px-0">
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-xl px-3 sm:px-3.5 py-1.5 sm:py-2 text-[12.5px] sm:text-[13px] font-medium transition-all cursor-pointer select-none',
                currentCategory === 'all'
                  ? 'bg-brand text-white shadow-xs'
                  : 'bg-card border border-border/80 text-muted-foreground hover:border-brand/40 hover:text-foreground hover:bg-accent/40 shadow-2xs',
              )}
            >
              <BookOpen className="size-3.5" />
              <span>{tr('全部')}</span>
              <span className={cn('ml-1 rounded-full px-1.5 py-0.2 text-[10.5px] sm:text-[11px]', currentCategory === 'all' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground')}>
                {totalArticles}
              </span>
            </button>

            {chapters.map((c) => {
              const active = currentCategory === c.name;
              return (
                <button
                  key={c.name}
                  type="button"
                  onClick={() => setCategoryFilter(c.name)}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-xl px-3 sm:px-3.5 py-1.5 sm:py-2 text-[12.5px] sm:text-[13px] font-medium transition-all cursor-pointer select-none',
                    active
                      ? 'bg-brand text-white shadow-xs'
                      : 'bg-card border border-border/80 text-muted-foreground hover:border-brand/40 hover:text-foreground hover:bg-accent/40 shadow-2xs',
                  )}
                >
                  <DocCategoryIcon name={c.name} platform={c.platform} className={cn('size-3.5', active ? 'text-white' : 'text-muted-foreground')} />
                  <span>{c.name}</span>
                  <span className={cn('ml-1 rounded-full px-1.5 py-0.2 text-[10.5px] sm:text-[11px]', active ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground')}>
                    {c.articles.length}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 搜索框 */}
          <form onSubmit={handleSearchSubmit} className="relative w-full sm:w-[260px] shrink-0">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={kw}
              onChange={(e) => setKw(e.target.value)}
              placeholder={tr('搜索文档标题或内容...')}
              className="h-9.5 rounded-xl pr-8 pl-9 text-xs"
            />
            {kw && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <X className="size-3.5" />
              </button>
            )}
          </form>
        </div>

        {/* 搜索结果提示 */}
        {q && (
          <div className="flex items-center justify-between rounded-xl bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
            <span>
              {tp('关于「{q}」的搜索结果：找到 {n} 篇匹配文档', { q, n: totalHitCount })}
            </span>
            <Button variant="ghost" size="sm" onClick={clearSearch} className="h-6 px-2 text-xs text-brand hover:text-brand-deep">
              {tr('清除搜索')}
            </Button>
          </div>
        )}
      </div>

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
    <div className="space-y-6 pb-20">
      {/* ── 顶部导航栏 ── */}
      <div {...enter()} className="flex items-center justify-between gap-2 sm:gap-4 border-b border-border/70 pb-3 sm:pb-4">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2 text-xs text-muted-foreground">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toList(a.category)}
            className="-ml-2 gap-1 rounded-xl text-xs text-muted-foreground hover:text-foreground h-8 px-2 sm:px-2.5"
          >
            <ArrowLeft className="size-3.5 sm:size-4" />
            <span className="hidden sm:inline">{tr('返回使用手册')}</span>
            <span className="sm:hidden">{tr('返回')}</span>
          </Button>
          <span className="text-border">/</span>
          <button
            type="button"
            onClick={() => toList(a.category)}
            className="hover:text-foreground transition-colors cursor-pointer shrink-0"
          >
            {a.category}
          </button>
          <span className="text-border">/</span>
          <span className="truncate max-w-[110px] sm:max-w-[240px] text-foreground font-medium">{a.title}</span>
        </div>

        {subUrl && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopySub}
            className="gap-1.5 rounded-xl text-xs shrink-0 h-8 px-2.5"
          >
            {copied === 'art-sub' ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            <span className="hidden sm:inline">{copied === 'art-sub' ? tr('已复制') : tr('复制订阅链接')}</span>
            <span className="sm:hidden">{copied === 'art-sub' ? tr('已复制') : tr('订阅链接')}</span>
          </Button>
        )}
      </div>

      {/* ── 文章头部 ── */}
      <header {...enter({ delay: 0.05 })} className="space-y-2.5 sm:space-y-3">
        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
          <Badge variant="secondary" className="rounded-full bg-brand/10 text-brand-ink text-xs font-medium">
            {a.category}
          </Badge>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Clock className="size-3.5" />
            {tp('约 {n} 分钟读完', { n: minutes })}
          </span>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Calendar className="size-3.5" />
            {formatDate(a.updated_at)}
          </span>
        </div>

        <h1 className="text-xl sm:text-2xl lg:text-3xl font-semibold tracking-tight text-foreground leading-snug">
          {a.title}
        </h1>
      </header>

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
              <span>{tr('按步骤操作仍遇到异常？我们的技术人员将竭诚为您协助。')}</span>
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
  );
}
