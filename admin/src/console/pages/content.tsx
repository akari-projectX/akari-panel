// 内容 (CNT-*): announcements (audience, site-zone window, pinned, mail to
// the audience) and the knowledge base (categories, articles with a slug —
// `terms` / `privacy` are the portal's legal pages), with the server's
// sanitized live preview next to the Markdown editor.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { del, get, post, put } from "../../shared/api";
import { dateTime, fromLocalInput, toLocalInput } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Drawer, MenuItem, RowMenu, useConfirm, useToast } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Callout,
  Card,
  CardHeader,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  Switch,
  Tabs,
  Textarea,
} from "../../shared/ui/primitives";
import { DataTable, type Column } from "../../shared/ui/table";
import { useDebounced, useRun } from "../kit";
import { navigate, setQuery, useRoute } from "../router";

type Announcement = {
  id: string;
  title_zh: string;
  title_en: string | null;
  body_zh: string;
  body_en: string | null;
  pinned: boolean;
  enabled: boolean;
  visible_from: string | null;
  visible_until: string | null;
  audience: string;
  active: boolean;
  reads: number;
  mail_requested_at: string | null;
  mail_sent: number;
  mail_done_at: string | null;
  created_at: string;
};
type Category = { id: string; name_zh: string; name_en: string | null; sort: number; articles: number };
type Article = {
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

function audienceName(a: string, tr: Tr) {
  return (
    (
      {
        all: tr("全部用户", "Everyone"),
        with_plan: tr("有生效套餐的用户", "Users with a plan"),
        without_plan: tr("没有套餐的用户", "Users without a plan"),
      } as Record<string, string>
    )[a] ?? a
  );
}

export function ContentPage() {
  const tr = useTr();
  const { sub } = useRoute();
  const tab = sub[0] === "kb" ? "kb" : "announcements";
  return (
    <>
      <PageHeader title={tr("内容管理", "Content")} />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={(v) => navigate(`/content/${v}`)}
          tabs={[
            { value: "announcements", label: tr("公告", "Announcements") },
            { value: "kb", label: tr("知识库", "Knowledge base") },
          ]}
        />
      </div>
      {tab === "announcements" ? <Announcements /> : <KnowledgeBase />}
    </>
  );
}

/** Markdown editor with the server-rendered (sanitized) preview. */
function MarkdownField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const tr = useTr();
  const md = useDebounced(value, 400);
  const prev = useQuery({
    queryKey: ["content-preview", md],
    queryFn: () => post<{ html: string }>("/content/preview", { markdown: md }),
    enabled: md.trim().length > 0,
  });
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Field label={label}>
        <Textarea rows={10} value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
      <div>
        <div className="mb-1.5 text-[13px] font-medium">{tr("预览", "Preview")}</div>
        {/* Server-sanitized HTML (markdown.rs): fixed tags, escaped input. */}
        <div
          className="md min-h-24 rounded-md border border-border p-3"
          data-testid="preview"
          dangerouslySetInnerHTML={{ __html: md.trim() ? (prev.data?.html ?? "") : "" }}
        />
      </div>
    </div>
  );
}

function Announcements() {
  const tr = useTr();
  const { query } = useRoute();
  const open = query.get("open");
  const q = useQuery({ queryKey: ["announcements"], queryFn: () => get<Announcement[]>("/announcements") });
  const columns: Column<Announcement>[] = [
    {
      key: "title",
      header: tr("标题", "Title"),
      fixed: true,
      mobile: "title",
      cell: (a) => (
        <span className="flex items-center gap-1.5">
          {a.pinned && <Badge tone="primary">{tr("置顶", "Pinned")}</Badge>}
          {a.title_zh}
        </span>
      ),
    },
    { key: "audience", header: tr("受众", "Audience"), cell: (a) => audienceName(a.audience, tr) },
    {
      key: "state",
      header: tr("状态", "State"),
      cell: (a) => (
        <Badge tone={a.active ? "success" : "neutral"}>
          {a.active
            ? tr("显示中", "Showing")
            : a.enabled
              ? tr("不在时间窗内", "Outside window")
              : tr("已停用", "Disabled")}
        </Badge>
      ),
    },
    {
      key: "window",
      header: tr("时间窗", "Window"),
      optional: true,
      cell: (a) => `${dateTime(a.visible_from)} → ${dateTime(a.visible_until)}`,
    },
    { key: "reads", header: tr("已读", "Reads"), cell: (a) => a.reads },
    {
      key: "mail",
      header: tr("邮件", "Mail"),
      cell: (a) =>
        a.mail_requested_at
          ? a.mail_done_at
            ? tr(`已发 ${a.mail_sent}`, `${a.mail_sent} sent`)
            : tr("发送中", "sending")
          : "—",
    },
    { key: "created", header: tr("创建", "Created"), cell: (a) => dateTime(a.created_at) },
  ];
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button size="sm" variant="primary" icon="plus" onClick={() => setQuery({ open: "new" }, false)}>
          {tr("新建公告", "New announcement")}
        </Button>
      </div>
      <DataTable
        label={tr("公告", "Announcements")}
        storageKey="announcements"
        rows={q.data ?? []}
        columns={columns}
        loading={q.isPending}
        error={q.error}
        onRetry={() => void q.refetch()}
        onRowClick={(a) => setQuery({ open: a.id }, false)}
        activeId={open}
      />
      {open && (
        <AnnouncementEditor
          key={open}
          a={open === "new" ? null : (q.data?.find((x) => x.id === open) ?? null)}
          onClose={() => setQuery({ open: null })}
        />
      )}
    </>
  );
}

function AnnouncementEditor({ a, onClose }: { a: Announcement | null; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [f, setF] = useState({
    title_zh: a?.title_zh ?? "",
    title_en: a?.title_en ?? "",
    body_zh: a?.body_zh ?? "",
    body_en: a?.body_en ?? "",
    pinned: a?.pinned ?? false,
    enabled: a?.enabled ?? true,
    from: toLocalInput(a?.visible_from),
    until: toLocalInput(a?.visible_until),
    audience: a?.audience ?? "all",
  });
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [run, busy] = useRun();
  const body = () => ({
    title_zh: f.title_zh,
    title_en: f.title_en.trim() || null,
    body_zh: f.body_zh,
    body_en: f.body_en.trim() || null,
    pinned: f.pinned,
    enabled: f.enabled,
    visible_from: f.from ? fromLocalInput(f.from) : null,
    visible_until: f.until ? fromLocalInput(f.until) : null,
    audience: f.audience,
  });
  const save = async () => {
    const r = await run(() => (a ? put(`/announcements/${a.id}`, body()) : post("/announcements", body())), {
      ok: tr("公告已保存", "Announcement saved"),
      invalidate: [["announcements"]],
    });
    if (r !== undefined) onClose();
  };
  const mail = async () => {
    if (!a) return;
    const ok = await confirm({
      title: tr("邮件通知受众？", "Mail the audience?"),
      impact: audienceName(a.audience, tr),
      description: tr("只发给已验证的邮箱，经发件箱排队发送。", "Verified addresses only, queued through the outbox."),
      tone: "warning",
      action: () => post(`/announcements/${a.id}/mail`),
    });
    if (ok) toast({ tone: "success", title: tr("已加入发送队列", "Queued") });
  };
  const remove = async () => {
    if (!a) return;
    const ok = await confirm({
      title: tr("删除公告？", "Delete the announcement?"),
      action: () => del(`/announcements/${a.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("已删除", "Deleted") });
      void run(async () => undefined, { invalidate: [["announcements"]] });
      onClose();
    }
  };
  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-4xl"
      title={a ? tr("编辑公告", "Edit announcement") : tr("新建公告", "New announcement")}
      footer={
        <>
          {a && (
            <Button variant="destructive-soft" onClick={remove}>
              {tr("删除", "Delete")}
            </Button>
          )}
          {a && (
            <Button icon="mail" onClick={mail}>
              {tr("邮件通知", "Mail it")}
            </Button>
          )}
          <Button variant="primary" loading={busy} onClick={save}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tr("受众", "Audience")}>
            <Select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}>
              {["all", "with_plan", "without_plan"].map((x) => (
                <option key={x} value={x}>
                  {audienceName(x, tr)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tr("开始显示（站点时区）", "Show from (site time zone)")}>
            <Input type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          </Field>
          <Field label={tr("结束显示（站点时区）", "Show until (site time zone)")}>
            <Input type="datetime-local" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4 text-[13px]">
          <label className="flex items-center gap-2">
            <Switch checked={f.pinned} onChange={(v) => setF({ ...f, pinned: v })} label={tr("置顶", "Pinned")} />
            {tr("置顶", "Pinned")}
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} label={tr("启用", "Enabled")} />
            {tr("启用", "Enabled")}
          </label>
        </div>
        <Segmented
          value={lang}
          onChange={setLang}
          options={[
            { value: "zh", label: tr("中文", "Chinese") },
            { value: "en", label: tr("英文（可选）", "English (optional)") },
          ]}
        />
        {lang === "zh" ? (
          <>
            <Field label={tr("标题（中文）", "Title (Chinese)")}>
              <Input value={f.title_zh} onChange={(e) => setF({ ...f, title_zh: e.target.value })} />
            </Field>
            <MarkdownField
              label={tr("正文（Markdown）", "Body (Markdown)")}
              value={f.body_zh}
              onChange={(v) => setF({ ...f, body_zh: v })}
            />
          </>
        ) : (
          <>
            <Field label={tr("标题（英文）", "Title (English)")}>
              <Input value={f.title_en} onChange={(e) => setF({ ...f, title_en: e.target.value })} />
            </Field>
            <MarkdownField
              label={tr("正文（英文）", "Body (English)")}
              value={f.body_en}
              onChange={(v) => setF({ ...f, body_en: v })}
            />
          </>
        )}
      </div>
    </Drawer>
  );
}

function KnowledgeBase() {
  const tr = useTr();
  const { query } = useRoute();
  const open = query.get("open");
  const cats = useQuery({ queryKey: ["kb", "categories"], queryFn: () => get<Category[]>("/kb/categories") });
  const arts = useQuery({ queryKey: ["kb", "articles"], queryFn: () => get<Article[]>("/kb/articles") });
  const legal = ["terms", "privacy"].filter((s) => !(arts.data ?? []).some((a) => a.slug === s));
  const columns: Column<Article>[] = [
    { key: "title", header: tr("标题", "Title"), fixed: true, mobile: "title", cell: (a) => a.title_zh },
    {
      key: "slug",
      header: tr("固定地址", "Slug"),
      cell: (a) => (a.slug ? <code className="text-xs">{a.slug}</code> : "—"),
    },
    { key: "cat", header: tr("分类", "Category"), cell: (a) => a.category_name ?? tr("未分类", "Uncategorized") },
    {
      key: "pub",
      header: tr("状态", "State"),
      cell: (a) => (
        <Badge tone={a.published ? "success" : "neutral"}>
          {a.published ? tr("已发布", "Published") : tr("草稿", "Draft")}
        </Badge>
      ),
    },
    { key: "sort", header: tr("排序", "Sort"), optional: true, cell: (a) => a.sort },
    { key: "updated", header: tr("更新", "Updated"), cell: (a) => dateTime(a.updated_at) },
  ];
  return (
    <>
      {legal.length > 0 && (
        <div className="mb-3">
          <Callout tone="info">
            {tr(
              `门户的服务条款 / 隐私政策页面读取固定地址为 terms、privacy 的已发布文章；还没有：${legal.join("、")}（缺省显示中性文案）。`,
              `The portal's terms / privacy pages show the published articles with slug terms / privacy; missing: ${legal.join(", ")} (a neutral text is shown).`,
            )}
          </Callout>
        </div>
      )}
      <Categories cats={cats.data ?? []} />
      <div className="mb-3 mt-4 flex justify-end">
        <Button size="sm" variant="primary" icon="plus" onClick={() => setQuery({ open: "new" }, false)}>
          {tr("新建文章", "New article")}
        </Button>
      </div>
      <DataTable
        label={tr("帮助文章", "Articles")}
        storageKey="kb"
        rows={arts.data ?? []}
        columns={columns}
        loading={arts.isPending}
        error={arts.error}
        onRowClick={(a) => setQuery({ open: a.id }, false)}
        activeId={open}
      />
      {open && (
        <ArticleEditor
          key={open}
          a={open === "new" ? null : (arts.data?.find((x) => x.id === open) ?? null)}
          cats={cats.data ?? []}
          onClose={() => setQuery({ open: null })}
        />
      )}
    </>
  );
}

function Categories({ cats }: { cats: Category[] }) {
  const tr = useTr();
  const confirm = useConfirm();
  const [run, busy] = useRun();
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<{ id: string; name_zh: string; name_en: string; sort: string } | null>(null);
  const add = async () => {
    const r = await run(() => post("/kb/categories", { name_zh: name.trim() }), {
      ok: tr("分类已添加", "Category added"),
      invalidate: [["kb"]],
    });
    if (r !== undefined) setName("");
  };
  return (
    <Card>
      <CardHeader title={tr("文章分类", "Categories")} />
      <ul className="divide-y divide-border">
        {cats.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-[13px] sm:px-5">
            {edit?.id === c.id ? (
              <>
                <Input
                  aria-label={tr("分类名称（中文）", "Name (Chinese)")}
                  className="h-8 w-40"
                  value={edit.name_zh}
                  onChange={(e) => setEdit({ ...edit, name_zh: e.target.value })}
                />
                <Input
                  aria-label={tr("英文名称（可选）", "Name (English)")}
                  className="h-8 w-40"
                  value={edit.name_en}
                  onChange={(e) => setEdit({ ...edit, name_en: e.target.value })}
                />
                <Input
                  aria-label={tr("排序", "Sort")}
                  className="h-8 w-20"
                  value={edit.sort}
                  onChange={(e) => setEdit({ ...edit, sort: e.target.value })}
                />
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  onClick={() =>
                    void run(
                      () =>
                        put(`/kb/categories/${c.id}`, {
                          name_zh: edit.name_zh,
                          name_en: edit.name_en.trim() || null,
                          sort: Number(edit.sort) || 0,
                        }),
                      { ok: tr("已保存", "Saved"), invalidate: [["kb"]] },
                    ).then((r) => r !== undefined && setEdit(null))
                  }
                >
                  {tr("保存", "Save")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>
                  {tr("取消", "Cancel")}
                </Button>
              </>
            ) : (
              <>
                <span className="font-medium">{c.name_zh}</span>
                {c.name_en && <span className="text-muted-foreground">{c.name_en}</span>}
                <span className="text-xs text-muted-foreground">
                  {tr(`${c.articles} 篇 · 排序 ${c.sort}`, `${c.articles} articles · sort ${c.sort}`)}
                </span>
                <span className="ml-auto">
                  <RowMenu label={tr(`分类 ${c.name_zh} 的操作`, `Actions of ${c.name_zh}`)}>
                    {(close) => (
                      <>
                        <MenuItem
                          icon="settings"
                          onClick={() => (
                            close(),
                            setEdit({ id: c.id, name_zh: c.name_zh, name_en: c.name_en ?? "", sort: String(c.sort) })
                          )}
                        >
                          {tr("改名 / 排序", "Rename / sort")}
                        </MenuItem>
                        <MenuItem
                          icon="trash"
                          danger
                          onClick={async () => {
                            close();
                            const ok = await confirm({
                              title: tr(`删除分类 ${c.name_zh}？`, `Delete ${c.name_zh}?`),
                              description: tr("其中的文章变为未分类。", "Its articles become uncategorized."),
                              action: () => del(`/kb/categories/${c.id}`),
                            });
                            if (ok)
                              void run(async () => undefined, { ok: tr("已删除", "Deleted"), invalidate: [["kb"]] });
                          }}
                        >
                          {tr("删除", "Delete")}
                        </MenuItem>
                      </>
                    )}
                  </RowMenu>
                </span>
              </>
            )}
          </li>
        ))}
        <li className="flex gap-2 px-4 py-2 sm:px-5">
          <Input
            aria-label={tr("新分类名称", "New category name")}
            placeholder={tr("新分类名称", "New category name")}
            className="h-8 w-56"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button size="sm" disabled={!name.trim()} loading={busy} onClick={add}>
            {tr("添加分类", "Add category")}
          </Button>
        </li>
      </ul>
    </Card>
  );
}

function ArticleEditor({ a, cats, onClose }: { a: Article | null; cats: Category[]; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const full = useQuery({
    queryKey: ["kb", "article", a?.id],
    queryFn: () => get<Article>(`/kb/articles/${a?.id}`),
    enabled: !!a,
  });
  const [f, setF] = useState<Omit<Article, "id" | "category_name" | "updated_at"> & { sortText: string }>({
    category_id: a?.category_id ?? null,
    title_zh: a?.title_zh ?? "",
    title_en: a?.title_en ?? "",
    body_zh: a?.body_zh ?? "",
    body_en: a?.body_en ?? "",
    sort: a?.sort ?? 0,
    sortText: String(a?.sort ?? 0),
    published: a?.published ?? false,
    slug: a?.slug ?? "",
  });
  useEffect(() => {
    if (full.data) setF((x) => ({ ...x, body_zh: full.data.body_zh, body_en: full.data.body_en ?? "" }));
  }, [full.data]);
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [run, busy] = useRun();
  const save = async () => {
    const b = {
      category_id: f.category_id,
      title_zh: f.title_zh,
      title_en: f.title_en?.trim() || null,
      body_zh: f.body_zh,
      body_en: f.body_en?.trim() || null,
      sort: Number(f.sortText) || 0,
      published: f.published,
      slug: f.slug?.trim() || null,
    };
    const r = await run(() => (a ? put(`/kb/articles/${a.id}`, b) : post("/kb/articles", b)), {
      ok: tr("文章已保存", "Article saved"),
      invalidate: [["kb"]],
    });
    if (r !== undefined) onClose();
  };
  const remove = async () => {
    if (!a) return;
    const ok = await confirm({
      title: tr("删除文章？", "Delete the article?"),
      action: () => del(`/kb/articles/${a.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("已删除", "Deleted") });
      void run(async () => undefined, { invalidate: [["kb"]] });
      onClose();
    }
  };
  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-4xl"
      title={a ? tr("编辑文章", "Edit article") : tr("新建文章", "New article")}
      footer={
        <>
          {a && (
            <Button variant="destructive-soft" onClick={remove}>
              {tr("删除", "Delete")}
            </Button>
          )}
          <Button variant="primary" loading={busy} onClick={save}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label={tr("分类", "Category")} className="sm:col-span-2">
            <Select value={f.category_id ?? ""} onChange={(e) => setF({ ...f, category_id: e.target.value || null })}>
              <option value="">{tr("未分类", "Uncategorized")}</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_zh}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={tr("固定地址（可选）", "Slug (optional)")}
            hint={tr("terms / privacy = 门户法律页", "terms / privacy = the portal's legal pages")}
          >
            <Input value={f.slug ?? ""} onChange={(e) => setF({ ...f, slug: e.target.value })} placeholder="terms" />
          </Field>
          <Field label={tr("排序", "Sort")}>
            <Input inputMode="numeric" value={f.sortText} onChange={(e) => setF({ ...f, sortText: e.target.value })} />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <Switch
            checked={f.published}
            onChange={(v) => setF({ ...f, published: v })}
            label={tr("发布", "Published")}
          />
          {tr("发布（用户可见）", "Published (visible to users)")}
        </label>
        <Segmented
          value={lang}
          onChange={setLang}
          options={[
            { value: "zh", label: tr("中文", "Chinese") },
            { value: "en", label: tr("英文（可选）", "English (optional)") },
          ]}
        />
        {lang === "zh" ? (
          <>
            <Field label={tr("文章标题（中文）", "Title (Chinese)")}>
              <Input value={f.title_zh} onChange={(e) => setF({ ...f, title_zh: e.target.value })} />
            </Field>
            <MarkdownField
              label={tr("正文（Markdown）", "Body (Markdown)")}
              value={f.body_zh}
              onChange={(v) => setF({ ...f, body_zh: v })}
            />
          </>
        ) : (
          <>
            <Field label={tr("文章标题（英文，可选）", "Title (English, optional)")}>
              <Input value={f.title_en ?? ""} onChange={(e) => setF({ ...f, title_en: e.target.value })} />
            </Field>
            <MarkdownField
              label={tr("正文（英文）", "Body (English)")}
              value={f.body_en ?? ""}
              onChange={(v) => setF({ ...f, body_en: v })}
            />
          </>
        )}
      </div>
    </Drawer>
  );
}
