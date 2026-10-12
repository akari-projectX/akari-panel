// 工单 (TKT-*; audit §5.8): the queue with filters in the URL and counters;
// the conversation dialog polls for new replies and scrolls to the newest,
// the reply box sits in the footer (Ctrl/⌘+Enter sends) next to reply /
// reply and close / close (each with its own busy state); the assignee is
// changed with an explicit "分配" (a focused select never submits).
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Inbox, LifeBuoy, Lock, MessageSquareReply, RotateCcw, Send, UserCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { get, post, put, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button } from "../../shared/ui/button";
import { Dialog } from "../../shared/ui/dialog";
import { Checkbox, Input, Kbd, MOD_KEY, Select, Textarea } from "../../shared/ui/form";
import { KV, PageHeader } from "../../shared/ui/layout";
import { EmptyState, ErrorState, LoadingBlock } from "../../shared/ui/states";
import { DataTable, Pager, type Column } from "../../shared/ui/table";
import { useAction } from "../data";
import { useDebounced } from "../kit";
import { navigate, setQuery, useRoute } from "../router";
import { useCrumb, useMe } from "../session";

type Ticket = {
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
  unread: boolean;
};
type Message = {
  id: number;
  staff: boolean;
  author_label?: string;
  author_email?: string | null;
  body: string;
  created_at: string;
};
type Admin = { id: string; email: string };

const CATEGORIES = ["general", "billing", "technical", "account", "other"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
/** The server's fixed page size (tickets.rs PAGE). */
const PER_PAGE = 50;

function catName(c: string, tr: Tr) {
  return (
    (
      {
        general: tr("一般", "General"),
        billing: tr("账单", "Billing"),
        technical: tr("技术", "Technical"),
        account: tr("账户", "Account"),
        other: tr("其他", "Other"),
      } as Record<string, string>
    )[c] ?? c
  );
}
function prioName(p: string, tr: Tr): [string, Tone] {
  return (
    (
      {
        low: [tr("低", "Low"), "neutral"],
        normal: [tr("普通", "Normal"), "info"],
        high: [tr("高", "High"), "warning"],
        urgent: [tr("紧急", "Urgent"), "danger"],
      } as Record<string, [string, Tone]>
    )[p] ?? [p, "neutral"]
  );
}
function statusName(s: string, tr: Tr): [string, Tone] {
  return (
    (
      {
        open: [tr("待回复", "Awaiting reply"), "warning"],
        answered: [tr("已回复", "Answered"), "success"],
        closed: [tr("已关闭", "Closed"), "neutral"],
      } as Record<string, [string, Tone]>
    )[s] ?? [s, "neutral"]
  );
}

export function TicketsPage() {
  const tr = useTr();
  const { query, sub } = useRoute();
  const f = {
    status: query.get("status") ?? "active",
    category: query.get("category") ?? "",
    priority: query.get("priority") ?? "",
    assignee: query.get("assignee") ?? "",
    unread: query.get("unread") === "1",
    page: Math.max(1, Number(query.get("page") ?? 1) || 1),
  };
  const [search, setSearch] = useState(query.get("q") ?? "");
  const dq = useDebounced(search.trim(), 300);
  useEffect(() => {
    if (dq !== (query.get("q") ?? "")) setQuery({ q: dq || null, page: null });
  }, [dq, query]);
  const list = useQuery({
    queryKey: ["tickets", f, dq],
    queryFn: () =>
      get<{ tickets: Ticket[]; total: number; per_page: number; open: number; unread: number }>(
        `/tickets${qs({ status: f.status, category: f.category, priority: f.priority, assignee: f.assignee, unread: f.unread ? "true" : "", q: dq, page: f.page })}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const admins = useQuery({ queryKey: ["admins"], queryFn: () => get<Admin[]>("/admins") });
  const open = sub[0];
  const perPage = list.data?.per_page ?? PER_PAGE;
  const filtered = f.status !== "active" || !!(f.category || f.priority || f.assignee || f.unread || dq);
  const columns: Column<Ticket>[] = [
    {
      key: "subject",
      header: tr("标题", "Subject"),
      fixed: true,
      mobile: "title",
      cell: (t) => (
        <span className="flex min-w-0 items-center gap-1.5">
          {t.unread && (
            <span className="size-2 shrink-0 rounded-full bg-primary" role="img" aria-label={tr("未读", "unread")} />
          )}
          <span className={cn("break-words", t.unread && "font-semibold")}>{t.subject}</span>
        </span>
      ),
    },
    { key: "user", header: tr("用户", "User"), cell: (t) => <span className="break-all">{t.user_email}</span> },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (t) => {
        const [s, tone] = statusName(t.status, tr);
        return <Badge tone={tone}>{s}</Badge>;
      },
    },
    { key: "category", header: tr("分类", "Category"), cell: (t) => catName(t.category, tr) },
    {
      key: "priority",
      header: tr("优先级", "Priority"),
      cell: (t) => {
        const [p, tone] = prioName(t.priority, tr);
        return <Badge tone={tone}>{p}</Badge>;
      },
    },
    { key: "assignee", header: tr("负责人", "Assignee"), cell: (t) => t.assignee_email ?? "—" },
    { key: "updated", header: tr("更新", "Updated"), cell: (t) => dateTime(t.updated_at) },
  ];
  const set = (p: Record<string, string | null>) => setQuery({ ...p, page: null });
  return (
    <>
      <PageHeader
        title={tr("工单", "Tickets")}
        description={
          list.data
            ? tr(
                `待回复 ${list.data.open} · 未读 ${list.data.unread}`,
                `${list.data.open} awaiting reply · ${list.data.unread} unread`,
              )
            : tr("用户的求助与回复", "Users' requests and replies")
        }
      />
      <DataTable
        label={tr("工单", "Tickets")}
        storageKey="tickets"
        rows={list.data?.tickets ?? []}
        columns={columns}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        activeId={open}
        onRowClick={(t) => navigate(`/tickets/${t.id}${location.search}`)}
        filtered={filtered}
        onClearFilters={() => {
          setSearch("");
          setQuery({ status: null, category: null, priority: null, assignee: null, unread: null, q: null, page: null });
        }}
        empty={
          filtered ? undefined : (
            <EmptyState
              icon={Inbox}
              title={tr("没有未关闭的工单", "No open tickets")}
              description={tr("用户在门户提交的工单会出现在这里。", "Tickets users open in the portal show up here.")}
            />
          )
        }
        toolbar={
          <>
            <Input
              type="search"
              aria-label={tr("搜索工单", "Search tickets")}
              placeholder={tr("搜索标题或邮箱…", "Search subject or email…")}
              className="w-full sm:w-56"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              aria-label={tr("状态", "Status")}
              className="min-w-28 flex-1 sm:flex-none"
              value={f.status}
              onChange={(e) => set({ status: e.target.value === "active" ? null : e.target.value })}
            >
              <option value="active">{tr("未关闭", "Not closed")}</option>
              <option value="open">{tr("待回复", "Awaiting reply")}</option>
              <option value="answered">{tr("已回复", "Answered")}</option>
              <option value="closed">{tr("已关闭", "Closed")}</option>
            </Select>
            <Select
              aria-label={tr("分类", "Category")}
              className="min-w-28 flex-1 sm:flex-none"
              value={f.category}
              onChange={(e) => set({ category: e.target.value || null })}
            >
              <option value="">{tr("全部分类", "Any category")}</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {catName(c, tr)}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("优先级", "Priority")}
              className="min-w-28 flex-1 sm:flex-none"
              value={f.priority}
              onChange={(e) => set({ priority: e.target.value || null })}
            >
              <option value="">{tr("全部优先级", "Any priority")}</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {prioName(p, tr)[0]}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("负责人", "Assignee")}
              className="min-w-32 flex-1 sm:flex-none"
              value={f.assignee}
              onChange={(e) => set({ assignee: e.target.value || null })}
            >
              <option value="">{tr("全部负责人", "Anyone")}</option>
              <option value="me">{tr("我负责的", "Mine")}</option>
              <option value="none">{tr("未分配", "Unassigned")}</option>
              {(admins.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </Select>
            <label className="flex min-h-8 items-center gap-2 px-1 text-body pointer-coarse:min-h-10">
              <Checkbox
                checked={f.unread}
                onChange={(v) => set({ unread: v ? "1" : null })}
                label={tr("只看未读", "Unread only")}
              />
              {tr("只看未读", "Unread only")}
            </label>
          </>
        }
        footer={
          <Pager
            total={list.data?.total ?? 0}
            offset={(f.page - 1) * perPage}
            limit={perPage}
            onOffset={(o) => setQuery({ page: o ? String(o / perPage + 1) : null })}
          />
        }
      />
      {open && (
        <TicketDialog id={open} admins={admins.data ?? []} onClose={() => navigate(`/tickets${location.search}`)} />
      )}
    </>
  );
}

function TicketDialog({ id, admins, onClose }: { id: string; admins: Admin[]; onClose: () => void }) {
  const tr = useTr();
  const me = useMe();
  const q = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => get<Ticket & { user_enabled: boolean; thread: Message[] }>(`/tickets/${id}`),
    refetchInterval: 15_000,
  });
  const t = q.data;
  useCrumb(t?.subject);
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [reply, replyBusy] = useAction();
  const [replyClose, replyCloseBusy] = useAction();
  const [toggle, toggleBusy] = useAction();
  const [assign, assignBusy] = useAction();
  const end = useRef<HTMLDivElement>(null);
  const count = t?.thread.length ?? 0;
  // Newest message in view: on open and whenever a new one arrives.
  useEffect(() => {
    if (count) end.current?.scrollIntoView({ block: "end" });
  }, [count]);
  const text = body.trim();
  const sending = replyBusy || replyCloseBusy;
  const send = async (close: boolean) => {
    if (!text || sending) return;
    const r = await (close ? replyClose : reply)(() => post(`/tickets/${id}/replies`, { message: text, close }), {
      ok: close ? tr("已回复并关闭", "Replied and closed") : tr("已回复", "Replied"),
    });
    if (r !== undefined) setBody("");
  };
  const chosen = assignee ?? t?.assignee_id ?? "";
  const assigneeChanged = !!t && assignee !== null && assignee !== (t.assignee_id ?? "");
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      icon={LifeBuoy}
      title={t?.subject ?? tr("工单", "Ticket")}
      dirty={!!text || assigneeChanged}
      description={
        t && (
          <span className="flex flex-wrap gap-1.5">
            <Badge tone={statusName(t.status, tr)[1]}>{statusName(t.status, tr)[0]}</Badge>
            <Badge>{catName(t.category, tr)}</Badge>
            <Badge tone={prioName(t.priority, tr)[1]}>{prioName(t.priority, tr)[0]}</Badge>
          </span>
        )
      }
      footer={
        t && (
          <div className="grid w-full gap-2">
            {t.status !== "closed" && (
              <Textarea
                aria-label={tr("回复", "Reply")}
                placeholder={tr(`写回复…（${MOD_KEY}+Enter 发送）`, `Write a reply… (${MOD_KEY}+Enter sends)`)}
                rows={3}
                className="max-h-48 min-h-16 resize-y"
                value={body}
                maxLength={5000}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void send(false);
                  }
                }}
              />
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              {t.status === "closed" ? (
                <Button
                  icon={RotateCcw}
                  loading={toggleBusy}
                  className="mr-auto"
                  onClick={() => void toggle(() => post(`/tickets/${id}/reopen`), { ok: tr("已重新打开", "Reopened") })}
                >
                  {tr("重新打开", "Reopen")}
                </Button>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    icon={Lock}
                    loading={toggleBusy}
                    disabled={sending}
                    className="mr-auto"
                    onClick={() => void toggle(() => post(`/tickets/${id}/close`), { ok: tr("已关闭", "Closed") })}
                  >
                    {tr("关闭工单", "Close ticket")}
                  </Button>
                  <span className="hidden text-footnote text-faint sm:inline">
                    <Kbd>{MOD_KEY}</Kbd> <Kbd>Enter</Kbd>
                  </span>
                  <Button
                    icon={MessageSquareReply}
                    loading={replyCloseBusy}
                    disabled={!text || replyBusy}
                    onClick={() => void send(true)}
                  >
                    {tr("回复并关闭", "Reply and close")}
                  </Button>
                  <Button
                    variant="primary"
                    icon={Send}
                    loading={replyBusy}
                    disabled={!text || replyCloseBusy}
                    onClick={() => void send(false)}
                  >
                    {tr("回复", "Reply")}
                  </Button>
                </>
              )}
            </div>
          </div>
        )
      }
    >
      {q.isPending ? (
        <LoadingBlock rows={6} />
      ) : q.isError && !t ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : t ? (
        <div className="grid gap-4">
          <KV
            items={[
              [
                tr("用户", "User"),
                <Link key="u" to={`/users?open=${t.user_id}`} className="break-all text-primary hover:underline">
                  {t.user_email}
                  {t.user_enabled ? "" : tr("（已停用/封禁）", " (disabled/banned)")}
                </Link>,
              ],
              [
                tr("关联订单", "Order"),
                t.order_id ? (
                  <Link key="o" to={`/orders?open=${t.order_id}`} className="font-mono text-primary hover:underline">
                    {t.order_no ?? t.order_id.slice(0, 8)}
                  </Link>
                ) : (
                  "—"
                ),
              ],
              [
                tr("关联节点", "Node"),
                t.node_id ? (
                  <Link key="n" to={`/nodes?open=node:${t.node_id}`} className="text-primary hover:underline">
                    {t.node_name ?? tr("已删除的节点", "Deleted node")}
                  </Link>
                ) : (
                  "—"
                ),
              ],
              [tr("创建", "Created"), dateTime(t.created_at)],
            ]}
          />
          <div className="flex flex-wrap items-end gap-2" data-nodirty>
            <label className="grid min-w-0 flex-1 basis-56 gap-1.5">
              <span className="text-footnote font-medium text-muted-foreground">{tr("负责人", "Assignee")}</span>
              <Select value={chosen} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">{tr("未分配", "Unassigned")}</option>
                {admins.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email}
                    {a.id === me.id ? tr("（我）", " (me)") : ""}
                  </option>
                ))}
              </Select>
            </label>
            <Button
              icon={UserCheck}
              loading={assignBusy}
              disabled={!assigneeChanged}
              onClick={async () => {
                const r = await assign(() => put(`/tickets/${id}/assignee`, { assignee_id: chosen || null }), {
                  ok: tr("已分配", "Assigned"),
                });
                if (r !== undefined) setAssignee(null);
              }}
            >
              {tr("分配", "Assign")}
            </Button>
          </div>
          <ol className="grid gap-3" aria-label={tr("会话", "Conversation")}>
            {t.thread.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "rounded-xl px-3.5 py-2.5 text-body",
                  m.staff ? "ml-6 bg-primary-soft sm:ml-12" : "mr-6 bg-window sm:mr-12",
                )}
              >
                <div className="mb-1 flex flex-wrap justify-between gap-x-3 text-footnote text-muted-foreground">
                  <span className="break-all">
                    {m.staff ? `${tr("客服", "Staff")} · ${m.author_email ?? m.author_label ?? ""}` : t.user_email}
                  </span>
                  <span>{dateTime(m.created_at)}</span>
                </div>
                <p className="break-words whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ol>
          {q.isError && (
            <p className="text-footnote text-warning" role="status">
              {tr("刷新失败，显示的是上次的数据", "Refresh failed; showing the last data")}
            </p>
          )}
          <div ref={end} />
        </div>
      ) : null}
    </Dialog>
  );
}
