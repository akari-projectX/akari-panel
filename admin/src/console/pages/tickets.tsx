// 工单 (TKT-*; v2 proposal §6 工单): an inbox, not a table + dialog.
// Desktop (≥1024px): the queue on the left, the conversation of
// `/tickets/<id>` in the middle and, from 1280px, the context column
// (user, recent orders, assignee, close / reopen) on the right (below
// 1280px it opens from the header's ⓘ). Phone: the queue full screen →
// the conversation full screen with a back arrow, the reply box above the
// tab bar. Views (待我回复 / 未分配 / 全部未关闭 / 已关闭) with counts,
// search, a filter popover (status, category, priority, assignee, unread)
// with removable chips — all in the URL (`?view&status&category&priority&
// assignee&unread&q&page`; the dashboard's `?status=open` still works).
// Waiting tickets first, longest wait first (`sort=waiting`); J / K move
// through the queue.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Inbox, LifeBuoy, ListFilter, MailCheck } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { get, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { ago } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Checkbox, Kbd, Select } from "../../shared/ui/form";
import { Popover } from "../../shared/ui/menu";
import { EmptyState, ErrorState, Skeleton } from "../../shared/ui/states";
import { FilterChip } from "../../shared/ui/table";
import { Avatar, SearchField } from "../components/kit";
import { useDebounced } from "../kit";
import { navigate, useQS, useRoute } from "../router";
import { TicketThread } from "./ticket-thread";

export type Ticket = {
  id: string;
  user_id: string;
  user_email: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  messages: number;
  order_id: string | null;
  order_no: string | null;
  node_id: string | null;
  node_name: string | null;
  assignee_id: string | null;
  assignee_email: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  unread: boolean;
  /** Waiting for staff since (status open only). */
  waiting_since: string | null;
  last_preview: string | null;
  last_staff: boolean | null;
};
export type Admin = { id: string; email: string };
type ListView = {
  tickets: Ticket[];
  total: number;
  per_page: number;
  open: number;
  unread: number;
  views: Record<"mine" | "unassigned" | "active" | "closed", number>;
  oldest: { id: string; subject: string; user_email: string; waiting_since: string } | null;
};

export const CATEGORIES = ["general", "billing", "technical", "account", "other"];
export const PRIORITIES = ["low", "normal", "high", "urgent"];
type View = "mine" | "unassigned" | "open" | "closed";
const VIEWS: View[] = ["mine", "unassigned", "open", "closed"];
/** A wait longer than this is red. */
const LONG_WAIT_MIN = 120;

export function catName(c: string, tr: Tr) {
  return (
    (
      {
        general: tr("一般", "General"),
        billing: tr("账单", "Billing"),
        technical: tr("技术", "Technical"),
        account: tr("账户", "Account"),
        other: tr("其他", "Other"),
      } as Record<string, string>
    )[c] ?? tr("其他", "Other")
  );
}
export function prioName(p: string, tr: Tr): [string, Tone] {
  return (
    (
      {
        low: [tr("低", "Low"), "neutral"],
        normal: [tr("普通", "Normal"), "info"],
        high: [tr("高", "High"), "warning"],
        urgent: [tr("紧急", "Urgent"), "danger"],
      } as Record<string, [string, Tone]>
    )[p] ?? [tr("普通", "Normal"), "info"]
  );
}
function viewName(v: View, tr: Tr) {
  return {
    mine: tr("待我回复", "Waiting on me"),
    unassigned: tr("未分配", "Unassigned"),
    open: tr("全部未关闭", "All open"),
    closed: tr("已关闭", "Closed"),
  }[v];
}

/** Minutes since an instant. */
export function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
}
/** "12 分钟" / "2 小时 5 分" / "3 天 4 小时". */
export function waitText(iso: string, tr: Tr): string {
  const m = minutesSince(iso);
  if (m < 60) return tr(`${m} 分钟`, `${m}m`);
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? tr(`${h} 小时 ${m % 60} 分`, `${h}h ${m % 60}m`) : tr(`${h} 小时`, `${h}h`);
  const d = Math.floor(h / 24);
  return h % 24 ? tr(`${d} 天 ${h % 24} 小时`, `${d}d ${h % 24}h`) : tr(`${d} 天`, `${d}d`);
}

/** A media query as state. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

/** The queue's URL state → the API query. */
function useFilters() {
  const [query, patch] = useQS();
  const rawStatus = query.get("status") ?? "";
  // Old links: ?status=closed = the closed view.
  const view: View =
    (VIEWS as string[]).includes(query.get("view") ?? "") && query.get("view") !== "open"
      ? (query.get("view") as View)
      : rawStatus === "closed"
        ? "closed"
        : "open";
  const status = view === "open" && (rawStatus === "open" || rawStatus === "answered") ? rawStatus : "";
  const f = {
    view,
    status,
    category: CATEGORIES.includes(query.get("category") ?? "") ? (query.get("category") as string) : "",
    priority: PRIORITIES.includes(query.get("priority") ?? "") ? (query.get("priority") as string) : "",
    assignee: view === "mine" || view === "unassigned" ? "" : (query.get("assignee") ?? ""),
    unread: query.get("unread") === "1",
    q: query.get("q") ?? "",
    page: Math.max(1, Math.floor(Number(query.get("page") ?? 1)) || 1),
  };
  const api = {
    status: view === "closed" ? "closed" : view === "mine" ? "open" : f.status || "active",
    assignee: view === "mine" ? "me" : view === "unassigned" ? "none" : f.assignee,
    category: f.category,
    priority: f.priority,
    unread: f.unread ? "true" : "",
    q: f.q.trim(),
    page: f.page,
    sort: "waiting",
  };
  return { f, api, patch };
}

export function TicketsPage() {
  const tr = useTr();
  const { sub } = useRoute();
  const wide = useMediaQuery("(min-width: 1024px)");
  const { f, api, patch } = useFilters();
  const list = useQuery({
    queryKey: ["tickets", api],
    queryFn: () => get<ListView>(`/tickets${qs(api)}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const admins = useQuery({ queryKey: ["admins"], queryFn: () => get<Admin[]>("/admins") });
  const id = sub[0] ?? null;
  const rows = useMemo(() => list.data?.tickets ?? [], [list.data]);

  // J / K: next / previous ticket (outside text fields).
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "j" && e.key !== "k")) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("[role=dialog],[role=alertdialog]")) return;
      if (!rows.length) return;
      const i = rows.findIndex((r) => r.id === id);
      const next = e.key === "j" ? Math.min(rows.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      e.preventDefault();
      navigate(`/tickets/${rows[next].id}${location.search}`);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [rows, id]);

  const queue = <Queue list={list} f={f} patch={patch} admins={admins.data ?? []} selected={id} />;

  if (!wide)
    return id ? (
      <TicketThread key={id} id={id} admins={admins.data ?? []} phone />
    ) : (
      <>
        <div className="mb-3">
          <h1 className="text-title2 font-bold">{tr("工单", "Tickets")}</h1>
          {list.data && (
            <p className="mt-0.5 text-body text-muted-foreground">
              {list.data.oldest
                ? tr(
                    `${list.data.open} 条等待回复，最久已等 ${waitText(list.data.oldest.waiting_since, tr)}`,
                    `${list.data.open} waiting for a reply, the longest for ${waitText(list.data.oldest.waiting_since, tr)}`,
                  )
                : tr("没有等待回复的工单", "Nothing waiting for a reply")}
            </p>
          )}
        </div>
        <div className="-mx-4 overflow-hidden bg-card shadow-card sm:mx-0 sm:rounded-xl">{queue}</div>
      </>
    );

  return (
    <div className="-mx-2 grid h-[calc(100dvh-52px-24px-48px)] min-h-[560px] grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-xl bg-card shadow-card xl:mx-0 2xl:grid-cols-[360px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-r border-separator">{queue}</aside>
      {id ? (
        <TicketThread key={id} id={id} admins={admins.data ?? []} />
      ) : (
        <Placeholder oldest={list.data?.oldest ?? null} empty={!!list.data && list.data.views.active === 0} />
      )}
    </div>
  );
}

type Filters = ReturnType<typeof useFilters>["f"];
type Patch = ReturnType<typeof useFilters>["patch"];

function Queue({
  list,
  f,
  patch,
  admins,
  selected,
}: {
  list: ReturnType<typeof useQuery<ListView>>;
  f: Filters;
  patch: Patch;
  admins: Admin[];
  selected: string | null;
}) {
  const tr = useTr();
  const [search, setSearch] = useState(f.q);
  const dq = useDebounced(search.trim(), 300);
  useEffect(() => {
    if (dq !== f.q.trim()) patch({ q: dq || null, page: null }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dq]);
  // Follow outside changes (清除筛选, Back).
  useEffect(() => {
    setSearch((s) => (s.trim() === f.q.trim() ? s : f.q));
  }, [f.q]);
  const set = (p: Record<string, string | null>) => patch({ ...p, page: null });
  const filters = [f.status, f.category, f.priority, f.assignee, f.unread ? "1" : ""].filter(Boolean).length;
  const clearAll = () => {
    setSearch("");
    patch({ status: null, category: null, priority: null, assignee: null, unread: null, q: null, page: null });
  };
  const data = list.data;
  const rows = data?.tickets ?? [];
  const per = data?.per_page ?? 50;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / per));
  const assigneeName = (a: string) =>
    a === "me"
      ? tr("我", "Me")
      : a === "none"
        ? tr("未分配", "Unassigned")
        : (admins.find((x) => x.id === a)?.email.split("@")[0] ?? tr("某位管理员", "An admin"));
  const viewCount = (v: View) =>
    data
      ? {
          mine: data.views.mine,
          unassigned: data.views.unassigned,
          open: data.views.active,
          closed: data.views.closed,
        }[v]
      : null;
  return (
    <>
      <div className="shrink-0 border-b border-separator px-3 pt-3 pb-2.5">
        <div className="mb-2.5 flex items-center gap-2 px-1 max-lg:hidden">
          <LifeBuoy className="size-[18px] text-primary" aria-hidden="true" />
          <h1 className="text-title3 font-semibold">{tr("工单", "Tickets")}</h1>
          <span className="ml-auto flex items-center gap-1 text-caption text-faint">
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> {tr("上下条", "next / previous")}
          </span>
        </div>
        <div
          className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]"
          role="tablist"
          aria-label={tr("视图", "Views")}
        >
          {VIEWS.map((v) => {
            const on = f.view === v;
            const n = viewCount(v);
            return (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => patch({ view: v === "open" ? null : v, status: null, assignee: null, page: null })}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-footnote font-medium transition-colors pointer-coarse:h-9",
                  on ? "bg-foreground text-background" : "bg-secondary text-muted-foreground hover:text-foreground",
                )}
              >
                {viewName(v, tr)}
                {n !== null && (
                  <span
                    className={cn(
                      "tnum",
                      on ? "opacity-70" : "text-faint",
                      v === "mine" && n > 0 && !on && "font-semibold text-primary",
                    )}
                  >
                    {n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <SearchField
            value={search}
            onChange={setSearch}
            label={tr("搜索工单", "Search tickets")}
            placeholder={tr("主题或邮箱", "Subject or email")}
            className="flex-1"
          />
          <Popover
            label={tr("筛选", "Filters")}
            className="grid w-64 gap-3 p-3"
            trigger={
              <button
                type="button"
                aria-label={tr("筛选", "Filters")}
                className={cn(
                  "hit-44 relative inline-flex size-8 shrink-0 items-center justify-center rounded-md shadow-[0_0_0_0.5px_var(--input)] hover:bg-accent pointer-coarse:size-10",
                  filters > 0 && "bg-primary-soft text-primary shadow-none",
                )}
              >
                <ListFilter className="size-4" aria-hidden="true" />
                {filters > 0 && (
                  <span className="tnum absolute -top-1 -right-1 inline-flex size-4 items-center justify-center rounded-full bg-primary text-micro font-semibold text-primary-foreground">
                    {filters}
                  </span>
                )}
              </button>
            }
          >
            {f.view === "open" && (
              <label className="grid gap-1 text-footnote font-medium text-muted-foreground">
                {tr("状态", "Status")}
                <Select value={f.status} onChange={(e) => set({ status: e.target.value || null })}>
                  <option value="">{tr("全部未关闭", "All open")}</option>
                  <option value="open">{tr("等待回复", "Waiting for a reply")}</option>
                  <option value="answered">{tr("已回复，等用户", "Answered, waiting for the user")}</option>
                </Select>
              </label>
            )}
            <label className="grid gap-1 text-footnote font-medium text-muted-foreground">
              {tr("分类", "Category")}
              <Select value={f.category} onChange={(e) => set({ category: e.target.value || null })}>
                <option value="">{tr("全部分类", "Any category")}</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {catName(c, tr)}
                  </option>
                ))}
              </Select>
            </label>
            <label className="grid gap-1 text-footnote font-medium text-muted-foreground">
              {tr("优先级", "Priority")}
              <Select value={f.priority} onChange={(e) => set({ priority: e.target.value || null })}>
                <option value="">{tr("全部优先级", "Any priority")}</option>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {prioName(p, tr)[0]}
                  </option>
                ))}
              </Select>
            </label>
            {(f.view === "open" || f.view === "closed") && (
              <label className="grid gap-1 text-footnote font-medium text-muted-foreground">
                {tr("负责人", "Assignee")}
                <Select value={f.assignee} onChange={(e) => set({ assignee: e.target.value || null })}>
                  <option value="">{tr("所有人", "Anyone")}</option>
                  <option value="me">{tr("我", "Me")}</option>
                  <option value="none">{tr("未分配", "Unassigned")}</option>
                  {admins.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.email}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <label className="flex min-h-8 items-center gap-2 text-body pointer-coarse:min-h-11">
              <Checkbox
                checked={f.unread}
                onChange={(v) => set({ unread: v ? "1" : null })}
                label={tr("只看未读", "Unread only")}
              />
              {tr("只看未读", "Unread only")}
            </label>
          </Popover>
        </div>
        {filters > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {f.status && (
              <FilterChip
                label={tr("状态", "Status")}
                value={f.status === "open" ? tr("等待回复", "Waiting") : tr("已回复", "Answered")}
                onClear={() => set({ status: null })}
              />
            )}
            {f.category && (
              <FilterChip
                label={tr("分类", "Category")}
                value={catName(f.category, tr)}
                onClear={() => set({ category: null })}
              />
            )}
            {f.priority && (
              <FilterChip
                label={tr("优先级", "Priority")}
                value={prioName(f.priority, tr)[0]}
                onClear={() => set({ priority: null })}
              />
            )}
            {f.assignee && (
              <FilterChip
                label={tr("负责人", "Assignee")}
                value={assigneeName(f.assignee)}
                onClear={() => set({ assignee: null })}
              />
            )}
            {f.unread && <FilterChip label={tr("只看未读", "Unread only")} onClear={() => set({ unread: null })} />}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" aria-busy={list.isFetching || undefined}>
        {list.isPending ? (
          <QueueSkeleton />
        ) : list.isError && !data ? (
          <ErrorState
            compact
            title={tr("工单列表加载失败", "The ticket list did not load")}
            error={list.error}
            onRetry={() => void list.refetch()}
          />
        ) : rows.length === 0 ? (
          filters || f.q ? (
            <EmptyState
              icon={Inbox}
              title={tr("没有符合条件的工单", "No matching tickets")}
              action={
                <Button variant="link" onClick={clearAll}>
                  {tr("清除筛选", "Clear filters")}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={MailCheck}
              title={
                f.view === "closed"
                  ? tr("还没有已关闭的工单", "No closed tickets yet")
                  : tr("收件箱已清空", "Inbox zero")
              }
              description={
                f.view === "mine"
                  ? tr(
                      "没有等你回复的工单。新工单进来时侧栏会显示数字。",
                      "Nothing is waiting on you. New tickets show a count in the sidebar.",
                    )
                  : f.view === "closed"
                    ? undefined
                    : tr(
                        "这个视图里没有工单。用户在门户提交的工单会出现在这里。",
                        "No tickets in this view. Tickets users open in the portal show up here.",
                      )
              }
            />
          )
        ) : (
          <ul className="divide-y divide-separator" aria-label={tr("工单", "Tickets")}>
            {rows.map((t) => (
              <QueueRow key={t.id} t={t} on={t.id === selected} />
            ))}
          </ul>
        )}
        {list.isError && data && (
          <p className="px-4 py-2 text-footnote text-warning" role="status">
            {tr("刷新失败，显示的是上次的数据", "Refresh failed; showing the last data")}
          </p>
        )}
      </div>
      {data && rows.length > 0 && (
        <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-t border-separator px-4 text-footnote text-faint">
          <span className="tnum">
            {tr(`共 ${data.total} 条 · 每页 ${per} 条`, `${data.total} in all · ${per} per page`)}
          </span>
          {pages > 1 && (
            <span className="flex items-center gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                icon={ChevronLeft}
                aria-label={tr("上一页", "Previous page")}
                disabled={f.page <= 1}
                onClick={() => patch({ page: f.page - 1 > 1 ? String(f.page - 1) : null })}
              />
              <span className="tnum">
                {f.page} / {pages}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                icon={ChevronRight}
                aria-label={tr("下一页", "Next page")}
                disabled={f.page >= pages}
                onClick={() => patch({ page: String(f.page + 1) })}
              />
            </span>
          )}
        </div>
      )}
    </>
  );
}

function QueueRow({ t, on }: { t: Ticket; on: boolean }) {
  const tr = useTr();
  const lang = useLang();
  const waiting = t.status === "open" && t.waiting_since;
  const long = waiting && minutesSince(t.waiting_since!) >= LONG_WAIT_MIN;
  const [prio, prioTone] = prioName(t.priority, tr);
  return (
    <li>
      <Link
        to={`/tickets/${t.id}${location.search}`}
        aria-current={on || undefined}
        className={cn(
          "relative grid w-full gap-0.5 py-2.5 pr-3.5 pl-7 text-left transition-colors",
          on ? "bg-primary-soft" : "hover:bg-accent",
        )}
      >
        {on && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-primary" aria-hidden="true" />}
        {t.unread && (
          <span
            className="absolute top-[15px] left-3 size-2 rounded-full bg-primary"
            role="img"
            aria-label={tr("未读", "Unread")}
          />
        )}
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-footnote",
              t.unread ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {t.user_email}
          </span>
          {waiting ? (
            <span
              className={cn("tnum shrink-0 text-footnote", long ? "font-semibold text-destructive" : "text-warning")}
            >
              {tr(`等 ${waitText(t.waiting_since!, tr)}`, `waiting ${waitText(t.waiting_since!, tr)}`)}
            </span>
          ) : (
            <span className="tnum shrink-0 text-footnote text-faint">{ago(t.updated_at, lang)}</span>
          )}
        </span>
        <span className={cn("truncate text-body", t.unread ? "font-semibold" : "font-medium")}>{t.subject}</span>
        {t.last_preview && (
          <span className="truncate text-footnote text-faint">
            {t.last_staff ? tr("客服：", "Staff: ") : ""}
            {t.last_preview}
          </span>
        )}
        <span className="mt-1 flex min-w-0 items-center gap-1.5">
          <Badge tone="outline" className="px-1.5 py-0 text-caption">
            {catName(t.category, tr)}
          </Badge>
          {(t.priority === "high" || t.priority === "urgent") && (
            <Badge tone={prioTone} className="px-1.5 py-0 text-caption">
              {prio}
            </Badge>
          )}
          {t.status === "answered" && (
            <span className="truncate text-caption text-faint">
              {tr("已回复，等用户", "Answered, waiting for the user")}
            </span>
          )}
          {t.status === "closed" && <span className="text-caption text-faint">{tr("已关闭", "Closed")}</span>}
          <span className="ml-auto flex shrink-0 items-center">
            {t.assignee_email ? (
              <span title={t.assignee_email} className="inline-flex">
                <Avatar name={t.assignee_email} size={18} />
                <span className="sr-only">{tr(`负责人 ${t.assignee_email}`, `Assignee ${t.assignee_email}`)}</span>
              </span>
            ) : (
              <span className="text-caption text-faint">{tr("未分配", "Unassigned")}</span>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

function QueueSkeleton() {
  return (
    <div className="divide-y divide-separator" aria-hidden="true">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="grid gap-2 py-3 pr-4 pl-7">
          <div className="flex justify-between">
            <Skeleton className="h-2.5 w-36" />
            <Skeleton className="h-2.5 w-12" />
          </div>
          <Skeleton className="h-3" style={{ width: `${55 + ((i * 13) % 35)}%` }} />
          <Skeleton className="h-2.5 w-4/5" />
        </div>
      ))}
    </div>
  );
}

function Placeholder({ oldest, empty }: { oldest: ListView["oldest"]; empty: boolean }) {
  const tr = useTr();
  return (
    <div className="flex flex-col items-center justify-center bg-window/50 p-8 text-center">
      {empty ? (
        <EmptyState
          icon={MailCheck}
          title={tr("收件箱已清空", "Inbox zero")}
          description={tr("所有工单都已处理。", "Every ticket has been handled.")}
          action={
            <Link to="/" className="text-body font-medium text-primary hover:underline">
              {tr("回到仪表盘", "Back to the dashboard")}
            </Link>
          }
        />
      ) : (
        <>
          <EmptyState
            icon={LifeBuoy}
            title={tr("选择一条工单", "Pick a ticket")}
            description={
              <>
                {tr(
                  "左侧按等待时间排序，等得最久的在最上面。",
                  "The queue is sorted by waiting time, the longest first.",
                )}
                <br />
                {tr("用", "Use")} <Kbd>J</Kbd> <Kbd>K</Kbd> {tr("上下切换。", "to move up and down.")}
              </>
            }
          />
          {oldest && (
            <Link
              to={`/tickets/${oldest.id}${location.search}`}
              className="-mt-4 flex max-w-sm items-center gap-3 rounded-xl bg-card px-4 py-3 text-left shadow-card hover:bg-accent"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-footnote font-medium text-destructive">
                  {tr(
                    `等得最久 · ${waitText(oldest.waiting_since, tr)}`,
                    `Waiting longest · ${waitText(oldest.waiting_since, tr)}`,
                  )}
                </span>
                <span className="block truncate text-body font-semibold">{oldest.subject}</span>
                <span className="block truncate text-footnote text-muted-foreground">{oldest.user_email}</span>
              </span>
              <span className="text-footnote font-medium text-primary">{tr("打开", "Open")}</span>
            </Link>
          )}
        </>
      )}
    </div>
  );
}
