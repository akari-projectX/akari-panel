import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useState } from "react";

import { useAdminConfirm as useConfirm } from "../admin-confirm";
import { Dialog } from "../components/dialog";
import { ErrorText, TableNote } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import {
  del,
  get,
  patch,
  post,
  put,
  subscriptionUrl,
  type PlanView,
  type UserDetail,
  type UserPage,
  type UserView,
} from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { extendDays, TERM_KINDS, termBody, termDays, termKindZh, type TermKind } from "../lib/admin-terms";
import { periodZh } from "../lib/billing";
import { fmtDate, fmtDateTime, TZ_LABEL } from "../lib/datetime";
import { copyText, humanBytes } from "../lib/utils";
import { BatchDialog, BatchJobsCard, ExportLink, exportHref, type BatchSelection } from "./admin-ops";
import { UserTraffic } from "./admin-traffic";

// Admin console (Chinese only, R18). W21: search, status/plan filters,
// sort and a total (GET /users?q=&status=&plan_id=&sort=), derived status
// badges, "新建用户" in a dialog, Beijing-time expiry dates.

/** Users per page (the server's default; its maximum is 200). */
export const PAGE_SIZE = 50;

const selectCls =
  "h-9 rounded-lg border border-border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export type StatusFilter = "" | "active" | "expired" | "quota" | "banned";
export type SortKey = "created" | "-created" | "email" | "-traffic" | "expires";

const STATUS_CHIPS: { id: StatusFilter; label: string }[] = [
  { id: "", label: "全部" },
  { id: "active", label: "正常" },
  { id: "expired", label: "已到期" },
  { id: "quota", label: "超出流量" },
  { id: "banned", label: "已封禁" },
];

const SORTS: { id: SortKey; label: string }[] = [
  { id: "created", label: "注册时间（早→晚）" },
  { id: "-created", label: "注册时间（晚→早）" },
  { id: "email", label: "邮箱" },
  { id: "-traffic", label: "已用流量（多→少）" },
  { id: "expires", label: "到期时间（近→远）" },
];

export interface UserFilters {
  q: string;
  status: StatusFilter;
  plan: string;
  sort: SortKey;
  page: number;
}

/** The query string of GET /users for the filters (defaults left out). */
export function usersQuery(f: UserFilters): string {
  const p = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(f.page * PAGE_SIZE) });
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.status) p.set("status", f.status);
  if (f.plan) p.set("plan_id", f.plan);
  if (f.sort !== "created") p.set("sort", f.sort);
  return `?${p.toString()}`;
}

/**
 * The status badge (W21, audit M8), the same precedence as the server's
 * status filter: banned (W28-c) > over quota > expired > active.
 */
export function userStatus(
  u: Pick<UserView, "enabled" | "disabled_reason" | "expires_at" | "role">,
  now: number = Date.now(),
): { label: string; variant: "success" | "destructive" | "secondary" | "outline"; filter: StatusFilter } {
  if (!u.enabled && u.disabled_reason !== "quota") {
    return { label: "已封禁", variant: "secondary", filter: "banned" };
  }
  if (!u.enabled) return { label: "超出流量", variant: "destructive", filter: "quota" };
  if (u.role === "user" && u.expires_at && Date.parse(u.expires_at) <= now) {
    return { label: "已到期", variant: "destructive", filter: "expired" };
  }
  return { label: "正常", variant: "success", filter: "active" };
}

export function AdminUsers() {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<UserFilters>({ q: "", status: "", plan: "", sort: "created", page: 0 });
  // Search as you type, settled for 300 ms; any filter change starts at page 1.
  useEffect(() => {
    const t = window.setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search, page: 0 })), 300);
    return () => window.clearTimeout(t);
  }, [search]);
  const set = (patchF: Partial<UserFilters>) => setFilters((f) => ({ ...f, page: 0, ...patchF }));

  const users = useQuery({
    queryKey: ["users", filters],
    queryFn: () => get<UserPage>(`/users${usersQuery(filters)}`),
    placeholderData: keepPreviousData,
  });
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [subToken, setSubToken] = useState<{ email: string; token: string; url?: string | null } | null>(null);
  // Ops: batch selection (ids across pages) and the batch dialog.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState<{ selection: BatchSelection; label: string } | null>(null);

  const rows = users.data?.users ?? [];
  const total = users.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = filters.q.trim() !== "" || filters.status !== "" || filters.plan !== "";
  const page = filters.page;
  const listFilter = {
    q: filters.q.trim() || undefined,
    plan_id: filters.plan || undefined,
    status: filters.status || undefined,
  };
  const pageIds = rows.map((u) => u.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggleOne = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const togglePage = () =>
    setSelected((s) => {
      const n = new Set(s);
      for (const id of pageIds) {
        if (allOnPage) n.delete(id);
        else n.add(id);
      }
      return n;
    });

  return (
    <div className="space-y-6">
      {batch && (
        <BatchDialog
          selection={batch.selection}
          selectionLabel={batch.label}
          plans={plans.data ?? []}
          onClose={() => setBatch(null)}
          onCreated={() => {
            setBatch(null);
            setSelected(new Set());
          }}
        />
      )}
      {creating && (
        <CreateUserDialog
          plans={plans.data ?? []}
          onClose={() => setCreating(false)}
          onCreated={(u) => {
            setCreating(false);
            if (u.role === "user") setSubToken({ email: u.email, token: u.sub_token, url: u.sub_url });
          }}
        />
      )}
      {subToken && (
        <Card>
          <CardContent className="space-y-2 pt-6">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{subToken.email}</span> 的订阅令牌（之后也可以在「管理 →
              复制订阅链接」再次取得）：
            </p>
            <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{subToken.token}</pre>
            {subToken.url && <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{subToken.url}</pre>}
            <Button variant="ghost" size="sm" onClick={() => setSubToken(null)}>
              隐藏
            </Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>
              <h1>用户</h1>
            </CardTitle>
            <CardDescription>
              账户、角色、套餐与流量。点「管理」查看当前订阅、分配或续期套餐、封禁或执行其他操作。
            </CardDescription>
          </div>
          <Button onClick={() => setCreating(true)}>新建用户</Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1 space-y-1.5 sm:max-w-sm">
              <Label htmlFor="users-q">搜索</Label>
              <Input
                id="users-q"
                type="search"
                placeholder="账号、邮箱或 ID 开头"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="users-plan">套餐</Label>
              <select
                id="users-plan"
                className={selectCls}
                value={filters.plan}
                onChange={(e) => set({ plan: e.target.value })}
              >
                <option value="">全部</option>
                <option value="none">无套餐</option>
                {(plans.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="users-sort">排序</Label>
              <select
                id="users-sort"
                className={selectCls}
                value={filters.sort}
                onChange={(e) => set({ sort: e.target.value as SortKey })}
              >
                {SORTS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="group" aria-label="按状态筛选" className="flex flex-wrap gap-1.5">
              {STATUS_CHIPS.map((c) => (
                <button
                  key={c.id || "all"}
                  type="button"
                  aria-pressed={filters.status === c.id}
                  onClick={() => set({ status: c.id })}
                  className={`h-8 rounded-full border px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    filters.status === c.id
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {users.isSuccess && (filtered ? `找到 ${total} 个用户` : `共 ${total} 个用户`)}
            </p>
          </div>
          <div role="toolbar" aria-label="批量操作与导出" className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={selected.size === 0}
              onClick={() => setBatch({ selection: { ids: [...selected] }, label: `已选中的 ${selected.size} 个用户` })}
            >
              批量操作（已选 {selected.size}）
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!users.isSuccess || total === 0}
              onClick={() =>
                setBatch({
                  selection: { filter: listFilter },
                  label: filtered ? `当前筛选条件下的全部用户（创建任务时为 ${total} 个）` : `全部 ${total} 个用户`,
                })
              }
            >
              {filtered ? `对筛选结果批量操作（${total}）` : `对全部用户批量操作（${total}）`}
            </Button>
            {selected.size > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                清除选择
              </Button>
            )}
            <ExportLink
              href={exportHref("/users/export.csv", {
                ...listFilter,
                sort: filters.sort === "created" ? undefined : filters.sort,
              })}
            >
              导出 CSV
            </ExportLink>
          </div>
          {users.isError && <ErrorText>{adminErrorText(users.error)}</ErrorText>}
          <Table label="用户列表">
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    aria-label="选择本页全部用户"
                    checked={allOnPage}
                    onChange={togglePage}
                    disabled={pageIds.length === 0}
                  />
                </TableHead>
                <TableHead className="sticky left-0 z-[1] bg-card">账号</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>套餐</TableHead>
                <TableHead>流量</TableHead>
                <TableHead>到期（{TZ_LABEL}）</TableHead>
                <TableHead className="sticky right-0 z-[1] bg-card text-right">
                  <span className="sr-only">操作</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.isPending && <TableNote colSpan={7}>加载中…</TableNote>}
              {users.isSuccess && rows.length === 0 && (
                <TableNote colSpan={7}>
                  {filtered
                    ? "没有符合条件的用户。"
                    : page === 0
                      ? "还没有用户，点「新建用户」创建第一个。"
                      : "这一页没有用户。"}
                </TableNote>
              )}
              {rows.map((u) => {
                const st = userStatus(u);
                return (
                  <Fragment key={u.id}>
                    <TableRow>
                      <TableCell className="w-8">
                        <input
                          type="checkbox"
                          aria-label={`选择 ${u.email}`}
                          checked={selected.has(u.id)}
                          onChange={() => toggleOne(u.id)}
                        />
                      </TableCell>
                      <TableCell className="sticky left-0 z-[1] bg-card">
                        <span className="flex max-w-[45vw] items-center gap-1.5 truncate whitespace-nowrap font-medium sm:max-w-none">
                          {u.email}
                          {u.role === "admin" && <Badge variant="outline">管理员</Badge>}
                        </span>
                        {!u.email_verified && (
                          <span
                            className="block text-xs text-muted-foreground"
                            title="邮箱未验证：不会收到邮件，也不能用于找回密码（仍可用它登录）"
                          >
                            未验证
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={st.variant}>{st.label}</Badge>
                      </TableCell>
                      <TableCell>
                        {u.plan_name ? (
                          <Badge variant="secondary">{u.plan_name}</Badge>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {humanBytes(u.traffic_used_bytes)}
                        {u.traffic_limit_bytes != null && ` / ${humanBytes(u.traffic_limit_bytes)}`}
                        {u.next_reset_at && (
                          <span className="block text-xs text-muted-foreground">{fmtDate(u.next_reset_at)} 重置</span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(u.expires_at)}</TableCell>
                      <TableCell className="sticky right-0 z-[1] bg-card text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-expanded={open === u.id}
                          aria-controls={`manage-${u.id}`}
                          onClick={() => setOpen(open === u.id ? null : u.id)}
                        >
                          {open === u.id ? "收起" : "管理"}
                          <span className="sr-only"> {u.email}</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                    {open === u.id && (
                      <TableRow id={`manage-${u.id}`} className="hover:bg-transparent">
                        <TableCell colSpan={7} className="bg-muted/30">
                          <ManageUser
                            user={u}
                            plans={plans.data ?? []}
                            onSubToken={(token, url) => setSubToken({ email: u.email, token, url })}
                            onClose={() => setOpen(null)}
                          />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          <nav aria-label="用户分页" className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              第 {page + 1} / {pages} 页
              {rows.length > 0 && `（${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + rows.length}）`}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}
              >
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= pages || users.isFetching}
                onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}
              >
                下一页
              </Button>
            </div>
          </nav>
        </CardContent>
      </Card>
      <BatchJobsCard />
    </div>
  );
}

// Everything about one account: role, current subscription and plan
// actions (D12), ban (W28-c), sessions, subscription token, delete.
function ManageUser({
  user,
  plans,
  onSubToken,
  onClose,
}: {
  user: UserView;
  plans: PlanView[];
  onSubToken: (token: string, url?: string | null) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // W20 (B1): the user's link (stored encrypted on the server; each read is audited).
  async function copySubscription() {
    setError(null);
    setNotice(null);
    try {
      const r = await get<{ legacy: boolean; sub_token: string | null; sub_url: string | null }>(
        `/users/${user.id}/subscription`,
      );
      if (r.legacy || !r.sub_token) {
        setNotice("该用户的订阅链接是旧版本生成的，无法显示；重新生成订阅令牌后即可复制（旧链接会失效）。");
        return;
      }
      const url = r.sub_url ?? subscriptionUrl(r.sub_token);
      setNotice((await copyText(url)) ? `已复制「${user.email}」的订阅链接。` : `复制失败，请手动复制：${url}`);
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function run(
    ask: { title: string; message: string; confirmLabel: string; destructive?: boolean },
    action: () => Promise<void>,
    done: string,
  ) {
    if (!(await confirm(ask))) return;
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  return (
    <div className="space-y-6 py-2 text-left">
      <EditUser user={user} />
      {user.role === "user" && <UserPlanForm user={user} plans={plans} />}
      <UserBan user={user} />
      {user.role === "user" && <UserTraffic userId={user.id} email={user.email} />}
      <section aria-label={`${user.email} 的其他操作`} className="space-y-2">
        <h2 className="text-sm font-medium">其他操作</h2>
        <div className="flex flex-wrap gap-2">
          {user.role === "user" && (
            <Button variant="outline" size="sm" onClick={() => void copySubscription()}>
              复制订阅链接
            </Button>
          )}
          {user.role === "user" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                run(
                  {
                    title: `为「${user.email}」生成新的订阅令牌？`,
                    message:
                      "旧的订阅链接和所有节点凭据会立即失效，已导入的客户端会被断开，用户需要在所有设备上重新导入。",
                    confirmLabel: "重新生成",
                    destructive: true,
                  },
                  async () => {
                    const res = await post<{ sub_token: string; sub_url?: string | null }>(
                      `/users/${user.id}/sub-token`,
                      {},
                    );
                    onSubToken(res.sub_token, res.sub_url);
                  },
                  "已生成新的订阅令牌（见页面上方）。",
                )
              }
            >
              重新生成订阅令牌
            </Button>
          )}
          {user.email && !user.email_verified && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                run(
                  {
                    title: `把「${user.email}」标记为已验证？`,
                    message: "标记后该邮箱可接收邮件、用于登录与找回密码。请确认该邮箱确实属于此用户。",
                    confirmLabel: "标记为已验证",
                  },
                  () => post(`/users/${user.id}/email/verify`, {}),
                  "邮箱已标记为已验证。",
                )
              }
            >
              标记邮箱已验证
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              run(
                {
                  title: `让「${user.email}」在所有设备上退出登录？`,
                  message: "该用户的全部会话立即失效，需要重新登录。",
                  confirmLabel: "吊销会话",
                },
                () => post(`/users/${user.id}/revoke-sessions`, {}),
                "已吊销该用户的全部会话。",
              )
            }
          >
            吊销会话
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() =>
              run(
                {
                  title: `永久删除用户「${user.email}」？`,
                  message: "此操作不可撤销，其订阅与节点权限会立即失效。",
                  confirmLabel: "删除",
                  destructive: true,
                },
                async () => {
                  await del(`/users/${user.id}`);
                  onClose();
                },
                "已删除。",
              )
            }
          >
            删除用户
          </Button>
        </div>
        <ErrorText>{error}</ErrorText>
        {notice && (
          <p role="status" className="text-sm text-emerald-700">
            {notice}
          </p>
        )}
      </section>
    </div>
  );
}

/** PATCH body with only the fields that changed; null when nothing did. */
export function userPatch(user: UserView, form: { role: string }): Record<string, unknown> | null {
  return form.role !== user.role ? { role: form.role } : null;
}

// D12: the traffic limit and expiry come from the plan (see 套餐 below);
// only the role is edited here.
function EditUser({ user }: { user: UserView }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState(user.role);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const body = userPatch(user, { role });
    if (body == null) return setMsg({ ok: true, text: "没有改动。" });
    try {
      await patch(`/users/${user.id}`, body);
      setMsg({ ok: true, text: "已保存。" });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err) });
    }
  }

  return (
    <form className="space-y-3" onSubmit={save} aria-label={`编辑 ${user.email}`}>
      <h2 className="text-sm font-medium">编辑用户</h2>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`eu-role-${user.id}`}>角色</Label>
          <select
            id={`eu-role-${user.id}`}
            className={selectCls}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          >
            <option value="user">用户</option>
            <option value="admin">管理员</option>
          </select>
        </div>
        <Button type="submit" size="sm">
          保存
        </Button>
      </div>
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </form>
  );
}

// W28-c: ban with a reason the user sees in the portal (kicks the user off
// every node at once, the subscription stops); unban.
function UserBan({ user }: { user: UserView }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const banned = !user.enabled && user.disabled_reason === "admin";
  const detail = useQuery({
    queryKey: ["user", user.id],
    queryFn: () => get<UserDetail>(`/users/${user.id}`),
    enabled: banned,
  });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function act(e?: React.FormEvent) {
    e?.preventDefault();
    setError(null);
    if (!banned && !reason.trim()) return setError("请填写封禁原因（会显示给用户）。");
    const ok = await confirm(
      banned
        ? {
            title: `解除「${user.email}」的封禁？`,
            message: "账户恢复使用，节点立即重新下发。",
            confirmLabel: "解除封禁",
          }
        : {
            title: `封禁「${user.email}」？`,
            message: "立即踢下线（所有节点）、订阅停止；用户仍可登录门户查看原因并提交工单。写入审计。",
            confirmLabel: "封禁",
            destructive: true,
          },
    );
    if (!ok) return;
    try {
      await post(`/users/${user.id}/${banned ? "unban" : "ban"}`, banned ? {} : { reason: reason.trim() });
      setReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["users"] }),
        queryClient.invalidateQueries({ queryKey: ["user", user.id] }),
      ]);
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  return (
    <form className="space-y-2" onSubmit={act} aria-label={`封禁 ${user.email}`}>
      <h2 className="text-sm font-medium">封禁</h2>
      {banned ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>
            已封禁
            {detail.data?.ban?.banned_at && `（${fmtDateTime(detail.data.ban.banned_at)}`}
            {detail.data?.ban?.banned_by_email && `，操作人 ${detail.data.ban.banned_by_email}`}
            {detail.data?.ban?.banned_at && "）"}：{detail.data?.ban?.reason ?? "—"}
          </span>
          <Button type="submit" size="sm" variant="outline">
            解除封禁
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`ban-${user.id}`}>原因（门户中对用户可见，最多 500 字）</Label>
            <Input
              id={`ban-${user.id}`}
              className="w-80"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button type="submit" size="sm" variant="destructive">
            封禁用户
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </form>
  );
}

type Created = UserView & { sub_token: string; sub_url?: string | null };

/** The POST /users body from the dialog's fields; a string = what is wrong. */
export function createUserBody(f: {
  password: string;
  email: string;
  role: string;
  planId: string;
  term: TermKind;
  days: string;
}): Record<string, unknown> | string {
  const body: Record<string, unknown> = { email: f.email.trim(), password: f.password };
  if (f.role !== "user") body.role = f.role;
  if (f.role === "user" && f.planId) {
    const term = termBody(f.term, f.days);
    if (typeof term === "string") return term;
    body.plan = { plan_id: f.planId, ...term };
  }
  return body;
}

/** Plan + term inputs (D12: an assignment is a plan and a duration). */
function TermFields({
  idPrefix,
  term,
  days,
  onTerm,
  onDays,
}: {
  idPrefix: string;
  term: TermKind;
  days: string;
  onTerm: (t: TermKind) => void;
  onDays: (d: string) => void;
}) {
  const rule = termDays(term);
  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-term`}>时长</Label>
        <select
          id={`${idPrefix}-term`}
          className={selectCls}
          value={term}
          onChange={(e) => onTerm(e.target.value as TermKind)}
        >
          {TERM_KINDS.map((k) => (
            <option key={k} value={k}>
              {termKindZh(k)}
            </option>
          ))}
        </select>
      </div>
      {rule !== "none" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-days`}>天数{rule === "optional" ? "（可选）" : ""}</Label>
          <Input
            id={`${idPrefix}-days`}
            className="w-28"
            inputMode="numeric"
            value={days}
            onChange={(e) => onDays(e.target.value)}
          />
        </div>
      )}
    </>
  );
}

function CreateUserDialog({
  plans,
  onClose,
  onCreated,
}: {
  plans: PlanView[];
  onClose: () => void;
  onCreated: (u: Created) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ password: "", email: "", role: "user", planId: "", days: "" });
  const [term, setTerm] = useState<TermKind>("month");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value })),
  });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = createUserBody({ ...form, term });
    if (typeof body === "string") return setError(body);
    setBusy(true);
    try {
      const u = await post<Created>("/users", body);
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      onCreated(u);
    } catch (err) {
      setError(adminErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="新建用户"
      description="邮箱即登录名（视为已验证：可收邮件、找回密码），密码至少 8 位。流量与到期时间由套餐决定。"
      onClose={onClose}
      className="sm:max-w-lg"
    >
      <form className="space-y-4" onSubmit={submit} aria-label="新建用户">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="nu-email">邮箱</Label>
            <Input id="nu-email" type="email" autoComplete="off" required {...field("email")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-password">密码</Label>
            <Input id="nu-password" type="password" autoComplete="new-password" required {...field("password")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-role">角色</Label>
            <select id="nu-role" className={`${selectCls} w-full`} {...field("role")}>
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          {form.role === "user" && (
            <div className="space-y-1.5">
              <Label htmlFor="nu-plan">套餐</Label>
              <select id="nu-plan" className={`${selectCls} w-full`} {...field("planId")}>
                <option value="">暂不分配</option>
                {plans
                  .filter((p) => p.enabled)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
          )}
          {form.role === "user" && form.planId && (
            <div className="flex flex-wrap items-end gap-3 sm:col-span-2">
              <TermFields
                idPrefix="nu"
                term={term}
                days={form.days}
                onTerm={setTerm}
                onDays={(d) => setForm((f) => ({ ...f, days: d }))}
              />
            </div>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "创建中…" : "创建"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const SUB_STATUS_ZH: Record<string, string> = {
  active: "正常",
  expired: "已到期",
  over_quota: "超出流量",
  banned: "已封禁",
};

/** "monthly" / "days-N" / "none" in Chinese. */
function resetZh(r: string): string {
  if (r === "monthly") return "每月";
  if (r.startsWith("days-")) return `每 ${r.slice(5)} 天`;
  return "不重置";
}

// D12: the current subscription and its actions — assign / change (plan +
// term), renew one term or extend N days, reset the plan traffic (confirmed),
// cancel. No limit or expiry inputs: both come from the plan.
export function UserPlanForm({ user, plans }: { user: UserView; plans: PlanView[] }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const detail = useQuery({ queryKey: ["user", user.id], queryFn: () => get<UserDetail>(`/users/${user.id}`) });
  const sub = detail.data?.subscription ?? null;
  const offered = plans.filter((p) => p.enabled || p.id === user.plan_id);
  const [planId, setPlanId] = useState(user.plan_id ?? offered[0]?.id ?? "");
  const [term, setTerm] = useState<TermKind>("month");
  const [days, setDays] = useState("");
  const [extend, setExtend] = useState("30");
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["users"] }),
      queryClient.invalidateQueries({ queryKey: ["plans"] }),
      queryClient.invalidateQueries({ queryKey: ["user", user.id] }),
    ]);
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    const t = termBody(term, days);
    if (typeof t === "string") return setError(t);
    if (
      user.plan_id &&
      !(await confirm({
        title: `为「${user.email}」更换 / 重新分配套餐？`,
        message: "从现在起按新的时长计算，已用流量清零，并按新套餐的节点组重新授权。不产生订单。",
        confirmLabel: "确定",
        destructive: true,
      }))
    )
      return;
    await act(() => put(`/users/${user.id}/plan`, { plan_id: planId, ...t }));
  }

  async function renew(how: "term" | "days") {
    let body: Record<string, unknown>;
    if (how === "days") {
      const n = extendDays(extend);
      if (typeof n === "string") return setError(n);
      body = { extend_days: n };
    } else {
      const t = termBody(term, days);
      if (typeof t === "string") return setError(t);
      body = t;
    }
    await act(() => patch(`/users/${user.id}/plan`, body));
  }

  async function resetTraffic() {
    const ok = await confirm({
      title: `重置「${user.email}」的套餐流量？`,
      message: "已用流量清零；因超出流量被停用的账户会自动恢复（封禁的不会）。重置周期不变，写入审计。",
      confirmLabel: "重置流量",
      destructive: true,
    });
    if (ok) await act(() => post(`/users/${user.id}/plan/reset-traffic`, { confirm: true }));
  }

  async function cancel() {
    const ok = await confirm({
      title: `取消「${user.email}」的套餐？`,
      message: "套餐授予的节点会被移除；流量上限与到期时间保留为记录，之后只能通过分配套餐改变。",
      confirmLabel: "取消套餐",
      cancelLabel: "保留",
      destructive: true,
    });
    if (ok) await act(() => del(`/users/${user.id}/plan`));
  }

  return (
    <form className="space-y-3" onSubmit={assign} aria-label={`${user.email} 的套餐`}>
      <h2 className="text-sm font-medium">当前订阅</h2>
      {detail.isError && <ErrorText>{adminErrorText(detail.error)}</ErrorText>}
      {sub ? (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <dt className="text-muted-foreground">套餐</dt>
          <dd>{sub.plan_name}</dd>
          <dt className="text-muted-foreground">时长</dt>
          <dd>{periodZh(sub.period, sub.period_days)}</dd>
          <dt className="text-muted-foreground">到期</dt>
          <dd>{sub.expires_at ? fmtDateTime(sub.expires_at) : "永久"}</dd>
          <dt className="text-muted-foreground">流量</dt>
          <dd>
            {humanBytes(sub.traffic_used_bytes)} /{" "}
            {sub.traffic_total_bytes == null ? "不限" : humanBytes(sub.traffic_total_bytes)}
          </dd>
          <dt className="text-muted-foreground">重置</dt>
          <dd>
            {resetZh(sub.reset_period)}
            {sub.next_reset_at && `，下次 ${fmtDateTime(sub.next_reset_at)}`}
          </dd>
          <dt className="text-muted-foreground">状态</dt>
          <dd>{SUB_STATUS_ZH[sub.status] ?? sub.status}</dd>
        </dl>
      ) : (
        detail.isSuccess && <p className="text-sm text-muted-foreground">没有生效的套餐。</p>
      )}
      {offered.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有可分配的套餐，请先在「套餐」页创建。</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`up-plan-${user.id}`}>套餐</Label>
            <select
              id={`up-plan-${user.id}`}
              className={selectCls}
              value={planId}
              onChange={(e) => setPlanId(e.target.value)}
            >
              {offered.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <TermFields idPrefix={`up-${user.id}`} term={term} days={days} onTerm={setTerm} onDays={setDays} />
          <Button type="submit" size="sm" disabled={!planId}>
            {user.plan_id ? "更换套餐" : "分配套餐"}
          </Button>
          {sub && sub.expires_at && (
            <Button type="button" size="sm" variant="outline" onClick={() => void renew("term")}>
              续期一个时长
            </Button>
          )}
        </div>
      )}
      {sub && (
        <div className="flex flex-wrap items-end gap-3">
          {sub.expires_at && sub.period !== "onetime" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={`up-extend-${user.id}`}>延长天数</Label>
                <Input
                  id={`up-extend-${user.id}`}
                  className="w-24"
                  inputMode="numeric"
                  value={extend}
                  onChange={(e) => setExtend(e.target.value)}
                />
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => void renew("days")}>
                延长
              </Button>
            </>
          )}
          <Button type="button" size="sm" variant="outline" onClick={() => void resetTraffic()}>
            重置流量
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => void cancel()}>
            取消套餐
          </Button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </form>
  );
}
