// 内容 (CNT-*; audit §5.9): announcements (audience, site-zone window,
// pinned, mail to the audience with the recipient count and a re-send
// warning) and the knowledge base (categories, articles with a slug —
// `terms` / `privacy` are the portal's legal pages), with the server's
// sanitized live preview next to the Markdown editor. Editors are dialogs
// with the dirty guard; zh/en tabs say which language is filled.
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { BookOpen, FolderPlus, Mail, Megaphone, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { del, get, post, put } from "../../shared/api";
import { dateTime, fromLocalInput, toLocalInput } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Segmented, Select, SwitchField, Textarea } from "../../shared/ui/form";
import { Callout, PageHeader } from "../../shared/ui/layout";
import { MenuItem, RowMenu } from "../../shared/ui/menu";
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from "../../shared/ui/states";
import { DataTable, type Column } from "../../shared/ui/table";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";
import { useAction } from "../data";
import { useDebounced } from "../kit";
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

const SORT_RE = /^-?\d{1,9}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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
      <PageHeader
        title={tr("内容管理", "Content")}
        description={tr(
          "门户里的公告与帮助文章；正文是 Markdown，由面板渲染并消毒。",
          "Announcements and help articles in the portal; Markdown rendered and sanitized by the panel.",
        )}
        actions={
          tab === "announcements" ? (
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setQuery({ open: "new" }, false)}>
              {tr("新建公告", "New announcement")}
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={Plus} onClick={() => setQuery({ open: "new" }, false)}>
              {tr("新建文章", "New article")}
            </Button>
          )
        }
      />
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
function MarkdownField({
  label,
  value,
  onChange,
  error,
  disabled,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  disabled?: boolean;
  required?: boolean;
}) {
  const tr = useTr();
  const md = useDebounced(value, 400);
  const prev = useQuery({
    queryKey: ["content-preview", md],
    queryFn: () => post<{ html: string }>("/content/preview", { markdown: md }),
    enabled: md.trim().length > 0,
  });
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Field label={label} error={error} required={required}>
        <Textarea rows={12} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </Field>
      <div className="grid content-start gap-1.5">
        <div className="flex items-center justify-between text-footnote font-medium text-muted-foreground">
          {tr("预览", "Preview")}
          {md.trim() && prev.isFetching && <span className="text-faint">{tr("渲染中…", "Rendering…")}</span>}
        </div>
        {md.trim() && prev.isError ? (
          <div className="rounded-md bg-window">
            <ErrorState compact error={prev.error} onRetry={() => void prev.refetch()} />
          </div>
        ) : (
          /* Server-sanitized HTML (markdown.rs): fixed tags, escaped input. */
          <div
            className="md min-h-24 overflow-x-auto rounded-md bg-window p-3 text-body"
            data-testid="preview"
            aria-busy={prev.isFetching || undefined}
            dangerouslySetInnerHTML={{ __html: md.trim() ? (prev.data?.html ?? "") : "" }}
          />
        )}
        {!md.trim() && <p className="text-footnote text-faint">{tr("输入正文后在这里预览。", "Type to preview.")}</p>}
      </div>
    </div>
  );
}

/** zh / en switch that says which language is filled in. */
function LangSwitch({
  value,
  onChange,
  zhFilled,
  enFilled,
}: {
  value: "zh" | "en";
  onChange: (v: "zh" | "en") => void;
  zhFilled: boolean;
  enFilled: boolean;
}) {
  const tr = useTr();
  const mark = (filled: boolean, optional: boolean) => (
    <Badge tone={filled ? "success" : optional ? "neutral" : "warning"} className="px-1.5">
      {filled ? tr("已填", "filled") : tr("未填", "empty")}
    </Badge>
  );
  return (
    <Segmented
      label={tr("语言", "Language")}
      value={value}
      onChange={onChange}
      options={[
        {
          value: "zh",
          label: (
            <>
              {tr("中文", "Chinese")} {mark(zhFilled, false)}
            </>
          ),
        },
        {
          value: "en",
          label: (
            <>
              {tr("英文（可选）", "English (optional)")} {mark(enFilled, true)}
            </>
          ),
        },
      ]}
    />
  );
}

function Announcements() {
  const tr = useTr();
  const { query } = useRoute();
  const open = query.get("open");
  const q = useQuery({
    queryKey: ["announcements"],
    queryFn: () => get<Announcement[]>("/announcements"),
    // While a mailing runs, follow its progress.
    refetchInterval: (s) => ((s.state.data ?? []).some((a) => a.mail_requested_at && !a.mail_done_at) ? 5000 : false),
  });
  const columns: Column<Announcement>[] = [
    {
      key: "title",
      header: tr("标题", "Title"),
      fixed: true,
      mobile: "title",
      cell: (a) => (
        <span className="flex min-w-0 items-center gap-1.5">
          {a.pinned && <Badge tone="primary">{tr("置顶", "Pinned")}</Badge>}
          <span className="break-words">{a.title_zh}</span>
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
    { key: "reads", header: tr("已读", "Reads"), align: "right", cell: (a) => a.reads },
    {
      key: "mail",
      header: tr("邮件", "Mail"),
      cell: (a) =>
        a.mail_requested_at ? (
          a.mail_done_at ? (
            <Badge tone="success">{tr(`已发 ${a.mail_sent} 封`, `${a.mail_sent} sent`)}</Badge>
          ) : (
            <Badge tone="info">{tr(`发送中 · ${a.mail_sent} 封`, `sending · ${a.mail_sent}`)}</Badge>
          )
        ) : (
          <span className="text-faint">—</span>
        ),
    },
    { key: "created", header: tr("创建", "Created"), cell: (a) => dateTime(a.created_at) },
  ];
  const editing = open && open !== "new" ? q.data?.find((x) => x.id === open) : undefined;
  return (
    <>
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
        empty={
          <EmptyState
            icon={Megaphone}
            title={tr("还没有公告", "No announcements yet")}
            description={tr(
              "公告显示在门户首页，也可以邮件通知受众。",
              "Shown on the portal home; can be mailed to the audience.",
            )}
            action={
              <Button size="sm" variant="primary" icon={Plus} onClick={() => setQuery({ open: "new" }, false)}>
                {tr("新建公告", "New announcement")}
              </Button>
            }
          />
        }
      />
      {open && (open === "new" || editing) && (
        <AnnouncementEditor key={open} a={editing ?? null} onClose={() => setQuery({ open: null })} />
      )}
    </>
  );
}

/** Upper bound of a mailing's recipients from the user list counts (verified addresses only get it). */
async function recipientEstimate(audience: string): Promise<number | null> {
  try {
    const all = (await get<{ total: number }>("/users?role=user&limit=1")).total;
    if (audience === "all") return all;
    const none = (await get<{ total: number }>("/users?role=user&plan_id=none&limit=1")).total;
    return audience === "without_plan" ? none : all - none;
  } catch {
    return null;
  }
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
  const [tried, setTried] = useState(false);
  const [save, saving] = useAction();
  const [mailing, setMailing] = useState(false);
  const errs = {
    title_zh: !f.title_zh.trim() ? tr("请填写中文标题", "Enter the Chinese title") : null,
    body_zh: !f.body_zh.trim() ? tr("请填写中文正文", "Enter the Chinese body") : null,
    body_en:
      f.title_en.trim() && !f.body_en.trim() ? tr("填了英文标题就要填英文正文", "An English title needs a body") : null,
    until: f.from && f.until && f.until <= f.from ? tr("结束时间要晚于开始时间", "Must be after the start") : null,
  };
  const bad = Object.values(errs).filter(Boolean).length;
  const err = (k: keyof typeof errs) => (tried && errs[k]) || undefined;
  const body = () => ({
    title_zh: f.title_zh.trim(),
    title_en: f.title_en.trim() || null,
    body_zh: f.body_zh,
    body_en: f.body_en.trim() || null,
    pinned: f.pinned,
    enabled: f.enabled,
    visible_from: f.from ? fromLocalInput(f.from) : null,
    visible_until: f.until ? fromLocalInput(f.until) : null,
    audience: f.audience,
  });
  const submit = async () => {
    setTried(true);
    if (bad) {
      if (errs.title_zh || errs.body_zh) setLang("zh");
      else if (errs.body_en) setLang("en");
      return;
    }
    const r = await save(() => (a ? put(`/announcements/${a.id}`, body()) : post("/announcements", body())), {
      ok: tr("公告已保存", "Announcement saved"),
    });
    if (r !== undefined) onClose();
  };
  const mail = async () => {
    if (!a || mailing) return;
    setMailing(true);
    const n = await recipientEstimate(a.audience);
    setMailing(false);
    const again = !!a.mail_requested_at;
    const ok = await confirm({
      title: again ? tr("再次邮件通知受众？", "Mail the audience again?") : tr("邮件通知受众？", "Mail the audience?"),
      description: tr(
        "只发给已验证的邮箱，经发件箱排队发送（按收件人的语言）。",
        "Verified addresses only, queued through the outbox (in each recipient's language).",
      ),
      impact:
        n === null
          ? tr(
              `受众：${audienceName(a.audience, tr)}（人数未知）`,
              `Audience: ${audienceName(a.audience, tr)} (count unknown)`,
            )
          : tr(
              `${audienceName(a.audience, tr)}：最多 ${n} 人（未验证邮箱的不发）`,
              `${audienceName(a.audience, tr)}: up to ${n} people (unverified addresses skipped)`,
            ),
      details: again ? (
        <Callout tone="warning">
          {tr(
            `这条公告已在 ${dateTime(a.mail_requested_at)} 发过（${a.mail_sent} 封）；再次发送会把全部受众重新发一遍。`,
            `Already mailed ${dateTime(a.mail_requested_at)} (${a.mail_sent}); sending again mails the whole audience again.`,
          )}
        </Callout>
      ) : undefined,
      tone: "warning",
      confirmLabel: again ? tr("确认再次发送", "Send again") : tr("确认发送", "Send"),
      action: () => post(`/announcements/${a.id}/mail`),
    });
    if (ok) toast({ tone: "success", title: tr("已加入发送队列", "Queued") });
  };
  const remove = async () => {
    if (!a) return;
    const ok = await confirm({
      title: tr("删除公告？", "Delete the announcement?"),
      description: tr(
        "门户里立即消失，已读记录一并删除。",
        "It disappears from the portal at once, with its read marks.",
      ),
      typeToConfirm: a.title_zh,
      confirmLabel: tr("删除", "Delete"),
      action: () => del(`/announcements/${a.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("已删除", "Deleted") });
      onClose();
    }
  };
  const sending = !!a?.mail_requested_at && !a.mail_done_at;
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      icon={Megaphone}
      title={a ? tr("编辑公告", "Edit announcement") : tr("新建公告", "New announcement")}
      description={
        a?.mail_requested_at
          ? sending
            ? tr(`邮件发送中（已发 ${a.mail_sent} 封）`, `Mailing (${a.mail_sent} sent)`)
            : tr(
                `已于 ${dateTime(a.mail_requested_at)} 邮件通知，${a.mail_sent} 封`,
                `Mailed ${dateTime(a.mail_requested_at)}, ${a.mail_sent} sent`,
              )
          : undefined
      }
      footer={
        <>
          {a && (
            <Button variant="destructive-soft" icon={Trash2} className="mr-auto" onClick={remove}>
              {tr("删除", "Delete")}
            </Button>
          )}
          {tried && bad > 0 && (
            <span className="text-footnote text-destructive">{tr(`${bad} 处需要修正`, `${bad} to fix`)}</span>
          )}
          {a && (
            <Button
              icon={Mail}
              loading={mailing}
              disabled={sending}
              title={sending ? tr("正在发送中", "Mailing now") : undefined}
              onClick={mail}
            >
              {tr("邮件通知", "Mail it")}
            </Button>
          )}
          <Button variant="primary" loading={saving} onClick={submit}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
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
          <Field
            label={tr("开始显示（站点时区）", "Show from (site time zone)")}
            hint={tr("留空 = 立即", "Empty = now")}
          >
            <Input type="datetime-local" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
          </Field>
          <Field
            label={tr("结束显示（站点时区）", "Show until (site time zone)")}
            hint={tr("留空 = 一直显示", "Empty = no end")}
            error={err("until")}
          >
            <Input type="datetime-local" value={f.until} onChange={(e) => setF({ ...f, until: e.target.value })} />
          </Field>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <SwitchField
            checked={f.pinned}
            onChange={(v) => setF({ ...f, pinned: v })}
            label={tr("置顶", "Pinned")}
            description={tr("排在门户公告列表最前", "First in the portal's list")}
          />
          <SwitchField
            checked={f.enabled}
            onChange={(v) => setF({ ...f, enabled: v })}
            label={tr("启用", "Enabled")}
            description={tr("关闭后门户不再显示", "Hidden from the portal when off")}
          />
        </div>
        <LangSwitch
          value={lang}
          onChange={setLang}
          zhFilled={!!(f.title_zh.trim() && f.body_zh.trim())}
          enFilled={!!(f.title_en.trim() && f.body_en.trim())}
        />
        {lang === "zh" ? (
          <>
            <Field label={tr("标题（中文）", "Title (Chinese)")} error={err("title_zh")} required>
              <Input value={f.title_zh} maxLength={200} onChange={(e) => setF({ ...f, title_zh: e.target.value })} />
            </Field>
            <MarkdownField
              label={tr("正文（Markdown）", "Body (Markdown)")}
              value={f.body_zh}
              error={err("body_zh")}
              required
              onChange={(v) => setF({ ...f, body_zh: v })}
            />
          </>
        ) : (
          <>
            <Field
              label={tr("标题（英文）", "Title (English)")}
              hint={tr("留空 = 英文用户也看中文", "Empty = English readers see Chinese")}
            >
              <Input value={f.title_en} maxLength={200} onChange={(e) => setF({ ...f, title_en: e.target.value })} />
            </Field>
            <MarkdownField
              label={tr("正文（英文）", "Body (English)")}
              value={f.body_en}
              error={err("body_en")}
              onChange={(v) => setF({ ...f, body_en: v })}
            />
          </>
        )}
      </div>
    </Dialog>
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
    {
      key: "title",
      header: tr("标题", "Title"),
      fixed: true,
      mobile: "title",
      cell: (a) => <span className="break-words">{a.title_zh}</span>,
    },
    {
      key: "slug",
      header: tr("固定地址", "Slug"),
      cell: (a) =>
        a.slug ? <code className="font-mono text-footnote">{a.slug}</code> : <span className="text-faint">—</span>,
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
    { key: "sort", header: tr("排序", "Sort"), optional: true, align: "right", cell: (a) => a.sort },
    { key: "updated", header: tr("更新", "Updated"), cell: (a) => dateTime(a.updated_at) },
  ];
  const editing = open && open !== "new" ? arts.data?.find((x) => x.id === open) : undefined;
  return (
    <div className="grid gap-4">
      {arts.data && legal.length > 0 && (
        <Callout tone="info">
          {tr(
            `门户的服务条款 / 隐私政策页面读取固定地址为 terms、privacy 的已发布文章；还没有：${legal.join("、")}（缺省显示中性文案）。`,
            `The portal's terms / privacy pages show the published articles with slug terms / privacy; missing: ${legal.join(", ")} (a neutral text is shown).`,
          )}
        </Callout>
      )}
      <Categories q={cats} />
      <DataTable
        label={tr("帮助文章", "Articles")}
        storageKey="kb"
        rows={arts.data ?? []}
        columns={columns}
        loading={arts.isPending}
        error={arts.error}
        onRetry={() => void arts.refetch()}
        onRowClick={(a) => setQuery({ open: a.id }, false)}
        activeId={open}
        empty={
          <EmptyState
            icon={BookOpen}
            title={tr("还没有文章", "No articles yet")}
            description={tr("文章显示在门户的帮助中心。", "Articles show in the portal's help centre.")}
            action={
              <Button size="sm" variant="primary" icon={Plus} onClick={() => setQuery({ open: "new" }, false)}>
                {tr("新建文章", "New article")}
              </Button>
            }
          />
        }
      />
      {open && (open === "new" || editing) && (
        <ArticleEditor key={open} a={editing ?? null} cats={cats.data ?? []} onClose={() => setQuery({ open: null })} />
      )}
    </div>
  );
}

function CategoryDialog({ c, onClose }: { c: Category; onClose: () => void }) {
  const tr = useTr();
  const [f, setF] = useState({ name_zh: c.name_zh, name_en: c.name_en ?? "", sort: String(c.sort) });
  const [tried, setTried] = useState(false);
  const [save, busy] = useAction();
  const errs = {
    name_zh: !f.name_zh.trim() ? tr("请填写名称", "Enter a name") : null,
    sort: !SORT_RE.test(f.sort.trim()) ? tr("整数，小的在前", "A whole number; smaller first") : null,
  };
  const bad = Object.values(errs).filter(Boolean).length;
  const submit = async () => {
    setTried(true);
    if (bad) return;
    const r = await save(
      () =>
        put(`/kb/categories/${c.id}`, {
          name_zh: f.name_zh.trim(),
          name_en: f.name_en.trim() || null,
          sort: Number(f.sort.trim()),
        }),
      { ok: tr("已保存", "Saved") },
    );
    if (r !== undefined) onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      icon={Pencil}
      title={tr("编辑分类", "Edit category")}
      onSubmit={() => void submit()}
      footer={
        <>
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" loading={busy}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label={tr("分类名称（中文）", "Name (Chinese)")} error={(tried && errs.name_zh) || undefined} required>
          <Input value={f.name_zh} onChange={(e) => setF({ ...f, name_zh: e.target.value })} data-autofocus />
        </Field>
        <Field label={tr("英文名称（可选）", "Name (English, optional)")}>
          <Input value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} />
        </Field>
        <Field
          label={tr("排序", "Sort")}
          hint={tr("小的在前", "Smaller first")}
          error={(tried && errs.sort) || undefined}
        >
          <Input inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

function Categories({ q }: { q: UseQueryResult<Category[]> }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const [add, adding] = useAction();
  const [name, setName] = useState("");
  const [edit, setEdit] = useState<Category | null>(null);
  const cats = q.data ?? [];
  const submit = async () => {
    if (!name.trim()) return;
    const r = await add(() => post("/kb/categories", { name_zh: name.trim() }), {
      ok: tr("分类已添加", "Category added"),
    });
    if (r !== undefined) setName("");
  };
  let list: ReactNode;
  if (q.isPending) list = <Skeleton className="m-4 h-16" />;
  else if (q.isError) list = <ErrorState compact error={q.error} onRetry={() => void q.refetch()} />;
  else if (cats.length === 0)
    list = (
      <p className="px-4 py-3 text-body text-muted-foreground">
        {tr("还没有分类；文章可以不分类。", "No categories yet; articles may stay uncategorized.")}
      </p>
    );
  else
    list = (
      <ul className="divide-y divide-separator">
        {cats.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-body">
            <span className="font-medium break-words">{c.name_zh}</span>
            {c.name_en && <span className="text-muted-foreground">{c.name_en}</span>}
            <span className="text-footnote text-muted-foreground">
              {tr(`${c.articles} 篇 · 排序 ${c.sort}`, `${c.articles} articles · sort ${c.sort}`)}
            </span>
            <span className="ml-auto">
              <RowMenu label={tr(`分类 ${c.name_zh} 的操作`, `Actions of ${c.name_zh}`)}>
                {(close) => (
                  <>
                    <MenuItem icon={Settings} onClick={() => (close(), setEdit(c))}>
                      {tr("改名 / 排序", "Rename / sort")}
                    </MenuItem>
                    <MenuItem
                      icon={Trash2}
                      danger
                      onClick={async () => {
                        close();
                        const ok = await confirm({
                          title: tr(`删除分类 ${c.name_zh}？`, `Delete ${c.name_zh}?`),
                          impact:
                            c.articles > 0
                              ? tr(`${c.articles} 篇文章会变成未分类`, `${c.articles} articles become uncategorized`)
                              : tr("这个分类下没有文章", "No articles in it"),
                          typeToConfirm: c.name_zh,
                          confirmLabel: tr("删除", "Delete"),
                          action: () => del(`/kb/categories/${c.id}`),
                        });
                        if (ok) toast({ tone: "success", title: tr("已删除", "Deleted") });
                      }}
                    >
                      {tr("删除", "Delete")}
                    </MenuItem>
                  </>
                )}
              </RowMenu>
            </span>
          </li>
        ))}
      </ul>
    );
  return (
    <Card>
      <CardHeader
        title={tr("文章分类", "Categories")}
        description={tr(
          "门户帮助中心按分类分组；删除分类不删除文章。",
          "Groups in the portal's help centre; deleting one keeps its articles.",
        )}
      />
      {list}
      <form
        className="flex flex-wrap gap-2 border-t border-separator px-4 py-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          aria-label={tr("新分类名称", "New category name")}
          placeholder={tr("新分类名称", "New category name")}
          className="min-w-0 flex-1 sm:max-w-64"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" size="md" icon={FolderPlus} disabled={!name.trim()} loading={adding}>
          {tr("添加分类", "Add category")}
        </Button>
      </form>
      {edit && <CategoryDialog c={edit} onClose={() => setEdit(null)} />}
    </Card>
  );
}

function ArticleEditor({ a, cats, onClose }: { a: Article | null; cats: Category[]; onClose: () => void }) {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const full = useQuery({
    queryKey: ["kb", "article", a?.id],
    queryFn: () => get<Article>(`/kb/articles/${a?.id}`),
    enabled: !!a,
    // Re-reads must never replace what the operator is typing.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const [f, setF] = useState({
    category_id: a?.category_id ?? null,
    title_zh: a?.title_zh ?? "",
    title_en: a?.title_en ?? "",
    body_zh: a?.body_zh ?? "",
    body_en: a?.body_en ?? "",
    sortText: String(a?.sort ?? 0),
    published: a?.published ?? false,
    slug: a?.slug ?? "",
  });
  // The full body arrives once, before the body fields are editable.
  const [loaded, setLoaded] = useState(!a);
  useEffect(() => {
    if (full.data && !loaded) {
      setF((x) => ({ ...x, body_zh: full.data.body_zh, body_en: full.data.body_en ?? "" }));
      setLoaded(true);
    }
  }, [full.data, loaded]);
  const [lang, setLang] = useState<"zh" | "en">("zh");
  const [tried, setTried] = useState(false);
  const [save, saving] = useAction();
  const errs = {
    title_zh: !f.title_zh.trim() ? tr("请填写中文标题", "Enter the Chinese title") : null,
    body_zh: loaded && !f.body_zh.trim() ? tr("请填写中文正文", "Enter the Chinese body") : null,
    sort: !SORT_RE.test(f.sortText.trim()) ? tr("整数，小的在前", "A whole number; smaller first") : null,
    slug:
      f.slug.trim() && !SLUG_RE.test(f.slug.trim())
        ? tr("小写字母、数字、-，不能以 - 开头，最多 64 个", "a-z 0-9 -, not starting with -, up to 64")
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
      category_id: f.category_id,
      title_zh: f.title_zh.trim(),
      title_en: f.title_en.trim() || null,
      body_zh: f.body_zh,
      body_en: f.body_en.trim() || null,
      sort: Number(f.sortText.trim()),
      published: f.published,
      slug: f.slug.trim() || null,
    };
    const r = await save(() => (a ? put(`/kb/articles/${a.id}`, b) : post("/kb/articles", b)), {
      ok: tr("文章已保存", "Article saved"),
    });
    if (r !== undefined) {
      if (a) void qc.removeQueries({ queryKey: ["kb", "article", a.id] });
      onClose();
    }
  };
  const remove = async () => {
    if (!a) return;
    const ok = await confirm({
      title: tr("删除文章？", "Delete the article?"),
      description:
        a.slug === "terms" || a.slug === "privacy"
          ? tr(
              "这是门户的法律页面，删除后门户显示中性文案。",
              "This is a portal legal page; the portal falls back to a neutral text.",
            )
          : tr("门户里立即消失。", "It disappears from the portal at once."),
      typeToConfirm: a.title_zh,
      confirmLabel: tr("删除", "Delete"),
      action: () => del(`/kb/articles/${a.id}`),
    });
    if (ok) {
      toast({ tone: "success", title: tr("已删除", "Deleted") });
      onClose();
    }
  };
  const bodyField = (zh: boolean) =>
    !loaded ? (
      full.isError ? (
        <ErrorState compact error={full.error} onRetry={() => void full.refetch()} />
      ) : (
        <div className="grid gap-1.5">
          <span className="text-footnote font-medium text-muted-foreground">{tr("正文", "Body")}</span>
          <LoadingBlock rows={4} />
        </div>
      )
    ) : zh ? (
      <MarkdownField
        label={tr("正文（Markdown）", "Body (Markdown)")}
        value={f.body_zh}
        error={err("body_zh")}
        required
        onChange={(v) => setF({ ...f, body_zh: v })}
      />
    ) : (
      <MarkdownField
        label={tr("正文（英文）", "Body (English)")}
        value={f.body_en}
        onChange={(v) => setF({ ...f, body_en: v })}
      />
    );
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      icon={BookOpen}
      title={a ? tr("编辑文章", "Edit article") : tr("新建文章", "New article")}
      footer={
        <>
          {a && (
            <Button variant="destructive-soft" icon={Trash2} className="mr-auto" onClick={remove}>
              {tr("删除", "Delete")}
            </Button>
          )}
          {tried && bad > 0 && (
            <span className="text-footnote text-destructive">{tr(`${bad} 处需要修正`, `${bad} to fix`)}</span>
          )}
          <Button variant="primary" loading={saving} disabled={!loaded} onClick={submit}>
            {tr("保存", "Save")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
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
            error={err("slug")}
          >
            <Input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value })} placeholder="terms" />
          </Field>
          <Field label={tr("排序", "Sort")} error={err("sort")}>
            <Input inputMode="numeric" value={f.sortText} onChange={(e) => setF({ ...f, sortText: e.target.value })} />
          </Field>
        </div>
        <SwitchField
          checked={f.published}
          onChange={(v) => setF({ ...f, published: v })}
          label={tr("发布", "Published")}
          description={tr(
            "发布后用户在门户可见；草稿只在这里可见",
            "Visible in the portal once published; drafts only here",
          )}
        />
        <LangSwitch
          value={lang}
          onChange={setLang}
          zhFilled={!!(f.title_zh.trim() && f.body_zh.trim())}
          enFilled={!!(f.title_en.trim() && f.body_en.trim())}
        />
        {lang === "zh" ? (
          <>
            <Field label={tr("文章标题（中文）", "Title (Chinese)")} error={err("title_zh")} required>
              <Input value={f.title_zh} maxLength={200} onChange={(e) => setF({ ...f, title_zh: e.target.value })} />
            </Field>
            {bodyField(true)}
          </>
        ) : (
          <>
            <Field label={tr("文章标题（英文，可选）", "Title (English, optional)")}>
              <Input value={f.title_en} maxLength={200} onChange={(e) => setF({ ...f, title_en: e.target.value })} />
            </Field>
            {bodyField(false)}
          </>
        )}
      </div>
    </Dialog>
  );
}
