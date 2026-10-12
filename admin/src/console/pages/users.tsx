// 用户 (USR-01…05, 24…28): the list with search, filters (more filters as
// chips), sort, page size, column chooser, selection with the bulk bar
// ("the ticked ones" or "all N matching"), batch jobs, bulk delete, CSV
// export of exactly what the list shows, new-user dialog; the detail
// dialog is user-detail.tsx. Every filter, the page and the open account
// live in the URL; the selection belongs to one view (filters + page) and
// is dropped when the view changes.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiBase } from "../../shared/base";
import { get, qs } from "../../shared/api";
import { bytes, dateOnly, dateTime, pct, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { DataTable, FilterChip, PAGE_SIZES, Pager, type Column } from "../../shared/ui/table";
import { useDebounced } from "../kit";
import { setQuery, useRoute } from "../router";
import type { PlanView } from "../types";
import { BatchDialog, BatchJobs, useBulkDelete, type Selection, type UserFilter } from "./user-batch";
import { CreateUserDialog, UserDetail } from "./user-detail";
import { Download, KeyRound, ListFilter, Plus, Search, Trash2 } from "lucide-react";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button, ButtonLink } from "../../shared/ui/button";
import { Field, Input, Select, SwitchField } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { Popover } from "../../shared/ui/menu";
import { Meter, usageTone } from "../../shared/ui/meter";

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
  /** How the account registered: password | passkey. */
  signup_method: "password" | "passkey";
  /** Registered with a passkey and no address bound yet (`email` is a placeholder). */
  email_pending: boolean;
};

const DEFAULT_LIMIT = 50;

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

const STATUSES = ["active", "expired", "quota", "banned", "erased"];
const CLEAR_ALL = {
  q: null,
  status: null,
  plan: null,
  role: null,
  never_used: null,
  registered_before: null,
  last_login_before: null,
  offset: null,
};

export function UsersPage() {
  const tr = useTr();
  const { query } = useRoute();
  const limitParam = Number(query.get("limit"));
  const f = {
    q: query.get("q") ?? "",
    status: query.get("status") ?? "",
    plan_id: query.get("plan") ?? "",
    role: query.get("role") ?? "",
    never_used: query.get("never_used") === "1",
    registered_before: query.get("registered_before") ?? "",
    last_login_before: query.get("last_login_before") ?? "",
    sort: query.get("sort") ?? "-created",
    offset: Math.max(0, Number(query.get("offset") ?? 0) || 0),
    limit: PAGE_SIZES.includes(limitParam) ? limitParam : DEFAULT_LIMIT,
  };
  const open = query.get("open");
  const creating = query.get("new") === "1";

  // Search box → URL (debounced); a change of the URL from elsewhere
  // (clear filters, Back, the command palette) → search box.
  const [search, setSearch] = useState(f.q);
  const debounced = useDebounced(search, 300);
  const [seenQ, setSeenQ] = useState(f.q);
  if (f.q !== seenQ) {
    setSeenQ(f.q);
    if (f.q !== debounced) setSearch(f.q);
  }
  useEffect(() => {
    if (debounced !== (query.get("q") ?? "")) setQuery({ q: debounced || null, offset: null });
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
  /** The list's query string (the CSV export sends the same filters). */
  const filterParams = {
    ...listFilter,
    never_used: f.never_used ? "true" : undefined,
    sort: f.sort,
  };
  const users = useQuery({
    queryKey: ["users", listFilter, f.sort, f.offset, f.limit],
    queryFn: () =>
      get<{ users: UserRow[]; total: number }>(`/users${qs({ ...filterParams, limit: f.limit, offset: f.offset })}`),
    placeholderData: keepPreviousData,
  });
  const plans = usePlans();
  const total = users.data?.total ?? 0;
  const filtered = Object.values(listFilter).some((v) => v !== undefined);

  // The selection (and "all matching") belongs to one view: filters, sort, page.
  const view = JSON.stringify([listFilter, f.sort, f.offset, f.limit]);
  const [picked, setPicked] = useState<{ view: string; ids: Set<string>; all: boolean }>({
    view,
    ids: new Set(),
    all: false,
  });
  const selected = picked.view === view ? picked.ids : new Set<string>();
  const allMatching = picked.view === view && picked.all && selected.size > 0;
  const setSelected = (ids: Set<string>) => setPicked({ view, ids, all: ids.size > 0 && allMatching });
  const clearSelection = () => setPicked({ view, ids: new Set(), all: false });

  const [batch, setBatch] = useState<{ selection: Selection; label: string } | null>(null);
  const [startDelete, deleting] = useBulkDelete();
  const [more, setMore] = useState(false);
  const planName = (id: string) =>
    id === "none"
      ? tr("无套餐", "No plan")
      : (plans.data?.find((p) => p.id === id)?.name ?? tr("已删除的套餐", "Deleted plan"));

  const columns: Column<UserRow>[] = [
    {
      key: "email",
      header: tr("邮箱", "Email"),
      fixed: true,
      mobile: "title",
      cell: (u) => (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="min-w-0 font-medium break-all">
            {u.email_pending ? tr("（待绑定邮箱）", "(email pending)") : u.email}
          </span>
          {u.is_owner && <Badge tone="primary">{tr("所有者", "Owner")}</Badge>}
          {u.role === "admin" && !u.is_owner && <Badge tone="outline">{tr("管理员", "Admin")}</Badge>}
          {u.email_pending && <Badge tone="warning">{tr("待绑定邮箱", "Email pending")}</Badge>}
          {!u.email_verified && !u.erased && !u.email_pending && (
            <Badge tone="warning">{tr("未验证", "Unverified")}</Badge>
          )}
          {u.signup_method === "passkey" && (
            <KeyRound
              className="size-3 shrink-0 text-faint"
              aria-label={tr("通行密钥注册", "Signed up with a passkey")}
            />
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
      cell: (u) =>
        u.plan_name ?? <span className="text-faint">{u.role === "admin" ? "—" : tr("无套餐", "No plan")}</span>,
    },
    {
      key: "traffic",
      header: tr("流量", "Traffic"),
      cell: (u) => {
        const p = pct(u.traffic_used_bytes, u.traffic_limit_bytes);
        return (
          <div className="grid min-w-28 gap-1 md:min-w-36">
            <div className="tnum flex justify-between gap-2 text-caption text-muted-foreground">
              <span>
                {bytes(u.traffic_used_bytes)}
                {u.traffic_limit_bytes !== null && ` / ${bytes(u.traffic_limit_bytes)}`}
              </span>
              {u.traffic_limit_bytes !== null && <span>{p.toFixed(0)}%</span>}
            </div>
            {u.traffic_limit_bytes !== null && <Meter value={p} tone={usageTone(p)} />}
          </div>
        );
      },
    },
    {
      key: "expires",
      header: tr("到期", "Expires"),
      cell: (u) => <span className="tnum">{dateOnly(u.expires_at)}</span>,
    },
    {
      key: "created",
      header: tr("注册时间", "Signed up"),
      mobile: "hide",
      cell: (u) => <span className="tnum">{dateOnly(u.created_at)}</span>,
    },
    {
      key: "last_login",
      header: tr("最后登录", "Last sign-in"),
      mobile: "hide",
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
    {
      key: "signup",
      header: tr("注册方式", "Signed up with"),
      optional: true,
      cell: (u) => (u.signup_method === "passkey" ? tr("通行密钥", "Passkey") : tr("密码", "Password")),
    },
    {
      key: "reset",
      header: tr("下次重置", "Next reset"),
      optional: true,
      cell: (u) => <span className="tnum">{dateOnly(u.next_reset_at)}</span>,
    },
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
  if (f.never_used)
    chips.push({ label: tr("从未使用", "Never used"), value: tr("是", "yes"), clear: { never_used: null } });
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

  const exportHref = `${apiBase}/users/export.csv${qs(filterParams)}`;
  const scope = (): { selection: Selection; label: string } =>
    allMatching
      ? {
          selection: { filter: listFilter },
          label: filtered
            ? tr(`当前筛选的全部 ${total} 个账户`, `all ${total} accounts matching the filters`)
            : tr(`全部 ${total} 个账户`, `all ${total} accounts`),
        }
      : {
          selection: { ids: [...selected] },
          label: tr(`已勾选的 ${selected.size} 个账户`, `${selected.size} ticked accounts`),
        };
  const clearFilters = () => {
    setSearch("");
    setQuery(CLEAR_ALL);
  };

  return (
    <>
      <PageHeader
        title={tr("用户", "Users")}
        description={
          users.data
            ? filtered
              ? tr(`${total.toLocaleString()} 个账户符合筛选`, `${total.toLocaleString()} accounts match`)
              : tr(`共 ${total.toLocaleString()} 个账户`, `${total.toLocaleString()} accounts`)
            : tr("账户、套餐与流量。", "Accounts, plans and traffic.")
        }
        actions={
          <>
            <ButtonLink href={exportHref} download variant="outline" icon={Download}>
              {tr("导出 CSV", "Export CSV")}
            </ButtonLink>
            <Button variant="primary" icon={Plus} onClick={() => setQuery({ new: "1" }, false)}>
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
        filtered={filtered}
        onClearFilters={clearFilters}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        activeId={open}
        onRowClick={(u) => setQuery({ open: u.id, tab: null }, false)}
        toolbar={
          <>
            <div className="relative min-w-0 flex-1 basis-56">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label={tr("搜索邮箱或 ID", "Search email or id")}
                placeholder={tr("搜索邮箱或 ID 开头…", "Search email or id prefix…")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select
              aria-label={tr("状态", "Status")}
              value={f.status}
              onChange={(e) => set({ status: e.target.value || null })}
              className="max-sm:flex-1"
            >
              <option value="">{tr("全部状态", "Any status")}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusName(s, tr)}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("套餐", "Plan")}
              value={f.plan_id}
              onChange={(e) => set({ plan: e.target.value || null })}
              className="max-w-full max-sm:flex-1"
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
              className="max-sm:flex-1"
            >
              <option value="-created">{tr("注册时间（新→旧）", "Newest first")}</option>
              <option value="created">{tr("注册时间（旧→新）", "Oldest first")}</option>
              <option value="email">{tr("邮箱", "Email")}</option>
              <option value="-traffic">{tr("已用流量（多→少）", "Most traffic")}</option>
              <option value="expires">{tr("到期（近→远）", "Expiring soonest")}</option>
            </Select>
            <Popover
              open={more}
              onOpenChange={setMore}
              align="start"
              label={tr("更多筛选", "More filters")}
              className="w-[min(18rem,calc(100vw-32px))] p-3"
              trigger={
                <Button variant="secondary" icon={ListFilter}>
                  {tr("更多筛选", "More filters")}
                </Button>
              }
            >
              <div className="space-y-3">
                <Field label={tr("角色", "Role")}>
                  <Select value={f.role} onChange={(e) => set({ role: e.target.value || null })}>
                    <option value="">{tr("全部", "Any")}</option>
                    <option value="user">{tr("用户", "User")}</option>
                    <option value="admin">{tr("管理员", "Admin")}</option>
                  </Select>
                </Field>
                <SwitchField
                  label={tr("从未使用", "Never used")}
                  description={tr(
                    "从无套餐、付款、流量、余额与工单的普通用户",
                    "Users with no plan, payment, traffic, balance or ticket ever",
                  )}
                  checked={f.never_used}
                  onChange={(v) => set({ never_used: v ? "1" : null })}
                />
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
            {chips.map((c) => (
              <FilterChip key={c.label} label={c.label} value={c.value} onClear={() => set(c.clear)} />
            ))}
            {filtered && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                {tr("清除筛选", "Clear filters")}
              </Button>
            )}
          </>
        }
        bulkActions={(n) => (
          <>
            {allMatching ? (
              <span className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium">
                  {tr(`将作用于全部匹配的 ${total} 个`, `Applies to all ${total} matching`)}
                </span>
                <Button size="sm" variant="link" onClick={() => setPicked({ view, ids: selected, all: false })}>
                  {tr(`只用已勾选的 ${n} 个`, `Only the ${n} ticked`)}
                </Button>
              </span>
            ) : (
              total > n && (
                <Button size="sm" variant="link" onClick={() => setPicked({ view, ids: selected, all: true })}>
                  {tr(`选择全部匹配的 ${total} 个`, `Select all ${total} matching`)}
                </Button>
              )
            )}
            <Button size="sm" variant="outline" onClick={() => setBatch(scope())}>
              {tr("批量操作", "Bulk action")}
            </Button>
            {(!allMatching || filtered) && (
              <Button
                size="sm"
                variant="destructive-soft"
                icon={Trash2}
                loading={deleting}
                onClick={async () => {
                  const s = scope();
                  if (await startDelete(s.selection, s.label)) clearSelection();
                }}
              >
                {tr("删除", "Delete")}
              </Button>
            )}
          </>
        )}
        footer={
          <Pager
            total={total}
            offset={f.offset}
            limit={f.limit}
            onOffset={(o) => setQuery({ offset: o ? String(o) : null })}
            onLimit={(l) => setQuery({ limit: l === DEFAULT_LIMIT ? null : String(l), offset: null })}
          />
        }
      />
      <div className="mt-4">
        <BatchJobs />
      </div>
      {open && (
        <UserDetail
          key={open}
          id={open}
          plans={plans.data ?? []}
          tab={query.get("tab") ?? ""}
          onTab={(t) => setQuery({ tab: t === "overview" ? null : t })}
          onClose={() => setQuery({ open: null, tab: null })}
        />
      )}
      {creating && <CreateUserDialog plans={plans.data ?? []} onClose={() => setQuery({ new: null })} />}
      {batch && (
        <BatchDialog
          selection={batch.selection}
          label={batch.label}
          plans={plans.data ?? []}
          onClose={() => setBatch(null)}
          onDone={() => {
            setBatch(null);
            clearSelection();
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
      return tr("未知", "Unknown");
  }
}

/** Find a user by address (exact or prefix) for pickers (manual orders, balances). */
export async function findUsers(q: string): Promise<UserRow[]> {
  const r = await get<{ users: UserRow[] }>(`/users${qs({ q, limit: 8 })}`);
  return r.users;
}
