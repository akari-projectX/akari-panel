// 系统设置 → 通知 → 邮件模板 (SET-18, proposal §4): a full-width editor at
// /settings/mail-templates. Desktop: template list | subject, placeholder
// chips and the CodeMirror source | server-rendered preview (≥1536px a
// fourth column lists the placeholders). Phone and narrow windows: a
// template picker and 编辑 / 预览 / 变量 tabs. One kind × language at a
// time (`?kind=&lang=` in the URL); leaving it with unsaved changes asks
// first (router blocker + beforeunload). Placeholders are checked as you
// type (unknown / missing required, with the line); the server's 400s
// (forbidden HTML…) arrive with `params.field/line/column` and show in the
// same error strip. Save is off while there are errors; 发送测试 sends the
// current draft (`POST /settings/mail-templates/test-draft`).
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  Braces,
  ChevronLeft,
  CircleAlert,
  Code2,
  Monitor,
  Moon,
  RotateCcw,
  Search,
  Send,
  Smartphone,
  Sun,
  Type,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useBlocker } from "react-router";
import { ApiError, del, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { errorCode } from "../../shared/errors";
import { dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Field, Input, Kbd, MOD_KEY, Segmented, Select } from "../../shared/ui/form";
import { Callout } from "../../shared/ui/layout";
import { ErrorState, LoadingBlock, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { RadioCards } from "../components/inputs";
import { FormError, useDebounced, useErrText } from "../kit";
import { useQS, useQueryParam } from "../router";
import { useCrumb, useMe } from "../session";
import { checkDraft, type MailField, type Problem } from "./mail-editor/check";
import type { EditorHandle } from "./mail-editor/code-editor";

// CodeMirror is a chunk of its own, fetched when the editor first shows.
const CodeEditor = lazy(() => import("./mail-editor/code-editor"));

type Template = {
  kind: string;
  label: string;
  locale: "zh" | "en";
  subject: string;
  body: string;
  html_source: string | null;
  starter_html: string;
  default_subject: string;
  default_body: string;
  custom: boolean;
  version: number;
  /** The override's last save (null for the default). */
  updated_at?: string | null;
  updated_by?: string | null;
  placeholders: { name: string; description: string }[];
  required: string[];
};
type Rendered = { subject: string; text: string; html: string };
type Locale = "zh" | "en";
type Mode = "auto" | "source";

/** The 17 kinds by purpose (the server's labels are Chinese; English here). */
const GROUPS: { zh: string; en: string; kinds: [string, string][] }[] = [
  {
    zh: "账户",
    en: "Account",
    kinds: [
      ["register_code", "Sign-up code"],
      ["email_code", "Email code"],
      ["register_exists", "Sign-up: address taken"],
      ["password_reset", "Password reset"],
      ["security_notice", "Security alert"],
    ],
  },
  {
    zh: "订单与订阅",
    en: "Orders & plans",
    kinds: [
      ["order_paid", "Payment receipt"],
      ["expiry_soon", "Plan expiring"],
      ["expired", "Plan expired"],
      ["quota_80", "80% of traffic used"],
      ["quota_100", "Traffic used up"],
      ["refund", "Refund notice"],
    ],
  },
  {
    zh: "工单与公告",
    en: "Tickets & announcements",
    kinds: [
      ["ticket_reply", "Ticket reply (to the user)"],
      ["ticket_new", "New ticket (to admins)"],
      ["announcement", "Announcement"],
      ["admin_notice", "Bulk mail from admins"],
    ],
  },
  {
    zh: "系统",
    en: "System",
    kinds: [
      ["node_alert", "Node alert"],
      ["test", "Test mail"],
    ],
  },
];
const EN_LABEL = new Map(GROUPS.flatMap((g) => g.kinds));

type Values = { subject: string; body: string; html: string; mode: Mode };
type DraftState = Values & { key: string; version: number; base: Values };

const valuesOf = (t: Template): Values => ({
  subject: t.subject,
  body: t.body,
  html: t.html_source ?? "",
  mode: t.html_source === null ? "auto" : "source",
});
const same = (a: Values, b: Values) =>
  a.subject === b.subject && a.body === b.body && a.mode === b.mode && (a.mode === "auto" || a.html === b.html);

function fieldLabel(tr: Tr, f: MailField | undefined, source: boolean): string {
  if (f === "subject") return tr("主题", "Subject");
  if (f === "html_source") return tr("HTML 源码", "HTML source");
  if (f === "body") return source ? tr("纯文本部分", "Plain-text part") : tr("正文", "Body");
  return "";
}

function problemText(tr: Tr, p: Problem, source: boolean): string {
  // The server's message already names the place ("HTML 源码第 3 行第 1 列：…").
  if (p.kind === "server") return p.text ?? "";
  const where = [fieldLabel(tr, p.field, source), p.line ? tr(`第 ${p.line} 行`, `line ${p.line}`) : ""]
    .filter(Boolean)
    .join(" ");
  const what =
    p.kind === "unknown"
      ? p.suggest
        ? tr(
            `未知变量 {${p.name}}，是不是 {${p.suggest}}？`,
            `unknown placeholder {${p.name}}; did you mean {${p.suggest}}?`,
          )
        : tr(`未知变量 {${p.name}}`, `unknown placeholder {${p.name}}`)
      : p.kind === "missing"
        ? tr(`缺少必需变量 {${p.name}}`, `the required placeholder {${p.name}} is missing`)
        : p.kind === "empty"
          ? tr("不能为空", "must not be empty")
          : (p.text ?? "");
  return where ? `${where}${tr("：", ": ")}${what}` : what;
}

/** A server 400 (preview or save) as a problem, with its place when the server gave one. */
function serverProblem(e: unknown, text: string): Problem | null {
  if (!(e instanceof ApiError) || e.status !== 400) return null;
  const f = e.params.field;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
  return {
    field: f === "subject" || f === "body" || f === "html_source" ? f : undefined,
    line: n(e.params.line),
    column: n(e.params.column),
    kind: "server",
    text,
  };
}

/** The query without the phone tab (switching 编辑 / 预览 / 变量 is not leaving). */
function withoutTab(search: string): string {
  const q = new URLSearchParams(search);
  q.delete("tab");
  return q.toString();
}

/** Leaving with unsaved changes (another template, language or page) asks first. */
function useLeaveGuard(dirty: boolean) {
  const tr = useTr();
  const confirm = useConfirm();
  const blocker = useBlocker(
    ({ currentLocation: a, nextLocation: b }) =>
      dirty && (a.pathname !== b.pathname || withoutTab(a.search) !== withoutTab(b.search)),
  );
  const asking = useRef(false);
  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;
    void confirm({
      title: tr("放弃未保存的修改？", "Discard unsaved changes?"),
      description: tr(
        "这个模板的修改还没有保存，离开后会丢失。",
        "This template has unsaved changes; leaving discards them.",
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

export function MailTemplatesPage() {
  const tr = useTr();
  useCrumb(tr("邮件模板", "Mail templates"));
  const list = useQuery({ queryKey: ["mail-templates"], queryFn: () => get<Template[]>("/settings/mail-templates") });
  const back = (
    <Link
      to="/settings/notices"
      className="hit-44 inline-flex items-center text-footnote text-muted-foreground hover:text-foreground max-lg:text-callout max-lg:text-primary"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      {tr("系统设置", "Settings")}
      <span className="max-lg:hidden">{tr(" · 通知", " · Notifications")}</span>
    </Link>
  );
  if (!list.data)
    return (
      <div>
        {back}
        <h1 className="mb-4 text-title2 font-bold tracking-[-0.02em] sm:text-title1">
          {tr("邮件模板", "Mail templates")}
        </h1>
        {list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : (
          <Card className="p-4">
            <LoadingBlock rows={8} />
          </Card>
        )}
      </div>
    );
  return <Editor templates={list.data} back={back} />;
}

function Editor({ templates, back }: { templates: Template[]; back: ReactNode }) {
  const tr = useTr();
  const me = useMe();
  const toast = useToast();
  const confirm = useConfirm();
  const errText = useErrText();

  // ---- which template ------------------------------------------------------
  const kindsPresent = useMemo(() => new Set(templates.map((t) => t.kind)), [templates]);
  const groups = useMemo(() => {
    const listed = new Set(GROUPS.flatMap((g) => g.kinds.map(([k]) => k)));
    const extra = [...kindsPresent].filter((k) => !listed.has(k));
    const gs = GROUPS.map((g) => ({ ...g, kinds: g.kinds.filter(([k]) => kindsPresent.has(k)).map(([k]) => k) }));
    if (extra.length) gs.push({ zh: "其他", en: "Other", kinds: extra });
    return gs.filter((g) => g.kinds.length);
  }, [kindsPresent]);
  const [kindParam, setKind] = useQueryParam("kind");
  const [langParam, setLang] = useQueryParam("lang");
  const kind = kindsPresent.has(kindParam) ? kindParam : (groups[0]?.kinds[0] ?? "");
  const locale: Locale = langParam === "en" ? "en" : "zh";
  const cur = templates.find((t) => t.kind === kind && t.locale === locale);
  const label = (k: string) => {
    const zh = templates.find((t) => t.kind === k)?.label ?? k;
    return tr(zh, EN_LABEL.get(k) ?? zh);
  };
  const custom = (k: string) => templates.some((t) => t.kind === k && t.custom);

  // ---- the draft -------------------------------------------------------------
  const key = cur ? `${cur.kind}/${cur.locale}` : "";
  const [draft, setDraft] = useState<DraftState | null>(null);
  const dirty = !!draft && !same(draft, draft.base);
  // Load on another template; reload after a save, a reset or another
  // admin's change unless there are unsaved edits (then saving reports the
  // version conflict instead of overwriting).
  if (cur && (!draft || draft.key !== key || (draft.version !== cur.version && !dirty))) {
    const v = valuesOf(cur);
    setDraft({ ...v, key, version: cur.version, base: v });
  }
  useLeaveGuard(dirty);
  const [saveError, setSaveError] = useState<unknown>(null);
  const update = (patch: Partial<Values>) => {
    setSaveError(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  // ---- view state ------------------------------------------------------------
  // The phone's 编辑 / 预览 / 变量 tab lives in the URL (?tab=), replacing the entry.
  const [tabParam] = useQueryParam("tab");
  const tab: "edit" | "preview" | "vars" = tabParam === "preview" || tabParam === "vars" ? tabParam : "edit";
  const [, patchQS] = useQS();
  const setTab = (t: "edit" | "preview" | "vars") => {
    if (t !== tab) patchQS({ tab: t === "edit" ? null : t }, true);
  };
  const [target, setTarget] = useState<"html" | "text">("html");
  const [view, setView] = useState<"html" | "text">("html");
  const [width, setWidth] = useState<"desktop" | "phone">("desktop");
  const [dark, setDark] = useState<"light" | "dark">("light");
  const [search, setSearch] = useState("");
  const editor = useRef<EditorHandle>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<"subject" | "editor">("editor");

  const source = draft?.mode === "source";
  const editing: MailField = source && target === "html" ? "html_source" : "body";
  const allowed = useMemo(() => cur?.placeholders.map((p) => p.name) ?? [], [cur]);

  // ---- problems --------------------------------------------------------------
  const client = useMemo(
    () =>
      draft && cur
        ? checkDraft(
            { subject: draft.subject, body: draft.body, html: draft.html, source: draft.mode === "source" },
            allowed,
            cur.required,
          )
        : [],
    [draft, cur, allowed],
  );
  const req = draft
    ? JSON.stringify({
        kind,
        locale,
        subject: draft.subject,
        body: draft.body,
        html_source: draft.mode === "source" ? draft.html : null,
      })
    : "";
  const debounced = useDebounced(req, 400);
  const preview = useQuery({
    queryKey: ["mail-template-preview", debounced],
    queryFn: () => post<Rendered>("/settings/mail-templates/preview", JSON.parse(debounced)),
    enabled: !!debounced && client.length === 0,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const stable = debounced === req;
  const problems: Problem[] = [...client];
  if (client.length === 0 && stable && preview.error) {
    const p = serverProblem(preview.error, errText(preview.error));
    if (p) problems.push(p);
  }
  if (saveError) {
    const p = serverProblem(saveError, errText(saveError));
    if (p && !problems.some((q) => q.text === p.text)) problems.push(p);
  }
  const lineMarks = useMemo(
    () => [...new Set(problems.filter((p) => p.field === editing && p.line).map((p) => p.line!))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(problems.map((p) => [p.field, p.line])), editing],
  );

  // ---- actions ---------------------------------------------------------------
  const [saving, setSaving] = useState(false);
  const path = cur ? `/settings/mail-templates/${cur.kind}/${cur.locale}` : "";
  const canSave = !!draft && !!cur && dirty && problems.length === 0 && !saving;
  const save = async () => {
    if (!draft || !cur || !canSave) return;
    setSaving(true);
    const sent: Values = { subject: draft.subject, body: draft.body, html: draft.html, mode: draft.mode };
    try {
      const r = await put<{ version: number }>(path, {
        version: draft.version,
        subject: sent.subject,
        body: sent.body,
        html_source: sent.mode === "source" ? sent.html : null,
      });
      setDraft((d) => (d && d.key === key ? { ...d, version: r.version, base: sent } : d));
      toast({ tone: "success", title: tr("模板已保存", "Template saved") });
    } catch (e) {
      setSaveError(e);
      toast({ tone: "error", title: errText(e), description: errorCode(e) || undefined });
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

  const reset = async () => {
    if (!cur) return;
    const ok = await confirm({
      title: tr("恢复默认模板？", "Reset to the default?"),
      description: tr(
        `「${label(cur.kind)}」（${locale === "zh" ? tr("中文", "Chinese") : "English"}）的自定义主题、正文与 HTML 源码会被删除，下一封邮件即用默认模板。`,
        `The custom subject, body and HTML source of “${label(cur.kind)}” (${locale === "zh" ? "Chinese" : "English"}) are deleted; the next mail uses the default.`,
      ),
      impact: dirty ? tr("未保存的修改也会丢失。", "Unsaved changes are lost too.") : undefined,
      confirmLabel: tr("恢复默认", "Reset"),
      action: () => del(path),
    });
    if (ok) {
      setSaveError(null);
      setDraft(null);
      toast({ tone: "success", title: tr("已恢复默认", "Reset to the default") });
    }
  };

  const loadStarter = async () => {
    if (!cur || !draft) return;
    if (
      draft.html.trim() &&
      !(await confirm({
        title: tr("用起点替换当前源码？", "Replace the source with the starting point?"),
        description: tr(
          "编辑器里的 HTML 源码会被覆盖（不影响已保存的版本）。起点由已保存的主题与正文生成。",
          "The HTML source in the editor is overwritten (the saved version is not touched). The starting point is built from the saved subject and body.",
        ),
        confirmLabel: tr("替换", "Replace"),
        tone: "warning",
      }))
    )
      return;
    update({ html: cur.starter_html });
    setTarget("html");
  };

  const setMode = (m: Mode) => {
    if (!draft || !cur) return;
    // The first switch to the source starts from the generated HTML.
    update(m === "source" && !draft.html.trim() ? { mode: m, html: cur.starter_html } : { mode: m });
    if (m === "source") setTarget("html");
  };

  const insert = (name: string) => {
    const text = `{${name}}`;
    const el = subjectRef.current;
    if (lastFocus.current === "subject" && el && draft) {
      const s = el.selectionStart ?? el.value.length;
      const e = el.selectionEnd ?? s;
      update({ subject: draft.subject.slice(0, s) + text + draft.subject.slice(e) });
      if (tab === "vars") setTab("edit");
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(s + text.length, s + text.length);
      });
      return;
    }
    if (tab === "vars") setTab("edit");
    // The editor may be mounting (tab switch): insert on the next frame.
    requestAnimationFrame(() => editor.current?.insert(text));
  };

  const goto = (p: Problem) => {
    if (p.field === "subject") {
      setTab("edit");
      subjectRef.current?.focus();
      return;
    }
    if (p.field === "html_source" && editing !== "html_source") setTarget("html");
    if (p.field === "body" && editing !== "body") setTarget("text");
    setTab("edit");
    if (p.line) {
      const { line, column } = p;
      requestAnimationFrame(() => editor.current?.gotoLine(line!, column));
    }
  };

  const [testOpen, setTestOpen] = useState(false);

  if (!cur || !draft) return <Skeleton className="h-[600px]" />;

  // ---- pieces ----------------------------------------------------------------
  const pick = (k: string) => {
    if (k !== kind) setKind(k);
  };
  const toolbar = (
    <div className="flex max-w-full items-center gap-2 overflow-x-auto [scrollbar-width:none] xl:flex-wrap">
      <Segmented
        label={tr("语言", "Language")}
        value={locale}
        onChange={(l) => l !== locale && setLang(l === "zh" ? null : l)}
        options={[
          { value: "zh", label: "中文" }, // i18n-ok: the language names itself
          { value: "en", label: "English" },
        ]}
      />
      <Segmented
        label={tr("排版方式", "Layout")}
        value={draft.mode}
        onChange={setMode}
        options={[
          {
            value: "auto",
            label: (
              <>
                <Type className="size-3.5" aria-hidden="true" />
                {tr("自动排版", "Automatic layout")}
              </>
            ),
          },
          {
            value: "source",
            label: (
              <>
                <Code2 className="size-3.5" aria-hidden="true" />
                {tr("HTML 源码", "HTML source")}
              </>
            ),
          },
        ]}
      />
    </div>
  );

  const q = search.trim().toLowerCase();
  const matches = (k: string) =>
    !q ||
    k.includes(q) ||
    label(k).toLowerCase().includes(q) ||
    (templates.find((t) => t.kind === k)?.label ?? "").includes(q);
  const shown = groups.map((g) => ({ ...g, kinds: g.kinds.filter(matches) })).filter((g) => g.kinds.length);
  const templateList = (
    <nav aria-label={tr("模板列表", "Templates")} className="p-2">
      <div className="relative mb-2">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint"
          aria-hidden="true"
        />
        <Input
          type="search"
          aria-label={tr("搜索模板", "Search templates")}
          placeholder={tr("搜索模板", "Search templates")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-7 rounded-full pl-7 text-footnote"
        />
      </div>
      {shown.map((g) => (
        <div key={g.zh} className="mb-2">
          <div className="px-2 pt-1 pb-1 text-caption font-semibold text-faint">{tr(g.zh, g.en)}</div>
          {g.kinds.map((k) => {
            const on = k === kind;
            return (
              <button
                key={k}
                type="button"
                aria-current={on ? "true" : undefined}
                onClick={() => pick(k)}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-[8px] px-2 text-left text-body",
                  on ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
              >
                <span className="flex-1 truncate">{label(k)}</span>
                {on && dirty && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-warning"
                    role="img"
                    aria-label={tr("未保存的修改", "Unsaved changes")}
                  />
                )}
                {custom(k) && (
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", on ? "bg-primary-foreground" : "bg-primary")}
                    role="img"
                    aria-label={tr("已自定义", "Custom")}
                  />
                )}
              </button>
            );
          })}
        </div>
      ))}
      {!shown.length && (
        <p className="px-2 py-3 text-footnote text-muted-foreground">{tr("没有匹配的模板", "No template matches")}</p>
      )}
    </nav>
  );

  const chips = (
    <div
      className="flex items-center gap-1.5 overflow-x-auto border-b border-separator px-3 py-1.5 [scrollbar-width:none] max-sm:hidden 2xl:hidden"
      role="group"
      aria-label={tr("插入变量", "Insert a placeholder")}
    >
      <Braces className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
      {cur.placeholders.map((p) => (
        <button
          key={p.name}
          type="button"
          title={p.description}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => insert(p.name)}
          className="shrink-0 rounded-[5px] bg-primary-soft px-1.5 py-0.5 font-mono text-caption text-primary hover:brightness-95"
        >
          {`{${p.name}}`}
          {cur.required.includes(p.name) && "*"}
        </button>
      ))}
    </div>
  );

  const varList = (
    <div className="grid gap-1 p-2">
      <div className="px-1 pb-1 text-caption font-semibold text-faint">
        {tr("变量 · 点击插入到光标处", "Placeholders · click to insert at the cursor")}
      </div>
      {cur.placeholders.map((p) => (
        <button
          key={p.name}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => insert(p.name)}
          className="flex min-h-9 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-accent"
        >
          <code className="rounded-[5px] bg-primary-soft px-1.5 py-0.5 font-mono text-footnote text-primary">{`{${p.name}}`}</code>
          <span className="min-w-0 flex-1 truncate text-footnote text-muted-foreground">{p.description}</span>
          {cur.required.includes(p.name) && (
            <Badge tone="warning" className="px-1.5 text-caption">
              {tr("必需", "Required")}
            </Badge>
          )}
        </button>
      ))}
      <p className="px-1 pt-2 text-caption text-faint">
        {source
          ? tr(
              '源码里 {变量} 是转义后的文本：链接就是网址文本，写成 <a href="{link}">…</a>。不允许脚本、表单、iframe、onclick 之类的事件属性和 javascript: 链接。',
              'In the source a {placeholder} is escaped text: a link is the URL, so write <a href="{link}">…</a>. Scripts, forms, iframes, event attributes such as onclick and javascript: links are refused.',
            )
          : tr(
              "自动排版：空行分段；单独成段的链接变量显示为按钮。",
              "Automatic layout: blank lines split paragraphs; a link placeholder alone in a paragraph becomes a button.",
            )}
      </p>
    </div>
  );

  const editorLabel =
    editing === "html_source"
      ? tr("HTML 源码", "HTML source")
      : source
        ? tr("纯文本部分", "Plain-text part")
        : tr("邮件正文", "Body");
  const editorPane = (
    <>
      <div className="flex flex-col gap-1 border-b border-separator px-4 py-2.5 sm:flex-row sm:items-center sm:gap-2 sm:px-3 sm:py-2">
        <label
          htmlFor="mail-subject"
          className="shrink-0 text-caption font-medium text-muted-foreground sm:text-footnote"
        >
          {tr("主题", "Subject")}
        </label>
        <Input
          id="mail-subject"
          ref={subjectRef}
          aria-label={tr("邮件主题", "Subject")}
          maxLength={200}
          value={draft.subject}
          aria-invalid={problems.some((p) => p.field === "subject") || undefined}
          onFocus={() => (lastFocus.current = "subject")}
          onChange={(e) => update({ subject: e.target.value })}
          className="sm:h-7"
        />
      </div>
      {chips}
      {source && (
        <div className="flex flex-wrap items-center gap-2 border-b border-separator px-3 py-1.5">
          <Segmented
            size="sm"
            label={tr("编辑哪一部分", "Part to edit")}
            value={target}
            onChange={setTarget}
            options={[
              { value: "html", label: tr("HTML 部分", "HTML part") },
              { value: "text", label: tr("纯文本部分", "Plain-text part") },
            ]}
          />
          <span className="text-caption text-faint max-sm:hidden">
            {target === "text"
              ? tr("不支持 HTML 的客户端显示这一份，仍须填写。", "Shown by clients without HTML; still required.")
              : tr(
                  "源码替换整封邮件的 HTML（含外层样式）。",
                  "The source replaces the whole HTML part, outer styling included.",
                )}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void loadStarter()}>
            {tr("载入起点", "Load a starting point")}
          </Button>
        </div>
      )}
      <div className="min-h-[320px] flex-1 overflow-hidden bg-window/40 max-xl:h-[55dvh] xl:min-h-0">
        <Suspense fallback={<LoadingBlock rows={10} className="p-4" />}>
          <CodeEditor
            key={`${key}:${draft.mode}:${editing}`}
            handle={editor}
            value={editing === "html_source" ? draft.html : draft.body}
            onChange={(v) => update(editing === "html_source" ? { html: v } : { body: v })}
            language={editing === "html_source" ? "html" : "text"}
            label={editorLabel}
            allowed={allowed}
            errorLines={lineMarks}
            onFocus={() => (lastFocus.current = "editor")}
            onSave={() => void saveRef.current()}
          />
        </Suspense>
      </div>
      {problems.length > 0 && (
        <div
          role="alert"
          aria-label={tr("模板错误", "Template errors")}
          className="max-h-32 overflow-y-auto border-t border-separator bg-destructive-soft px-3 py-2 text-footnote"
        >
          {problems.map((p, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goto(p)}
              className="flex w-full items-start gap-2 py-0.5 text-left hover:underline"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden="true" />
              <span>{problemText(tr, p, source)}</span>
            </button>
          ))}
          <p className="mt-1 pl-5.5 text-caption text-muted-foreground">
            {tr("保存前需要修正。", "Fix these before saving.")}
          </p>
        </div>
      )}
    </>
  );

  const previewData = preview.data;
  const previewPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-separator px-3 py-2">
        <Segmented
          size="sm"
          label={tr("预览格式", "Preview format")}
          value={view}
          onChange={setView}
          options={[
            { value: "html", label: "HTML" },
            { value: "text", label: tr("纯文本", "Plain text") },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          <Segmented
            size="sm"
            label={tr("预览宽度", "Preview width")}
            value={width}
            onChange={setWidth}
            options={[
              {
                value: "desktop",
                label: <Monitor className="size-3.5" aria-label={tr("桌面宽度", "Desktop width")} />,
              },
              { value: "phone", label: <Smartphone className="size-3.5" aria-label={tr("手机宽度", "Phone width")} /> },
            ]}
          />
          <Segmented
            size="sm"
            label={tr("预览配色", "Preview colours")}
            value={dark}
            onChange={setDark}
            options={[
              { value: "light", label: <Sun className="size-3.5" aria-label={tr("浅色", "Light")} /> },
              {
                value: "dark",
                label: <Moon className="size-3.5" aria-label={tr("模拟深色客户端", "Simulated dark client")} />,
              },
            ]}
          />
        </div>
      </div>
      <div className="min-h-[2.25rem] border-b border-separator px-4 py-2 text-footnote">
        <span className="text-muted-foreground">{tr("主题：", "Subject: ")}</span>
        <span className="font-medium">{previewData?.subject ?? "—"}</span>
        {preview.isFetching && <span className="ml-2 text-caption text-faint">{tr("更新中…", "Updating…")}</span>}
      </div>
      <div
        className={cn(
          "flex min-h-[480px] flex-1 justify-center overflow-auto p-4 xl:min-h-0",
          "bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]",
        )}
      >
        {preview.error && !serverProblem(preview.error, "") ? (
          <ErrorState error={preview.error} onRetry={() => void preview.refetch()} compact />
        ) : !previewData ? (
          client.length ? (
            <p className="self-center text-body text-muted-foreground">
              {tr("修正模板错误后显示预览。", "The preview shows once the template errors are fixed.")}
            </p>
          ) : (
            <Skeleton className="h-full min-h-[440px] w-full max-w-[640px]" />
          )
        ) : view === "html" ? (
          <iframe
            title={tr("邮件 HTML 预览", "Mail HTML preview")}
            sandbox=""
            srcDoc={previewData.html}
            className={cn(
              "h-full min-h-[440px] rounded-lg bg-[Canvas] shadow-raised [color-scheme:light] transition-[width] duration-(--dur-base)",
              width === "phone" ? "w-[375px] max-w-full" : "w-full max-w-[640px]",
              dark === "dark" && "invert hue-rotate-180",
            )}
          />
        ) : (
          <pre
            aria-label={tr("纯文本预览", "Plain-text preview")}
            className={cn(
              "h-fit rounded-lg bg-card p-4 font-mono text-footnote whitespace-pre-wrap shadow-card",
              width === "phone" ? "w-[375px] max-w-full" : "w-full max-w-[640px]",
              dark === "dark" && "invert hue-rotate-180",
            )}
          >
            {previewData.text}
          </pre>
        )}
      </div>
      <div className="border-t border-separator px-3 py-1.5 text-caption text-faint">
        {tr(
          "示例数据渲染；外部图片不加载；深色只是模拟，实际以收件客户端为准",
          "Rendered with sample data; external images are not loaded; dark is only a simulation — the recipient's client decides",
        )}
      </div>
    </div>
  );

  const footer = (
    <div className="z-10 flex flex-wrap items-center gap-2 border-t border-separator bg-[color-mix(in_srgb,var(--window),var(--card)_40%)] px-4 py-2.5 max-xl:sticky max-xl:bottom-0 max-xl:rounded-b-xl max-sm:rounded-none max-lg:bottom-[calc(52px+env(safe-area-inset-bottom))]">
      <span className="flex items-center gap-1.5 text-footnote" aria-live="polite">
        {dirty ? (
          <>
            <span className="size-2 rounded-full bg-warning" aria-hidden="true" />
            {tr("未保存的修改", "Unsaved changes")}
          </>
        ) : (
          <span className="text-muted-foreground">
            {cur.custom
              ? [
                  tr("已自定义", "Custom"),
                  cur.updated_at ? dateTime(cur.updated_at) : tr("已保存", "saved"),
                  cur.updated_by,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : tr("使用默认模板", "Using the default template")}
          </span>
        )}
      </span>
      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        icon={RotateCcw}
        disabled={!cur.custom}
        title={cur.custom ? undefined : tr("这是默认模板", "This is the default")}
        onClick={() => void reset()}
      >
        {tr("恢复默认", "Reset to default")}
      </Button>
      <Button variant="outline" size="sm" icon={Send} onClick={() => setTestOpen(true)}>
        {tr("发送测试", "Send a test")}
      </Button>
      <Button variant="primary" size="sm" loading={saving} disabled={!canSave} onClick={() => void save()}>
        {tr("保存", "Save")}
        <Kbd className="bg-primary-foreground/20 text-current shadow-none max-sm:hidden">{`${MOD_KEY}S`}</Kbd>
      </Button>
    </div>
  );

  return (
    <div className="xl:-mt-2">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-64">
          {back}
          <h1 className="text-title2 font-bold tracking-[-0.02em] sm:text-title1">
            {tr("邮件模板", "Mail templates")}
          </h1>
        </div>
        <div className="max-xl:hidden">{toolbar}</div>
      </div>

      {/* Narrow: picker, language + mode, tabs. */}
      <div className="mb-3 grid gap-2 xl:hidden">
        <Select
          aria-label={tr("模板", "Template")}
          className="[&>select]:pointer-coarse:h-11"
          value={kind}
          onChange={(e) => pick(e.target.value)}
        >
          {groups.map((g) => (
            <optgroup key={g.zh} label={tr(g.zh, g.en)}>
              {g.kinds.map((k) => (
                <option key={k} value={k}>
                  {`${tr(g.zh, g.en)} · ${label(k)}${custom(k) ? tr("（已自定义）", " (custom)") : ""}`}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        {toolbar}
        <Segmented
          label={tr("编辑器视图", "Editor view")}
          className="w-full [&>button]:flex-1 [&>button]:justify-center"
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "edit",
              label: (
                <>
                  {tr("编辑", "Edit")}
                  {problems.length > 0 && (
                    <span className="ml-1 size-1.5 rounded-full bg-destructive" aria-hidden="true" />
                  )}
                </>
              ),
            },
            { value: "preview", label: tr("预览", "Preview") },
            { value: "vars", label: tr("变量", "Placeholders") },
          ]}
        />
      </div>

      <Card className="flex flex-col max-sm:-mx-4 max-sm:rounded-none xl:h-[calc(100dvh-170px)] xl:min-h-[620px] xl:overflow-hidden">
        <div className="grid min-h-0 flex-1 xl:grid-cols-[220px_minmax(0,1fr)_minmax(0,1fr)] 2xl:grid-cols-[230px_minmax(0,1fr)_minmax(0,1fr)_230px]">
          <aside className="hidden overflow-y-auto border-r border-separator bg-window/60 xl:block">
            {templateList}
          </aside>
          <section
            aria-label={tr("编辑", "Edit")}
            className={cn("flex min-h-0 flex-col xl:border-r xl:border-separator", tab !== "edit" && "max-xl:hidden")}
          >
            {editorPane}
          </section>
          <section
            aria-label={tr("预览", "Preview")}
            className={cn("flex min-h-0 flex-col", tab !== "preview" && "max-xl:hidden")}
          >
            {previewPane}
          </section>
          <aside
            aria-label={tr("变量", "Placeholders")}
            className={cn(
              "hidden overflow-y-auto border-separator 2xl:block 2xl:border-l",
              tab === "vars" && "max-xl:block",
            )}
          >
            {varList}
          </aside>
        </div>
        {footer}
      </Card>

      <TestDraft
        open={testOpen}
        onClose={() => setTestOpen(false)}
        defaultTo={me.email}
        dirty={dirty}
        draftOk={problems.length === 0}
        savedPath={`${path}/test`}
        body={{
          kind,
          locale,
          subject: draft.subject,
          body: draft.body,
          html_source: draft.mode === "source" ? draft.html : null,
        }}
      />
    </div>
  );
}

/**
 * 发送测试: the current draft as it is in the editor (unsaved; not while it
 * has errors) or the saved version, with sample values (ruling ⑥).
 */
function TestDraft({
  open,
  onClose,
  defaultTo,
  dirty,
  draftOk,
  savedPath,
  body,
}: {
  open: boolean;
  onClose: () => void;
  defaultTo: string;
  dirty: boolean;
  draftOk: boolean;
  savedPath: string;
  body: { kind: string; locale: string; subject: string; body: string; html_source: string | null };
}) {
  const tr = useTr();
  const toast = useToast();
  const [to, setTo] = useState(defaultTo);
  const [which, setWhich] = useState<"draft" | "saved">("saved");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  // Each opening starts from the draft when there is a sendable one.
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setWhich(dirty && draftOk ? "draft" : "saved");
      setError(null);
    }
  }
  const send = useCallback(async () => {
    const addr = to.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(addr)) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (which === "draft") await post("/settings/mail-templates/test-draft", { ...body, to: addr });
      else await post(savedPath, { to: addr });
      toast({ tone: "success", title: tr(`测试邮件已发出：${addr}`, `Test mail sent to ${addr}`) });
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [to, which, body, savedPath, toast, tr, onClose]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dirty={false}
      size="md"
      icon={Send}
      title={tr("发送测试邮件", "Send a test mail")}
      description={tr(
        "用示例数据渲染，经已保存的发信设置立即发出。",
        "Rendered with sample values and sent right away over the saved mail settings.",
      )}
      onSubmit={() => void send()}
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>{tr("取消", "Cancel")}</Button>
          <Button type="submit" variant="primary" icon={Send} loading={busy}>
            {tr("发送", "Send")}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field group label={tr("发送哪个版本", "Which version")}>
          <RadioCards<"draft" | "saved">
            value={which}
            onChange={setWhich}
            cols={2}
            label={tr("发送哪个版本", "Which version")}
            items={[
              {
                value: "draft",
                title: tr("当前草稿", "Current draft"),
                desc: dirty
                  ? tr("编辑器里未保存的内容", "What is in the editor, unsaved")
                  : tr("与已保存的版本相同", "Same as the saved version"),
                disabled: draftOk
                  ? undefined
                  : tr("草稿有错误，修正后才能发送", "The draft has errors; fix them first"),
              },
              {
                value: "saved",
                title: tr("已保存的版本", "Saved version"),
                desc: tr("下一封真实邮件用的就是它", "What the next real mail uses"),
              },
            ]}
          />
        </Field>
        <Field
          label={tr("测试收件地址", "Test address")}
          error={invalid ? tr("请输入有效的邮箱地址", "Enter a valid email address") : undefined}
        >
          <Input
            type="email"
            data-autofocus
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setInvalid(false);
            }}
          />
        </Field>
        {error ? (
          <Callout tone="danger">
            <FormError error={error} />
          </Callout>
        ) : null}
      </div>
    </Dialog>
  );
}
