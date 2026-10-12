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
import { ago, bytes, dateOnly, dateTime, pct, yuan } from "../../shared/format";
import { useLang, useTr, type Tr } from "../../shared/i18n";
import { cn } from "../../shared/cn";
import { DataTable, FilterChip, PAGE_SIZES, Pager, type Column } from "../../shared/ui/table";
import { useDebounced } from "../kit";
import { setQuery, useRoute } from "../router";
import type { PlanView } from "../types";
import { BatchDialog, BatchJobs, useBulkDelete, type Kind, type Selection, type UserFilter } from "./user-batch";
import { CreateUserDialog, UserDetail } from "./user-detail";
import {
  Ban,
  CalendarPlus,
  Clock,
  Download,
  Filter,
  Gauge,
  KeyRound,
  Layers,
  Mail,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button, ButtonLink } from "../../shared/ui/button";
import { Field, Input, Segmented, Select, SwitchField } from "../../shared/ui/form";
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
export function userStatus(u: UserRow, tr: Tr): { label: string; tone: Tone; icon?: LucideIcon } {
  if (u.erased) return { label: tr("已注销", "Erased"), tone: "outline", icon: UserX };
  if (!u.enabled && u.disabled_reason !== "quota") return { label: tr("已封禁", "Banned"), tone: "danger", icon: Ban };
  if (!u.enabled) return { label: tr("流量用尽", "Over quota"), tone: "warning", icon: Gauge };
  if (u.role === "user" && u.expires_at && Date.parse(u.expires_at) <= Date.now())
    return { label: tr("已到期", "Expired"), tone: "warning", icon: Clock };
  if (u.role === "user" && !u.plan_id) return { label: tr("无套餐", "No plan"), tone: "outline", icon: RotateCcw };
  return { label: tr("正常", "Active"), tone: "success" };
}

/** The status pill (dot when active, else an icon), as in the design. */
export function UserStatusBadge({ user }: { user: UserRow }) {
  const tr = useTr();
  const s = userStatus(user, tr);
  const Icon = s.icon;
  return (
    <Badge tone={s.tone} dot={!Icon}>
      {Icon && <Icon aria-hidden="true" />}
      {s.label}
    </Badge>
  );
}

/** Avatar colours (chart tokens, so both themes are covered). */
const HUES = ["--chart-1", "--chart-3", "--chart-7", "--chart-5", "--chart-2", "--chart-6"];

/** The address's initial on a soft gradient of a colour picked from the address. */
export function Avatar({ email, large, className }: { email: string; large?: boolean; className?: string }) {
  const c = `var(${HUES[(email.charCodeAt(0) || 0) % HUES.length]})`;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white uppercase",
        large ? "size-10 text-headline" : "size-[30px] text-footnote",
        className,
      )}
      style={{ background: `linear-gradient(180deg, color-mix(in srgb, ${c}, white 22%), ${c})` }}
    >
      {email.slice(0, 1) || "?"}
    </span>
  );
}

export function usePlans() {
  return useQuery({ queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") });
}

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
/** The status segments: four server statuses, plus "never used" (D10). */
type Seg = "" | "all" | "active" | "expired" | "quota" | "banned" | "never";
const SORTS = ["-created", "created", "email", "-traffic", "expires"];

function sortName(s: string, tr: Tr): string {
  switch (s) {
    case "created":
      return tr("注册时间（旧→新）", "Oldest first");
    case "email":
      return tr("邮箱", "Email");
    case "-traffic":
      return tr("已用流量（多→少）", "Most traffic");
    case "expires":
      return tr("到期（近→远）", "Expiring soonest");
    default:
      return tr("注册时间（新→旧）", "Newest first");
  }
}

export function UsersPage() {
  const tr = useTr();
  const lang = useLang();
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
  // The header's "N active" (the same list endpoint, one row).
  const active = useQuery({
    queryKey: ["users", "active-count"],
    queryFn: () => get<{ total: number }>(`/users${qs({ status: "active", limit: 1 })}`),
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

  const [batch, setBatch] = useState<{ selection: Selection; label: string; kind?: Kind } | null>(null);
  const [startDelete, deleting] = useBulkDelete();
  const [more, setMore] = useState(false);
  const planName = (id: string) =>
    id === "none"
      ? tr("无套餐", "No plan")
      : (plans.data?.find((p) => p.id === id)?.name ?? tr("已删除的套餐", "Deleted plan"));

  // The segments show the status filter, or "never used" on its own; any
  // other combination (erased, or both) is shown as chips instead.
  const seg: Seg = f.never_used
    ? f.status
      ? ""
      : "never"
    : !f.status
      ? "all"
      : f.status === "erased"
        ? ""
        : (f.status as Seg);
  const onSeg = (v: Seg) =>
    set(
      v === "all"
        ? { status: null, never_used: null }
        : v === "never"
          ? { status: null, never_used: "1" }
          : { status: v || null, never_used: null },
    );

  const traffic = (u: UserRow) => {
    const p = pct(u.traffic_used_bytes, u.traffic_limit_bytes);
    return { p, limited: u.traffic_limit_bytes !== null };
  };

  const columns: Column<UserRow>[] = [
    {
      key: "email",
      header: tr("用户", "User"),
      label: tr("用户", "User"),
      fixed: true,
      mobile: "title",
      className: "md:min-w-64",
      cell: (u) => {
        const t = traffic(u);
        return (
          <div className="flex min-w-0 items-center gap-2.5 max-md:gap-3">
            <Avatar email={u.email_pending ? "?" : u.email} className="max-md:size-9 max-md:text-callout" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-body font-medium">
                <span className="min-w-0 break-all">
                  {u.email_pending ? tr("（待绑定邮箱）", "(email pending)") : u.email}
                </span>
                {u.is_owner && (
                  <Badge tone="primary" className="px-1.5 text-caption">
                    {tr("所有者", "Owner")}
                  </Badge>
                )}
                {u.role === "admin" && !u.is_owner && (
                  <Badge tone="outline" className="px-1.5 text-caption">
                    {tr("管理员", "Admin")}
                  </Badge>
                )}
                {u.email_pending && (
                  <Badge tone="warning" className="px-1.5 text-caption">
                    {tr("待绑定邮箱", "Email pending")}
                  </Badge>
                )}
                {!u.email_verified && !u.erased && !u.email_pending && (
                  <Badge tone="warning" className="px-1.5 text-caption">
                    {tr("未验证", "Unverified")}
                  </Badge>
                )}
                {u.signup_method === "passkey" && (
                  <KeyRound
                    className="size-3 shrink-0 text-faint"
                    aria-label={tr("通行密钥注册", "Signed up with a passkey")}
                  />
                )}
              </div>
              <div className="tnum text-footnote font-normal text-faint max-md:hidden">
                {tr(`注册于 ${dateOnly(u.created_at)}`, `Signed up ${dateOnly(u.created_at)}`)}
              </div>
              {/* Phone card: status and plan, then the usage bar. */}
              <div className="mt-1 flex min-w-0 items-center gap-2 font-normal md:hidden">
                <UserStatusBadge user={u} />
                <span className="truncate text-footnote text-muted-foreground">
                  {u.plan_name ?? (u.role === "admin" ? "" : tr("无套餐", "No plan"))}
                </span>
              </div>
              {t.limited && (
                <div className="mt-1.5 flex items-center gap-2 font-normal md:hidden">
                  <Meter value={t.p} tone={usageTone(t.p)} className="flex-1" label={tr("流量用量", "Traffic used")} />
                  <span className="tnum text-caption text-muted-foreground">{t.p.toFixed(0)}%</span>
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      key: "status",
      header: tr("状态", "Status"),
      mobile: "hide",
      cell: (u) => <UserStatusBadge user={u} />,
    },
    {
      key: "plan",
      header: tr("套餐", "Plan"),
      mobile: "hide",
      cell: (u) =>
        u.plan_name ?? <span className="text-faint">{u.role === "admin" ? "—" : tr("无套餐", "No plan")}</span>,
    },
    {
      key: "traffic",
      header: tr("本周期流量", "Traffic this period"),
      mobile: "hide",
      className: "md:min-w-44",
      cell: (u) => {
        const t = traffic(u);
        return (
          <div className="grid gap-1">
            <div className="tnum flex justify-between gap-2 text-caption text-muted-foreground">
              <span>
                {bytes(u.traffic_used_bytes)}
                {t.limited ? ` / ${bytes(u.traffic_limit_bytes)}` : ""}
              </span>
              {t.limited && <span>{t.p.toFixed(0)}%</span>}
            </div>
            {t.limited && <Meter value={t.p} tone={usageTone(t.p)} label={tr("流量用量", "Traffic used")} />}
          </div>
        );
      },
    },
    {
      key: "expires",
      header: tr("到期", "Expires"),
      mobile: "hide",
      cell: (u) => <span className="tnum">{dateOnly(u.expires_at)}</span>,
    },
    {
      key: "last_login",
      header: tr("最后登录", "Last sign-in"),
      mobile: "hide",
      cell: (u) =>
        u.last_login_at ? (
          <span className="text-muted-foreground" title={dateTime(u.last_login_at)}>
            {ago(u.last_login_at, lang)}
          </span>
        ) : (
          <span className="text-muted-foreground">{tr("从未", "never")}</span>
        ),
    },
    {
      key: "created",
      header: tr("注册时间", "Signed up"),
      optional: true,
      cell: (u) => <span className="tnum">{dateOnly(u.created_at)}</span>,
    },
    {
      key: "balance",
      header: tr("余额", "Balance"),
      optional: true,
      cell: (u) => yuan(u.balance_cents),
      align: "right",
    },
    {
      key: "passkeys",
      header: tr("通行密钥", "Passkeys"),
      optional: true,
      cell: (u) => u.passkeys,
      align: "right",
    },
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

  // Chips: what the segments and the search box do not already show.
  const chips: { label: string; value: string; clear: Record<string, null> }[] = [];
  if (f.status && seg === "")
    chips.push({ label: tr("状态", "Status"), value: statusName(f.status, tr), clear: { status: null } });
  if (f.never_used && seg === "")
    chips.push({ label: tr("从未使用", "Never used"), value: tr("是", "yes"), clear: { never_used: null } });
  if (f.plan_id) chips.push({ label: tr("套餐", "Plan"), value: planName(f.plan_id), clear: { plan: null } });
  if (f.role)
    chips.push({
      label: tr("角色", "Role"),
      value: f.role === "admin" ? tr("管理员", "Admin") : tr("用户", "User"),
      clear: { role: null },
    });
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
  if (f.sort !== "-created")
    chips.push({ label: tr("排序", "Sort"), value: sortName(f.sort, tr), clear: { sort: null } });

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
          users.data ? (
            filtered ? (
              tr(`${total.toLocaleString()} 个账户符合筛选`, `${total.toLocaleString()} accounts match`)
            ) : (
              <>
                {tr("共 ", "")}
                <span className="tnum">{total.toLocaleString()}</span>
                {tr(" 个账户", " accounts")}
                {active.data && (
                  <>
                    {" · "}
                    {tr("正常 ", "")}
                    <span className="tnum">{active.data.total.toLocaleString()}</span>
                    {tr("", " active")}
                  </>
                )}
              </>
            )
          ) : (
            tr("账户、套餐与流量。", "Accounts, plans and traffic.")
          )
        }
        actions={
          <>
            <ButtonLink
              href={exportHref}
              download
              variant="outline"
              icon={Download}
              aria-label={tr("导出 CSV", "Export CSV")}
            >
              <span className="max-sm:hidden">{tr("导出 CSV", "Export CSV")}</span>
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
            <div className="relative min-w-0 flex-1 basis-60">
              <Search
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-faint"
                aria-hidden="true"
              />
              <Input
                type="search"
                aria-label={tr("搜索邮箱或 ID", "Search email or id")}
                placeholder={tr("邮箱、用户 ID", "Email, user ID")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <Segmented<Seg>
              label={tr("状态", "Status")}
              value={seg}
              onChange={onSeg}
              options={[
                { value: "all", label: tr("全部", "All") },
                { value: "active", label: tr("正常", "Active") },
                { value: "expired", label: tr("已到期", "Expired") },
                { value: "quota", label: tr("流量用尽", "Over quota") },
                { value: "banned", label: tr("已封禁", "Banned") },
                { value: "never", label: tr("从未使用", "Never used") },
              ]}
            />
            <Popover
              open={more}
              onOpenChange={setMore}
              align="end"
              label={tr("更多筛选", "More filters")}
              className="w-[min(18rem,calc(100vw-32px))] p-3"
              trigger={
                <Button variant="ghost" size="pill" icon={Filter} aria-label={tr("更多筛选", "More filters")}>
                  <span className="max-sm:hidden">{tr("套餐、注册时间…", "Plan, sign-up date…")}</span>
                </Button>
              }
            >
              <div className="space-y-3">
                <Field label={tr("套餐", "Plan")}>
                  <Select value={f.plan_id} onChange={(e) => set({ plan: e.target.value || null })}>
                    <option value="">{tr("全部套餐", "Any plan")}</option>
                    <option value="none">{tr("无套餐", "No plan")}</option>
                    {(plans.data ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={tr("排序", "Sort")}>
                  <Select
                    value={f.sort}
                    onChange={(e) => set({ sort: e.target.value === "-created" ? null : e.target.value })}
                  >
                    {SORTS.map((s) => (
                      <option key={s} value={s}>
                        {sortName(s, tr)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={tr("角色", "Role")}>
                  <Select value={f.role} onChange={(e) => set({ role: e.target.value || null })}>
                    <option value="">{tr("全部", "Any")}</option>
                    <option value="user">{tr("用户", "User")}</option>
                    <option value="admin">{tr("管理员", "Admin")}</option>
                  </Select>
                </Field>
                <SwitchField
                  label={tr("只看已注销", "Erased only")}
                  description={tr("有财务记录、匿名化保留的账户", "Accounts kept anonymized for their finance records")}
                  checked={f.status === "erased"}
                  onChange={(v) => set({ status: v ? "erased" : null })}
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
            {(chips.length > 0 || filtered) && (
              <div className="flex w-full flex-wrap items-center gap-2">
                {chips.map((c) => (
                  <FilterChip key={c.label} label={c.label} value={c.value} onClear={() => set(c.clear)} />
                ))}
                {filtered && (
                  <Button size="sm" variant="ghost" onClick={clearFilters}>
                    {tr("清除筛选", "Clear filters")}
                  </Button>
                )}
              </div>
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
            <Button
              size="sm"
              variant="outline"
              icon={CalendarPlus}
              className="max-sm:hidden"
              onClick={() => setBatch({ ...scope(), kind: "extend_expiry" })}
            >
              {tr("延长", "Extend")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              icon={Mail}
              className="max-sm:hidden"
              onClick={() => setBatch({ ...scope(), kind: "send_email" })}
            >
              {tr("发邮件", "Email")}
            </Button>
            <Button size="sm" variant="outline" icon={Ban} onClick={() => setBatch({ ...scope(), kind: "ban" })}>
              {tr("封禁", "Ban")}
            </Button>
            <Button size="sm" variant="outline" icon={Layers} onClick={() => setBatch(scope())}>
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
            totalLabel={tr(`${total.toLocaleString()} 个结果`, `${total.toLocaleString()} results`)}
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
          initialKind={batch.kind}
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
