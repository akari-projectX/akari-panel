// 用户 (USR-01…05, 24…28): the list with search, filters (D10 more
// filters as chips), sort, column chooser, selection with the bulk bar,
// batch jobs, bulk delete, CSV export, new-user dialog; the drawer is in
// user-drawer.tsx. Filters live in the URL.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiBase } from "../../shared/base";
import { get, qs } from "../../shared/api";
import { bytes, dateOnly, dateTime, pct, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Popover } from "../../shared/ui/overlays";
import {
  Badge,
  Button,
  Field,
  Input,
  PageHeader,
  Progress,
  Select,
  Switch,
  usageTone,
  type Tone,
} from "../../shared/ui/primitives";
import { DataTable, FilterChip, Pager, type Column } from "../../shared/ui/table";
import { useDebounced } from "../kit";
import { setQuery, useRoute } from "../router";
import type { PlanView } from "../types";
import { BatchDialog, BatchJobs, BulkDeleteDialog, type Selection, type UserFilter } from "./user-batch";
import { CreateUserDialog, UserDrawer } from "./user-drawer";

export type UserRow = {
  id: string;
  role: string;
  enabled: boolean;
  traffic_limit_bytes: number | null;
  traffic_used_bytes: number;
  expires_at: string | null;
  created_at: string;
  disabled_reason: string | null;
  plan_id: string | null;
  plan_name: string | null;
  next_reset_at: string | null;
  email: string;
  email_verified: boolean;
  is_owner: boolean;
  erased: boolean;
  last_login_at: string | null;
  balance_cents: number;
  passkeys: number;
};

const PAGE = 50;

/** Status badge, same precedence as the server's status filter. */
export function userStatus(u: UserRow, tr: Tr): { label: string; tone: Tone } {
  if (u.erased) return { label: tr("已注销", "Erased"), tone: "outline" };
  if (!u.enabled && u.disabled_reason !== "quota") return { label: tr("已封禁", "Banned"), tone: "danger" };
  if (!u.enabled) return { label: tr("流量用尽", "Over quota"), tone: "warning" };
  if (u.role === "user" && u.expires_at && Date.parse(u.expires_at) <= Date.now())
    return { label: tr("已到期", "Expired"), tone: "warning" };
  if (u.role === "user" && !u.plan_id) return { label: tr("无套餐", "No plan"), tone: "neutral" };
  return { label: tr("正常", "Active"), tone: "success" };
}

export function usePlans() {
  return useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
}

export function UsersPage() {
  const tr = useTr();
  const { query } = useRoute();
  const f: UserFilter & { sort: string; offset: number } = {
    q: query.get("q") ?? "",
    status: query.get("status") ?? "",
    plan_id: query.get("plan") ?? "",
    role: query.get("role") ?? "",
    never_used: query.get("never_used") === "1",
    registered_before: query.get("registered_before") ?? "",
    last_login_before: query.get("last_login_before") ?? "",
    sort: query.get("sort") ?? "-created",
    offset: Number(query.get("offset") ?? 0) || 0,
  };
  const open = query.get("open");
  const creating = query.get("new") === "1";
  const [search, setSearch] = useState(f.q ?? "");
  const debounced = useDebounced(search, 300);
  useEffect(() => {
    if ((debounced ?? "") !== (query.get("q") ?? "")) setQuery({ q: debounced || null, offset: null });
  }, [debounced, query]);
  const set = (patch: Record<string, string | null>) => setQuery({ ...patch, offset: null });

  const listFilter: UserFilter = {
    q: f.q || undefined,
    status: f.status || undefined,
    plan_id: f.plan_id || undefined,
    role: f.role || undefined,
    never_used: f.never_used || undefined,
    registered_before: f.registered_before || undefined,
    last_login_before: f.last_login_before || undefined,
  };
  const users = useQuery({
    queryKey: ["users", listFilter, f.sort, f.offset],
    queryFn: () =>
      get<{ users: UserRow[]; total: number }>(
        `/users${qs({ ...listFilter, never_used: f.never_used ? "true" : undefined, sort: f.sort, limit: PAGE, offset: f.offset })}`,
      ),
    placeholderData: keepPreviousData,
  });
  const plans = usePlans();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<{ selection: Selection; label: string } | null>(null);
  const [bulkDelete, setBulkDelete] = useState<{ selection: Selection; label: string } | null>(null);
  const [more, setMore] = useState(false);
  const total = users.data?.total ?? 0;
  const filtered = Object.values(listFilter).some((v) => v !== undefined);
  const planName = (id: string) =>
    id === "none" ? tr("无套餐", "No plan") : (plans.data?.find((p) => p.id === id)?.name ?? id.slice(0, 8));

  const columns: Column<UserRow>[] = [
    {
      key: "email",
      header: tr("邮箱", "Email"),
      fixed: true,
      mobile: "title",
      cell: (u) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{u.email}</span>
          {u.is_owner && <Badge tone="primary">{tr("所有者", "Owner")}</Badge>}
          {u.role === "admin" && !u.is_owner && <Badge tone="outline">{tr("管理员", "Admin")}</Badge>}
          {!u.email_verified && !u.erased && (
            <Badge tone="warning" className="text-[10px]">
              {tr("未验证", "Unverified")}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: tr("状态", "Status"),
      cell: (u) => {
        const s = userStatus(u, tr);
        return (
          <Badge tone={s.tone} dot>
            {s.label}
          </Badge>
        );
      },
    },
    {
      key: "plan",
      header: tr("套餐", "Plan"),
      cell: (u) => u.plan_name ?? <span className="text-muted-foreground">—</span>,
    },
    {
      key: "traffic",
      header: tr("流量", "Traffic"),
      cell: (u) => {
        const p = pct(u.traffic_used_bytes, u.traffic_limit_bytes);
        return (
          <div className="min-w-32">
            <div className="text-xs tabular-nums">
              {bytes(u.traffic_used_bytes)}
              {u.traffic_limit_bytes !== null && ` / ${bytes(u.traffic_limit_bytes)}`}
            </div>
            {u.traffic_limit_bytes !== null && <Progress value={p} tone={usageTone(p)} className="mt-1" />}
          </div>
        );
      },
    },
    { key: "expires", header: tr("到期", "Expires"), cell: (u) => dateOnly(u.expires_at) },
    { key: "created", header: tr("注册时间", "Signed up"), cell: (u) => dateOnly(u.created_at) },
    {
      key: "last_login",
      header: tr("最后登录", "Last sign-in"),
      cell: (u) => (u.last_login_at ? dateTime(u.last_login_at) : tr("从未", "never")),
    },
    {
      key: "balance",
      header: tr("余额", "Balance"),
      optional: true,
      cell: (u) => yuan(u.balance_cents),
      align: "right",
    },
    { key: "passkeys", header: tr("通行密钥", "Passkeys"), optional: true, cell: (u) => u.passkeys, align: "right" },
    { key: "reset", header: tr("下次重置", "Next reset"), optional: true, cell: (u) => dateOnly(u.next_reset_at) },
  ];

  const chips: { label: string; value: string; clear: Record<string, null> }[] = [];
  if (f.status) chips.push({ label: tr("状态", "Status"), value: statusName(f.status, tr), clear: { status: null } });
  if (f.plan_id) chips.push({ label: tr("套餐", "Plan"), value: planName(f.plan_id), clear: { plan: null } });
  if (f.role)
    chips.push({
      label: tr("角色", "Role"),
      value: f.role === "admin" ? tr("管理员", "Admin") : tr("用户", "User"),
      clear: { role: null },
    });
  if (f.never_used) chips.push({ label: tr("从未使用", "Never used"), value: "✓", clear: { never_used: null } });
  if (f.registered_before)
    chips.push({
      label: tr("注册早于", "Signed up before"),
      value: f.registered_before,
      clear: { registered_before: null },
    });
  if (f.last_login_before)
    chips.push({
      label: tr("最后登录早于", "Last sign-in before"),
      value: f.last_login_before,
      clear: { last_login_before: null },
    });

  const exportHref = `${apiBase}/users/export.csv${qs({ q: f.q, plan_id: f.plan_id, status: f.status, role: f.role, sort: f.sort })}`;
  const filterSelection: Selection = { filter: listFilter };

  return (
    <>
      <PageHeader
        title={tr("用户", "Users")}
        description={tr(
          "账户、套餐与流量。点一行打开详情：当前订阅、套餐操作、封禁与登录方式。",
          "Accounts, plans and traffic. Open a row for the subscription, plan actions, bans and sign-in methods.",
        )}
        actions={
          <>
            <a
              href={exportHref}
              download
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] font-medium shadow-card hover:bg-muted"
            >
              {tr("导出 CSV", "Export CSV")}
            </a>
            <Button size="sm" variant="primary" icon="plus" onClick={() => setQuery({ new: "1" }, false)}>
              {tr("新建用户", "New user")}
            </Button>
          </>
        }
      />
      <DataTable
        label={tr("用户列表", "Users")}
        storageKey="users"
        rows={users.data?.users ?? []}
        columns={columns}
        loading={users.isPending}
        error={users.error}
        onRetry={() => void users.refetch()}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        activeId={open}
        onRowClick={(u) => setQuery({ open: u.id }, false)}
        toolbar={
          <>
            <Input
              type="search"
              aria-label={tr("搜索邮箱或 ID", "Search email or id")}
              placeholder={tr("搜索邮箱或 ID 开头…", "Search email or id prefix…")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full sm:w-56"
            />
            <Select
              aria-label={tr("状态", "Status")}
              value={f.status}
              onChange={(e) => set({ status: e.target.value || null })}
              className="w-32 [&_select]:h-8"
            >
              <option value="">{tr("全部状态", "Any status")}</option>
              {["active", "expired", "quota", "banned", "erased"].map((s) => (
                <option key={s} value={s}>
                  {statusName(s, tr)}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("套餐", "Plan")}
              value={f.plan_id}
              onChange={(e) => set({ plan: e.target.value || null })}
              className="w-36 [&_select]:h-8"
            >
              <option value="">{tr("全部套餐", "Any plan")}</option>
              <option value="none">{tr("无套餐", "No plan")}</option>
              {(plans.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("排序", "Sort")}
              value={f.sort}
              onChange={(e) => set({ sort: e.target.value })}
              className="w-40 [&_select]:h-8"
            >
              <option value="-created">{tr("注册时间（新→旧）", "Newest first")}</option>
              <option value="created">{tr("注册时间（旧→新）", "Oldest first")}</option>
              <option value="email">{tr("邮箱", "Email")}</option>
              <option value="-traffic">{tr("已用流量（多→少）", "Most traffic")}</option>
              <option value="expires">{tr("到期（近→远）", "Expiring soonest")}</option>
            </Select>
            <div className="relative">
              <Button size="sm" variant="secondary" icon="filter" onClick={() => setMore((v) => !v)}>
                {tr("更多筛选", "More filters")}
              </Button>
              <Popover open={more} onClose={() => setMore(false)} align="left" className="w-72 p-3">
                <div className="space-y-3">
                  <Field label={tr("角色", "Role")}>
                    <Select value={f.role} onChange={(e) => set({ role: e.target.value || null })}>
                      <option value="">{tr("全部", "Any")}</option>
                      <option value="user">{tr("用户", "User")}</option>
                      <option value="admin">{tr("管理员", "Admin")}</option>
                    </Select>
                  </Field>
                  <div className="flex items-center justify-between gap-3 text-[13px]">
                    <span>
                      {tr("从未使用", "Never used")}
                      <span className="block text-xs text-muted-foreground">
                        {tr(
                          "从无套餐、付款、流量、余额与工单（D10）",
                          "No plan, payment, traffic, balance or ticket ever (D10)",
                        )}
                      </span>
                    </span>
                    <Switch
                      checked={f.never_used ?? false}
                      label={tr("从未使用", "Never used")}
                      onChange={(v) => set({ never_used: v ? "1" : null })}
                    />
                  </div>
                  <Field label={tr("注册早于（站点时区的日）", "Signed up before (site day)")}>
                    <Input
                      type="date"
                      value={f.registered_before}
                      onChange={(e) => set({ registered_before: e.target.value || null })}
                    />
                  </Field>
                  <Field
                    label={tr("最后登录早于", "Last sign-in before")}
                    hint={tr("从未登录的也算", "Never signed in counts")}
                  >
                    <Input
                      type="date"
                      value={f.last_login_before}
                      onChange={(e) => set({ last_login_before: e.target.value || null })}
                    />
                  </Field>
                </div>
              </Popover>
            </div>
            {chips.map((c) => (
              <FilterChip key={c.label} label={c.label} value={c.value} onClear={() => set(c.clear)} />
            ))}
            {filtered && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setQuery({
                    q: null,
                    status: null,
                    plan: null,
                    role: null,
                    never_used: null,
                    registered_before: null,
                    last_login_before: null,
                    offset: null,
                  });
                }}
              >
                {tr("清除筛选", "Clear filters")}
              </Button>
            )}
          </>
        }
        bulkActions={(n) => (
          <>
            <Button
              size="sm"
              onClick={() =>
                setBatch({
                  selection: { ids: [...selected] },
                  label: tr(`已选的 ${n} 个账户`, `${n} selected accounts`),
                })
              }
            >
              {tr("批量操作", "Bulk action")}
            </Button>
            <Button
              size="sm"
              variant="destructive-soft"
              icon="trash"
              onClick={() =>
                setBulkDelete({
                  selection: { ids: [...selected] },
                  label: tr(`已选的 ${n} 个账户`, `${n} selected accounts`),
                })
              }
            >
              {tr("删除", "Delete")}
            </Button>
          </>
        )}
        footer={
          <>
            <span className="flex flex-wrap items-center gap-2">
              <Pager
                total={total}
                offset={f.offset}
                limit={PAGE}
                onOffset={(o) => setQuery({ offset: o ? String(o) : null })}
              />
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={total === 0}
                onClick={() =>
                  setBatch({
                    selection: filterSelection,
                    label: filtered
                      ? tr(`当前筛选的全部 ${total} 个账户`, `all ${total} accounts matching the filters`)
                      : tr(`全部 ${total} 个账户`, `all ${total} accounts`),
                  })
                }
              >
                {filtered
                  ? tr(`对筛选结果批量操作（${total}）`, `Bulk action on matches (${total})`)
                  : tr(`对全部用户批量操作（${total}）`, `Bulk action on everyone (${total})`)}
              </Button>
              {filtered && (
                <Button
                  size="sm"
                  variant="destructive-soft"
                  disabled={total === 0}
                  onClick={() =>
                    setBulkDelete({
                      selection: filterSelection,
                      label: tr(`当前筛选的全部 ${total} 个账户`, `all ${total} accounts matching the filters`),
                    })
                  }
                >
                  {tr(`删除全部匹配的（${total}）`, `Delete all matches (${total})`)}
                </Button>
              )}
            </span>
          </>
        }
      />
      <div className="mt-4">
        <BatchJobs />
      </div>
      {open && <UserDrawer id={open} plans={plans.data ?? []} onClose={() => setQuery({ open: null })} />}
      {creating && <CreateUserDialog plans={plans.data ?? []} onClose={() => setQuery({ new: null })} />}
      {batch && (
        <BatchDialog
          selection={batch.selection}
          label={batch.label}
          plans={plans.data ?? []}
          onClose={() => setBatch(null)}
          onDone={() => {
            setBatch(null);
            setSelected(new Set());
          }}
        />
      )}
      {bulkDelete && (
        <BulkDeleteDialog
          selection={bulkDelete.selection}
          label={bulkDelete.label}
          onClose={() => setBulkDelete(null)}
          onDone={() => {
            setBulkDelete(null);
            setSelected(new Set());
          }}
        />
      )}
    </>
  );
}

function statusName(s: string, tr: Tr): string {
  switch (s) {
    case "active":
      return tr("正常", "Active");
    case "expired":
      return tr("已到期", "Expired");
    case "quota":
      return tr("流量用尽", "Over quota");
    case "banned":
      return tr("已封禁", "Banned");
    case "erased":
      return tr("已注销", "Erased");
    default:
      return s;
  }
}

/** Find a user by address (exact or prefix) for pickers (manual orders, balances). */
export async function findUsers(q: string): Promise<UserRow[]> {
  const r = await get<{ users: UserRow[] }>(`/users${qs({ q, limit: 8 })}`);
  return r.users;
}
