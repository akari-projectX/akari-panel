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
  type UserNodeView,
  type UserPage,
  type UserView,
} from "../lib/api";
import { adminErrorText } from "../lib/admin-errors";
import { dateInputValue, endOfDayIso, fmtDate, TZ_LABEL } from "../lib/datetime";
import { copyText, GIB, humanBytes } from "../lib/utils";
import { UserTraffic } from "./admin-traffic";

// Admin console (Chinese only, R18). W21: search, status/plan filters,
// sort and a total (GET /users?q=&status=&plan_id=&sort=), derived status
// badges, "新建用户" in a dialog, Beijing-time expiry dates.

/** Users per page (the server's default; its maximum is 200). */
export const PAGE_SIZE = 50;

const selectCls =
  "h-9 rounded-lg border border-border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export type StatusFilter = "" | "active" | "expired" | "quota" | "disabled";
export type SortKey = "created" | "-created" | "login" | "-traffic" | "expires";

const STATUS_CHIPS: { id: StatusFilter; label: string }[] = [
  { id: "", label: "全部" },
  { id: "active", label: "正常" },
  { id: "expired", label: "已到期" },
  { id: "quota", label: "超出流量" },
  { id: "disabled", label: "已停用" },
];

const SORTS: { id: SortKey; label: string }[] = [
  { id: "created", label: "注册时间（早→晚）" },
  { id: "-created", label: "注册时间（晚→早）" },
  { id: "login", label: "账号" },
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

const DISABLED_REASON: Record<string, string> = { admin: "管理员停用", expiry: "到期停用" };

/**
 * The status badge (W21, audit M8), the same precedence as the server's
 * status filter: disabled (reason) > over quota > expired > active.
 */
export function userStatus(
  u: Pick<UserView, "enabled" | "disabled_reason" | "expires_at" | "role">,
  now: number = Date.now(),
): { label: string; variant: "success" | "destructive" | "secondary" | "outline"; filter: StatusFilter } {
  if (!u.enabled && u.disabled_reason !== "quota") {
    const why = u.disabled_reason ? DISABLED_REASON[u.disabled_reason] : null;
    return { label: why ? `已停用（${why}）` : "已停用", variant: "secondary", filter: "disabled" };
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
  const [subToken, setSubToken] = useState<{ login: string; token: string; url?: string | null } | null>(null);

  const rows = users.data?.users ?? [];
  const total = users.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = filters.q.trim() !== "" || filters.status !== "" || filters.plan !== "";
  const page = filters.page;

  return (
    <div className="space-y-6">
      {creating && (
        <CreateUserDialog
          onClose={() => setCreating(false)}
          onCreated={(u) => {
            setCreating(false);
            if (u.role === "user") setSubToken({ login: u.login, token: u.sub_token, url: u.sub_url });
          }}
        />
      )}
      {subToken && (
        <Card>
          <CardContent className="space-y-2 pt-6">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{subToken.login}</span> 的订阅令牌（之后也可以在「管理 →
              复制订阅链接」再次取得）：
            </p>
            <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{subToken.token}</pre>
            {subToken.url && <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs">{subToken.url}</pre>}
            <Button variant="ghost" size="sm" onClick={() => setSubToken(null)}>
              我已保存，隐藏
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
            <CardDescription>账户、角色、套餐与流量。点「管理」编辑用户、查看节点权限或执行其他操作。</CardDescription>
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
          {users.isError && <ErrorText>{adminErrorText(users.error)}</ErrorText>}
          <Table label="用户列表">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-[1] bg-card">账号</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>套餐</TableHead>
                <TableHead>流量</TableHead>
                <TableHead>到期（{TZ_LABEL}）</TableHead>
                <TableHead>两步验证</TableHead>
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
                      <TableCell className="sticky left-0 z-[1] bg-card">
                        <span className="flex max-w-[45vw] items-center gap-1.5 truncate whitespace-nowrap font-medium sm:max-w-none">
                          {u.login}
                          {u.role === "admin" && <Badge variant="outline">管理员</Badge>}
                        </span>
                        {u.email && (
                          <span
                            className="block max-w-56 truncate text-xs text-muted-foreground"
                            title={u.email_verified ? "邮箱已验证" : "邮箱未验证：不会收到邮件，也不能用于找回密码"}
                          >
                            {u.email}
                            {!u.email_verified && "（未验证）"}
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
                      <TableCell>
                        {u.totp_enabled ? (
                          <Badge variant="success">已开启</Badge>
                        ) : (
                          <Badge variant="secondary">未开启</Badge>
                        )}
                      </TableCell>
                      <TableCell className="sticky right-0 z-[1] bg-card text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          aria-expanded={open === u.id}
                          aria-controls={`manage-${u.id}`}
                          onClick={() => setOpen(open === u.id ? null : u.id)}
                        >
                          {open === u.id ? "收起" : "管理"}
                          <span className="sr-only"> {u.login}</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                    {open === u.id && (
                      <TableRow id={`manage-${u.id}`} className="hover:bg-transparent">
                        <TableCell colSpan={7} className="bg-muted/30">
                          <ManageUser
                            user={u}
                            plans={plans.data ?? []}
                            onSubToken={(token, url) => setSubToken({ login: u.login, token, url })}
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
    </div>
  );
}

// Everything about one account: edit, plan, node access, sessions, 2FA,
// subscription token, delete.
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
      setNotice((await copyText(url)) ? `已复制「${user.login}」的订阅链接。` : `复制失败，请手动复制：${url}`);
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
      {user.role === "user" && <UserNodes user={user} />}
      {user.role === "user" && <UserTraffic userId={user.id} login={user.login} />}
      <section aria-label={`${user.login} 的其他操作`} className="space-y-2">
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
                    title: `为「${user.login}」生成新的订阅令牌？`,
                    message: "旧的订阅链接会立即失效，用户需要在所有设备上重新导入。",
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
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              run(
                {
                  title: `让「${user.login}」在所有设备上退出登录？`,
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
          {user.totp_enabled && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                run(
                  {
                    title: `重置「${user.login}」的两步验证？`,
                    message: "其会话会全部结束，之后只需密码即可登录，可再自行开启。",
                    confirmLabel: "重置",
                    destructive: true,
                  },
                  () => del(`/users/${user.id}/totp`),
                  "已重置两步验证。",
                )
              }
            >
              重置两步验证
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={() =>
              run(
                {
                  title: `永久删除用户「${user.login}」？`,
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
export function userPatch(
  user: UserView,
  form: { role: string; enabled: boolean; limitGib: string; expires: string },
): Record<string, unknown> | null | "bad-limit" {
  const body: Record<string, unknown> = {};
  if (form.role !== user.role) body.role = form.role;
  if (form.enabled !== user.enabled) body.enabled = form.enabled;
  if (user.plan_id == null) {
    const text = form.limitGib.trim();
    let limit: number | null = null;
    if (text !== "") {
      const n = Number(text);
      if (!Number.isFinite(n) || n < 0) return "bad-limit";
      limit = Math.round(n * GIB);
    }
    if (limit !== user.traffic_limit_bytes) body.traffic_limit_bytes = limit;
    // A picked day is a Beijing day; the account lasts through 23:59:59.
    if (form.expires !== dateInputValue(user.expires_at)) body.expires_at = endOfDayIso(form.expires);
  }
  return Object.keys(body).length === 0 ? null : body;
}

const gibText = (bytes: number | null) => (bytes == null ? "" : String(Number((bytes / GIB).toFixed(3))));

function EditUser({ user }: { user: UserView }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState(user.role);
  const [enabled, setEnabled] = useState(user.enabled);
  const [limitGib, setLimitGib] = useState(gibText(user.traffic_limit_bytes));
  const [expires, setExpires] = useState(dateInputValue(user.expires_at));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const planManaged = user.plan_id != null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const body = userPatch(user, { role, enabled, limitGib, expires });
    if (body === "bad-limit") return setMsg({ ok: false, text: "流量上限须为不小于 0 的数字（GiB），留空表示不限。" });
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
    <form className="space-y-3" onSubmit={save} aria-label={`编辑 ${user.login}`}>
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
        <div className="space-y-1.5">
          <Label htmlFor={`eu-limit-${user.id}`}>流量上限（GiB，留空不限）</Label>
          <Input
            id={`eu-limit-${user.id}`}
            type="number"
            min="0"
            step="any"
            className="w-40"
            value={limitGib}
            disabled={planManaged}
            onChange={(e) => setLimitGib(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`eu-exp-${user.id}`}>到期日（{TZ_LABEL}，留空不过期）</Label>
          <Input
            id={`eu-exp-${user.id}`}
            type="date"
            className="w-44"
            value={expires}
            disabled={planManaged}
            onChange={(e) => setExpires(e.target.value)}
          />
        </div>
        <label className="flex h-9 items-center gap-1.5 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用
        </label>
        <Button type="submit" size="sm">
          保存
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">到期日当天 23:59:59（{TZ_LABEL}）到期。</p>
      {planManaged && (
        <p className="text-xs text-muted-foreground">
          流量上限与到期时间由套餐「{user.plan_name}」管理；要修改请更换套餐，或取消套餐后再编辑。
        </p>
      )}
      {!user.enabled && user.disabled_reason === "quota" && (
        <p className="text-xs text-muted-foreground">
          提高上限不会自动启用因超出流量而停用的用户，请同时勾选「启用」。
        </p>
      )}
      {msg && (
        <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-emerald-700" : "text-destructive"}`}>
          {msg.text}
        </p>
      )}
    </form>
  );
}

// Read-only: which nodes the account can use, through which inbounds, and
// whether each comes from the plan or a manual assignment.
function UserNodes({ user }: { user: UserView }) {
  const nodes = useQuery({
    queryKey: ["user-nodes", user.id],
    queryFn: () => get<UserNodeView[]>(`/users/${user.id}/nodes`),
  });
  return (
    <section aria-label={`${user.login} 的节点权限`} className="space-y-2">
      <h2 className="text-sm font-medium">节点权限</h2>
      {nodes.isError && <ErrorText>{adminErrorText(nodes.error)}</ErrorText>}
      <Table label="节点权限">
        <TableHeader>
          <TableRow>
            <TableHead>节点</TableHead>
            <TableHead>地区</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>入站</TableHead>
            <TableHead>来源</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.isPending && <TableNote colSpan={5}>加载中…</TableNote>}
          {nodes.isSuccess && nodes.data.length === 0 && <TableNote colSpan={5}>该用户目前没有可用节点。</TableNote>}
          {(nodes.data ?? []).map((n) => (
            <TableRow key={n.node_id}>
              <TableCell className="whitespace-nowrap font-medium">{n.name}</TableCell>
              <TableCell>{n.region ?? "—"}</TableCell>
              <TableCell className="whitespace-nowrap">
                {n.deleting ? "删除中" : !n.enabled ? "已停用" : n.status === "online" ? "在线" : "离线"}
              </TableCell>
              <TableCell className="text-xs">
                {n.inbounds.map((i) => `${i.tag}（${i.protocol}）`).join("、") || "—"}
              </TableCell>
              <TableCell>
                <Badge variant="secondary">{n.manual ? "手动分配" : "套餐"}</Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

type Created = UserView & { sub_token: string; sub_url?: string | null };

/** The POST /users body from the dialog's fields; a string = what is wrong. */
export function createUserBody(f: {
  login: string;
  password: string;
  email: string;
  role: string;
  limitGib: string;
  expires: string;
}): Record<string, unknown> | string {
  const body: Record<string, unknown> = { login: f.login.trim(), password: f.password };
  if (f.role !== "user") body.role = f.role;
  if (f.email.trim()) body.email = f.email.trim();
  const text = f.limitGib.trim();
  if (text !== "") {
    const gb = Number(text);
    if (!Number.isFinite(gb) || gb < 0) return "流量上限须为不小于 0 的数字（GiB）。";
    if (gb > 0) body.traffic_limit_bytes = Math.round(gb * GIB);
  }
  if (f.expires) body.expires_at = endOfDayIso(f.expires);
  return body;
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (u: Created) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ login: "", password: "", email: "", role: "user", limitGib: "", expires: "" });
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
    const body = createUserBody(form);
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
      description="账号 3–64 个字符（字母、数字、_ . -），密码至少 8 位。"
      onClose={onClose}
      className="sm:max-w-lg"
    >
      <form className="space-y-4" onSubmit={submit} aria-label="新建用户">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="nu-login">账号</Label>
            <Input id="nu-login" autoComplete="off" required {...field("login")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-password">密码</Label>
            <Input id="nu-password" type="password" autoComplete="new-password" required {...field("password")} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="nu-email">邮箱（可选，视为已验证：可收邮件、找回密码）</Label>
            <Input id="nu-email" type="email" autoComplete="off" {...field("email")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-role">角色</Label>
            <select id="nu-role" className={`${selectCls} w-full`} {...field("role")}>
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-limit">流量上限（GiB，留空不限）</Label>
            <Input id="nu-limit" type="number" min="0" step="any" {...field("limitGib")} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="nu-expires">到期日（{TZ_LABEL}，当天 23:59:59 到期；留空不过期）</Label>
            <Input id="nu-expires" type="date" {...field("expires")} />
          </div>
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

// Assign / change / cancel a user's plan. Assigning replaces the active
// plan; the user's node access, quota and expiry follow the plan.
export function UserPlanForm({ user, plans }: { user: UserView; plans: PlanView[] }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const offered = plans.filter((p) => p.enabled || p.id === user.plan_id);
  const [planId, setPlanId] = useState(user.plan_id ?? offered[0]?.id ?? "");
  const [expires, setExpires] = useState("");
  const [resetTraffic, setResetTraffic] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["users"] }),
      queryClient.invalidateQueries({ queryKey: ["plans"] }),
      queryClient.invalidateQueries({ queryKey: ["user-nodes", user.id] }),
    ]);
  }

  async function assign(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body: Record<string, unknown> = { plan_id: planId };
    if (expires) body.expires_at = endOfDayIso(expires);
    if (resetTraffic) body.reset_traffic = true;
    try {
      await put(`/users/${user.id}/plan`, body);
      await refresh();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function cancel() {
    const ok = await confirm({
      title: `取消「${user.login}」的套餐？`,
      message: "套餐授予的节点会被移除；流量上限与到期时间沿用上一个套餐的设置（之后可手动修改）。",
      confirmLabel: "取消套餐",
      cancelLabel: "保留",
      destructive: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await del(`/users/${user.id}/plan`);
      await refresh();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  return (
    <form className="space-y-3" onSubmit={assign} aria-label={`${user.login} 的套餐`}>
      <h2 className="text-sm font-medium">套餐</h2>
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
          <div className="space-y-1.5">
            <Label htmlFor={`up-exp-${user.id}`}>套餐到期日（{TZ_LABEL}，可选）</Label>
            <Input
              id={`up-exp-${user.id}`}
              type="date"
              className="w-44"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </div>
          <label className="flex h-9 items-center gap-1.5 text-sm">
            <input type="checkbox" checked={resetTraffic} onChange={(e) => setResetTraffic(e.target.checked)} />
            清零已用流量
          </label>
          <Button type="submit" size="sm" disabled={!planId}>
            {user.plan_id ? "更换套餐" : "分配套餐"}
          </Button>
          {user.plan_id && (
            <Button type="button" variant="destructive" size="sm" onClick={cancel}>
              取消套餐
            </Button>
          )}
        </div>
      )}
      {user.plan_id && (
        <p className="text-xs text-muted-foreground">取消套餐后，流量上限与到期时间沿用上一个套餐的设置。</p>
      )}
      <ErrorText>{error}</ErrorText>
    </form>
  );
}
