// 工单 (TKT-*): the queue with filters and counters, the conversation
// drawer (reply, reply and close, close / reopen, assignee).
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { get, post, put, qs } from "../../shared/api";
import { dateTime } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Drawer } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  KV,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  type Tone,
} from "../../shared/ui/primitives";
import { DataTable, Pager, type Column } from "../../shared/ui/table";
import { FormError, useDebounced, useRun } from "../kit";
import { navigate, setQuery, useRoute } from "../router";
import { useMe } from "../session";

type Ticket = {
  id: string;
  user_id: string;
  user_email: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  messages: number;
  order_no: string | null;
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

const CATEGORIES = ["general", "billing", "technical", "account", "other"];
const PRIORITIES = ["low", "normal", "high", "urgent"];

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
    page: Number(query.get("page") ?? 1) || 1,
  };
  const [search, setSearch] = useState(query.get("q") ?? "");
  const dq = useDebounced(search, 300);
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
  const admins = useQuery({ queryKey: ["admins"], queryFn: () => get<{ id: string; email: string }[]>("/admins") });
  const open = sub[0];
  const columns: Column<Ticket>[] = [
    {
      key: "subject",
      header: tr("标题", "Subject"),
      fixed: true,
      mobile: "title",
      cell: (t) => (
        <span className="flex items-center gap-1.5">
          {t.unread && <span className="h-2 w-2 rounded-full bg-primary" aria-label={tr("未读", "unread")} />}
          <span className={t.unread ? "font-semibold" : ""}>{t.subject}</span>
        </span>
      ),
    },
    { key: "user", header: tr("用户", "User"), cell: (t) => t.user_email },
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
          list.data &&
          tr(
            `待回复 ${list.data.open} · 未读 ${list.data.unread}`,
            `${list.data.open} awaiting reply · ${list.data.unread} unread`,
          )
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
        toolbar={
          <>
            <Select
              aria-label={tr("状态", "Status")}
              className="w-32 [&_select]:h-8"
              value={f.status}
              onChange={(e) => set({ status: e.target.value })}
            >
              <option value="active">{tr("未关闭", "Not closed")}</option>
              <option value="open">{tr("待回复", "Awaiting reply")}</option>
              <option value="answered">{tr("已回复", "Answered")}</option>
              <option value="closed">{tr("已关闭", "Closed")}</option>
            </Select>
            <Select
              aria-label={tr("分类", "Category")}
              className="w-28 [&_select]:h-8"
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
              className="w-28 [&_select]:h-8"
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
              className="w-36 [&_select]:h-8"
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
            <label className="flex items-center gap-1.5 text-[13px]">
              <Checkbox
                checked={f.unread}
                onChange={(v) => set({ unread: v ? "1" : null })}
                label={tr("只看未读", "Unread only")}
              />
              {tr("只看未读", "Unread only")}
            </label>
            <Input
              type="search"
              aria-label={tr("搜索工单", "Search tickets")}
              placeholder={tr("搜索标题或邮箱…", "Search subject or email…")}
              className="h-8 w-full sm:w-52"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </>
        }
        footer={
          <Pager
            total={list.data?.total ?? 0}
            offset={(f.page - 1) * 50}
            limit={50}
            onOffset={(o) => setQuery({ page: o ? String(o / 50 + 1) : null })}
          />
        }
      />
      {open && (
        <TicketDrawer id={open} admins={admins.data ?? []} onClose={() => navigate(`/tickets${location.search}`)} />
      )}
    </>
  );
}

function TicketDrawer({
  id,
  admins,
  onClose,
}: {
  id: string;
  admins: { id: string; email: string }[];
  onClose: () => void;
}) {
  const tr = useTr();
  const me = useMe();
  const q = useQuery({
    queryKey: ["tickets", "detail", id],
    queryFn: () => get<Ticket & { user_enabled: boolean; thread: Message[] }>(`/tickets/${id}`),
  });
  const [body, setBody] = useState("");
  const [run, busy] = useRun();
  const t = q.data;
  const reply = async (close: boolean) => {
    const r = await run(() => post(`/tickets/${id}/replies`, { message: body.trim(), close }), {
      ok: close ? tr("已回复并关闭", "Replied and closed") : tr("已回复", "Replied"),
      invalidate: [["tickets"], ["admin-badges"]],
    });
    if (r !== undefined) {
      setBody("");
      void q.refetch();
    }
  };
  const act = (path: string, ok: string) =>
    run(() => post(`/tickets/${id}/${path}`), { ok, invalidate: [["tickets"], ["admin-badges"]] }).then(() =>
      q.refetch(),
    );
  return (
    <Drawer
      open
      onClose={onClose}
      width="sm:max-w-2xl"
      title={t?.subject ?? tr("工单", "Ticket")}
      subtitle={
        t && (
          <span className="flex flex-wrap gap-1.5">
            <Badge tone={statusName(t.status, tr)[1]}>{statusName(t.status, tr)[0]}</Badge>
            <Badge>{catName(t.category, tr)}</Badge>
            <Badge tone={prioName(t.priority, tr)[1]}>{prioName(t.priority, tr)[0]}</Badge>
          </span>
        )
      }
      footer={
        t &&
        (t.status === "closed" ? (
          <Button onClick={() => void act("reopen", tr("已重新打开", "Reopened"))}>{tr("重新打开", "Reopen")}</Button>
        ) : (
          <Button variant="ghost" onClick={() => void act("close", tr("已关闭", "Closed"))}>
            {tr("关闭工单", "Close ticket")}
          </Button>
        ))
      }
    >
      {q.isPending && <Skeleton className="h-64" />}
      <FormError error={q.error} />
      {t && (
        <>
          <KV
            items={[
              [
                tr("用户", "User"),
                <button
                  key="u"
                  type="button"
                  className="text-primary hover:underline"
                  onClick={() => navigate(`/users?open=${t.user_id}`)}
                >
                  {t.user_email}
                  {t.user_enabled ? "" : tr("（已停用/封禁）", " (disabled/banned)")}
                </button>,
              ],
              [tr("关联订单", "Order"), t.order_no ?? "—"],
              [tr("关联节点", "Node"), t.node_name ?? "—"],
              [tr("创建", "Created"), dateTime(t.created_at)],
            ]}
          />
          <Field label={tr("负责人", "Assignee")} className="mt-3">
            <Select
              value={t.assignee_id ?? ""}
              onChange={(e) =>
                void run(() => put(`/tickets/${id}/assignee`, { assignee_id: e.target.value || null }), {
                  ok: tr("已分配", "Assigned"),
                  invalidate: [["tickets"]],
                }).then(() => q.refetch())
              }
            >
              <option value="">{tr("未分配", "Unassigned")}</option>
              {admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                  {a.id === me.id ? tr("（我）", " (me)") : ""}
                </option>
              ))}
            </Select>
          </Field>
          <ol className="mt-4 space-y-3">
            {t.thread.map((m) => (
              <li
                key={m.id}
                className={`rounded-lg border px-3 py-2 text-[13px] ${m.staff ? "ml-6 border-primary/30 bg-primary-soft/40" : "mr-6 border-border"}`}
              >
                <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                  <span>
                    {m.staff ? `${tr("客服", "Staff")} · ${m.author_email ?? m.author_label ?? ""}` : t.user_email}
                  </span>
                  <span>{dateTime(m.created_at)}</span>
                </div>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </li>
            ))}
          </ol>
          {t.status !== "closed" && (
            <div className="mt-4 space-y-2">
              <Field label={tr("回复", "Reply")}>
                <Textarea
                  rows={4}
                  className="font-sans"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={5000}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" loading={busy} disabled={!body.trim()} onClick={() => void reply(false)}>
                  {tr("回复", "Reply")}
                </Button>
                <Button loading={busy} disabled={!body.trim()} onClick={() => void reply(true)}>
                  {tr("回复并关闭", "Reply and close")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Drawer>
  );
}
