// Ops 后台（仅中文）：内容 = 公告 + 知识库。公告：标题/正文（Markdown 安全子集，
// 服务端渲染并消毒）、可选英文版、置顶、启用、显示时间段（北京时间）、受众
// （全部 / 有生效套餐 / 无套餐），「邮件通知受众」经发件箱分批发送。知识库：
// 分类（排序）与文章（分类、排序、发布），正文同为 Markdown。编辑器右侧
// 实时预览 = 服务端渲染结果（/content/preview）。深链 /admin/content/<tab>。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { RichHtml } from "../components/rich-html";
import { Tabs } from "../components/tabs";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import { adminBase, del, get, post, put } from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { datetimeInputIso, datetimeInputValue, fmtDateTime, TZ_LABEL } from "../lib/datetime";
import { navigate, usePath } from "../lib/router";

const errText = (err: unknown) => (err instanceof Error ? adminErrorText(err) : "失败");

export const CONTENT_TABS = [
  { id: "announcements", label: "公告" },
  { id: "kb", label: "知识库" },
] as const;
export type ContentTab = (typeof CONTENT_TABS)[number]["id"];

export function contentTabOf(path: string): ContentTab {
  const base = `${adminBase}/content/`;
  const seg = path.startsWith(base) ? path.slice(base.length).split("/")[0] : "";
  return CONTENT_TABS.find((t) => t.id === seg)?.id ?? "announcements";
}

export function AdminContent() {
  const tab = contentTabOf(usePath());
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">内容管理</h1>
      <Tabs label="内容分类" tabs={CONTENT_TABS} value={tab} onChange={(t) => navigate(`${adminBase}/content/${t}`)}>
        {tab === "announcements" ? <Announcements /> : <KnowledgeBase />}
      </Tabs>
    </div>
  );
}

// --- Markdown editor with the server's preview -----------------------------

/** The server-rendered HTML of `md` (debounced). */
function usePreview(md: string): { html: string | null; error: string | null } {
  const [state, setState] = useState<{ html: string | null; error: string | null }>({ html: null, error: null });
  useEffect(() => {
    if (!md.trim()) {
      setState({ html: null, error: null });
      return;
    }
    let live = true;
    const h = setTimeout(() => {
      post<{ html: string }>("/content/preview", { markdown: md })
        .then((r) => live && setState({ html: r.html, error: null }))
        .catch((e: unknown) => live && setState({ html: null, error: errText(e) }));
    }, 400);
    return () => {
      live = false;
      clearTimeout(h);
    };
  }, [md]);
  return state;
}

function MarkdownField({
  id,
  label,
  value,
  onChange,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  const preview = usePreview(value);
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor={id}>{label}</Label>
        <Textarea
          id={id}
          rows={10}
          value={value}
          required={required}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          支持 Markdown：# 标题、**粗体**、*斜体*、`代码`、[链接](https://…)、![图片](https://…)、- 列表、&gt;
          引用。不支持 HTML（会按原文显示）；图片只允许 https 或本站地址。
        </p>
      </div>
      <section aria-label={`${label}预览`} className="space-y-1.5">
        <p className="text-sm font-medium">预览（用户看到的样子）</p>
        <div className="min-h-24 rounded-lg border border-border p-3">
          {preview.error ? (
            <p role="alert" className="text-sm text-destructive">
              {preview.error}
            </p>
          ) : preview.html ? (
            <RichHtml html={preview.html} />
          ) : (
            <p className="text-sm text-muted-foreground">输入正文后显示预览。</p>
          )}
        </div>
      </section>
    </div>
  );
}

// --- 公告 -------------------------------------------------------------------

export type Audience = "all" | "with_plan" | "without_plan";
export const AUDIENCE_ZH: Record<Audience, string> = {
  all: "全部用户",
  with_plan: "有生效套餐的用户",
  without_plan: "没有套餐的用户",
};

export interface AnnouncementRow {
  id: string;
  title_zh: string;
  title_en: string | null;
  body_zh: string;
  body_en: string | null;
  pinned: boolean;
  enabled: boolean;
  visible_from: string | null;
  visible_until: string | null;
  audience: Audience;
  created_at: string;
  updated_at: string;
  active: boolean;
  reads: number;
  mail_requested_at: string | null;
  mail_sent: number;
  mail_done_at: string | null;
}

interface AnnouncementForm {
  title_zh: string;
  title_en: string;
  body_zh: string;
  body_en: string;
  pinned: boolean;
  enabled: boolean;
  visible_from: string;
  visible_until: string;
  audience: Audience;
}

const emptyAnnouncement: AnnouncementForm = {
  title_zh: "",
  title_en: "",
  body_zh: "",
  body_en: "",
  pinned: false,
  enabled: true,
  visible_from: "",
  visible_until: "",
  audience: "all",
};

/** The request body of the form (empty optional fields = null). */
export function announcementBody(f: AnnouncementForm) {
  return {
    title_zh: f.title_zh,
    title_en: f.title_en.trim() || null,
    body_zh: f.body_zh,
    body_en: f.body_en.trim() || null,
    pinned: f.pinned,
    enabled: f.enabled,
    visible_from: datetimeInputIso(f.visible_from),
    visible_until: datetimeInputIso(f.visible_until),
    audience: f.audience,
  };
}

function formOf(a: AnnouncementRow): AnnouncementForm {
  return {
    title_zh: a.title_zh,
    title_en: a.title_en ?? "",
    body_zh: a.body_zh,
    body_en: a.body_en ?? "",
    pinned: a.pinned,
    enabled: a.enabled,
    visible_from: datetimeInputValue(a.visible_from),
    visible_until: datetimeInputValue(a.visible_until),
    audience: a.audience,
  };
}

function mailState(a: AnnouncementRow): string {
  if (!a.mail_requested_at) return "未发送";
  if (!a.mail_done_at) return `发送中（已入队 ${a.mail_sent}）`;
  return `已发送 ${a.mail_sent} 封`;
}

function Announcements() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["announcements"],
    queryFn: () => get<AnnouncementRow[]>("/announcements"),
    refetchInterval: 10_000,
  });
  const [editing, setEditing] = useState<AnnouncementRow | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const confirm = useConfirm();

  async function remove(a: AnnouncementRow) {
    if (
      !(await confirm({
        title: `删除公告「${a.title_zh}」？`,
        body: "删除后用户不再看到它，已读记录一并删除。",
        destructive: true,
        confirmLabel: "删除",
      }))
    )
      return;
    setError(null);
    try {
      await del(`/announcements/${a.id}`);
      setNote("已删除。");
      await qc.invalidateQueries({ queryKey: ["announcements"] });
    } catch (e) {
      setError(errText(e));
    }
  }

  async function mail(a: AnnouncementRow) {
    if (
      !(await confirm({
        title: `邮件通知「${a.title_zh}」的受众？`,
        body: `将给「${AUDIENCE_ZH[a.audience]}」中已验证邮箱的用户各发一封邮件（每 10 秒最多入队 100 封，按用户语言）。`,
        confirmLabel: "发送",
      }))
    )
      return;
    setError(null);
    try {
      await post(`/announcements/${a.id}/mail`, {});
      setNote("已开始发送。");
      await qc.invalidateQueries({ queryKey: ["announcements"] });
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>
              <h2>公告列表</h2>
            </CardTitle>
            <CardDescription>用户在门户仪表盘看到当前生效且属于其受众的公告（置顶在前）。</CardDescription>
          </div>
          <Button onClick={() => setEditing("new")}>新建公告</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {note && (
            <p role="status" className="text-sm text-emerald-700">
              {note}
            </p>
          )}
          <Table label="公告">
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>受众</TableHead>
                <TableHead>显示时间段（{TZ_LABEL}）</TableHead>
                <TableHead>已读</TableHead>
                <TableHead>邮件</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-sm text-muted-foreground">
                    还没有公告。
                  </TableCell>
                </TableRow>
              )}
              {list.data?.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="max-w-64">
                    <span className="block truncate font-medium">{a.title_zh}</span>
                    {a.title_en && <span className="block truncate text-xs text-muted-foreground">{a.title_en}</span>}
                  </TableCell>
                  <TableCell className="space-x-1">
                    {a.pinned && <Badge>置顶</Badge>}
                    {a.active ? (
                      <Badge variant="success">显示中</Badge>
                    ) : (
                      <Badge variant="secondary">{a.enabled ? "不在时间段内" : "已停用"}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{AUDIENCE_ZH[a.audience]}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.visible_from ? fmtDateTime(a.visible_from) : "立即"} —{" "}
                    {a.visible_until ? fmtDateTime(a.visible_until) : "长期"}
                  </TableCell>
                  <TableCell className="text-xs">{a.reads}</TableCell>
                  <TableCell className="text-xs">{mailState(a)}</TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditing(a)}>
                      编辑
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void mail(a)}>
                      邮件通知
                    </Button>
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void remove(a)}>
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {list.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errText(list.error)}
            </p>
          )}
        </CardContent>
      </Card>
      {editing && (
        <AnnouncementEditor
          key={editing === "new" ? "new" : editing.id}
          row={editing === "new" ? null : editing}
          onDone={(msg) => {
            setEditing(null);
            setNote(msg);
            void qc.invalidateQueries({ queryKey: ["announcements"] });
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function AnnouncementEditor({
  row,
  onDone,
  onCancel,
}: {
  row: AnnouncementRow | null;
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<AnnouncementForm>(row ? formOf(row) : emptyAnnouncement);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof AnnouncementForm>(k: K, v: AnnouncementForm[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (row) await put(`/announcements/${row.id}`, announcementBody(f));
      else await post("/announcements", announcementBody(f));
      onDone(row ? "已保存。" : "已发布公告。");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{row ? "编辑公告" : "新建公告"}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ann-title-zh">标题（中文）</Label>
              <Input
                id="ann-title-zh"
                maxLength={120}
                value={f.title_zh}
                onChange={(e) => set("title_zh", e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-title-en">标题（英文，可选）</Label>
              <Input
                id="ann-title-en"
                maxLength={120}
                value={f.title_en}
                onChange={(e) => set("title_en", e.target.value)}
              />
            </div>
          </div>
          <MarkdownField
            id="ann-body-zh"
            label="正文（中文）"
            value={f.body_zh}
            onChange={(v) => set("body_zh", v)}
            required
          />
          <MarkdownField
            id="ann-body-en"
            label="正文（英文，可选；留空则英文界面显示中文）"
            value={f.body_en}
            onChange={(v) => set("body_en", v)}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ann-audience">受众</Label>
              <select
                id="ann-audience"
                className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm"
                value={f.audience}
                onChange={(e) => set("audience", e.target.value as Audience)}
              >
                {(Object.keys(AUDIENCE_ZH) as Audience[]).map((a) => (
                  <option key={a} value={a}>
                    {AUDIENCE_ZH[a]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-from">开始显示（{TZ_LABEL}，可选）</Label>
              <Input
                id="ann-from"
                type="datetime-local"
                value={f.visible_from}
                onChange={(e) => set("visible_from", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ann-until">结束显示（{TZ_LABEL}，可选）</Label>
              <Input
                id="ann-until"
                type="datetime-local"
                value={f.visible_until}
                onChange={(e) => set("visible_until", e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-6 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.pinned} onChange={(e) => set("pinned", e.target.checked)} />
              置顶
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={f.enabled} onChange={(e) => set("enabled", e.target.checked)} />
              启用（显示给用户）
            </label>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              {row ? "保存公告" : "发布公告"}
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// --- 知识库 -----------------------------------------------------------------

export interface KbCategory {
  id: string;
  name_zh: string;
  name_en: string | null;
  sort: number;
  articles: number;
  created_at: string;
}

export interface KbArticle {
  id: string;
  category_id: string | null;
  category_name: string | null;
  title_zh: string;
  title_en: string | null;
  body_zh: string;
  body_en: string | null;
  sort: number;
  published: boolean;
  created_at: string;
  updated_at: string;
}

function KnowledgeBase() {
  const qc = useQueryClient();
  const cats = useQuery({ queryKey: ["kb-categories"], queryFn: () => get<KbCategory[]>("/kb/categories") });
  const arts = useQuery({ queryKey: ["kb-articles"], queryFn: () => get<KbArticle[]>("/kb/articles") });
  const [editing, setEditing] = useState<KbArticle | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const confirm = useConfirm();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["kb-categories"] });
    void qc.invalidateQueries({ queryKey: ["kb-articles"] });
  };

  async function act(f: () => Promise<unknown>, ok: string) {
    setError(null);
    try {
      await f();
      setNote(ok);
      refresh();
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="space-y-6">
      <CategoriesCard cats={cats.data ?? []} onAct={act} />
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>
              <h2>帮助文章</h2>
            </CardTitle>
            <CardDescription>已发布的文章出现在门户「帮助」页，可被搜索；未发布的只在这里可见。</CardDescription>
          </div>
          <Button onClick={() => setEditing("new")}>新建文章</Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {note && (
            <p role="status" className="text-sm text-emerald-700">
              {note}
            </p>
          )}
          <Table label="帮助文章">
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>分类</TableHead>
                <TableHead>排序</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>更新时间</TableHead>
                <TableHead>
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {arts.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-sm text-muted-foreground">
                    还没有文章。
                  </TableCell>
                </TableRow>
              )}
              {arts.data?.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="max-w-64 truncate font-medium">{a.title_zh}</TableCell>
                  <TableCell className="text-xs">{a.category_name ?? "未分类"}</TableCell>
                  <TableCell className="text-xs">{a.sort}</TableCell>
                  <TableCell>
                    {a.published ? <Badge variant="success">已发布</Badge> : <Badge variant="secondary">草稿</Badge>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDateTime(a.updated_at)}</TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap text-right">
                    <Button size="sm" variant="outline" onClick={() => setEditing(a)}>
                      编辑
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() =>
                        void confirm({
                          title: `删除文章「${a.title_zh}」？`,
                          destructive: true,
                          confirmLabel: "删除",
                        }).then((yes) => {
                          if (yes) void act(() => del(`/kb/articles/${a.id}`), "已删除。");
                        })
                      }
                    >
                      删除
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      {editing && (
        <ArticleEditor
          key={editing === "new" ? "new" : editing.id}
          row={editing === "new" ? null : editing}
          cats={cats.data ?? []}
          onDone={(msg) => {
            setEditing(null);
            setNote(msg);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CategoriesCard({
  cats,
  onAct,
}: {
  cats: KbCategory[];
  onAct: (f: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [nameZh, setNameZh] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [sort, setSort] = useState("0");
  const confirm = useConfirm();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>文章分类</h2>
        </CardTitle>
        <CardDescription>分类按排序值从小到大显示；删除分类后其中的文章变为「未分类」。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y divide-border rounded-lg border border-border">
          {cats.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">还没有分类。</li>}
          {cats.map((c) => (
            <CategoryRow key={c.id} c={c} onAct={onAct} confirm={confirm} />
          ))}
        </ul>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_6rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void onAct(
              () =>
                post("/kb/categories", { name_zh: nameZh, name_en: nameEn.trim() || null, sort: Number(sort) || 0 }),
              "已添加分类。",
            ).then(() => {
              setNameZh("");
              setNameEn("");
              setSort("0");
            });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="kb-cat-zh">分类名称（中文）</Label>
            <Input id="kb-cat-zh" maxLength={64} value={nameZh} onChange={(e) => setNameZh(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kb-cat-en">英文名称（可选）</Label>
            <Input id="kb-cat-en" maxLength={64} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="kb-cat-sort">排序</Label>
            <Input id="kb-cat-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
          </div>
          <Button type="submit">添加分类</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function CategoryRow({
  c,
  onAct,
  confirm,
}: {
  c: KbCategory;
  onAct: (f: () => Promise<unknown>, ok: string) => Promise<void>;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const [edit, setEdit] = useState(false);
  const [zh, setZh] = useState(c.name_zh);
  const [en, setEn] = useState(c.name_en ?? "");
  const [sort, setSort] = useState(String(c.sort));
  if (edit)
    return (
      <li className="flex flex-wrap items-end gap-2 px-3 py-2">
        <Input aria-label="分类名称（中文）" className="w-40" value={zh} onChange={(e) => setZh(e.target.value)} />
        <Input aria-label="英文名称" className="w-40" value={en} onChange={(e) => setEn(e.target.value)} />
        <Input aria-label="排序" className="w-20" value={sort} onChange={(e) => setSort(e.target.value)} />
        <Button
          size="sm"
          onClick={() =>
            void onAct(
              () => put(`/kb/categories/${c.id}`, { name_zh: zh, name_en: en.trim() || null, sort: Number(sort) || 0 }),
              "已保存。",
            ).then(() => setEdit(false))
          }
        >
          保存
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEdit(false)}>
          取消
        </Button>
      </li>
    );
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      <span className="font-medium">{c.name_zh}</span>
      {c.name_en && <span className="text-muted-foreground">{c.name_en}</span>}
      <span className="text-xs text-muted-foreground">
        排序 {c.sort} · {c.articles} 篇
      </span>
      <span className="ml-auto space-x-1">
        <Button size="sm" variant="outline" onClick={() => setEdit(true)}>
          编辑
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          onClick={() =>
            void confirm({
              title: `删除分类「${c.name_zh}」？`,
              body: c.articles ? `其中的 ${c.articles} 篇文章会变为「未分类」。` : undefined,
              destructive: true,
              confirmLabel: "删除",
            }).then((yes) => {
              if (yes) void onAct(() => del(`/kb/categories/${c.id}`), "已删除分类。");
            })
          }
        >
          删除
        </Button>
      </span>
    </li>
  );
}

function ArticleEditor({
  row,
  cats,
  onDone,
  onCancel,
}: {
  row: KbArticle | null;
  cats: KbCategory[];
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const [cat, setCat] = useState(row?.category_id ?? "");
  const [titleZh, setTitleZh] = useState(row?.title_zh ?? "");
  const [titleEn, setTitleEn] = useState(row?.title_en ?? "");
  const [bodyZh, setBodyZh] = useState(row?.body_zh ?? "");
  const [bodyEn, setBodyEn] = useState(row?.body_en ?? "");
  const [sort, setSort] = useState(String(row?.sort ?? 0));
  const [published, setPublished] = useState(row?.published ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = {
      category_id: cat || null,
      title_zh: titleZh,
      title_en: titleEn.trim() || null,
      body_zh: bodyZh,
      body_en: bodyEn.trim() || null,
      sort: Number(sort) || 0,
      published,
    };
    try {
      if (row) await put(`/kb/articles/${row.id}`, body);
      else await post("/kb/articles", body);
      onDone("已保存文章。");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{row ? "编辑文章" : "新建文章"}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={save} noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="kb-title-zh">文章标题（中文）</Label>
              <Input id="kb-title-zh" maxLength={120} value={titleZh} onChange={(e) => setTitleZh(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-title-en">文章标题（英文，可选）</Label>
              <Input id="kb-title-en" maxLength={120} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-cat">分类</Label>
              <select
                id="kb-cat"
                className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm"
                value={cat}
                onChange={(e) => setCat(e.target.value)}
              >
                <option value="">未分类</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name_zh}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-sort">文章排序</Label>
              <Input id="kb-sort" inputMode="numeric" value={sort} onChange={(e) => setSort(e.target.value)} />
            </div>
          </div>
          <MarkdownField id="kb-body-zh" label="文章正文（中文）" value={bodyZh} onChange={setBodyZh} required />
          <MarkdownField id="kb-body-en" label="文章正文（英文，可选）" value={bodyEn} onChange={setBodyEn} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
            发布（门户「帮助」页可见）
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy}>
              保存文章
            </Button>
            <Button type="button" variant="outline" onClick={onCancel}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
