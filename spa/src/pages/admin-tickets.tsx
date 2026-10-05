// W17 admin console: 工单管理 (Chinese only, R18). Queue with filters,
// thread view at /{prefix}/admin/tickets/<id> (deep link), reply (and
// close), close / reopen, assign to an admin. Types mirror src/tickets.rs.
import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Textarea } from "../components/ui/textarea";
import {
  adminBase,
  get,
  post,
  put,
  TICKET_MAX_BODY,
  type TicketCategory,
  type TicketMessage,
  type TicketPriority,
  type TicketStatus,
} from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { fmtDateTime } from "../lib/datetime";
import { navigate, usePath } from "../lib/router";

export interface AdminTicketRow {
  id: string;
  user_id: string;
  user_email: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
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
  closed_by: "user" | "staff" | null;
  unread: boolean;
}

export interface AdminTicketList {
  tickets: AdminTicketRow[];
  total: number;
  page: number;
  per_page: number;
  open: number;
  unread: number;
}

export interface AdminTicketView extends AdminTicketRow {
  user_enabled: boolean;
  thread: TicketMessage[];
}

export const CATEGORY_ZH: Record<TicketCategory, string> = {
  general: "一般问题",
  billing: "付款与订单",
  technical: "连接与技术",
  account: "账户",
  other: "其他",
};
export const PRIORITY_ZH: Record<TicketPriority, string> = { low: "低", normal: "普通", high: "高", urgent: "紧急" };
export const STATUS_ZH: Record<TicketStatus, string> = { open: "待回复", answered: "已回复", closed: "已关闭" };

const SELECT = "h-9 rounded-lg border border-border bg-background px-2 text-sm";

function fmt(s: string | null) {
  return fmtDateTime(s);
}

function TicketStatusBadge({ s }: { s: TicketStatus }) {
  return (
    <Badge variant={s === "open" ? "destructive" : s === "answered" ? "success" : "secondary"}>{STATUS_ZH[s]}</Badge>
  );
}

function PriorityBadge({ p }: { p: TicketPriority }) {
  return (
    <Badge variant={p === "urgent" ? "destructive" : p === "high" ? "default" : "outline"}>{PRIORITY_ZH[p]}</Badge>
  );
}

export function AdminTickets() {
  const path = usePath();
  const detailId = path.startsWith(`${adminBase}/tickets/`) ? path.slice(`${adminBase}/tickets/`.length) : null;
  return detailId ? <TicketDetail id={detailId} onBack={() => navigate(`${adminBase}/tickets`)} /> : <TicketQueue />;
}

function TicketQueue() {
  const [status, setStatus] = useState("active");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState("");
  const [assignee, setAssignee] = useState("");
  const [unread, setUnread] = useState(false);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  if (priority) params.set("priority", priority);
  if (assignee) params.set("assignee", assignee);
  if (unread) params.set("unread", "true");
  if (search) params.set("q", search);
  params.set("page", String(page));
  const qs = params.toString();
  const list = useQuery({
    queryKey: ["tickets", qs],
    queryFn: () => get<AdminTicketList>(`/tickets?${qs}`),
    refetchInterval: 15_000,
  });
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.per_page)) : 1;

  function reset<T>(set: (v: T) => void) {
    return (v: T) => {
      set(v);
      setPage(1);
    };
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h1>工单管理</h1>
        </CardTitle>
        <CardDescription>
          {list.data ? `待回复 ${list.data.open} 个，未读 ${list.data.unread} 个。` : "用户提交的工单。"}
          用户只能看到自己的工单；回复以「客服」身份显示。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q.trim());
            setPage(1);
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="tq-status">状态</Label>
            <select id="tq-status" className={SELECT} value={status} onChange={(e) => reset(setStatus)(e.target.value)}>
              <option value="active">未关闭</option>
              <option value="open">待回复</option>
              <option value="answered">已回复</option>
              <option value="closed">已关闭</option>
              <option value="">全部</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tq-category">分类</Label>
            <select
              id="tq-category"
              className={SELECT}
              value={category}
              onChange={(e) => reset(setCategory)(e.target.value)}
            >
              <option value="">全部</option>
              {Object.entries(CATEGORY_ZH).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tq-priority">优先级</Label>
            <select
              id="tq-priority"
              className={SELECT}
              value={priority}
              onChange={(e) => reset(setPriority)(e.target.value)}
            >
              <option value="">全部</option>
              {Object.entries(PRIORITY_ZH).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="tq-assignee">负责人</Label>
            <select
              id="tq-assignee"
              className={SELECT}
              value={assignee}
              onChange={(e) => reset(setAssignee)(e.target.value)}
            >
              <option value="">全部</option>
              <option value="me">我负责的</option>
              <option value="none">未分配</option>
            </select>
          </div>
          <label className="flex h-9 items-center gap-1 text-sm">
            <input type="checkbox" checked={unread} onChange={(e) => reset(setUnread)(e.target.checked)} />
            只看未读
          </label>
          <div className="space-y-1">
            <Label htmlFor="tq-q">搜索</Label>
            <Input
              id="tq-q"
              className="w-48"
              value={q}
              maxLength={64}
              placeholder="标题或用户名"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline">
            搜索
          </Button>
        </form>
        {list.isPending ? (
          <p className="text-sm text-muted-foreground">加载中…</p>
        ) : list.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {adminErrorText(list.error, "工单列表加载失败")}
          </p>
        ) : list.data.tickets.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有符合条件的工单。</p>
        ) : (
          <Table label="工单列表">
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>用户</TableHead>
                <TableHead>分类 / 优先级</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>负责人</TableHead>
                <TableHead>最近更新</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.tickets.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">
                    {r.subject}
                    {r.unread && (
                      <Badge variant="destructive" className="ml-2">
                        未读
                      </Badge>
                    )}
                    <span className="block text-xs text-muted-foreground">{r.messages} 条消息</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.user_email}</TableCell>
                  <TableCell>
                    <span className="mr-1 text-sm">{CATEGORY_ZH[r.category]}</span>
                    <PriorityBadge p={r.priority} />
                  </TableCell>
                  <TableCell>
                    <TicketStatusBadge s={r.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.assignee_email ?? "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{fmt(r.updated_at)}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => navigate(`${adminBase}/tickets/${r.id}`)}>
                      处理
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {list.data && list.data.total > list.data.per_page && (
          <div className="flex items-center gap-2 text-sm">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              上一页
            </Button>
            <span>
              第 {page} / {pages} 页（共 {list.data.total} 个）
            </span>
            <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              下一页
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TicketDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => get<AdminTicketView>(`/tickets/${id}`),
    refetchInterval: 15_000,
  });
  const admins = useQuery({
    queryKey: ["admins"],
    queryFn: () => get<{ id: string; email: string }[]>("/admins"),
  });

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["ticket", id] }),
      queryClient.invalidateQueries({ queryKey: ["tickets"] }),
      queryClient.invalidateQueries({ queryKey: ["admin-badges"] }),
    ]);
  }

  async function act(what: string, run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refresh();
      return true;
    } catch (err) {
      setError(adminErrorText(err, what));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(e: FormEvent, close: boolean) {
    e.preventDefault();
    if (!reply.trim()) return;
    if (await act("回复失败", () => post(`/tickets/${id}/replies`, { message: reply, close }))) setReply("");
  }

  if (ticket.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (ticket.isError)
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {adminErrorText(ticket.error, "工单加载失败")}
        </p>
        <Button variant="outline" size="sm" onClick={onBack}>
          返回工单列表
        </Button>
      </div>
    );
  const v = ticket.data;
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>
            <h1>{v.subject}</h1>
          </CardTitle>
          <CardDescription>
            用户 {v.user_email}
            {!v.user_enabled && "（账户已停用）"} · {CATEGORY_ZH[v.category]} · 创建于 {fmt(v.created_at)}
            {v.order_no && ` · 订单 ${v.order_no}`}
            {v.node_name && ` · 节点 ${v.node_name}`}
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <PriorityBadge p={v.priority} />
          <TicketStatusBadge s={v.status} />
          <Button variant="outline" size="sm" onClick={onBack}>
            返回工单列表
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="td-assignee">负责人</Label>
            <select
              id="td-assignee"
              className={SELECT}
              value={v.assignee_id ?? ""}
              disabled={busy}
              onChange={(e) =>
                void act("分配失败", () => put(`/tickets/${id}/assignee`, { assignee_id: e.target.value || null }))
              }
            >
              <option value="">未分配</option>
              {(admins.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
            </select>
          </div>
          {v.status === "closed" ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void act("重新打开失败", () => post(`/tickets/${id}/reopen`, {}))}
            >
              重新打开
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: "关闭这个工单？",
                    message: "用户将不能再回复，除非你重新打开。",
                    confirmLabel: "关闭工单",
                  })
                )
                  void act("关闭失败", () => post(`/tickets/${id}/close`, {}));
              }}
            >
              关闭工单
            </Button>
          )}
        </div>
        <ol className="space-y-3" aria-label="工单消息">
          {v.thread.map((m) => (
            <li
              key={m.id}
              className={`rounded-lg border p-3 text-sm ${m.staff ? "border-primary/30 bg-primary/5" : "border-border"}`}
            >
              <p className="mb-1 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">
                  {m.staff
                    ? `客服 ${m.author_email ?? m.author_label ?? ""}`
                    : (m.author_email ?? m.author_label ?? "用户")}
                </span>
                {" · "}
                {fmt(m.created_at)}
              </p>
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
            </li>
          ))}
        </ol>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {v.status === "closed" ? (
          <p className="text-sm text-muted-foreground">
            工单已关闭（{v.closed_by === "user" ? "用户" : "客服"}关闭于 {fmt(v.closed_at)}）。重新打开后才能回复。
          </p>
        ) : (
          <form className="space-y-2" onSubmit={(e) => void send(e, false)}>
            <Label htmlFor="td-reply">回复</Label>
            <Textarea
              id="td-reply"
              rows={5}
              value={reply}
              maxLength={TICKET_MAX_BODY}
              onChange={(e) => setReply(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !reply.trim()}>
                回复
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !reply.trim()}
                onClick={(e) => void send(e, true)}
              >
                回复并关闭
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
