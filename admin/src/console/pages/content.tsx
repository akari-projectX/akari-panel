// 内容 (CNT-*; v2 proposal §6 内容 · 公告 / 知识库). `/content/announcements`:
// announcements by lifecycle — 进行中 (pinned first) → 已排期 → 草稿 → 已结束
// (collapsed) — with a time axis and a per-row window bar (red line =
// today), language fill chips, audience, window, the mail state (sent N /
// progress / a 邮件通知 button) and a ⋯ menu (edit, mail, copy as new,
// delete). Editor = xl dialog: form left (zh / EN tabs with fill dots,
// title, Markdown body, audience cards with recipient counts, start / end
// as site-time-zone date-time inputs, pinned), the server-rendered preview
// right; 存为草稿 (enabled off) and 发布 each with their own spinner.
// Mailing = a dialog with recipients, a duplicate warning that must be
// acknowledged, and the progress while it runs. The knowledge base lives
// in content-kb.tsx. URL: `?open=new|<id>` (`&copy=<id>`), `?mail=<id>`.
import { useQuery } from "@tanstack/react-query";
import {
  Brush,
  CalendarClock,
  CircleCheck,
  Copy,
  Mail,
  MailCheck,
  Megaphone,
  Pencil,
  Pin,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { del, get, post, put } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateOnly, dateTime, fromLocalInput, toLocalInput } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Card } from "../../shared/ui/card";
import { useConfirm } from "../../shared/ui/confirm";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Field, Input, Segmented, Switch, Textarea } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { MenuItem, MenuSeparator, RowMenu } from "../../shared/ui/menu";
import { Meter } from "../../shared/ui/meter";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { useToast } from "../../shared/ui/toast";
import { FixCount, Spin } from "../components/kit";
import { LangTabs, RadioCards } from "../components/inputs";
import { Fact, LangChip, MarkdownPreview } from "../components/support-content";
import { useAction } from "../data";
import { navigate, useQS, useRoute } from "../router";
import { useSite } from "../session";
import { KnowledgeBase, useArticles } from "./content-kb";
import { TagChip, TagsManager, useAnnouncementTags, type AnnouncementTag } from "./content-tags";

export type Announcement = {
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
  tag_id: string | null;
  tag_name_zh: string | null;
  tag_name_en: string | null;
  tag_color: string | null;
  active: boolean;
  reads: number;
  mail_requested_at: string | null;
  mail_sent: number;
  mail_done_at: string | null;
  created_at: string;
  /** Who a mailing would reach now (verified customers in the audience). */
  recipients?: number;
};
type Audience = "all" | "with_plan" | "without_plan";
type Life = "live" | "scheduled" | "draft" | "ended";
const ORDER: Life[] = ["live", "scheduled", "draft", "ended"];
const DAY = 86_400_000;

function audienceName(a: string, tr: Tr) {
  return (
    (
      {
        all: tr("全部用户", "Everyone"),
        with_plan: tr("有生效套餐的用户", "Users with a plan"),
        without_plan: tr("没有套餐的用户", "Users without a plan"),
      } as Record<string, string>
    )[a] ?? tr("全部用户", "Everyone")
  );
}
function lifeName(s: Life, tr: Tr) {
  return {
    live: tr("进行中", "Live"),
    scheduled: tr("已排期", "Scheduled"),
    draft: tr("草稿", "Drafts"),
    ended: tr("已结束", "Ended"),
  }[s];
}
function lifeHint(s: Life, tr: Tr) {
  return {
    live: tr("正在门户首页显示", "Showing on the portal home"),
    scheduled: tr("到时间自动显示", "Shows up on its start time"),
    draft: tr("只有管理员能看到", "Only admins see these"),
    ended: "",
  }[s];
}
/** Lifecycle from the enabled flag and the window (the server's `active` = live). */
export function lifeOf(a: Announcement, now = Date.now()): Life {
  if (!a.enabled) return "draft";
  if (a.visible_from && Date.parse(a.visible_from) > now) return "scheduled";
  if (a.visible_until && Date.parse(a.visible_until) <= now) return "ended";
  return "live";
}
const mailing = (a: Announcement) => !!a.mail_requested_at && !a.mail_done_at;

export function ContentPage() {
  const tr = useTr();
  const { sub } = useRoute();
  const [, patch] = useQS();
  const tab = sub[0] === "kb" ? "kb" : sub[0] === "tags" ? "tags" : "announcements";
  const anns = useAnnouncements();
  const arts = useArticles();
  const tags = useAnnouncementTags();
  const live = (anns.data ?? []).filter((a) => lifeOf(a) === "live").length;
  const docs = (arts.data ?? []).filter((a) => a.slug !== "terms" && a.slug !== "privacy").length;
  return (
    <>
      <PageHeader
        title={tr("内容", "Content")}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1">
            {tr("门户里用户能看到的公告和帮助文章。", "The announcements and help articles users see in the portal.")}
            <Link to="/settings/brand" className="inline-flex items-center gap-1 text-primary hover:underline">
              <Brush className="size-3.5" aria-hidden="true" />
              {tr("Logo 与页脚在 系统设置 › 外观与品牌", "Logo and footer: Settings › Brand")}
            </Link>
          </span>
        }
        actions={
          tab === "announcements" ? (
            <Button variant="primary" icon={Plus} onClick={() => patch({ open: "new", copy: null })}>
              {tr("新建公告", "New announcement")}
            </Button>
          ) : tab === "tags" ? (
            <Button variant="primary" icon={Plus} onClick={() => patch({ open: "new" })}>
              {tr("新建标签", "New tag")}
            </Button>
          ) : undefined
        }
      >
        <div className="w-full">
          <Segmented
            label={tr("内容类型", "Content type")}
            value={tab}
            onChange={(v) => navigate(`/content/${v}`)}
            options={[
              {
                value: "announcements",
                label: (
                  <>
                    {tr("公告", "Announcements")}
                    {live > 0 && (
                      <span className="tnum text-caption text-success">{tr(`${live} 进行中`, `${live} live`)}</span>
                    )}
                  </>
                ),
              },
              { value: "tags", label: tr("公告标签", "Announcement tags"), count: tags.data?.length },
              { value: "kb", label: tr("知识库", "Knowledge base"), count: arts.data ? docs : undefined },
            ]}
          />
        </div>
      </PageHeader>
      {tab === "announcements" ? <Announcements q={anns} /> : tab === "tags" ? <TagsManager /> : <KnowledgeBase />}
    </>
  );
}

function useAnnouncements() {
  return useQuery({
    queryKey: ["announcements"],
    queryFn: () => get<Announcement[]>("/announcements"),
    // While a mailing runs, follow its progress.
    refetchInterval: (s) => ((s.state.data ?? []).some(mailing) ? 5000 : false),
  });
}

function Announcements({ q }: { q: ReturnType<typeof useAnnouncements> }) {
  const tr = useTr();
  const [query, patch] = useQS();
  const [showEnded, setShowEnded] = useState(false);
  const list = q.data ?? [];
  const open = query.get("open");
  const copy = query.get("copy");
  const mailId = query.get("mail");
  const editing = open && open !== "new" ? list.find((a) => a.id === open) : undefined;
  const copyOf = open === "new" && copy ? list.find((a) => a.id === copy) : undefined;
  const mailOf = mailId ? list.find((a) => a.id === mailId) : undefined;
  const now = Date.now();
  const axis = useAxis(list, now);

  let body;
  if (q.isPending)
    body = (
      <Card className="divide-y divide-separator" aria-busy="true">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex h-16 items-center gap-4 px-4">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="ml-auto h-2 w-1/3 rounded-full" />
          </div>
        ))}
      </Card>
    );
  else if (q.isError && !q.data)
    body = (
      <Card>
        <ErrorState
          title={tr("公告加载失败", "The announcements did not load")}
          error={q.error}
          onRetry={() => void q.refetch()}
        />
      </Card>
    );
  else if (list.length === 0)
    body = (
      <Card>
        <EmptyState
          icon={Megaphone}
          title={tr("还没有公告", "No announcements yet")}
          description={tr(
            "公告会出现在门户首页顶部。可以设定显示时间、只给某些用户看，并用邮件通知他们。",
            "Announcements show at the top of the portal home. Set when they show, who sees them, and mail them out.",
          )}
          action={
            <Button variant="primary" icon={Plus} onClick={() => patch({ open: "new" })}>
              {tr("新建公告", "New announcement")}
            </Button>
          }
        />
      </Card>
    );
  else
    body = (
      <div className="grid gap-5">
        {ORDER.map((s) => {
          const rows = list.filter((a) => lifeOf(a, now) === s).sort((a, b) => Number(b.pinned) - Number(a.pinned));
          if (!rows.length) return null;
          const collapsed = s === "ended" && !showEnded;
          return (
            <section key={s} aria-label={lifeName(s, tr)}>
              <div className="mb-2 flex items-center gap-2 px-1">
                <h2 className="text-headline font-semibold">{lifeName(s, tr)}</h2>
                <span className="tnum rounded-full bg-secondary px-1.5 text-footnote font-medium text-muted-foreground">
                  {rows.length}
                </span>
                {lifeHint(s, tr) && <span className="text-footnote text-faint max-sm:hidden">{lifeHint(s, tr)}</span>}
                {s === "ended" && (
                  <Button
                    variant="link"
                    size="sm"
                    className="ml-auto"
                    aria-expanded={!collapsed}
                    onClick={() => setShowEnded(!showEnded)}
                  >
                    {collapsed ? tr("展开", "Show") : tr("收起", "Hide")}
                  </Button>
                )}
              </div>
              {!collapsed && (
                <Card className="divide-y divide-separator overflow-hidden">
                  {(s === "live" || s === "scheduled") && <Axis axis={axis} />}
                  {rows.map((a) => (
                    <AnnRow key={a.id} a={a} life={s} axis={axis} />
                  ))}
                </Card>
              )}
            </section>
          );
        })}
      </div>
    );

  return (
    <>
      {body}
      {open && (open === "new" || editing) && (
        <AnnouncementEditor
          key={`${open}:${copy ?? ""}`}
          a={editing ?? null}
          from={copyOf ?? null}
          onClose={() => patch({ open: null, copy: null }, true)}
        />
      )}
      {mailOf && <MailDialog key={mailOf.id} a={mailOf} onClose={() => patch({ mail: null }, true)} />}
    </>
  );
}

/* ---------- Time axis ---------- */

type AxisRange = { lo: number; hi: number; now: number; ticks: { at: number; label: string }[] };

/** The axis of the live / scheduled rows: from two weeks back (or the earliest start) to the latest end (≥ two weeks ahead). */
function useAxis(list: Announcement[], now: number): AxisRange {
  const shown = list.filter((a) => {
    const l = lifeOf(a, now);
    return l === "live" || l === "scheduled";
  });
  let lo = now - 14 * DAY;
  let hi = now + 14 * DAY;
  for (const a of shown) {
    if (a.visible_from) lo = Math.min(lo, Date.parse(a.visible_from));
    if (a.visible_until) hi = Math.max(hi, Date.parse(a.visible_until));
  }
  // Keep the axis readable: at most a year either side.
  lo = Math.max(lo, now - 365 * DAY);
  hi = Math.min(hi, now + 365 * DAY);
  const ticks = [0, 1 / 3, 2 / 3, 1].map((f) => {
    const t = lo + (hi - lo) * f;
    return { at: f, label: dateOnly(new Date(t).toISOString()).slice(5) };
  });
  return { lo, hi, now, ticks };
}
const pos = (r: AxisRange, t: number) => Math.min(1, Math.max(0, (t - r.lo) / (r.hi - r.lo)));

function Axis({ axis }: { axis: AxisRange }) {
  const tr = useTr();
  return (
    <div className="hidden h-7 items-end gap-4 bg-window/60 px-4 pb-1 lg:flex" aria-hidden="true">
      <span className="flex flex-1 items-center gap-1.5 text-caption text-faint">
        {tr("显示时间窗（站点时区）", "Display window (site time zone)")}
        <span className="inline-block h-2.5 w-px bg-destructive" />
        {tr("今天", "today")}
      </span>
      <div className="relative h-4 w-[260px] text-caption text-faint xl:w-[320px]">
        {axis.ticks.map((t, i) => (
          <span
            key={i}
            className={cn(
              "tnum absolute whitespace-nowrap",
              i === 0 ? "" : i === axis.ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
            )}
            style={{ left: `${t.at * 100}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
      <span className="w-[132px]" />
      <span className="w-7" />
    </div>
  );
}

function WindowBar({ a, life, axis }: { a: Announcement; life: Life; axis: AxisRange }) {
  const from = pos(axis, a.visible_from ? Date.parse(a.visible_from) : axis.lo);
  const until = pos(axis, a.visible_until ? Date.parse(a.visible_until) : axis.hi);
  return (
    <div className="relative h-5 w-[260px] shrink-0 xl:w-[320px]" aria-hidden="true">
      <div className="absolute inset-x-0 top-1/2 h-px bg-separator" />
      {axis.ticks.map((t, i) => (
        <span
          key={i}
          className="absolute top-1/2 h-1.5 w-px -translate-y-1/2 bg-separator"
          style={{ left: `${t.at * 100}%` }}
        />
      ))}
      <span
        className={cn(
          "absolute top-1/2 h-2 min-w-1.5 -translate-y-1/2 rounded-full",
          life === "live" ? "bg-success" : "bg-info/70",
          !a.visible_until && "rounded-r-none",
        )}
        style={{ left: `${from * 100}%`, width: `${Math.max(0, until - from) * 100}%` }}
      />
      <span className="absolute inset-y-0 w-px bg-destructive" style={{ left: `${pos(axis, axis.now) * 100}%` }} />
    </div>
  );
}

/* ---------- Rows ---------- */

function MailStatus({ a, life }: { a: Announcement; life: Life }) {
  const tr = useTr();
  const [, patch] = useQS();
  if (mailing(a)) {
    const total = a.recipients ?? 0;
    return (
      <button
        type="button"
        onClick={() => patch({ mail: a.id })}
        className="grid w-[132px] gap-1 text-left"
        aria-label={tr("邮件发送进度", "Mailing progress")}
      >
        <span className="flex items-center gap-1 text-footnote text-info">
          <Spin className="size-3.5" />
          {tr("发送中", "Sending")}
        </span>
        <Meter value={total ? (a.mail_sent / total) * 100 : 0} tone="primary" />
        <span className="tnum text-caption text-faint">
          {a.mail_sent} / {total || "—"}
        </span>
      </button>
    );
  }
  if (a.mail_requested_at)
    return (
      <span className="flex w-[132px] items-center gap-1 text-footnote text-muted-foreground">
        <MailCheck className="size-3.5 shrink-0 text-success" aria-hidden="true" />
        <span className="tnum truncate">
          {tr(
            `${a.mail_sent} 人 · ${dateOnly(a.mail_requested_at).slice(5)}`,
            `${a.mail_sent} · ${dateOnly(a.mail_requested_at).slice(5)}`,
          )}
        </span>
      </span>
    );
  if (life === "draft" || life === "ended") return <span className="w-[132px] text-footnote text-faint">—</span>;
  return (
    <span className="w-[132px]">
      <Button size="sm" variant="soft" icon={Mail} onClick={() => patch({ mail: a.id })}>
        {tr("邮件通知", "Mail it")}
      </Button>
    </span>
  );
}

function AnnRow({ a, life, axis }: { a: Announcement; life: Life; axis: AxisRange }) {
  const tr = useTr();
  const [, patch] = useQS();
  const remove = useDeleteAnnouncement();
  const edit = () => patch({ open: a.id, copy: null });
  const when =
    a.visible_from || a.visible_until ? (
      <span className="tnum">
        {a.visible_from ? dateTime(a.visible_from).slice(5) : tr("立即", "now")} →{" "}
        {a.visible_until ? dateTime(a.visible_until).slice(5) : tr("不结束", "no end")}
      </span>
    ) : (
      <span>{tr("一直显示", "Always")}</span>
    );
  return (
    <div className="flex min-h-16 items-center gap-3 px-4 py-2.5 hover:bg-accent/50 sm:gap-4">
      <button type="button" onClick={edit} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          {a.pinned && (
            <Badge tone="warning" className="px-1.5">
              <Pin className="fill-current" aria-hidden="true" />
              {tr("置顶", "Pinned")}
            </Badge>
          )}
          {a.tag_color && a.tag_name_zh && <TagChip name={a.tag_name_zh} color={a.tag_color} />}
          <span className="truncate text-body font-semibold hover:text-primary">{a.title_zh}</span>
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote text-muted-foreground">
          <span className="flex gap-1">
            <LangChip on>{tr("中", "ZH")}</LangChip>
            <LangChip on={!!(a.title_en && a.body_en)}>EN</LangChip>
          </span>
          <span className="inline-flex items-center gap-1">
            <Users className="size-3.5 text-faint" aria-hidden="true" />
            {audienceName(a.audience, tr)}
          </span>
          <span className="text-faint">·</span>
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="size-3.5 text-faint" aria-hidden="true" />
            {when}
          </span>
        </span>
      </button>
      {(life === "live" || life === "scheduled") && (
        <span className="hidden lg:block">
          <WindowBar a={a} life={life} axis={axis} />
        </span>
      )}
      <span className="max-sm:hidden">
        <MailStatus a={a} life={life} />
      </span>
      <RowMenu label={tr(`${a.title_zh} 的操作`, `Actions of ${a.title_zh}`)}>
        {() => (
          <>
            <MenuItem icon={Pencil} onClick={edit}>
              {tr("编辑", "Edit")}
            </MenuItem>
            <MenuItem icon={Mail} disabled={mailing(a)} onClick={() => patch({ mail: a.id })}>
              {a.mail_requested_at ? tr("再次邮件通知…", "Mail again…") : tr("邮件通知…", "Mail it…")}
            </MenuItem>
            <MenuItem icon={Copy} onClick={() => patch({ open: "new", copy: a.id })}>
              {tr("复制为新公告", "Copy as new")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onClick={() => void remove(a)}>
              {tr("删除…", "Delete…")}
            </MenuItem>
          </>
        )}
      </RowMenu>
    </div>
  );
}

function useDeleteAnnouncement() {
  const tr = useTr();
  const confirm = useConfirm();
  const toast = useToast();
  return async (a: Announcement): Promise<boolean> => {
    const ok = await confirm({
      title: tr(`删除公告「${a.title_zh}」？`, `Delete "${a.title_zh}"?`),
      description: tr(
        "门户上立即消失，已读记录一并删除，无法恢复。已发出的邮件不受影响。",
        "It disappears from the portal at once with its read marks; this cannot be undone. Mail already sent is not affected.",
      ),
      impacts: [
        { label: tr("状态", "State"), value: lifeName(lifeOf(a), tr) },
        { label: tr("显示对象", "Audience"), value: audienceName(a.audience, tr) },
        {
          label: tr("已邮件通知", "Mailed"),
          value: a.mail_requested_at ? tr(`${a.mail_sent} 人`, `${a.mail_sent} people`) : tr("未发送", "Not mailed"),
        },
      ],
      typeToConfirm: a.title_zh,
      confirmLabel: tr("删除公告", "Delete announcement"),
      action: () => del(`/announcements/${a.id}`),
    });
    if (ok) toast({ tone: "success", title: tr("已删除", "Deleted") });
    return ok;
  };
}

/* ---------- Editor ---------- */

/** Recipient counts per audience for the editor's cards (the list rows carry them; else none). */
function useAudienceCounts(): Partial<Record<Audience, number>> {
  const q = useQuery({ queryKey: ["announcements"], queryFn: () => get<Announcement[]>("/announcements") });
  const out: Partial<Record<Audience, number>> = {};
  for (const a of q.data ?? []) if (a.recipients !== undefined) out[a.audience as Audience] = a.recipients;
  return out;
}

function AnnouncementEditor({
  a,
  from,
  onClose,
}: {
  a: Announcement | null;
  /** "复制为新公告": the new one starts from this one. */
  from: Announcement | null;
  onClose: () => void;
}) {
  const tr = useTr();
  const site = useSite();
  const remove = useDeleteAnnouncement();
  const counts = useAudienceCounts();
  const src = a ?? from;
  const [f, setF] = useState({
    title_zh: src?.title_zh ?? "",
    title_en: src?.title_en ?? "",
    body_zh: src?.body_zh ?? "",
    body_en: src?.body_en ?? "",
    pinned: src?.pinned ?? false,
    from: a ? toLocalInput(a.visible_from) : "",
    until: a ? toLocalInput(a.visible_until) : "",
    audience: (src?.audience ?? "all") as Audience,
    tag_id: src?.tag_id ?? "",
  });
  const tagsQ = useAnnouncementTags();
  const [lang, setLang] = useState("zh");
  const [tried, setTried] = useState(false);
  const [saveDraft, draftBusy] = useAction();
  const [publish, publishBusy] = useAction();
  const fromIso = f.from ? fromLocalInput(f.from) : null;
  const untilIso = f.until ? fromLocalInput(f.until) : null;
  const errs = {
    title_zh: !f.title_zh.trim() ? tr("请填写中文标题", "Enter the Chinese title") : null,
    body_zh: !f.body_zh.trim() ? tr("请填写中文正文", "Enter the Chinese body") : null,
    en:
      !!f.title_en.trim() !== !!f.body_en.trim()
        ? tr("英文标题和正文要么都填，要么都不填", "Fill in both the English title and body, or neither")
        : null,
    from: f.from && !fromIso ? tr("时间格式不对", "Not a valid time") : null,
    until:
      f.until && !untilIso
        ? tr("时间格式不对", "Not a valid time")
        : fromIso && untilIso && untilIso <= fromIso
          ? tr("结束时间要晚于开始时间", "Must be after the start")
          : null,
  };
  // Pickable: the enabled tags, plus the one this announcement already has (even if disabled).
  const offered = (tagsQ.data ?? []).filter((t) => t.enabled || t.id === a?.tag_id);
  const tag: AnnouncementTag | undefined = offered.find((t) => t.id === f.tag_id);
  const bad = Object.values(errs).filter(Boolean).length;
  const err = (k: keyof typeof errs) => (tried && errs[k]) || undefined;
  const wasLive = !!a && a.enabled;
  const submit = async (enabled: boolean) => {
    setTried(true);
    if (bad) {
      if (errs.title_zh || errs.body_zh) setLang("zh");
      else if (errs.en) setLang("en");
      return;
    }
    const body = {
      title_zh: f.title_zh.trim(),
      title_en: f.title_en.trim() || null,
      body_zh: f.body_zh,
      body_en: f.body_en.trim() ? f.body_en : null,
      pinned: f.pinned,
      enabled,
      visible_from: fromIso,
      visible_until: untilIso,
      audience: f.audience,
      tag_id: tag?.id ?? null,
    };
    const run = enabled ? publish : saveDraft;
    const r = await run(() => (a ? put(`/announcements/${a.id}`, body) : post("/announcements", body)), {
      ok: enabled
        ? wasLive
          ? tr("公告已保存", "Announcement saved")
          : tr("已发布", "Published")
        : tr("已存为草稿", "Saved as a draft"),
    });
    if (r !== undefined) onClose();
  };
  const zh = lang === "zh";
  const cur = zh ? { title: f.title_zh, body: f.body_zh } : { title: f.title_en, body: f.body_en };
  const count = (x: Audience) =>
    counts[x] !== undefined ? tr(`${counts[x]} 人可收邮件`, `${counts[x]} mail recipients`) : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      icon={Megaphone}
      title={a ? tr("编辑公告", "Edit announcement") : tr("新建公告", "New announcement")}
      description={tr(
        `门户首页顶部显示；时间按站点时区（${site.timezone}）。`,
        `Shown at the top of the portal home; times in the site time zone (${site.timezone}).`,
      )}
      footer={
        <>
          {a && (
            <Button
              variant="ghost"
              icon={Trash2}
              className="mr-auto text-destructive"
              onClick={async () => {
                if (await remove(a)) onClose();
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
            {!wasLive && (
              <Button loading={draftBusy} disabled={publishBusy || tagsQ.isPending} onClick={() => void submit(false)}>
                {tr("存为草稿", "Save as draft")}
              </Button>
            )}
            {wasLive && (
              <Button loading={draftBusy} disabled={publishBusy || tagsQ.isPending} onClick={() => void submit(false)}>
                {tr("撤回为草稿", "Back to draft")}
              </Button>
            )}
            <Button
              variant="primary"
              icon={Send}
              loading={publishBusy}
              disabled={draftBusy || tagsQ.isPending}
              onClick={() => void submit(true)}
            >
              {wasLive ? tr("保存", "Save") : tr("发布", "Publish")}
            </Button>
          </div>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="grid min-w-0 content-start gap-4">
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
            label={zh ? tr("标题（中文）", "Title (Chinese)") : tr("标题（英文）", "Title (English)")}
            required={zh}
            error={zh ? err("title_zh") : err("en")}
          >
            <Input
              value={cur.title}
              maxLength={200}
              data-autofocus
              placeholder={
                zh
                  ? tr("一句话说清楚，例如：10 月 25 日凌晨维护", "One line, e.g. Maintenance on Oct 25")
                  : "Maintenance on Oct 25"
              }
              onChange={(e) => setF(zh ? { ...f, title_zh: e.target.value } : { ...f, title_en: e.target.value })}
            />
          </Field>
          <Field
            label={tr("标签", "Tag")}
            group
            hint={tr(
              "公告标题前的彩色小标签，可以不选。标签在「公告标签」里管理。",
              "A small coloured label before the title; optional. Manage tags in Announcement tags.",
            )}
          >
            <div role="radiogroup" aria-label={tr("标签", "Tag")} className="flex flex-wrap gap-2">
              <TagChoice on={!tag} onClick={() => setF({ ...f, tag_id: "" })}>
                <span className="text-footnote font-medium text-muted-foreground">{tr("无标签", "No tag")}</span>
              </TagChoice>
              {offered.map((t) => (
                <TagChoice key={t.id} on={tag?.id === t.id} onClick={() => setF({ ...f, tag_id: t.id })}>
                  <TagChip name={t.name_zh} color={t.color} />
                  {!t.enabled && <span className="text-footnote text-faint">{tr("已停用", "disabled")}</span>}
                </TagChoice>
              ))}
            </div>
            <div
              data-testid="title-preview"
              className="mt-2 flex min-w-0 items-center gap-2 rounded-lg bg-window px-3 py-2 ring-1 ring-border ring-inset"
            >
              <span className="shrink-0 text-footnote text-muted-foreground">{tr("标题预览", "Title preview")}</span>
              {tag && <TagChip name={zh || !tag.name_en ? tag.name_zh : tag.name_en} color={tag.color} />}
              <span className="truncate text-body font-semibold">
                {cur.title.trim() || (
                  <span className="font-normal text-faint">{tr("（还没有标题）", "(no title yet)")}</span>
                )}
              </span>
            </div>
          </Field>
          <Field
            label={zh ? tr("正文（Markdown）", "Body (Markdown)") : tr("正文（英文）", "Body (English)")}
            required={zh}
            error={zh ? err("body_zh") : undefined}
            hint={tr("支持 Markdown：## 小标题、**粗体**、链接", "Markdown: ## headings, **bold**, links")}
          >
            <Textarea
              value={cur.body}
              onChange={(e) => setF(zh ? { ...f, body_zh: e.target.value } : { ...f, body_en: e.target.value })}
              className="min-h-40 font-mono text-footnote"
            />
          </Field>
          <Field label={tr("显示给", "Show to")}>
            <RadioCards<Audience>
              label={tr("显示给", "Show to")}
              value={f.audience}
              onChange={(v) => setF({ ...f, audience: v })}
              items={(["all", "with_plan", "without_plan"] as Audience[]).map((x) => ({
                value: x,
                title: audienceName(x, tr),
                desc: count(x),
              }))}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={tr("开始显示", "Show from")}
              hint={tr(`站点时区 ${site.timezone} · 留空 = 立即`, `Site time zone ${site.timezone} · empty = now`)}
              error={err("from")}
            >
              <Input
                type="datetime-local"
                className="tnum"
                value={f.from}
                onChange={(e) => setF({ ...f, from: e.target.value })}
              />
            </Field>
            <Field
              label={tr("结束显示", "Show until")}
              hint={tr("留空 = 一直显示", "Empty = no end")}
              error={err("until")}
            >
              <Input
                type="datetime-local"
                className="tnum"
                value={f.until}
                onChange={(e) => setF({ ...f, until: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex items-center gap-3 rounded-lg bg-window px-3 py-2.5 ring-1 ring-border ring-inset">
            <Pin className="size-4 shrink-0 text-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="block text-body font-medium">{tr("置顶", "Pinned")}</span>
              <span className="block text-footnote text-muted-foreground">
                {tr("同时进行的公告里排在最前。", "First among the announcements showing at the same time.")}
              </span>
            </span>
            <Switch checked={f.pinned} onChange={(v) => setF({ ...f, pinned: v })} label={tr("置顶", "Pinned")} />
          </div>
        </div>
        <div className="min-w-0 lg:sticky lg:top-0 lg:self-start">
          <MarkdownPreview
            className="min-h-[320px] lg:h-[calc(min(86vh,880px)-170px)]"
            title={cur.title}
            tag={tag && <TagChip name={zh || !tag.name_en ? tag.name_zh : tag.name_en} color={tag.color} />}
            markdown={cur.body}
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

/** One option of the tag picker (a radio): the tag as users see it, ringed when chosen. */
function TagChoice({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-card px-2.5 shadow-[0_0_0_0.5px_var(--input)] transition-shadow",
        on && "shadow-[0_0_0_1.5px_var(--primary),0_0_0_4px_var(--ring)]",
      )}
    >
      {children}
    </button>
  );
}

/* ---------- Mailing ---------- */

function MailDialog({ a, onClose }: { a: Announcement; onClose: () => void }) {
  const tr = useTr();
  const [ack, setAck] = useState(false);
  const [send, busy] = useAction();
  const running = mailing(a);
  const dup = !!a.mail_requested_at && !running;
  const total = a.recipients;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      icon={Mail}
      title={
        running ? tr("正在发送邮件通知", "Mailing in progress") : tr("用邮件通知这条公告？", "Mail this announcement?")
      }
      description={tr(`「${a.title_zh}」`, `"${a.title_zh}"`)}
      footer={
        running ? (
          <>
            <span className="mr-auto text-footnote text-muted-foreground">
              {tr("可以关闭此窗口，发送在后台继续。", "You can close this; sending continues in the background.")}
            </span>
            <Button onClick={onClose}>{tr("关闭", "Close")}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {tr("取消", "Cancel")}
            </Button>
            <Button
              variant="primary"
              icon={Send}
              loading={busy}
              disabled={dup && !ack}
              onClick={async () => {
                const r = await send(() => post(`/announcements/${a.id}/mail`), {
                  ok: tr("已加入发送队列", "Queued"),
                });
                if (r !== undefined) onClose();
              }}
            >
              {total !== undefined ? tr(`发送 ${total} 封`, `Send ${total}`) : tr("发送", "Send")}
            </Button>
          </>
        )
      }
    >
      {running ? (
        <div className="grid gap-3" role="status">
          <div className="flex items-baseline justify-between">
            <span className="tnum text-title2 font-semibold">{a.mail_sent}</span>
            <span className="tnum text-body text-muted-foreground">
              {total !== undefined ? tr(`/ ${total} 封`, `/ ${total}`) : ""}
            </span>
          </div>
          <Meter value={total ? (a.mail_sent / total) * 100 : 0} tone="primary" className="h-2" />
          <span className="flex items-center gap-1 text-footnote text-muted-foreground">
            <Spin className="size-3.5" />
            {tr("每 5 秒刷新一次进度", "Progress refreshes every 5 seconds")}
          </span>
          <div className="rounded-lg bg-window p-3 text-footnote text-muted-foreground ring-1 ring-border ring-inset">
            {tr("失败的邮件进入", "Failed mail goes to")}{" "}
            <Link to="/status?tab=mail&mail=dead" className="text-primary hover:underline">
              {tr("系统状态 › 邮件队列", "Status › Mail queue")}
            </Link>
            {tr("，可单独重发。", ", where it can be retried.")}
          </div>
        </div>
      ) : (
        <div className="grid gap-3">
          <dl className="divide-y divide-separator rounded-lg ring-1 ring-border ring-inset">
            <Fact k={tr("收件人", "Recipients")} v={audienceName(a.audience, tr)} />
            <Fact
              k={tr("人数", "Count")}
              v={
                <span className="tnum">
                  {total !== undefined ? tr(`${total} 人`, `${total}`) : tr("未知", "Unknown")}
                </span>
              }
            />
            <Fact k={tr("未验证邮箱 / 已封禁的用户", "Unverified / banned users")} v={tr("不发送", "Skipped")} />
            <Fact k={tr("语言", "Language")} v={tr("按收件人的语言", "Each recipient's language")} />
          </dl>
          {dup ? (
            <div className="rounded-lg bg-warning-soft p-3">
              <div className="flex items-center gap-1.5 text-body font-semibold text-warning">
                <TriangleAlert className="size-4" aria-hidden="true" />
                {tr("已经发过一次", "Already mailed once")}
              </div>
              <p className="mt-1 text-footnote text-foreground/80">
                {tr(
                  `${dateTime(a.mail_requested_at)} 已发给 ${a.mail_sent} 人。再发一次，他们会收到重复的邮件。`,
                  `Sent to ${a.mail_sent} people on ${dateTime(a.mail_requested_at)}. Sending again mails them twice.`,
                )}
              </p>
              <label className="mt-2 flex min-h-8 items-center gap-2 text-footnote font-medium pointer-coarse:min-h-11">
                <Checkbox checked={ack} onChange={setAck} label={tr("我确认要重复发送", "I want to send it again")} />
                {tr("我确认要重复发送", "I want to send it again")}
              </label>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-footnote text-muted-foreground">
              <CircleCheck className="size-3.5 text-success" aria-hidden="true" />
              {tr("这条公告还没有发过邮件。", "This announcement has not been mailed yet.")}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
