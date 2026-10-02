import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";

import { ErrorText, TableNote } from "../components/status";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { del, get, patch, post, put, type PlanView, type UserNodeView, type UserView } from "../lib/api";
import { adminErrorText } from "../lib/errors";
import { GIB, humanBytes } from "../lib/utils";

// Admin console (Chinese only, R18).

/** Users per page (the server's default; its maximum is 200). */
export const PAGE_SIZE = 50;

const dateOf = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("zh-CN") : "—");
/** "YYYY-MM-DD" (UTC) of a timestamp, for <input type="date">. */
const utcDate = (s: string | null) => (s ? s.slice(0, 10) : "");
const DISABLED_REASON: Record<string, string> = { admin: "管理员停用", quota: "超出流量", expiry: "已到期" };

export function AdminUsers() {
  const [page, setPage] = useState(0);
  const users = useQuery({
    queryKey: ["users", page],
    queryFn: () => get<UserView[]>(`/users?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  });
  const plans = useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
  const [open, setOpen] = useState<string | null>(null);
  const [subToken, setSubToken] = useState<{ login: string; token: string; url?: string | null } | null>(null);

  const rows = users.data ?? [];
  const hasNext = rows.length === PAGE_SIZE;

  return (
    <div className="space-y-6">
      <CreateUser onSubToken={(login, token, url) => setSubToken({ login, token, url })} />
      {subToken && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{subToken.login}</span>{" "}
              的订阅令牌——只显示这一次，请立即保存：
            </p>
            <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">{subToken.token}</pre>
            {subToken.url && <pre className="mt-2 overflow-auto rounded-lg bg-muted p-3 text-xs">{subToken.url}</pre>}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>用户</h1>
          </CardTitle>
          <CardDescription>账户、角色、套餐与流量。点「管理」编辑用户、查看节点权限或执行其他操作。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {users.isError && <ErrorText>{adminErrorText(users.error)}</ErrorText>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>账号</TableHead>
                <TableHead>邮箱</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>套餐</TableHead>
                <TableHead>流量</TableHead>
                <TableHead>下次重置</TableHead>
                <TableHead>到期</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>两步验证</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.isPending && <TableNote colSpan={10}>加载中…</TableNote>}
              {users.isSuccess && rows.length === 0 && (
                <TableNote colSpan={10}>{page === 0 ? "还没有用户，在上方创建第一个。" : "这一页没有用户。"}</TableNote>
              )}
              {rows.map((u) => (
                <Fragment key={u.id}>
                  <TableRow>
                    <TableCell className="whitespace-nowrap font-medium">{u.login}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {u.email ? (
                        <span title={u.email_verified ? "邮箱已验证" : "邮箱未验证：不会收到邮件，也不能用于找回密码"}>
                          {u.email}{" "}
                          <Badge variant={u.email_verified ? "secondary" : "outline"}>
                            {u.email_verified ? "已验证" : "未验证"}
                          </Badge>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{u.role === "admin" ? "管理员" : "用户"}</Badge>
                    </TableCell>
                    <TableCell>
                      {u.plan_name ? (
                        <Badge variant="secondary">{u.plan_name}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {humanBytes(u.traffic_used_bytes)}
                      {u.traffic_limit_bytes != null && ` / ${humanBytes(u.traffic_limit_bytes)}`}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{dateOf(u.next_reset_at)}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{dateOf(u.expires_at)}</TableCell>
                    <TableCell>
                      {u.enabled ? (
                        <Badge variant="success">正常</Badge>
                      ) : (
                        <Badge variant="destructive">
                          {u.disabled_reason ? `停用（${DISABLED_REASON[u.disabled_reason]}）` : "停用"}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.totp_enabled ? (
                        <Badge variant="success">已开启</Badge>
                      ) : (
                        <Badge variant="secondary">未开启</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
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
                      <TableCell colSpan={10} className="bg-muted/30">
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
              ))}
            </TableBody>
          </Table>
          <nav aria-label="用户分页" className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">
              第 {page + 1} 页{rows.length > 0 && `（${page * PAGE_SIZE + 1}–${page * PAGE_SIZE + rows.length}）`}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                上一页
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!hasNext || users.isFetching}
                onClick={() => setPage(page + 1)}
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
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function run(confirmText: string, action: () => Promise<void>, done: string) {
    if (!window.confirm(confirmText)) return;
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
      <section aria-label={`${user.login} 的其他操作`} className="space-y-2">
        <h3 className="text-sm font-medium">其他操作</h3>
        <div className="flex flex-wrap gap-2">
          {user.role === "user" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                run(
                  `为「${user.login}」生成新的订阅令牌？旧的订阅链接会立即失效。`,
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
                `让「${user.login}」在所有设备上退出登录？`,
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
                  `重置「${user.login}」的两步验证？其会话会全部结束，之后只需密码即可登录，可再自行开启。`,
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
                `永久删除用户「${user.login}」？此操作不可撤销，其订阅与节点权限会立即失效。`,
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
    if (form.expires !== utcDate(user.expires_at)) {
      body.expires_at = form.expires ? new Date(`${form.expires}T00:00:00Z`).toISOString() : null;
    }
  }
  return Object.keys(body).length === 0 ? null : body;
}

const gibText = (bytes: number | null) => (bytes == null ? "" : String(Number((bytes / GIB).toFixed(3))));

function EditUser({ user }: { user: UserView }) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState(user.role);
  const [enabled, setEnabled] = useState(user.enabled);
  const [limitGib, setLimitGib] = useState(gibText(user.traffic_limit_bytes));
  const [expires, setExpires] = useState(utcDate(user.expires_at));
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
      <h3 className="text-sm font-medium">编辑用户</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`eu-role-${user.id}`}>角色</Label>
          <select
            id={`eu-role-${user.id}`}
            className="h-9 rounded-lg border border-border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          <Label htmlFor={`eu-exp-${user.id}`}>到期日（UTC，留空不过期）</Label>
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
      <h3 className="text-sm font-medium">节点权限</h3>
      {nodes.isError && <ErrorText>{adminErrorText(nodes.error)}</ErrorText>}
      <Table>
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
              <TableCell>
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

function CreateUser({ onSubToken }: { onSubToken: (login: string, token: string, url?: string | null) => void }) {
  const queryClient = useQueryClient();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [limitGb, setLimitGb] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const body: Record<string, unknown> = { login, password };
    if (role !== "user") body.role = role;
    const gb = Number(limitGb);
    if (limitGb.trim() !== "" && (!Number.isFinite(gb) || gb < 0)) {
      return setMsg({ ok: false, text: "流量上限须为不小于 0 的数字（GiB）。" });
    }
    if (limitGb.trim() !== "" && gb > 0) body.traffic_limit_bytes = Math.round(gb * GIB);
    try {
      const u = await post<UserView & { sub_token: string; sub_url?: string | null }>("/users", body);
      setMsg({ ok: true, text: `已创建 ${u.login}。` });
      if (u.role === "user") onSubToken(u.login, u.sub_token, u.sub_url);
      setLogin("");
      setPassword("");
      setLimitGb("");
      setRole("user");
      await queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (err) {
      setMsg({ ok: false, text: adminErrorText(err) });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>新建用户</h2>
        </CardTitle>
        <CardDescription>账号 3–64 个字符（字母、数字、_ . -），密码至少 8 位；流量上限可选（GiB）。</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={submit} aria-label="新建用户">
          <div className="space-y-1.5">
            <Label htmlFor="nu-login">账号</Label>
            <Input id="nu-login" value={login} onChange={(e) => setLogin(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-password">密码</Label>
            <Input
              id="nu-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-role">角色</Label>
            <select
              id="nu-role"
              className="h-9 rounded-lg border border-border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="user">用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nu-limit">流量上限（GiB）</Label>
            <Input
              id="nu-limit"
              type="number"
              min="0"
              step="any"
              className="w-32"
              value={limitGb}
              onChange={(e) => setLimitGb(e.target.value)}
            />
          </div>
          <Button type="submit">创建</Button>
        </form>
        {msg && (
          <p
            role={msg.ok ? "status" : "alert"}
            className={`mt-3 text-sm ${msg.ok ? "text-emerald-700" : "text-destructive"}`}
          >
            {msg.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// Assign / change / cancel a user's plan. Assigning replaces the active
// plan; the user's node access, quota and expiry follow the plan.
export function UserPlanForm({ user, plans }: { user: UserView; plans: PlanView[] }) {
  const queryClient = useQueryClient();
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
    if (expires) body.expires_at = new Date(`${expires}T00:00:00Z`).toISOString();
    if (resetTraffic) body.reset_traffic = true;
    try {
      await put(`/users/${user.id}/plan`, body);
      await refresh();
    } catch (err) {
      setError(adminErrorText(err));
    }
  }

  async function cancel() {
    if (
      !window.confirm(
        `取消「${user.login}」的套餐？套餐授予的节点会被移除；流量上限与到期时间沿用上一个套餐的设置（之后可手动修改）。`,
      )
    ) {
      return;
    }
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
      <h3 className="text-sm font-medium">套餐</h3>
      {offered.length === 0 ? (
        <p className="text-sm text-muted-foreground">还没有可分配的套餐，请先在「套餐」页创建。</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`up-plan-${user.id}`}>套餐</Label>
            <select
              id={`up-plan-${user.id}`}
              className="h-9 rounded-lg border border-border bg-card px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            <Label htmlFor={`up-exp-${user.id}`}>套餐到期日（UTC，可选）</Label>
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
