// 系统设置 → 订阅 → 订阅模板 (SET-29): a full-width editor at
// /settings/sub-templates. One tab per client (Sing-box · Clash · Surge ·
// Surfboard, `?format=`), a CodeMirror 6 editor (its own chunk, loaded when the
// editor first shows) and a side column with the placeholder cheat-sheet (the
// API's own help) and the rendered preview. 预览 renders the draft on the
// server with sample data, or with a chosen real user's lines and
// credentials (audited; the subscription link in it stays a placeholder).
// Drafts live per client while the page is open; leaving with unsaved changes
// asks first. 保存 sends the version it was loaded at: when someone else
// saved in between (409, or the list shows a newer version) a banner offers
// to load theirs or to overwrite it with this draft. Reset to default deletes
// the stored template (after a confirmation). The server's 400s carry
// `params.line/column` and show as markers in the editor and a list under it.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Eye,
  RotateCcw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBlocker } from "react-router";
import { ApiError, del, get, post, put, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { errorCode } from "../../shared/errors";
import { dateTime } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Input, Kbd, MOD_KEY, Segmented } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { ErrorState, LoadingBlock } from "../../shared/ui/states";
import { Tabs } from "../../shared/ui/tabs";
import { useToast } from "../../shared/ui/toast";
import { useDebounced, useErrText } from "../kit";
import { useWide } from "../components/settings-kit";
import { useQS } from "../router";
import { useCrumb } from "../session";
import type { EditorHandle, ErrorPos, Lang } from "./sub-templates/code-editor";

// CodeMirror is a chunk of its own, fetched when the editor first shows.
const CodeEditor = lazy(() => import("./sub-templates/code-editor"));

type Fmt = "sing-box" | "clash" | "surge" | "surfboard";
type Help = { token: string; zh: string; en: string };
type Template = {
  format: Fmt;
  body: string;
  default_body: string;
  is_default: boolean;
  /** 0 = nothing stored yet (the built-in default is in use). */
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  placeholders: Help[];
};
type List = { templates: Template[] };
type Rendered = { content_type: string; body: string };
type Problem = ErrorPos & { text: string };

const FORMATS: { id: Fmt; name: string; lang: Lang; file: string }[] = [
  { id: "sing-box", name: "Sing-box", lang: "json", file: "JSON" },
  { id: "clash", name: "Clash", lang: "yaml", file: "YAML" },
  { id: "surge", name: "Surge", lang: "ini", file: "Surge" },
  { id: "surfboard", name: "Surfboard", lang: "ini", file: "Surfboard" },
];
const isFmt = (v: string | null): v is Fmt => FORMATS.some((f) => f.id === v);

/** An unsaved draft: the text and the server version it started from. */
type Draft = { body: string; version: number };

/** A server 400 as a problem (with its place when the server gave one). */
function problemOf(e: unknown, text: string): Problem | null {
  if (!(e instanceof ApiError) || e.status !== 400 || e.code !== "sub_template.invalid") return null;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  return { line: n(e.params.line) ?? 0, column: n(e.params.column), text };
}

/** Leaving with unsaved changes (another page) asks first. */
function useLeaveGuard(dirty: boolean) {
  const tr = useTr();
  const confirm = useConfirm();
  const blocker = useBlocker(({ currentLocation: a, nextLocation: b }) => dirty && a.pathname !== b.pathname);
  const asking = useRef(false);
  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;
    void confirm({
      title: tr("放弃未保存的修改？", "Discard unsaved changes?"),
      description: tr(
        "订阅模板的修改还没有保存，离开后会丢失。",
        "The subscription template has unsaved changes; leaving discards them.",
      ),
      confirmLabel: tr("放弃修改", "Discard"),
      tone: "warning",
    }).then((ok) => {
      asking.current = false;
      if (ok) blocker.proceed();
      else blocker.reset();
    });
  }, [blocker, confirm, tr]);
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);
}

export function SubTemplatesPage() {
  const tr = useTr();
  useCrumb(tr("订阅模板", "Subscription templates"));
  const list = useQuery({ queryKey: ["sub-templates"], queryFn: () => get<List>("/sub-templates") });
  const back = (
    <Link
      to="/settings/subscription"
      className="hit-44 inline-flex items-center text-footnote text-muted-foreground hover:text-foreground max-lg:text-callout max-lg:text-primary"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      {tr("系统设置", "Settings")}
      <span className="max-lg:hidden">{tr(" · 订阅", " · Subscription")}</span>
    </Link>
  );
  const title = (
    <>
      <h1 className="text-title2 font-bold tracking-[-0.02em] sm:text-title1">
        {tr("订阅模板", "Subscription templates")}
      </h1>
      <p className="mt-0.5 text-body text-muted-foreground">
        {tr("配置各个客户端的订阅模板", "Configure the subscription template of each client")}
      </p>
    </>
  );
  if (!list.data)
    return (
      <div>
        {back}
        <div className="mb-4">{title}</div>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <Card className="p-4">
            <LoadingBlock rows={8} />
          </Card>
        )}
      </div>
    );
  return <Editor templates={list.data.templates} back={back} title={title} refetch={() => list.refetch()} />;
}

function Editor({
  templates,
  back,
  title,
  refetch,
}: {
  templates: Template[];
  back: React.ReactNode;
  title: React.ReactNode;
  refetch: () => Promise<unknown>;
}) {
  const tr = useTr();
  const lang = useLang();
  const toast = useToast();
  const confirm = useConfirm();
  const errText = useErrText();
  const qc = useQueryClient();
  const wide = useWide();
  const [query, patch] = useQS();
  const fmt: Fmt = isFmt(query.get("format")) ? (query.get("format") as Fmt) : "sing-box";
  const info = FORMATS.find((f) => f.id === fmt)!;
  const cur = templates.find((t) => t.format === fmt)!;

  // ---- drafts (kept per client while the page is open) -----------------------
  const [drafts, setDrafts] = useState<Partial<Record<Fmt, Draft>>>({});
  const draft = drafts[fmt];
  const body = draft?.body ?? cur.body;
  const dirty = (f: Fmt) => {
    const d = drafts[f];
    return !!d && d.body !== templates.find((t) => t.format === f)?.body;
  };
  const isDirty = dirty(fmt);
  const anyDirty = FORMATS.some((f) => dirty(f.id));
  useLeaveGuard(anyDirty);
  // Someone else saved (or reset) since this draft started: save would be refused.
  const [conflict, setConflict] = useState(false);
  const stale = !!draft && isDirty && (draft.version !== cur.version || conflict);

  const [problems, setProblems] = useState<Problem[]>([]);
  const marks = useMemo<ErrorPos[]>(
    () => problems.filter((p) => p.line > 0).map((p) => ({ line: p.line, column: p.column })),
    [problems],
  );
  const editor = useRef<EditorHandle>(null);

  const edit = (text: string) => {
    setDrafts((d) => ({ ...d, [fmt]: { body: text, version: d[fmt]?.version ?? cur.version } }));
    setProblems([]);
  };
  const setFmt = (f: Fmt) => patch({ format: f === "sing-box" ? null : f }, true);

  /** The list as the server now has it (a save/reset result), without waiting for a refetch. */
  const store = (t: Template) =>
    qc.setQueryData<List>(["sub-templates"], (l) =>
      l ? { templates: l.templates.map((x) => (x.format === t.format ? t : x)) } : l,
    );
  const drop = (f: Fmt) =>
    setDrafts((d) => {
      const next = { ...d };
      delete next[f];
      return next;
    });

  // ---- save -----------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const canSave = !!draft && isDirty && !saving && !stale;
  const save = async () => {
    if (!draft || !canSave) return;
    setSaving(true);
    try {
      const t = await put<Template>(`/sub-templates/${fmt}`, { version: draft.version, body: draft.body });
      store(t);
      drop(fmt);
      setProblems([]);
      toast({ tone: "success", title: tr("订阅模板已保存", "Subscription template saved") });
    } catch (e) {
      const p = problemOf(e, errText(e));
      if (p) setProblems([p]);
      if (e instanceof ApiError && e.code === "sub_template.version_conflict") {
        await refetch().catch(() => undefined);
        setConflict(true);
      } else if (!p) toast({ tone: "error", title: errText(e), description: errorCode(e) || undefined });
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---- reset to default -------------------------------------------------------
  const reset = async () => {
    if (cur.is_default) {
      // Nothing stored: the default is only what the draft replaced.
      drop(fmt);
      setProblems([]);
      return;
    }
    const ok = await confirm({
      title: tr("恢复默认模板？", "Reset to the default template?"),
      description: tr(
        `${info.name} 的自定义模板会被删除，之后订阅立即使用内置默认模板。`,
        `The custom ${info.name} template is deleted; subscriptions use the built-in default from then on.`,
      ),
      impact: isDirty ? tr("编辑器里未保存的修改也会丢失。", "Unsaved changes in the editor are lost too.") : undefined,
      confirmLabel: tr("恢复默认", "Reset to default"),
      action: async () => store(await del<Template>(`/sub-templates/${fmt}`)),
    });
    if (ok) {
      drop(fmt);
      setProblems([]);
      setConflict(false);
      toast({ tone: "success", title: tr("已恢复默认模板", "Reset to the default template") });
    }
  };

  const loadTheirs = () => {
    drop(fmt);
    setConflict(false);
    setProblems([]);
  };
  const overwrite = () => {
    setDrafts((d) => (d[fmt] ? { ...d, [fmt]: { ...d[fmt], version: cur.version } } : d));
    setConflict(false);
  };

  // ---- side column: placeholders / preview ------------------------------------
  const [side, setSide] = useState<"vars" | "preview">("vars");
  const [varsOpen, setVarsOpen] = useState(false);
  const [source, setSource] = useState<"sample" | "user">("sample");
  const [userQ, setUserQ] = useState("");
  const [picked, setPicked] = useState<UserHit | null>(null);
  const [shown, setShown] = useState<(Rendered & { fmt: Fmt }) | null>(null);
  const rendered = shown?.fmt === fmt ? shown : null;
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<unknown>(null);
  const run = async () => {
    if (source === "user" && !picked) return;
    setSide("preview");
    setPreviewing(true);
    setPreviewError(null);
    try {
      const r = await post<Rendered>(`/sub-templates/${fmt}/preview`, {
        body,
        ...(source === "user" && picked ? { user_id: picked.id } : {}),
      });
      setShown({ ...r, fmt });
      setProblems([]);
    } catch (e) {
      setShown(null);
      const p = problemOf(e, errText(e));
      if (p) setProblems([p]);
      else setPreviewError(e);
    } finally {
      setPreviewing(false);
    }
  };

  const insert = (token: string) => editor.current?.insert(token);

  const formatTabs = (
    <Tabs<Fmt>
      label={tr("客户端", "Client")}
      value={fmt}
      onChange={setFmt}
      tabs={FORMATS.map((f) => ({
        value: f.id,
        label: (
          <>
            {f.name}
            {dirty(f.id) && (
              <span
                className="size-1.5 rounded-full bg-warning"
                role="img"
                aria-label={tr("有未保存的修改", "Unsaved changes")}
              />
            )}
          </>
        ),
      }))}
      className="px-4"
    />
  );

  const errorStrip = problems.length > 0 && (
    <div
      role="alert"
      aria-label={tr("模板错误", "Template errors")}
      className="border-t border-separator bg-destructive-soft px-4 py-2.5 text-footnote"
    >
      {problems.map((p, i) => (
        <div key={i} className="flex items-start gap-2">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1">{p.text}</span>
          {p.line > 0 && (
            <button
              type="button"
              className="shrink-0 text-primary hover:underline"
              onClick={() => editor.current?.gotoLine(p.line, p.column)}
            >
              {p.column
                ? tr(`第 ${p.line} 行 第 ${p.column} 列`, `Line ${p.line}, column ${p.column}`)
                : tr(`第 ${p.line} 行`, `Line ${p.line}`)}
            </button>
          )}
        </div>
      ))}
    </div>
  );

  const conflictBanner = stale && (
    <div role="alert" className="border-t border-separator px-4 py-3">
      <Callout tone="warning" title={tr("模板已被其他管理员修改", "The template was changed by another admin")}>
        <p className="text-footnote text-muted-foreground">
          {tr(
            "你的草稿基于旧版本，现在保存会被拒绝。载入最新版本会放弃你的草稿；覆盖则保留你的草稿，保存时替换他们的修改。",
            "Your draft is based on an older version, so saving is refused. Loading the latest discards your draft; overwriting keeps it and replaces their changes when you save.",
          )}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" icon={RotateCcw} onClick={loadTheirs}>
            {tr("载入最新版本", "Load the latest version")}
          </Button>
          <Button size="sm" variant="ghost" onClick={overwrite}>
            {tr("保留我的草稿并覆盖", "Keep my draft and overwrite")}
          </Button>
        </div>
      </Callout>
    </div>
  );

  const footer = (
    <div className="z-10 flex flex-wrap items-center gap-2 border-t border-separator bg-[color-mix(in_srgb,var(--window),var(--card)_40%)] px-4 py-2.5 max-lg:sticky max-lg:bottom-[calc(52px+env(safe-area-inset-bottom))]">
      <span className="flex items-center gap-1.5 text-footnote" aria-live="polite">
        {isDirty ? (
          <>
            <span className="size-2 rounded-full bg-warning" aria-hidden="true" />
            {tr("未保存的修改", "Unsaved changes")}
          </>
        ) : (
          <span className="text-muted-foreground">
            {cur.is_default
              ? tr("使用内置默认模板", "Using the built-in default")
              : [tr("已自定义", "Custom"), cur.updated_at ? dateTime(cur.updated_at) : null, cur.updated_by]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        )}
      </span>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        icon={RotateCcw}
        disabled={cur.is_default && !isDirty}
        title={cur.is_default && !isDirty ? tr("这已经是默认模板", "This is already the default") : undefined}
        onClick={() => void reset()}
      >
        {tr("恢复默认", "Reset to default")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        icon={Eye}
        loading={previewing}
        disabled={source === "user" && !picked}
        onClick={() => void run()}
      >
        {tr("预览", "Preview")}
      </Button>
      <Button variant="primary" size="sm" loading={saving} disabled={!canSave} onClick={() => void save()}>
        {tr("保存", "Save")}
        <Kbd className="bg-primary-foreground/20 text-current shadow-none max-sm:hidden">{`${MOD_KEY}S`}</Kbd>
      </Button>
    </div>
  );

  const vars = (
    <div className="p-3">
      {!wide && (
        <button
          type="button"
          aria-expanded={varsOpen}
          className="hit-44 flex w-full items-center gap-1.5 text-callout font-medium"
          onClick={() => setVarsOpen((v) => !v)}
        >
          {varsOpen ? (
            <ChevronDown className="size-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-4" aria-hidden="true" />
          )}
          {tr("占位符说明", "Placeholder help")}
          <span className="tnum rounded-full bg-secondary px-1.5 text-caption text-muted-foreground">
            {cur.placeholders.length}
          </span>
        </button>
      )}
      {(wide || varsOpen) && (
        <>
          <p className="mb-2 text-caption text-muted-foreground">
            {tr(
              "点击占位符，插入到编辑器的光标处。名称与 xboard 一致，可直接粘贴 xboard 的模板。",
              "Click a placeholder to insert it at the cursor. The names follow xboard, so an xboard template can be pasted as is.",
            )}
          </p>
          <ul className="grid gap-2">
            {cur.placeholders.map((p) => (
              <li key={p.token} className="rounded-lg bg-window/60 p-2.5">
                <button
                  type="button"
                  aria-label={tr(`插入 ${p.token}`, `Insert ${p.token}`)}
                  className="rounded bg-primary-soft px-1.5 py-0.5 font-mono text-footnote text-primary hover:underline"
                  onClick={() => insert(p.token)}
                >
                  {p.token}
                </button>
                <p className="mt-1 text-footnote text-muted-foreground">{lang === "en" ? p.en : p.zh}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );

  const previewPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid gap-2 border-b border-separator px-3 py-2.5">
        <Segmented
          size="sm"
          label={tr("预览数据", "Preview data")}
          value={source}
          onChange={setSource}
          options={[
            { value: "sample", label: tr("示例数据", "Sample data") },
            { value: "user", label: tr("真实用户", "A real user") },
          ]}
        />
        {source === "user" ? (
          <>
            <Callout tone="warning">
              <p className="text-footnote">
                <ShieldAlert className="mr-1 inline size-3.5 align-text-bottom" aria-hidden="true" />
                {tr(
                  "会用该用户的真实线路和凭据渲染，并记入审计日志（订阅模板预览）。订阅链接仍是占位符。",
                  "Renders with this user's real lines and credentials and is recorded in the audit log (subscription template preview). The subscription link stays a placeholder.",
                )}
              </p>
            </Callout>
            <UserPicker q={userQ} onQ={setUserQ} picked={picked} onPick={setPicked} />
          </>
        ) : (
          <p className="text-caption text-muted-foreground">
            {tr(
              "用内置的示例线路渲染，不含任何真实凭据。",
              "Rendered with built-in sample lines; no real credentials.",
            )}
          </p>
        )}
      </div>
      <div className="h-[45dvh] min-h-[240px] overflow-hidden bg-window/40 lg:h-auto lg:min-h-0 lg:flex-1">
        {previewError ? (
          <ErrorState error={previewError} onRetry={() => void run()} compact />
        ) : rendered ? (
          <Suspense fallback={<LoadingBlock rows={8} className="p-4" />}>
            <CodeEditor
              key={`${fmt}:preview`}
              readOnly
              value={rendered.body}
              lang={info.lang}
              label={tr("预览结果", "Rendered preview")}
            />
          </Suspense>
        ) : (
          <p className="p-4 text-body text-muted-foreground">
            {previewing
              ? tr("渲染中…", "Rendering…")
              : problems.length > 0
                ? tr("模板有错误，修正后再预览。", "The template has errors; fix them to see the preview.")
                : tr("点「预览」按当前草稿渲染一份输出。", "Press Preview to render the current draft.")}
          </p>
        )}
      </div>
    </div>
  );

  const editorPane = (
    <Suspense fallback={<LoadingBlock rows={10} className="p-4" />}>
      <CodeEditor
        key={fmt}
        handle={editor}
        value={body}
        onChange={edit}
        lang={info.lang}
        label={tr(`${info.name} 订阅模板`, `${info.name} subscription template`)}
        errors={marks}
        onSave={() => void saveRef.current()}
      />
    </Suspense>
  );

  return (
    <div className="xl:-mt-2">
      <div className="mb-4">
        {back}
        {title}
      </div>
      <Card className="flex flex-col max-sm:-mx-4 max-sm:rounded-none lg:h-[calc(100dvh-190px)] lg:min-h-[620px] lg:overflow-hidden">
        {formatTabs}
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
          <section aria-label={tr("编辑", "Edit")} className="flex min-h-0 flex-col lg:border-r lg:border-separator">
            <div className="h-[55dvh] min-h-[320px] overflow-hidden bg-window/40 lg:h-auto lg:min-h-0 lg:flex-1">
              {editorPane}
            </div>
            {errorStrip}
            {conflictBanner}
          </section>
          <aside
            aria-label={tr("占位符与预览", "Placeholders and preview")}
            className="flex min-h-0 flex-col max-lg:border-t max-lg:border-separator"
          >
            <div className="flex items-center gap-2 border-b border-separator px-3 py-2">
              <Segmented
                size="sm"
                label={tr("侧栏", "Side panel")}
                value={side}
                onChange={setSide}
                options={[
                  { value: "vars", label: tr("占位符", "Placeholders") },
                  { value: "preview", label: tr("预览", "Preview") },
                ]}
              />
              <span className="ml-auto text-caption text-faint">{info.file}</span>
            </div>
            <div className={cn("flex min-h-0 flex-1 flex-col", side === "vars" && "overflow-y-auto")}>
              {side === "vars" ? vars : previewPane}
            </div>
          </aside>
        </div>
        {footer}
      </Card>
    </div>
  );
}

type UserHit = { id: string; email: string; plan_name: string | null };

/** Search users by address and pick one (the preview with real data). */
function UserPicker({
  q,
  onQ,
  picked,
  onPick,
}: {
  q: string;
  onQ: (v: string) => void;
  picked: UserHit | null;
  onPick: (u: UserHit) => void;
}) {
  const tr: Tr = useTr();
  const term = useDebounced(q.trim(), 300);
  const hits = useQuery({
    queryKey: ["sub-template-users", term],
    queryFn: () => get<{ users: UserHit[] }>(`/users${qs({ q: term, limit: 5 })}`),
    enabled: term.length >= 2,
  });
  return (
    <div className="grid gap-1.5">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
        <Input
          aria-label={tr("搜索用户（邮箱）", "Search users (email)")}
          placeholder={tr("输入至少 2 个字符的邮箱…", "At least 2 characters of the email…")}
          value={q}
          onChange={(e) => onQ(e.target.value)}
          className="pl-8"
        />
      </div>
      {picked && (
        <p className="flex items-center gap-1 text-footnote">
          <Check className="size-3.5 text-success" aria-hidden="true" />
          {tr("已选：", "Selected: ")}
          <span className="min-w-0 truncate font-medium">{picked.email}</span>
        </p>
      )}
      {hits.data && (
        <ul aria-label={tr("匹配的用户", "Matching users")} className="grid gap-0.5">
          {hits.data.users.length === 0 && (
            <li className="text-footnote text-muted-foreground">{tr("没有匹配的用户", "No matching users")}</li>
          )}
          {hits.data.users.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                aria-pressed={picked?.id === u.id}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-footnote hover:bg-secondary",
                  picked?.id === u.id && "bg-primary-soft",
                )}
                onClick={() => onPick(u)}
              >
                <span className="min-w-0 flex-1 truncate">{u.email}</span>
                <span className="shrink-0 text-caption text-faint">{u.plan_name ?? tr("无套餐", "No plan")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
