// 内容 · 知识库 (CNT-03…06; v2 proposal §6). Master / detail: the rail
// holds the fixed 法律页面 group (服务条款 /terms, 隐私政策 /privacy — the
// portal's terms page and the sign-up checkbox read them) and the
// categories (counts, 全部文章, 未分类, the 管理分类 gear, 新建分类); the
// right pane lists the category's articles ("全部文章" grouped by category in
// the portal's order) with sort, title, the EN fill chip, slug, state,
// updated and a ⋯ menu (edit, publish / unpublish, delete). Phone: the
// categories become chips, the legal pages a group under the list.
// Article editor = xl dialog with the live preview; the body loads
// separately and is locked (skeleton) until it arrived, without touching a
// title typed meanwhile; the slug is checked live against the other
// articles. Categories = lg dialog (move up / down, zh + en names on one
// row, article count, delete with the "N 篇文章会变成未分类" impact).
// URL: `?cat=<id>|none`, `?q=`, `?open=new|<id>` (`&slug=terms|privacy`,
// `&in=<category>`), `?cats=1`.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  Check,
  FileText,
  FolderOpen,
  Lock,
  Pencil,
  Plus,
  Scale,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { del, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateOnly } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Select, Switch, Textarea } from "../../shared/ui/form";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { FixCount, SearchField } from "../components/kit";
import { LangTabs } from "../components/inputs";
import { LangChip, MarkdownPreview, useMediaQuery } from "../components/support-content";
import { useAction } from "../data";
import { useDebounced } from "../kit";
import { useQS } from "../router";

export type Category = { id: string; name_zh: string; name_en: string | null; sort: number; articles: number };
export type Article = {
  id: string;
  category_id: string | null;
  category_name: string | null;
  title_zh: string;
  title_en: string | null;
  body_zh: string;
  body_en: string | null;
  sort: number;
  published: boolean;
  slug: string | null;
  updated_at: string;
};

const LEGAL = ["terms", "privacy"] as const;
type Legal = (typeof LEGAL)[number];
const isLegal = (slug: string | null | undefined): slug is Legal => slug === "terms" || slug === "privacy";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SORT_RE = /^\d{1,7}$/;
/** The server's bound on a sort value (kb.rs MAX_SORT). */
const MAX_SORT = 1_000_000;

function legalName(s: Legal, tr: Tr) {
  return s === "terms" ? tr("服务条款", "Terms of service") : tr("隐私政策", "Privacy policy");
}

export function useArticles() {
  return useQuery({ queryKey: ["kb", "articles"], queryFn: () => get<Article[]>("/kb/articles") });
}
function useCategories() {
  return useQuery({ queryKey: ["kb", "categories"], queryFn: () => get<Category[]>("/kb/categories") });
}

export function KnowledgeBase() {
  const tr = useTr();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [query, patch] = useQS();
  const cats = useCategories();
  const arts = useArticles();
  const all = arts.data ?? [];
  const docs = all.filter((a) => !isLegal(a.slug));
  const legal = LEGAL.map((s) => ({ slug: s, a: all.find((a) => a.slug === s) }));
  const catList = [...(cats.data ?? [])].sort((a, b) => a.sort - b.sort);
  const rawCat = query.get("cat") ?? "all";
  const cat = rawCat === "none" || catList.some((c) => c.id === rawCat) ? rawCat : "all";
  const q = query.get("q") ?? "";
  const [search, setSearch] = useState(q);
  const dq = useDebounced(search.trim(), 250);
  useEffect(() => {
    if (dq !== q) patch({ q: dq || null }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  useEffect(() => {
    setSearch((s) => (s.trim() === q ? s : q));
  }, [q]);
  const order = new Map(catList.map((c, i) => [c.id, i]));
  const rank = (a: Article) => (a.category_id ? (order.get(a.category_id) ?? 9999) : 10_000);
  const count = (c: string) =>
    c === "all"
      ? docs.length
      : c === "none"
        ? docs.filter((a) => !a.category_id).length
        : docs.filter((a) => a.category_id === c).length;
  const needle = q.toLowerCase();
  const rows = docs
    .filter((a) => cat === "all" || (cat === "none" ? !a.category_id : a.category_id === cat))
    .filter(
      (a) =>
        !needle ||
        a.title_zh.toLowerCase().includes(needle) ||
        (a.title_en ?? "").toLowerCase().includes(needle) ||
        (a.slug ?? "").includes(needle),
    )
    .sort((a, b) => rank(a) - rank(b) || a.sort - b.sort || a.title_zh.localeCompare(b.title_zh));
  const current = catList.find((c) => c.id === cat);
  const catTitle =
    cat === "all"
      ? tr("全部文章", "All articles")
      : cat === "none"
        ? tr("未分类", "Uncategorized")
        : (current?.name_zh ?? "");
  const pick = (c: string) => {
    setSearch("");
    patch({ cat: c === "all" ? null : c, q: null });
  };
  const openNew = () => patch({ open: "new", slug: null, in: cat !== "all" && cat !== "none" ? cat : null });
  const open = query.get("open");
  const editing = open && open !== "new" ? all.find((a) => a.id === open) : undefined;
  const newSlug = query.get("slug");

  const list = arts.isPending ? (
    <div className="divide-y divide-separator" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 px-4">
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="ml-auto h-3 w-20" />
        </div>
      ))}
    </div>
  ) : arts.isError && !arts.data ? (
    <ErrorState
      title={tr("文章加载失败", "The articles did not load")}
      error={arts.error}
      onRetry={() => void arts.refetch()}
    />
  ) : rows.length === 0 ? (
    q ? (
      <EmptyState
        icon={FileText}
        title={tr(`没有包含「${q}」的文章`, `No article matches "${q}"`)}
        action={
          <Button variant="ghost" onClick={() => pick(cat)}>
            {tr("清除搜索", "Clear search")}
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={FolderOpen}
        title={
          cat === "all"
            ? tr("还没有文章", "No articles yet")
            : tr(`「${catTitle}」里还没有文章`, `No articles in "${catTitle}" yet`)
        }
        description={tr(
          "文章发布后出现在门户「帮助中心」。没有文章的分类在门户里不显示。",
          "Published articles show in the portal's help centre. Empty categories are hidden there.",
        )}
        action={
          <Button variant="primary" icon={Plus} onClick={openNew}>
            {cat === "all" ? tr("新建文章", "New article") : tr("在这里新建文章", "New article here")}
          </Button>
        }
      />
    )
  ) : (
    <ul className="divide-y divide-separator" aria-label={tr("帮助文章", "Articles")}>
      {rows.map((a, i) => (
        <Fragment key={a.id}>
          {cat === "all" && (i === 0 || rows[i - 1].category_id !== a.category_id) && (
            <li className="flex h-8 items-center gap-2 bg-window/70 px-4 text-footnote font-semibold text-muted-foreground">
              <FolderOpen className="size-3.5 text-faint" aria-hidden="true" />
              {catList.find((c) => c.id === a.category_id)?.name_zh ?? tr("未分类", "Uncategorized")}
            </li>
          )}
          <ArticleRow a={a} wide={wide} onOpen={() => patch({ open: a.id, slug: null, in: null })} />
        </Fragment>
      ))}
    </ul>
  );

  const catItems = [
    { id: "all", name: tr("全部文章", "All articles") },
    ...catList.map((c) => ({ id: c.id, name: c.name_zh })),
    { id: "none", name: tr("未分类", "Uncategorized") },
  ];
  const legalButton = (l: (typeof legal)[number], row: boolean) => (
    <button
      key={l.slug}
      type="button"
      onClick={() => patch(l.a ? { open: l.a.id, slug: null, in: null } : { open: "new", slug: l.slug, in: null })}
      className={cn(
        "flex w-full items-center gap-2.5 text-left font-medium hover:bg-accent",
        row ? "h-12 px-4 text-body" : "h-9 rounded-[9px] px-2 text-body",
      )}
    >
      {l.slug === "terms" ? (
        <Scale className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate">{legalName(l.slug, tr)}</span>
      {!l.a ? (
        <span className="text-footnote text-warning">{tr("未创建", "Not created")}</span>
      ) : !l.a.published ? (
        <span className="text-footnote text-faint">{tr("未发布", "Not published")}</span>
      ) : row ? (
        <span className="text-footnote text-faint">
          {tr(`更新于 ${dateOnly(l.a.updated_at)}`, `Updated ${dateOnly(l.a.updated_at)}`)}
        </span>
      ) : (
        <span className="font-mono text-caption text-faint">/{l.slug}</span>
      )}
    </button>
  );

  return (
    <>
      {cats.isError && !cats.data && (
        <Card className="mb-4">
          <ErrorState
            compact
            title={tr("分类加载失败", "The categories did not load")}
            error={cats.error}
            onRetry={() => void cats.refetch()}
          />
        </Card>
      )}
      {wide ? (
        <Card className="grid min-h-[560px] grid-cols-[248px_minmax(0,1fr)] overflow-hidden">
          <aside className="border-r border-separator bg-window/50">
            <nav className="grid content-start gap-4 p-2.5" aria-label={tr("知识库分类", "Knowledge base categories")}>
              <div>
                <div className="flex items-center gap-1.5 px-2 pb-1 text-caption font-semibold text-faint">
                  <Lock className="size-3" aria-hidden="true" />
                  {tr("法律页面 · 门户固定读取", "Legal pages · fixed in the portal")}
                </div>
                {legal.map((l) => legalButton(l, false))}
              </div>
              <div>
                <div className="flex items-center px-2 pb-1">
                  <span className="flex-1 text-caption font-semibold text-faint">{tr("分类", "Categories")}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Settings2}
                    aria-label={tr("管理分类", "Manage categories")}
                    onClick={() => patch({ cats: "1" })}
                  />
                </div>
                {cats.isPending ? (
                  <div className="grid gap-1.5 px-2">
                    {[0, 1, 2].map((i) => (
                      <Skeleton key={i} className="h-6" />
                    ))}
                  </div>
                ) : (
                  catItems.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => pick(c.id)}
                      aria-current={cat === c.id || undefined}
                      className={cn(
                        "flex h-8 w-full items-center gap-2.5 rounded-[9px] px-2 text-left text-body font-medium",
                        cat === c.id
                          ? "bg-[color-mix(in_srgb,var(--foreground)_9%,transparent)]"
                          : "text-foreground/80 hover:bg-accent",
                      )}
                    >
                      {c.id === "all" ? (
                        <BookOpen
                          className={cn("size-4", cat === c.id ? "text-primary" : "text-muted-foreground")}
                          aria-hidden="true"
                        />
                      ) : (
                        <FolderOpen
                          className={cn(
                            "size-4",
                            cat === c.id ? "text-primary" : "text-muted-foreground",
                            c.id === "none" && "opacity-60",
                          )}
                          aria-hidden="true"
                        />
                      )}
                      <span className={cn("flex-1 truncate", c.id === "none" && "text-muted-foreground")}>
                        {c.name}
                      </span>
                      <span className="tnum text-footnote text-faint">{arts.data ? count(c.id) : ""}</span>
                    </button>
                  ))
                )}
                <button
                  type="button"
                  onClick={() => patch({ cats: "new" })}
                  className="mt-1 flex h-8 w-full items-center gap-2.5 rounded-[9px] px-2 text-left text-body text-primary hover:bg-accent"
                >
                  <Plus className="size-4" aria-hidden="true" />
                  {tr("新建分类", "New category")}
                </button>
              </div>
            </nav>
          </aside>
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-3 border-b border-separator px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-headline font-semibold">{catTitle}</h2>
                <p className="truncate text-footnote text-muted-foreground">
                  {cat === "all"
                    ? tr(
                        "按分类和排序显示，与门户「帮助中心」一致",
                        "By category and sort, as in the portal's help centre",
                      )
                    : cat === "none"
                      ? tr(
                          "不在任何分类里的文章不会出现在门户的分类导航中",
                          "Articles without a category are not in the portal's category list",
                        )
                      : (current?.name_en ?? "")}
                </p>
              </div>
              <SearchField
                value={search}
                onChange={setSearch}
                label={tr("搜索文章", "Search articles")}
                placeholder={tr("标题或地址", "Title or slug")}
                className="w-56"
              />
              <Button variant="primary" icon={Plus} onClick={openNew}>
                {tr("新建文章", "New article")}
              </Button>
            </div>
            <div className="min-h-0 flex-1">{list}</div>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4">
          <div
            className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]"
            role="group"
            aria-label={tr("知识库分类", "Knowledge base categories")}
          >
            {catItems.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pick(c.id)}
                aria-pressed={cat === c.id}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1 rounded-full px-3 text-footnote font-medium",
                  cat === c.id ? "bg-foreground text-background" : "bg-card shadow-card",
                )}
              >
                {c.name}
                <span className="tnum opacity-60">{arts.data ? count(c.id) : ""}</span>
              </button>
            ))}
            <Button
              variant="outline"
              size="icon"
              icon={Settings2}
              className="shrink-0 rounded-full"
              aria-label={tr("管理分类", "Manage categories")}
              onClick={() => patch({ cats: "1" })}
            />
          </div>
          <SearchField
            value={search}
            onChange={setSearch}
            label={tr("搜索文章", "Search articles")}
            placeholder={tr("标题或地址", "Title or slug")}
          />
          <Card className="overflow-hidden">{list}</Card>
          <section aria-label={tr("法律页面", "Legal pages")}>
            <h3 className="mb-1.5 flex items-center gap-1.5 px-1 text-footnote font-semibold text-muted-foreground">
              <Lock className="size-3" aria-hidden="true" />
              {tr("法律页面", "Legal pages")}
            </h3>
            <Card className="divide-y divide-separator overflow-hidden">{legal.map((l) => legalButton(l, true))}</Card>
          </section>
          <Button variant="primary" size="lg" icon={Plus} onClick={openNew}>
            {tr("新建文章", "New article")}
          </Button>
        </div>
      )}

      {open && (open === "new" || editing) && (
        <ArticleEditor
          key={`${open}:${newSlug ?? ""}`}
          a={editing ?? null}
          newSlug={open === "new" && isLegal(newSlug) ? newSlug : null}
          defaultCat={query.get("in")}
          cats={catList}
          articles={all}
          onClose={() => patch({ open: null, slug: null, in: null }, true)}
        />
      )}
      {query.get("cats") && (
        <CategoriesDialog
          cats={catList}
          articles={all}
          adding={query.get("cats") === "new"}
          onClose={() => patch({ cats: null }, true)}
        />
      )}
    </>
  );
}

function ArticleRow({ a, wide, onOpen }: { a: Article; wide: boolean; onOpen: () => void }) {
  const tr = useTr();
  const toast = useToast();
  const [toggle] = useAction();
  const remove = useDeleteArticle();
  return (
    <li className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50">
      {wide && <span className="tnum w-6 shrink-0 text-right text-footnote text-faint">{a.sort}</span>}
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          <span className="truncate text-body font-semibold hover:text-primary">{a.title_zh}</span>
          {!(a.title_en && a.body_en) && <LangChip on={false}>EN</LangChip>}
        </span>
        <span className="mt-0.5 flex items-center gap-2 text-footnote text-muted-foreground">
          <span className="truncate font-mono text-faint">
            {a.slug ? `/kb/${a.slug}` : tr("无固定地址", "No fixed address")}
          </span>
        </span>
      </button>
      {a.published ? (
        <Badge tone="success" dot>
          {tr("已发布", "Published")}
        </Badge>
      ) : (
        <Badge tone="outline">{tr("草稿", "Draft")}</Badge>
      )}
      {wide && <span className="tnum w-20 shrink-0 text-right text-footnote text-faint">{dateOnly(a.updated_at)}</span>}
      <RowMenu label={tr(`${a.title_zh} 的操作`, `Actions of ${a.title_zh}`)}>
        {() => (
          <>
            <MenuItem icon={Pencil} onClick={onOpen}>
              {tr("编辑", "Edit")}
            </MenuItem>
            <MenuItem
              icon={a.published ? X : Send}
              onClick={() =>
                void toggle(
                  async () => {
                    const full = await get<Article>(`/kb/articles/${a.id}`);
                    return put(`/kb/articles/${a.id}`, { ...articleBody(full), published: !a.published });
                  },
                  { ok: a.published ? tr("已撤回为草稿", "Back to draft") : tr("已发布", "Published") },
                )
              }
            >
              {a.published ? tr("撤回为草稿", "Unpublish") : tr("发布", "Publish")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={Trash2}
              danger
              onClick={async () => {
                if (await remove(a)) toast({ tone: "success", title: tr("已删除", "Deleted") });
              }}
            >
              {tr("删除…", "Delete…")}
            </MenuItem>
          </>
        )}
      </RowMenu>
    </li>
  );
}

/** The PUT body of an article as stored (for a publish toggle). */
function articleBody(a: Article) {
  return {
    category_id: a.category_id,
    title_zh: a.title_zh,
    title_en: a.title_en,
    body_zh: a.body_zh,
    body_en: a.body_en,
    sort: a.sort,
    published: a.published,
    slug: a.slug,
  };
}

function useDeleteArticle() {
  const tr = useTr();
  const confirm = useConfirm();
  return (a: Article) =>
    confirm({
      title: tr(`删除文章「${a.title_zh}」？`, `Delete "${a.title_zh}"?`),
      description: isLegal(a.slug)
        ? tr(
            "这是门户的法律页面：删除后门户的条款页显示中性文案。",
            "This is a portal legal page: the portal falls back to a neutral text.",
          )
        : tr(
            "门户里立即消失，指向它的链接会变成 404。",
            "It disappears from the portal at once; links to it become 404.",
          ),
      impacts: [
        {
          label: tr("地址", "Address"),
          value: <span className="font-mono">{a.slug ? `/kb/${a.slug}` : tr("无固定地址", "No fixed address")}</span>,
        },
        { label: tr("状态", "State"), value: a.published ? tr("已发布", "Published") : tr("草稿", "Draft") },
      ],
      typeToConfirm: a.title_zh,
      confirmLabel: tr("删除文章", "Delete article"),
      action: () => del(`/kb/articles/${a.id}`),
    });
}

/* ---------- Article editor ---------- */

function ArticleEditor({
  a,
  newSlug,
  defaultCat,
  cats,
  articles,
  onClose,
}: {
  a: Article | null;
  /** A new legal page (terms / privacy). */
  newSlug: Legal | null;
  defaultCat: string | null;
  cats: Category[];
  articles: Article[];
  onClose: () => void;
}) {
  const tr = useTr();
  const toast = useToast();
  const qc = useQueryClient();
  const remove = useDeleteArticle();
  const full = useQuery({
    queryKey: ["kb", "article", a?.id],
    queryFn: () => get<Article>(`/kb/articles/${a?.id}`),
    enabled: !!a,
    // Re-reads must never replace what the operator is typing.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const legalSlug: Legal | null = isLegal(a?.slug) ? (a.slug as Legal) : newSlug;
  const [f, setF] = useState({
    category_id: a ? a.category_id : cats.some((c) => c.id === defaultCat) ? defaultCat : null,
    title_zh: a?.title_zh ?? (newSlug ? legalName(newSlug, (zh) => zh) : ""),
    title_en: a?.title_en ?? (newSlug ? legalName(newSlug, (_zh, en) => en) : ""),
    body_zh: "",
    body_en: "",
    sortText: String(a?.sort ?? 0),
    published: a?.published ?? false,
    slug: a?.slug ?? newSlug ?? "",
  });
  // The body arrives once, before the body fields are editable; titles typed meanwhile stay.
  const [loaded, setLoaded] = useState(!a);
  useEffect(() => {
    if (full.data && !loaded) {
      setF((x) => ({ ...x, body_zh: full.data.body_zh, body_en: full.data.body_en ?? "" }));
      setLoaded(true);
    }
  }, [full.data, loaded]);
  const [lang, setLang] = useState("zh");
  const [tried, setTried] = useState(false);
  const [save, saving] = useAction();
  const slug = f.slug.trim();
  const clash = slug ? articles.find((x) => x.slug === slug && x.id !== a?.id) : undefined;
  const sort = f.sortText.trim();
  const errs = {
    title_zh: !f.title_zh.trim() ? tr("请填写中文标题", "Enter the Chinese title") : null,
    body_zh: loaded && !f.body_zh.trim() ? tr("请填写中文正文", "Enter the Chinese body") : null,
    sort:
      !SORT_RE.test(sort) || Number(sort) > MAX_SORT
        ? tr("请输入 0 或正整数（最大 1000000）", "Enter 0 or a whole number (up to 1000000)")
        : null,
    slug: legalSlug
      ? null
      : slug && !SLUG_RE.test(slug)
        ? tr("只能用小写字母、数字和短横线，不能以短横线开头", "Lowercase letters, digits and -, not starting with -")
        : clash
          ? tr(`已被「${clash.title_zh}」使用`, `Already used by "${clash.title_zh}"`)
          : null,
  };
  const bad = Object.values(errs).filter(Boolean).length;
  const err = (k: keyof typeof errs) => (tried && errs[k]) || undefined;
  const submit = async () => {
    setTried(true);
    if (!loaded) return;
    if (bad) {
      if (errs.title_zh || errs.body_zh) setLang("zh");
      return;
    }
    const b = {
      category_id: legalSlug ? (a?.category_id ?? null) : f.category_id,
      title_zh: f.title_zh.trim(),
      title_en: f.title_en.trim() || null,
      body_zh: f.body_zh,
      body_en: f.body_en.trim() ? f.body_en : null,
      sort: Number(sort),
      published: f.published,
      slug: legalSlug ?? (slug || null),
    };
    const r = await save(() => (a ? put(`/kb/articles/${a.id}`, b) : post("/kb/articles", b)), {
      ok: tr("文章已保存", "Article saved"),
    });
    if (r !== undefined) {
      if (a) void qc.removeQueries({ queryKey: ["kb", "article", a.id] });
      onClose();
    }
  };
  const zh = lang === "zh";
  const cur = zh ? { title: f.title_zh, body: f.body_zh } : { title: f.title_en, body: f.body_en };
  const setTitle = (v: string) => setF((x) => (zh ? { ...x, title_zh: v } : { ...x, title_en: v }));
  const setBody = (v: string) => setF((x) => (zh ? { ...x, body_zh: v } : { ...x, body_en: v }));
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      icon={legalSlug ? Scale : FileText}
      title={
        legalSlug
          ? tr(`编辑${legalName(legalSlug, tr)}`, `Edit the ${legalName(legalSlug, tr).toLowerCase()}`)
          : a
            ? tr("编辑文章", "Edit article")
            : tr("新建文章", "New article")
      }
      description={
        legalSlug
          ? tr(
              `门户的 /${legalSlug} 页面和注册页的勾选框读取这篇，地址固定。`,
              `The portal's /${legalSlug} page and the sign-up checkbox read this article; its address is fixed.`,
            )
          : tr("发布后出现在门户「帮助中心」。", "Shows in the portal's help centre once published.")
      }
      footer={
        <>
          {a && (
            <Button
              variant="ghost"
              icon={Trash2}
              className="mr-auto text-destructive"
              onClick={async () => {
                if (await remove(a)) {
                  toast({ tone: "success", title: tr("已删除", "Deleted") });
                  onClose();
                }
              }}
            >
              {tr("删除", "Delete")}
            </Button>
          )}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {tried && <FixCount n={bad} />}
            <Button variant="ghost" onClick={onClose}>
              {tr("取消", "Cancel")}
            </Button>
            <Button variant="primary" loading={saving} disabled={!loaded} onClick={() => void submit()}>
              {tr("保存", "Save")}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="grid min-w-0 content-start gap-4">
          {!loaded && !full.isError && (
            <div
              className="flex items-center gap-2 rounded-lg bg-info-soft px-3 py-2 text-footnote text-foreground/80"
              role="status"
            >
              {tr(
                "正在载入正文。载入完成前正文不能编辑；你已经改的标题不会被覆盖。",
                "Loading the body. It cannot be edited until it arrives; titles you changed are kept.",
              )}
            </div>
          )}
          {!legalSlug && (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_112px]">
              <Field label={tr("分类", "Category")}>
                <Select
                  value={f.category_id ?? ""}
                  onChange={(e) => setF({ ...f, category_id: e.target.value || null })}
                >
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name_zh}
                    </option>
                  ))}
                  <option value="">{tr("未分类", "Uncategorized")}</option>
                </Select>
              </Field>
              <Field label={tr("排序", "Sort")} hint={tr("小的在前", "Smaller first")} error={err("sort")}>
                <Input
                  inputMode="numeric"
                  value={f.sortText}
                  onChange={(e) => setF({ ...f, sortText: e.target.value })}
                />
              </Field>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <LangTabs
              value={lang}
              onChange={setLang}
              items={[
                {
                  value: "zh",
                  label: tr("中文", "Chinese"),
                  filled: !!(f.title_zh.trim() && f.body_zh.trim()),
                  required: true,
                },
                { value: "en", label: "English", filled: !!(f.title_en.trim() && f.body_en.trim()) },
              ]}
            />
            <span className="text-footnote text-faint">
              {zh ? tr("必填", "Required") : tr("不填则英文用户看到中文", "Empty = English readers see Chinese")}
            </span>
          </div>
          <Field
            label={
              zh ? tr("文章标题（中文）", "Title (Chinese)") : tr("文章标题（英文，可选）", "Title (English, optional)")
            }
            required={zh}
            error={zh ? err("title_zh") : undefined}
          >
            <Input value={cur.title} maxLength={200} data-autofocus onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field
            label={zh ? tr("正文（Markdown）", "Body (Markdown)") : tr("正文（英文）", "Body (English)")}
            required={zh}
            error={zh ? err("body_zh") : undefined}
            hint={tr(
              "支持 Markdown：## 小标题、**粗体**、链接、图片地址",
              "Markdown: ## headings, **bold**, links, image URLs",
            )}
          >
            {full.isError && !loaded ? (
              <ErrorState compact error={full.error} onRetry={() => void full.refetch()} />
            ) : (
              <div className="relative">
                <Textarea
                  value={cur.body}
                  disabled={!loaded}
                  onChange={(e) => setBody(e.target.value)}
                  className="min-h-48 font-mono text-footnote"
                />
                {!loaded && (
                  <div className="pointer-events-none absolute inset-0 grid content-start gap-2 p-3" aria-hidden="true">
                    {[70, 92, 55, 84, 40].map((w, i) => (
                      <Skeleton key={i} className="h-2.5" style={{ width: `${w}%` }} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </Field>
          {!legalSlug && (
            <Field
              label={tr("地址（可选）", "Address (optional)")}
              error={err("slug")}
              hint={
                slug && !errs.slug ? (
                  <span className="flex items-center gap-1 text-success">
                    <Check className="size-3.5" aria-hidden="true" />
                    {tr(`可用 · 门户地址 /kb/${slug}`, `Available · portal address /kb/${slug}`)}
                  </span>
                ) : slug && errs.slug ? (
                  <span className="text-destructive">{errs.slug}</span>
                ) : (
                  tr(
                    "小写字母、数字、短横线；发布后改地址，旧链接会失效",
                    "Lowercase letters, digits, -; changing it after publishing breaks old links",
                  )
                )
              }
            >
              <div className="flex items-center rounded-md shadow-[0_0_0_0.5px_var(--input)]">
                <span className="pl-2.5 font-mono text-footnote text-faint" aria-hidden="true">
                  /kb/
                </span>
                <Input
                  value={f.slug}
                  onChange={(e) => setF({ ...f, slug: e.target.value })}
                  className="font-mono text-footnote shadow-none"
                />
              </div>
            </Field>
          )}
          <div className="flex items-center gap-3 rounded-lg bg-window px-3 py-2.5 ring-1 ring-border ring-inset">
            <Send className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium">{tr("发布", "Published")}</span>
              <span className="block text-footnote text-muted-foreground">
                {legalSlug
                  ? tr(
                      "关闭后门户的条款页显示中性文案，注册页不再链接这篇。",
                      "When off, the portal shows a neutral text and the sign-up page no longer links it.",
                    )
                  : tr("关闭 = 草稿，只有管理员能看到。", "Off = draft, only admins see it.")}
              </span>
            </span>
            <Switch
              checked={f.published}
              onChange={(v) => setF({ ...f, published: v })}
              label={tr("发布", "Published")}
            />
          </div>
        </div>
        <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          <MarkdownPreview
            className="min-h-[320px] lg:h-[calc(min(86vh,880px)-170px)]"
            title={cur.title}
            markdown={cur.body}
            loading={!loaded}
            label={
              zh
                ? tr("门户预览 · 中文", "Portal preview · Chinese")
                : tr("门户预览 · English", "Portal preview · English")
            }
          />
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- Categories ---------- */

type CatDraft = { key: string; id: string | null; name_zh: string; name_en: string; sort: number };

function CategoriesDialog({
  cats,
  articles,
  adding,
  onClose,
}: {
  cats: Category[];
  articles: Article[];
  adding: boolean;
  onClose: () => void;
}) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [save, saving] = useAction();
  const fresh = (): CatDraft => ({ key: `n${Math.random()}`, id: null, name_zh: "", name_en: "", sort: 0 });
  const [rows, setRows] = useState<CatDraft[]>(() => [
    ...cats.map((c) => ({ key: c.id, id: c.id, name_zh: c.name_zh, name_en: c.name_en ?? "", sort: c.sort })),
    ...(adding ? [fresh()] : []),
  ]);
  const [tried, setTried] = useState(false);
  // A category deleted meanwhile (here) leaves the draft too.
  const ids = cats.map((c) => c.id).join(",");
  useEffect(() => {
    const live = new Set(ids.split(","));
    setRows((rs) => (rs.some((r) => r.id && !live.has(r.id)) ? rs.filter((r) => !r.id || live.has(r.id)) : rs));
  }, [ids]);
  const n = (id: string | null) => (id ? articles.filter((a) => a.category_id === id).length : 0);
  const move = (i: number, d: -1 | 1) =>
    setRows((rs) => {
      const x = [...rs];
      [x[i], x[i + d]] = [x[i + d], x[i]];
      return x;
    });
  const set = (key: string, patch: Partial<CatDraft>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const bad = rows.filter((r) => !r.name_zh.trim()).length;
  const original = new Map(cats.map((c) => [c.id, c]));
  const dirty =
    rows.some((r, i) => {
      if (!r.id) return true;
      const c = original.get(r.id);
      return !c || c.name_zh !== r.name_zh || (c.name_en ?? "") !== r.name_en || cats.indexOf(c) !== i;
    }) || rows.filter((r) => r.id).length !== cats.length;
  const submit = async () => {
    setTried(true);
    if (bad) return;
    const r = await save(
      async () => {
        // Sorts follow the order on screen (10, 20, …), only changed rows are written.
        for (const [i, row] of rows.entries()) {
          const sort = (i + 1) * 10;
          const body = { name_zh: row.name_zh.trim(), name_en: row.name_en.trim() || null, sort };
          if (!row.id) await post("/kb/categories", body);
          else {
            const c = original.get(row.id);
            if (!c || c.name_zh !== body.name_zh || (c.name_en ?? null) !== body.name_en || c.sort !== sort)
              await put(`/kb/categories/${row.id}`, body);
          }
        }
        return true;
      },
      { ok: tr("分类已保存", "Categories saved") },
    );
    if (r !== undefined) onClose();
  };
  const remove = async (row: CatDraft) => {
    if (!row.id) {
      setRows((rs) => rs.filter((r) => r.key !== row.key));
      return;
    }
    const count = n(row.id);
    const name = cats.find((c) => c.id === row.id)?.name_zh ?? row.name_zh;
    const ok = await confirm({
      title: tr(`删除分类「${name}」？`, `Delete the category "${name}"?`),
      description: tr("分类里的文章不会被删除。", "Its articles are kept."),
      impacts: [
        {
          label: tr("会变成未分类的文章", "Articles that become uncategorized"),
          value: tr(`${count} 篇文章会变成未分类`, `${count} articles become uncategorized`),
        },
        {
          label: tr("门户帮助中心", "Portal help centre"),
          value: tr("不再显示这个分类", "No longer shows this category"),
        },
      ],
      typeToConfirm: name,
      confirmLabel: tr("删除分类", "Delete category"),
      action: () => del(`/kb/categories/${row.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("已删除", "Deleted") });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={FolderOpen}
      title={tr("管理分类", "Manage categories")}
      description={tr(
        "顺序就是门户「帮助中心」里的顺序。中文名必填，英文名可选。",
        "The order is the portal help centre's order. The Chinese name is required, English optional.",
      )}
      dirty={dirty}
      footer={
        <>
          <Button variant="ghost" icon={Plus} className="mr-auto" onClick={() => setRows((rs) => [...rs, fresh()])}>
            {tr("新建分类", "New category")}
          </Button>
          {tried && <FixCount n={bad} />}
          <Button variant="ghost" onClick={onClose}>
            {tr("取消", "Cancel")}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title={tr("还没有分类", "No categories yet")}
          description={tr("文章可以不分类。", "Articles may stay uncategorized.")}
        />
      ) : (
        <div className="grid gap-1.5">
          <div className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_64px_36px] gap-2 px-1 text-footnote font-medium text-muted-foreground max-sm:hidden">
            <span>{tr("顺序", "Order")}</span>
            <span>{tr("中文名", "Chinese name")}</span>
            <span>English</span>
            <span className="text-right">{tr("文章", "Articles")}</span>
            <span />
          </div>
          {rows.map((r, i) => {
            const label = r.name_zh || tr("新分类", "new category");
            return (
              <div
                key={r.key}
                className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_64px_36px] items-center gap-2 rounded-lg px-1 py-1 hover:bg-accent/50 max-sm:grid-cols-[72px_minmax(0,1fr)_36px]"
              >
                <span className="flex">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={ArrowUp}
                    disabled={i === 0}
                    aria-label={tr(`上移 ${label}`, `Move ${label} up`)}
                    onClick={() => move(i, -1)}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={ArrowDown}
                    disabled={i === rows.length - 1}
                    aria-label={tr(`下移 ${label}`, `Move ${label} down`)}
                    onClick={() => move(i, 1)}
                  />
                </span>
                <Input
                  value={r.name_zh}
                  maxLength={60}
                  aria-label={tr(`分类 ${i + 1} 的中文名`, `Chinese name of category ${i + 1}`)}
                  placeholder={tr("中文名", "Chinese name")}
                  aria-invalid={(tried && !r.name_zh.trim()) || undefined}
                  data-autofocus={(!r.id && i === rows.length - 1) || undefined}
                  onChange={(e) => set(r.key, { name_zh: e.target.value })}
                />
                <Input
                  value={r.name_en}
                  maxLength={60}
                  aria-label={tr(`分类 ${i + 1} 的英文名`, `English name of category ${i + 1}`)}
                  placeholder="English name"
                  className="max-sm:col-start-2 max-sm:row-start-2"
                  onChange={(e) => set(r.key, { name_en: e.target.value })}
                />
                <span className="tnum text-right text-footnote text-muted-foreground max-sm:hidden">
                  {tr(`${n(r.id)} 篇`, `${n(r.id)}`)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  icon={Trash2}
                  className="text-faint hover:text-destructive max-sm:col-start-3 max-sm:row-start-1"
                  aria-label={tr(`删除 ${label}`, `Delete ${label}`)}
                  onClick={() => void remove(r)}
                />
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}
