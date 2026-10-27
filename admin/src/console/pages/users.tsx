// 用户 (USR-01…05, 24…28), v2: find one person, or act on a group.
// Left: the view rail (fixed presets with live counts, then 按套餐; phone:
// horizontal pills). Right: search (/), 更多筛选, sort, columns, filter
// chips + "匹配 N 个", the list (window-virtualized), the pager. Ticking
// rows raises the floating SelectionBar (batch wizard, bulk delete); the
// header has 批量任务 (jobs popover), 导出 CSV (same filters) and 新建用户.
// The detail dialog is user-detail.tsx; batch UI is user-batch.tsx.
// URL: ?view= &q= &plan= &role= &never=1 &reg= &login= &sort= &cols= &size=
// &page= &open= &tab= &new=1 &jobs=1 &job=<id> &status=.
import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDownUp,
  Ban,
  CalendarClock,
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleOff,
  Columns3,
  Copy,
  Crown,
  Download,
  Gauge,
  KeyRound,
  Layers,
  ListFilter,
  Mail,
  MailWarning,
  Plus,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Trash2,
  UserRound,
  UserX,
  Users as UsersIcon,
  Wallet,
  X,
  Clock,
  Ellipsis,
  ListChecks,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { apiBase } from "../../shared/base";
import { get, post, qs } from "../../shared/api";
import { cn } from "../../shared/cn";
import { bytes, copyText, dateOnly, pct, yuan } from "../../shared/format";
import { useTr, type Tr } from "../../shared/i18n";
import { Badge, type Tone } from "../../shared/ui/badge";
import { Button, ButtonLink } from "../../shared/ui/button";
import { useConfirm } from "../../shared/ui/confirm";
import { Checkbox, Field, Input, Kbd, Segmented, Select } from "../../shared/ui/form";
import { PageHeader } from "../../shared/ui/layout";
import { Menu, MenuItem, MenuLabel, MenuSeparator, Popover } from "../../shared/ui/menu";
import { Meter, usageTone } from "../../shared/ui/meter";
import { EmptyState, ErrorState, SkeletonRows } from "../../shared/ui/states";
import { FilterChip } from "../../shared/ui/table";
import { useToast } from "../../shared/ui/toast";
import { Avatar as KitAvatar, RelDays, SearchField, SelectionBar } from "../components/kit";
import { UserStatus } from "../components/status";
import { useAction } from "../data";
import { useDebounced } from "../kit";
import { navigate, useQS } from "../router";
import type { PlanView } from "../types";
import {
  BatchDialog,
  JobDialog,
  JobsButton,
  jobsQuery,
  useBulkDelete,
  type Kind,
  type Selection,
  type UserFilter,
} from "./user-batch";
import { CreateUserDialog, UserDetail } from "./user-detail";

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
  /** The inviter's current address (null: none, or the account is gone). */
  inviter_email: string | null;
  /** The last site day with traffic (YYYY-MM-DD), null = never. */
  last_traffic_day: string | null;
};

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

/** The status pill (dot when active, else an icon). */
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

/** The address's initial on a colour picked from the address (kit Avatar). */
export function Avatar({ email, large, className }: { email: string; large?: boolean; className?: string }) {
  return <KitAvatar name={email || "?"} size={large ? 40 : 30} className={className} />;
}

const plansQuery = { queryKey: ["plans"], queryFn: () => get<PlanView[]>("/plans") };

export function usePlans() {
  return useQuery(plansQuery);
}

/** Find a user by address (exact or prefix) for pickers (manual orders, balances). */
export async function findUsers(q: string): Promise<UserRow[]> {
  const r = await get<{ users: UserRow[] }>(`/users${qs({ q, limit: 8 })}`);
  return r.users;
}

/** Owner / admin / unverified / pending marks after the address. */
export function UserMarks({ u, compact }: { u: UserRow; compact?: boolean }) {
  const tr = useTr();
  return (
    <>
      {u.is_owner && (
        <Badge tone="primary" className="px-1.5 text-caption" title={tr("所有者", "Owner")}>
          <Crown aria-hidden="true" />
          {compact ? <span className="sr-only">{tr("所有者", "Owner")}</span> : tr("所有者", "Owner")}
        </Badge>
      )}
      {u.role === "admin" && !u.is_owner && (
        <Badge tone="info" className="px-1.5 text-caption" title={tr("管理员", "Admin")}>
          <ShieldCheck aria-hidden="true" />
          {compact ? <span className="sr-only">{tr("管理员", "Admin")}</span> : tr("管理员", "Admin")}
        </Badge>
      )}
      {u.email_pending ? (
        <Badge tone="warning" className="px-1.5 text-caption">
          {tr("待绑定邮箱", "Email pending")}
        </Badge>
      ) : (
        !u.email_verified &&
        !u.erased && (
          <Badge tone="warning" className="px-1.5 text-caption" title={tr("邮箱未验证", "Email not verified")}>
            <MailWarning aria-hidden="true" />
            {compact ? <span className="sr-only">{tr("未验证", "Unverified")}</span> : tr("未验证", "Unverified")}
          </Badge>
        )
      )}
      {u.signup_method === "passkey" && (
        <KeyRound className="size-3 shrink-0 text-faint" aria-label={tr("通行密钥注册", "Signed up with a passkey")} />
      )}
    </>
  );
}

/** Used / total + percentage + meter of the current period. */
export function TrafficCell({ u }: { u: UserRow }) {
  const tr = useTr();
  if (u.traffic_limit_bytes === null)
    return <span className="tnum text-caption text-muted-foreground">{bytes(u.traffic_used_bytes)}</span>;
  const p = pct(u.traffic_used_bytes, u.traffic_limit_bytes);
  return (
    <div className="grid min-w-0 gap-1">
      <div className="flex justify-between gap-2 text-caption text-muted-foreground">
        <span className="tnum truncate">
          {u.traffic_used_bytes === 0
            ? tr("未使用", "Unused")
            : `${bytes(u.traffic_used_bytes)} / ${bytes(u.traffic_limit_bytes)}`}
        </span>
        <span className={cn("tnum", p >= 100 ? "text-destructive" : p >= 80 && "text-warning")}>{p.toFixed(0)}%</span>
      </div>
      <Meter value={p} tone={usageTone(p)} label={tr("流量用量", "Traffic used")} />
    </div>
  );
}

/* ---------- Views ---------- */

export type Counts = {
  all: number;
  active: number;
  expiring: number;
  usage80: number;
  lapsed: number;
  never: number;
  banned: number;
  admins: number;
  unverified: number;
  erased?: number;
  week_new?: number;
};
type ViewId = "all" | "active" | "expiring" | "quota" | "lapsed" | "never" | "banned" | "admins" | "unverified";
type ViewDef = {
  id: ViewId;
  icon: LucideIcon;
  count: keyof Counts;
  tone?: "warning" | "danger";
  params: Partial<UserFilter>;
  label: (tr: Tr) => string;
  hint: (tr: Tr) => string;
};
const VIEWS: ViewDef[] = [
  {
    id: "all",
    icon: UsersIcon,
    count: "all",
    params: {},
    label: (tr) => tr("全部", "All"),
    hint: (tr) => tr("所有账户（含已注销的匿名记录）", "Every account (incl. anonymized ones)"),
  },
  {
    id: "active",
    icon: Check,
    count: "active",
    params: { status: "active" },
    label: (tr) => tr("正常", "Active"),
    hint: (tr) => tr("未封禁、未到期、未用尽", "Not banned, expired or over quota"),
  },
  {
    id: "expiring",
    icon: CalendarClock,
    count: "expiring",
    tone: "warning",
    params: { view: "expiring" },
    label: (tr) => tr("7 天内到期", "Expiring in 7 days"),
    hint: (tr) => tr("提醒续费的最佳时机", "The time to remind them to renew"),
  },
  {
    id: "quota",
    icon: Gauge,
    count: "usage80",
    tone: "warning",
    params: { view: "usage80" },
    label: (tr) => tr("流量将尽", "Traffic running out"),
    hint: (tr) => tr("本周期已用 ≥ 80%", "≥ 80% used this period"),
  },
  {
    id: "lapsed",
    icon: CircleOff,
    count: "lapsed",
    tone: "warning",
    params: { view: "lapsed" },
    label: (tr) => tr("已到期 · 用尽", "Expired · over quota"),
    hint: (tr) => tr("需要续费或重置流量", "Need a renewal or a traffic reset"),
  },
  {
    id: "never",
    icon: UserRound,
    count: "never",
    params: { never_used: true },
    label: (tr) => tr("从未使用", "Never used"),
    hint: (tr) => tr("注册后没有套餐、订单与流量", "No plan, order or traffic since signing up"),
  },
  {
    id: "banned",
    icon: Ban,
    count: "banned",
    tone: "danger",
    params: { status: "banned" },
    label: (tr) => tr("已封禁", "Banned"),
    hint: (tr) => tr("订阅已停用", "Subscription stopped"),
  },
  {
    id: "admins",
    icon: ShieldCheck,
    count: "admins",
    params: { role: "admin" },
    label: (tr) => tr("管理员", "Admins"),
    hint: (tr) => tr("所有者与管理员", "The owner and admins"),
  },
  {
    id: "unverified",
    icon: MailWarning,
    count: "unverified",
    params: { view: "unverified" },
    label: (tr) => tr("邮箱未验证", "Email not verified"),
    hint: (tr) => tr("可在详情里手动标记已验证", "Mark verified in the detail"),
  },
];

const SORTS = ["-created", "expires", "-usage", "-login", "-balance", "created", "email", "-traffic"];
function sortName(s: string, tr: Tr): string {
  switch (s) {
    case "created":
      return tr("注册时间（旧 → 新）", "Signed up (oldest first)");
    case "expires":
      return tr("到期时间（近 → 远）", "Expiry (soonest first)");
    case "-usage":
      return tr("流量使用率（高 → 低）", "Traffic used (highest %)");
    case "-login":
      return tr("最后登录（近 → 远）", "Last sign-in (latest first)");
    case "-balance":
      return tr("余额（高 → 低）", "Balance (highest first)");
    case "email":
      return tr("邮箱（A → Z）", "Email (A → Z)");
    case "-traffic":
      return tr("已用流量（多 → 少）", "Traffic used (most first)");
    default:
      return tr("注册时间（新 → 旧）", "Signed up (newest first)");
  }
}
const shortSort = (s: string, tr: Tr) =>
  sortName(s, tr)
    .replace(/[（(].*$/, "")
    .trim();

type OptCol = "login" | "balance" | "passkeys" | "inviter" | "signup";
const OPT_COLS: OptCol[] = ["login", "balance", "passkeys", "inviter", "signup"];
function colName(c: OptCol, tr: Tr): string {
  return {
    login: tr("最后登录", "Last sign-in"),
    balance: tr("余额", "Balance"),
    passkeys: tr("通行密钥", "Passkeys"),
    inviter: tr("邀请人", "Invited by"),
    signup: tr("注册方式", "Signed up with"),
  }[c];
}
const COLS_KEY = "akari.admin.users.cols";
function readCols(): OptCol[] | null {
  try {
    const v = localStorage.getItem(COLS_KEY);
    return v === null ? null : (v.split(",").filter((c) => OPT_COLS.includes(c as OptCol)) as OptCol[]);
  } catch {
    return null;
  }
}
function writeCols(cols: OptCol[]) {
  try {
    localStorage.setItem(COLS_KEY, cols.join(","));
  } catch {
    /* storage blocked */
  }
}

const SIZES = [50, 100, 200];
const DEFAULT_SIZE = 50;

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

/* ---------- Data ---------- */

const paramsOf = (filter: UserFilter, sort: string) => ({
  ...filter,
  never_used: filter.never_used ? "true" : undefined,
  sort,
});

const listQuery = (filter: UserFilter, sort: string, offset: number, size: number) => ({
  queryKey: ["users", filter, sort, offset, size],
  queryFn: () =>
    get<{ users: UserRow[]; total: number }>(`/users${qs({ ...paramsOf(filter, sort), limit: size, offset })}`),
});

const countsQuery = {
  queryKey: ["users", "counts"],
  queryFn: () => get<{ counts?: Counts }>(`/users${qs({ counts: "true", limit: 1 })}`).then((r) => r.counts ?? null),
  staleTime: 30_000,
};

/** The default list (all accounts, newest first, first page) ahead of a visit (pages.ts). */
export function prefetchData(qc: QueryClient): void {
  const all: UserFilter = { ...(VIEWS.find((v) => v.id === "all")?.params ?? {}) };
  void qc.prefetchQuery<unknown>(listQuery(all, "-created", 0, DEFAULT_SIZE));
  void qc.prefetchQuery<unknown>(countsQuery);
  void qc.prefetchQuery<unknown>(plansQuery);
  void qc.prefetchQuery<unknown>(jobsQuery);
}

/* ---------- Page ---------- */

export function UsersPage() {
  const tr = useTr();
  const toast = useToast();
  const [query, patch] = useQS();
  const g = (k: string) => query.get(k) ?? "";

  const viewParam = g("view");
  const planView = viewParam.startsWith("plan:") ? viewParam.slice(5) : "";
  const view: ViewId | "plan" = planView
    ? "plan"
    : VIEWS.some((v) => v.id === viewParam)
      ? (viewParam as ViewId)
      : "all";
  const f = {
    q: g("q"),
    plan: g("plan"),
    role: g("role"),
    never: g("never") === "1",
    reg: g("reg"),
    login: g("login"),
    status: g("status"),
    sort: SORTS.includes(g("sort")) ? g("sort") : "-created",
    size: SIZES.includes(Number(g("size"))) ? Number(g("size")) : DEFAULT_SIZE,
    page: Math.max(1, Math.floor(Number(g("page"))) || 1),
  };
  const [stored] = useState(readCols);
  const cols: OptCol[] = query.has("cols")
    ? (g("cols")
        .split(",")
        .filter((c) => OPT_COLS.includes(c as OptCol)) as OptCol[])
    : (stored ?? ["login"]);

  const open = query.get("open");
  const creating = query.get("new") === "1";
  const jobId = query.get("job");

  // The filter sent to the list, the export and "all matching" batches.
  const viewDef = VIEWS.find((v) => v.id === view);
  const listFilter: UserFilter = {
    ...(viewDef?.params ?? {}),
    ...(planView ? { plan_id: planView } : {}),
    ...(f.q ? { q: f.q } : {}),
    ...(f.plan ? { plan_id: f.plan } : {}),
    ...(f.role ? { role: f.role } : {}),
    ...(f.never ? { never_used: true } : {}),
    ...(f.reg ? { registered_before: f.reg } : {}),
    ...(f.login ? { last_login_before: f.login } : {}),
    ...(f.status ? { status: f.status } : {}),
  };
  const filterParams = paramsOf(listFilter, f.sort);
  const offset = (f.page - 1) * f.size;
  const users = useQuery({ ...listQuery(listFilter, f.sort, offset, f.size), placeholderData: keepPreviousData });
  const counts = useQuery(countsQuery);
  const plans = usePlans();
  const rows = users.data?.users ?? [];
  const total = users.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / f.size));

  // Search box → URL (debounced 250 ms); URL → box (clear, Back, palette).
  const [search, setSearch] = useState(f.q);
  const debounced = useDebounced(search, 250);
  const [seenQ, setSeenQ] = useState(f.q);
  if (f.q !== seenQ) {
    setSeenQ(f.q);
    if (f.q !== debounced) setSearch(f.q);
  }
  useEffect(() => {
    if (debounced !== (query.get("q") ?? "")) patch({ q: debounced || null, page: null }, true);
  }, [debounced, query, patch]);

  const set = (o: Record<string, string | null>) => patch({ ...o, page: null });
  const planName = (id: string) =>
    id === "none"
      ? tr("无套餐", "No plan")
      : (plans.data?.find((p) => p.id === id)?.name ?? tr("已删除的套餐", "Deleted plan"));

  // Chips: what the view rail and the search box do not already show.
  const chips: { k: string; label: string; value: string; clear: Record<string, null> }[] = [];
  if (view !== "all" && viewDef)
    chips.push({ k: "view", label: tr("视图", "View"), value: viewDef.label(tr), clear: { view: null, filter: null } });
  if (planView) chips.push({ k: "pv", label: tr("套餐", "Plan"), value: planName(planView), clear: { view: null } });
  if (f.plan) chips.push({ k: "plan", label: tr("套餐", "Plan"), value: planName(f.plan), clear: { plan: null } });
  if (f.role)
    chips.push({
      k: "role",
      label: tr("角色", "Role"),
      value: f.role === "admin" ? tr("管理员", "Admin") : tr("普通用户", "User"),
      clear: { role: null },
    });
  if (f.never)
    chips.push({
      k: "never",
      label: tr("从未使用", "Never used"),
      value: "",
      clear: { never: null },
    });
  if (f.reg)
    chips.push({
      k: "reg",
      label: tr("注册早于", "Signed up before"),
      value: f.reg,
      clear: { reg: null },
    });
  if (f.login)
    chips.push({
      k: "login",
      label: tr("最后登录早于", "Last sign-in before"),
      value: f.login,
      clear: { login: null },
    });
  if (f.status)
    chips.push({ k: "status", label: tr("状态", "Status"), value: statusName(f.status, tr), clear: { status: null } });
  const filtered = chips.length > 0 || !!f.q;
  const clearAll = () => {
    setSearch("");
    patch({
      view: null,
      q: null,
      plan: null,
      role: null,
      never: null,
      reg: null,
      login: null,
      status: null,
      page: null,
    });
  };

  // Selection: belongs to one view (filters, sort, page, size).
  const selKey = JSON.stringify([listFilter, f.sort, f.page, f.size]);
  const [picked, setPicked] = useState<{ key: string; ids: Set<string>; all: boolean }>({
    key: selKey,
    ids: new Set(),
    all: false,
  });
  const sel = picked.key === selKey ? picked.ids : new Set<string>();
  const allMatching = picked.key === selKey && picked.all && sel.size > 0;
  const setSel = (ids: Set<string>) => setPicked({ key: selKey, ids, all: false });
  const clearSel = () => setPicked({ key: selKey, ids: new Set(), all: false });
  const toggle = (id: string) => {
    const n = new Set(sel);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setSel(n);
  };
  const [selMode, setSelMode] = useState(false);

  const scope = (): { selection: Selection; label: string; count: number } =>
    allMatching
      ? {
          selection: { filter: listFilter },
          count: total,
          label: filtered
            ? tr(`当前筛选的全部 ${total} 个账户`, `all ${total} accounts matching the filters`)
            : tr(`全部 ${total} 个账户`, `all ${total} accounts`),
        }
      : {
          selection: { ids: [...sel] },
          count: sel.size,
          label: tr(`已勾选的 ${sel.size} 个账户`, `${sel.size} ticked accounts`),
        };
  const [batch, setBatch] = useState<{ selection: Selection; label: string; count: number; kind?: Kind } | null>(null);
  const [startDelete, deleting] = useBulkDelete();
  const openBatch = (kind?: Kind) => setBatch({ ...scope(), kind });

  const exportHref = `${apiBase}/users/export.csv${qs(filterParams)}`;
  const viewLabel = planView ? `${tr("套餐", "Plan")} ${planName(planView)}` : (viewDef?.label(tr) ?? "");
  const openUser = (id: string) => patch({ open: id, tab: null });

  const c = counts.data;
  return (
    <>
      <PageHeader
        title={tr("用户", "Users")}
        description={
          c ? (
            <>
              <span className="tnum">{c.all.toLocaleString()}</span>
              {tr(" 个账户", " accounts")}
              <span className="max-sm:hidden">
                {" · "}
                {tr("正常 ", "")}
                <span className="tnum">{c.active.toLocaleString()}</span>
                {tr("", " active")}
              </span>
              {" · "}
              {tr("7 天内到期 ", "")}
              <button
                type="button"
                className="tnum font-medium text-warning hover:underline"
                onClick={() => set({ view: "expiring" })}
              >
                {c.expiring.toLocaleString()}
              </button>
              {tr("", " expiring in 7 days")}
            </>
          ) : (
            tr("账户、套餐与流量。", "Accounts, plans and traffic.")
          )
        }
        actions={
          <>
            <JobsButton />
            <ButtonLink
              href={exportHref}
              download
              variant="outline"
              icon={Download}
              className="max-sm:hidden"
              aria-label={tr("导出 CSV", "Export CSV")}
              onClick={() =>
                toast({
                  tone: "success",
                  title: tr(`正在导出 ${total.toLocaleString()} 个用户`, `Exporting ${total.toLocaleString()} users`),
                  description:
                    tr("筛选与列表一致：", "Same filters as the list: ") +
                    [
                      viewLabel,
                      ...chips.filter((x) => x.k !== "view" && x.k !== "pv").map((x) => `${x.label} ${x.value}`.trim()),
                      ...(f.q ? [`“${f.q}”`] : []),
                    ].join(tr("、", ", ")),
                })
              }
            >
              {tr("导出 CSV", "Export CSV")}
            </ButtonLink>
            <Button variant="primary" icon={Plus} onClick={() => patch({ new: "1" })}>
              {tr("新建用户", "New user")}
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[212px_minmax(0,1fr)] lg:gap-5">
        <ViewRail
          view={planView ? `plan:${planView}` : view}
          counts={c ?? null}
          plans={plans.data ?? []}
          onPick={(v) => set({ view: v === "all" ? null : v, filter: null, plan: null })}
        />

        <div className="min-w-0 overflow-hidden rounded-xl bg-card shadow-card">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-separator p-3">
            <SearchField
              value={search}
              onChange={setSearch}
              label={tr("搜索邮箱或 ID", "Search email or id")}
              placeholder={tr("邮箱，或用户 ID 前缀", "Email, or a user id prefix")}
              shortcut="/"
              className="min-w-0 flex-1 basis-56"
            />
            <MoreFilters
              value={{ plan: f.plan, role: f.role, never: f.never, reg: f.reg, login: f.login }}
              plans={plans.data ?? []}
              count={[f.plan, f.role, f.never ? "1" : "", f.reg, f.login].filter(Boolean).length}
              onApply={set}
            />
            <Menu
              label={tr("排序", "Sort")}
              trigger={
                <Button variant="ghost" size="pill" icon={ArrowDownUp} aria-label={tr("排序", "Sort")}>
                  <span className="max-sm:hidden">{shortSort(f.sort, tr)}</span>
                </Button>
              }
            >
              <MenuLabel>{tr("排序", "Sort")}</MenuLabel>
              {SORTS.map((s) => (
                <MenuItem
                  key={s}
                  icon={s === f.sort ? Check : Blank}
                  onClick={() => set({ sort: s === "-created" ? null : s })}
                >
                  {sortName(s, tr)}
                </MenuItem>
              ))}
            </Menu>
            <Popover
              label={tr("显示的列", "Visible columns")}
              className="w-56"
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  icon={Columns3}
                  className="rounded-full max-md:hidden"
                  aria-label={tr("显示的列", "Visible columns")}
                />
              }
            >
              <div className="px-2 pt-1 pb-1.5 text-caption font-semibold text-faint">
                {tr("显示的列（会记住）", "Visible columns (remembered)")}
              </div>
              {OPT_COLS.map((k) => (
                <label
                  key={k}
                  className="flex h-8 items-center gap-2.5 rounded-[7px] px-2 text-body hover:bg-accent pointer-coarse:h-11"
                >
                  <Checkbox
                    checked={cols.includes(k)}
                    label={colName(k, tr)}
                    onChange={() => {
                      const n = cols.includes(k) ? cols.filter((x) => x !== k) : [...cols, k];
                      writeCols(n);
                      patch({ cols: n.join(",") }, true);
                    }}
                  />
                  {colName(k, tr)}
                </label>
              ))}
            </Popover>
            <Button
              variant={selMode || sel.size ? "soft" : "ghost"}
              size="pill"
              className="md:hidden"
              onClick={() => {
                if (selMode || sel.size) {
                  setSelMode(false);
                  clearSel();
                } else setSelMode(true);
              }}
            >
              {selMode || sel.size ? tr("完成", "Done") : tr("选择", "Select")}
            </Button>
          </div>
          {filtered && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-separator px-3 py-2">
              {chips.map((x) => (
                <FilterChip key={x.k} label={x.label} value={x.value} onClear={() => set(x.clear)} />
              ))}
              <Button size="sm" variant="ghost" onClick={clearAll}>
                {tr("清除全部", "Clear all")}
              </Button>
              {users.data && (
                <span className="tnum ml-auto text-footnote text-muted-foreground">
                  {tr(`匹配 ${total.toLocaleString()} 个`, `${total.toLocaleString()} match`)}
                </span>
              )}
            </div>
          )}

          <UserList
            rows={rows}
            state={
              users.isPending
                ? "loading"
                : users.error && !users.data
                  ? "error"
                  : rows.length === 0
                    ? filtered
                      ? "nomatch"
                      : "empty"
                    : "ok"
            }
            error={users.error}
            onRetry={() => void users.refetch()}
            cols={cols}
            sel={sel}
            selMode={selMode || sel.size > 0}
            activeId={open}
            onToggle={toggle}
            onTogglePage={(all) => setSel(all ? new Set() : new Set([...sel, ...rows.map((u) => u.id)]))}
            onOpen={openUser}
            onClear={clearAll}
            onCreate={() => patch({ new: "1" })}
          />

          {rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-separator px-4 py-2 text-footnote text-muted-foreground">
              <span className="tnum">
                {tr(
                  `第 ${(offset + 1).toLocaleString()}–${Math.min(offset + f.size, total).toLocaleString()} 个，共 ${total.toLocaleString()} 个`,
                  `${(offset + 1).toLocaleString()}–${Math.min(offset + f.size, total).toLocaleString()} of ${total.toLocaleString()}`,
                )}
              </span>
              <span className="hidden items-center gap-1.5 sm:inline-flex">
                {tr("每页", "Per page")}
                <Segmented
                  size="sm"
                  label={tr("每页条数", "Rows per page")}
                  value={String(f.size)}
                  onChange={(v) => set({ size: Number(v) === DEFAULT_SIZE ? null : v })}
                  options={SIZES.map((n) => ({ value: String(n), label: String(n) }))}
                />
              </span>
              <span className="ml-auto inline-flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  icon={ChevronLeft}
                  disabled={f.page <= 1}
                  aria-label={tr("上一页", "Previous page")}
                  onClick={() => patch({ page: f.page - 1 > 1 ? String(f.page - 1) : null })}
                />
                <span className="tnum inline-flex items-center gap-1">
                  <PageJump page={f.page} pages={pages} onJump={(p) => patch({ page: p > 1 ? String(p) : null })} /> /{" "}
                  {pages}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  icon={ChevronRight}
                  disabled={f.page >= pages}
                  aria-label={tr("下一页", "Next page")}
                  onClick={() => patch({ page: String(f.page + 1) })}
                />
              </span>
              <span className="hidden xl:inline">
                <Kbd>J</Kbd> <Kbd>K</Kbd> {tr("移动", "move")} · <Kbd>↵</Kbd> {tr("打开", "open")} · <Kbd>X</Kbd>{" "}
                {tr("勾选", "tick")}
              </span>
            </div>
          )}
        </div>
      </div>

      <SelectionBar
        count={sel.size}
        total={total}
        allMatching={allMatching}
        onAll={() => setPicked({ key: selKey, ids: sel, all: true })}
        onClear={() => {
          clearSel();
          setSelMode(false);
        }}
      >
        <Button
          size="sm"
          variant="ghost"
          icon={CalendarPlus}
          aria-label={tr("延长", "Extend")}
          onClick={() => openBatch("extend_expiry")}
        >
          <span className="max-sm:hidden">{tr("延长", "Extend")}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={RefreshCcw}
          aria-label={tr("重置流量", "Reset traffic")}
          onClick={() => openBatch("reset_traffic")}
        >
          <span className="max-sm:hidden">{tr("重置流量", "Reset traffic")}</span>
        </Button>
        <Button size="sm" variant="ghost" icon={Ban} aria-label={tr("封禁", "Ban")} onClick={() => openBatch("ban")}>
          <span className="max-sm:hidden">{tr("封禁", "Ban")}</span>
        </Button>
        <Menu
          label={tr("更多批量操作", "More bulk actions")}
          trigger={
            <Button size="sm" variant="ghost" icon={Ellipsis} aria-label={tr("更多批量操作", "More bulk actions")} />
          }
        >
          <MenuItem icon={ShieldOff} onClick={() => openBatch("unban")}>
            {tr("解除封禁", "Unban")}
          </MenuItem>
          <MenuItem icon={Layers} onClick={() => openBatch("set_plan")}>
            {tr("分配 / 更换套餐", "Assign / change plan")}
          </MenuItem>
          <MenuItem icon={CircleOff} onClick={() => openBatch("cancel_plan")}>
            {tr("取消套餐", "Cancel plan")}
          </MenuItem>
          <MenuItem icon={Wallet} onClick={() => openBatch("add_balance")}>
            {tr("调整余额", "Adjust balance")}
          </MenuItem>
          <MenuItem icon={Mail} onClick={() => openBatch("send_email")}>
            {tr("发送邮件", "Send email")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={ListChecks} onClick={() => openBatch()}>
            {tr("选择操作…", "Choose an action…")}
          </MenuItem>
        </Menu>
        {(!allMatching || filtered) && (
          <Button
            size="sm"
            variant="destructive-soft"
            icon={Trash2}
            loading={deleting}
            aria-label={tr("删除", "Delete")}
            onClick={async () => {
              const s = scope();
              if (await startDelete(s.selection, s.label)) clearSel();
            }}
          >
            <span className="max-sm:hidden">{tr("删除", "Delete")}</span>
          </Button>
        )}
      </SelectionBar>

      {open && (
        <UserDetail
          key={open}
          id={open}
          plans={plans.data ?? []}
          tab={query.get("tab") ?? ""}
          onTab={(t) => patch({ tab: t === "overview" ? null : t }, true)}
          onClose={() => patch({ open: null, tab: null })}
        />
      )}
      {creating && <CreateUserDialog plans={plans.data ?? []} onClose={() => patch({ new: null })} />}
      {batch && (
        <BatchDialog
          selection={batch.selection}
          label={batch.label}
          count={batch.count}
          initialKind={batch.kind}
          plans={plans.data ?? []}
          onClose={() => setBatch(null)}
          onDone={(id) => {
            setBatch(null);
            clearSel();
            setSelMode(false);
            patch(id ? { job: id } : { jobs: "1" });
          }}
        />
      )}
      {jobId && <JobDialog id={jobId} onClose={() => patch({ job: null })} />}
    </>
  );
}

/** An empty 16px slot in a menu (keeps labels aligned with the checked one). */
const Blank = (({ className }: { className?: string }) => (
  <span className={cn("inline-block size-4", className)} aria-hidden="true" />
)) as unknown as LucideIcon;
Blank.displayName = "Blank";

/** The page number box of the pager (Enter jumps). */
function PageJump({ page, pages, onJump }: { page: number; pages: number; onJump: (p: number) => void }) {
  const tr = useTr();
  const [text, setText] = useState(String(page));
  const [seen, setSeen] = useState(page);
  if (seen !== page) {
    setSeen(page);
    setText(String(page));
  }
  return (
    <Input
      aria-label={tr("跳到页", "Go to page")}
      inputMode="numeric"
      data-nodirty
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        const n = /^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : NaN;
        if (Number.isNaN(n)) return setText(String(page));
        onJump(Math.min(pages, Math.max(1, n)));
      }}
      className="h-6 w-12 px-1 text-center text-footnote pointer-coarse:h-9"
    />
  );
}

/* ---------- View rail ---------- */

function ViewRail({
  view,
  counts,
  plans,
  onPick,
}: {
  view: string;
  counts: Counts | null;
  plans: PlanView[];
  onPick: (v: string) => void;
}) {
  const tr = useTr();
  const withUsers = plans.filter((p) => p.active_users > 0);
  const n = (k: keyof Counts) => (counts?.[k] ?? null) as number | null;
  const Item = ({
    id,
    label,
    count,
    icon: I,
    tone,
    title,
  }: {
    id: string;
    label: string;
    count: number | null;
    icon: LucideIcon;
    tone?: string;
    title?: string;
  }) => {
    const on = view === id;
    return (
      <button
        type="button"
        onClick={() => onPick(id)}
        title={title}
        aria-current={on || undefined}
        className={cn(
          "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body transition-colors",
          on ? "bg-primary-soft font-semibold text-primary" : "text-foreground hover:bg-accent",
        )}
      >
        <I
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            on
              ? "text-primary"
              : tone === "danger"
                ? "text-destructive"
                : tone === "warning"
                  ? "text-warning"
                  : "text-muted-foreground",
          )}
        />
        <span className="flex-1 truncate">{label}</span>
        <span className={cn("tnum text-footnote", on ? "text-primary" : "text-faint")}>
          {count === null ? "" : count.toLocaleString()}
        </span>
      </button>
    );
  };
  return (
    <>
      {/* Phone: horizontal pills */}
      <nav
        aria-label={tr("用户视图", "User views")}
        className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] lg:hidden"
      >
        {VIEWS.map((v) => {
          const on = view === v.id;
          const cnt = n(v.count);
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onPick(v.id)}
              aria-current={on || undefined}
              className={cn(
                "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-body font-medium shadow-card pointer-coarse:h-11",
                on ? "bg-primary text-primary-foreground" : "bg-card text-foreground",
              )}
            >
              {v.label(tr)}
              {cnt !== null && (
                <span className={cn("tnum text-footnote", on ? "text-primary-foreground/80" : "text-faint")}>
                  {cnt.toLocaleString()}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      {/* Desktop: the rail */}
      <nav
        aria-label={tr("用户视图", "User views")}
        className="sticky top-20 hidden content-start gap-4 self-start lg:grid"
      >
        <div>
          <div className="mb-1 px-2.5 text-caption font-semibold tracking-wide text-faint">{tr("视图", "Views")}</div>
          <div className="grid gap-px">
            {VIEWS.map((v) => (
              <Item
                key={v.id}
                id={v.id}
                label={v.label(tr)}
                count={n(v.count)}
                icon={v.icon}
                tone={v.tone}
                title={v.hint(tr)}
              />
            ))}
          </div>
        </div>
        {withUsers.length > 0 && (
          <div>
            <div className="mb-1 px-2.5 text-caption font-semibold tracking-wide text-faint">
              {tr("按套餐", "By plan")}
            </div>
            <div className="grid gap-px">
              {withUsers.map((p) => (
                <Item key={p.id} id={`plan:${p.id}`} label={p.name} count={p.active_users} icon={Layers} />
              ))}
            </div>
          </div>
        )}
        <p className="px-2.5 text-footnote text-faint">
          {tr("视图人数实时计算。勾选后可对整个视图批量操作。", "Counts are live. Tick rows to act on a whole view.")}
        </p>
      </nav>
    </>
  );
}

/* ---------- More filters ---------- */

type MoreValue = { plan: string; role: string; never: boolean; reg: string; login: string };

function MoreFilters({
  value,
  plans,
  count,
  onApply,
}: {
  value: MoreValue;
  plans: PlanView[];
  count: number;
  onApply: (o: Record<string, string | null>) => void;
}) {
  const tr = useTr();
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(value);
  const dayErr = (s: string) =>
    s && !/^\d{4}-\d{2}-\d{2}$/.test(s) ? tr("日期格式为 YYYY-MM-DD", "Use YYYY-MM-DD") : undefined;
  const bad = !!dayErr(d.reg) || !!dayErr(d.login);
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setD(value);
        setOpen(o);
      }}
      label={tr("更多筛选", "More filters")}
      className="w-[min(20rem,calc(100vw-24px))] p-3"
      trigger={
        <Button
          variant={count ? "soft" : "ghost"}
          size="pill"
          icon={ListFilter}
          aria-label={tr("更多筛选", "More filters")}
        >
          <span className="max-sm:hidden">{tr("更多筛选", "More filters")}</span>
          {count > 0 && (
            <span className="tnum rounded-full bg-primary px-1.5 text-caption text-primary-foreground">{count}</span>
          )}
        </Button>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (bad) return;
          onApply({
            plan: d.plan || null,
            role: d.role || null,
            never: d.never ? "1" : null,
            reg: d.reg || null,
            login: d.login || null,
          });
          setOpen(false);
        }}
      >
        <Field label={tr("套餐", "Plan")}>
          <Select value={d.plan} onChange={(e) => setD({ ...d, plan: e.target.value })}>
            <option value="">{tr("任意套餐", "Any plan")}</option>
            <option value="none">{tr("无套餐", "No plan")}</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={tr("角色", "Role")} group>
          <Segmented
            label={tr("角色", "Role")}
            value={d.role || "any"}
            onChange={(v) => setD({ ...d, role: v === "any" ? "" : v })}
            options={[
              { value: "any", label: tr("全部", "Any") },
              { value: "user", label: tr("普通用户", "Users") },
              { value: "admin", label: tr("管理员", "Admins") },
            ]}
          />
        </Field>
        <label className="flex min-h-8 items-center gap-2 text-body pointer-coarse:min-h-11">
          <Checkbox checked={d.never} label={tr("从未使用", "Never used")} onChange={(v) => setD({ ...d, never: v })} />
          {tr("从未使用（注册后没有套餐、订单与流量）", "Never used (no plan, order or traffic)")}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <Field label={tr("注册早于", "Signed up before")} error={dayErr(d.reg)}>
            <Input type="date" value={d.reg} onChange={(e) => setD({ ...d, reg: e.target.value })} />
          </Field>
          <Field label={tr("最后登录早于", "Last sign-in before")} error={dayErr(d.login)}>
            <Input type="date" value={d.login} onChange={(e) => setD({ ...d, login: e.target.value })} />
          </Field>
        </div>
        <p className="text-footnote text-faint">
          {tr(
            "日期按站点时区的自然日计算；从未登录的也算“最后登录早于”。导出 CSV 使用同样的条件。",
            "Days are site-time-zone days; never signed in counts as before. The CSV export uses the same filters.",
          )}
        </p>
        <div className="flex justify-end gap-2 border-t border-separator pt-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setD({ plan: "", role: "", never: false, reg: "", login: "" })}
          >
            {tr("重置", "Reset")}
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={bad}>
            {tr("应用", "Apply")}
          </Button>
        </div>
      </form>
    </Popover>
  );
}

/* ---------- The list ---------- */

const VIRTUAL_FROM = 120;
const phoneQuery = "(max-width: 767px)";

function UserList({
  rows,
  state,
  error,
  onRetry,
  cols,
  sel,
  selMode,
  activeId,
  onToggle,
  onTogglePage,
  onOpen,
  onClear,
  onCreate,
}: {
  rows: UserRow[];
  state: "ok" | "loading" | "error" | "empty" | "nomatch";
  error: unknown;
  onRetry: () => void;
  cols: OptCol[];
  sel: Set<string>;
  selMode: boolean;
  activeId: string | null;
  onToggle: (id: string) => void;
  onTogglePage: (allTicked: boolean) => void;
  onOpen: (id: string) => void;
  onClear: () => void;
  onCreate: () => void;
}) {
  const tr = useTr();
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const virtual = state === "ok" && rows.length > VIRTUAL_FROM;
  useLayoutEffect(() => {
    if (virtual && listRef.current) setMargin(listRef.current.getBoundingClientRect().top + window.scrollY);
  }, [virtual, rows.length]);
  const v = useWindowVirtualizer({
    count: virtual ? rows.length : 0,
    estimateSize: () => (typeof matchMedia !== "undefined" && matchMedia(phoneQuery).matches ? 88 : 53),
    overscan: 12,
    scrollMargin: margin,
  });
  const items = virtual ? v.getVirtualItems() : [];
  const shown = virtual ? items.map((i) => rows[i.index]) : rows;
  const padTop = virtual && items.length ? items[0].start - margin : 0;
  const padBottom = virtual && items.length ? v.getTotalSize() - (items[items.length - 1].end - margin) : 0;

  // Keyboard: J/K move, Enter opens, X ticks (outside fields and dialogs).
  const [cursor, setCursor] = useState(-1);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector("[role=dialog],[role=alertdialog],[role=menu]")) return;
      const list = rowsRef.current;
      const k = e.key.toLowerCase();
      if (k === "j" || k === "k") {
        e.preventDefault();
        setCursor((c) => Math.min(list.length - 1, Math.max(0, c + (k === "j" ? 1 : -1))));
      } else if (k === "enter" || k === "x") {
        setCursor((c) => {
          const u = list[c];
          if (u) {
            e.preventDefault();
            if (k === "x") onToggle(u.id);
            else onOpen(u.id);
          }
          return c;
        });
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onOpen, onToggle]);
  const cursorId = rows[cursor]?.id;
  useEffect(() => {
    if (cursorId) document.querySelector(`[data-row="${cursorId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursorId]);

  if (state === "loading") return <SkeletonRows rows={10} height={52} />;
  if (state === "error")
    return <ErrorState error={error} title={tr("用户列表加载失败", "The user list did not load")} onRetry={onRetry} />;
  if (state === "empty")
    return (
      <EmptyState
        icon={UsersIcon}
        title={tr("还没有用户", "No users yet")}
        description={tr(
          "开放注册后，新用户会出现在这里。也可以先手动创建一个账户（邮箱视为已验证）。",
          "Users appear here once sign-up is open. You can also create one (the address counts as verified).",
        )}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="outline" onClick={() => navigate("/settings/signup")}>
              {tr("注册设置", "Sign-up settings")}
            </Button>
            <Button variant="primary" icon={Plus} onClick={onCreate}>
              {tr("新建用户", "New user")}
            </Button>
          </div>
        }
      />
    );
  if (state === "nomatch")
    return (
      <EmptyState
        icon={SlidersHorizontal}
        title={tr("没有匹配的用户", "No matching users")}
        description={tr(
          "换个关键词，或放宽筛选条件。按 ID 查找请输入 ID 的前 4 位以上。",
          "Try other words or fewer filters. To find an id, type at least its first 4 characters.",
        )}
        action={
          <Button variant="outline" icon={X} onClick={onClear}>
            {tr("清除筛选", "Clear filters")}
          </Button>
        }
      />
    );

  const allTicked = rows.length > 0 && rows.every((u) => sel.has(u.id));
  const someTicked = !allTicked && rows.some((u) => sel.has(u.id));
  const right = (c: OptCol) => c === "balance" || c === "passkeys";
  const optCell = (c: OptCol, u: UserRow): ReactNode => {
    switch (c) {
      case "login":
        return u.last_login_at ? dateOnly(u.last_login_at) : <span className="text-faint">{tr("从未", "never")}</span>;
      case "balance":
        return u.balance_cents ? yuan(u.balance_cents) : <span className="text-faint">{yuan(0)}</span>;
      case "passkeys":
        return u.passkeys || <span className="text-faint">—</span>;
      case "inviter":
        return u.inviter_email ?? <span className="text-faint">—</span>;
      case "signup":
        return u.signup_method === "passkey" ? tr("通行密钥", "Passkey") : tr("密码", "Password");
    }
  };
  const expiry = (u: UserRow) =>
    u.role !== "user" || !u.plan_id ? (
      <span className="text-faint">—</span>
    ) : u.expires_at ? (
      <RelDays date={u.expires_at} className="text-body" />
    ) : (
      <span className="text-body text-muted-foreground">{tr("不过期", "No expiry")}</span>
    );
  const lastUsed = (u: UserRow) =>
    u.last_traffic_day ? (
      <span className="tnum text-body text-muted-foreground">{u.last_traffic_day}</span>
    ) : (
      <span className="text-body text-faint">{tr("从未", "never")}</span>
    );

  return (
    <div ref={listRef}>
      {/* Desktop table */}
      <div
        className="scroll-thin hidden overflow-x-auto overscroll-x-contain md:block"
        role="region"
        aria-label={tr("用户列表", "Users")}
      >
        <table className="w-full text-body">
          <thead>
            <tr className="h-9 border-b border-separator text-left text-footnote text-muted-foreground">
              <th className="w-10 pl-4">
                <Checkbox
                  checked={allTicked}
                  indeterminate={someTicked}
                  label={tr("勾选本页", "Tick this page")}
                  onChange={() => onTogglePage(allTicked)}
                />
              </th>
              <th className="min-w-56 px-3 font-medium">{tr("用户", "User")}</th>
              <th className="px-3 font-medium">{tr("状态", "Status")}</th>
              <th className="min-w-40 px-3 font-medium">{tr("套餐与本周期流量", "Plan and traffic")}</th>
              <th className="px-3 font-medium whitespace-nowrap">{tr("到期", "Expires")}</th>
              <th className="px-3 font-medium whitespace-nowrap">{tr("最后使用", "Last used")}</th>
              {cols.map((c) => (
                <th key={c} className={cn("px-3 font-medium whitespace-nowrap", right(c) && "text-right")}>
                  {colName(c, tr)}
                </th>
              ))}
              <th className="w-10 pr-3" aria-label={tr("操作", "Actions")} />
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: padTop }} colSpan={7 + cols.length} />
              </tr>
            )}
            {shown.map((u) => {
              const s = sel.has(u.id);
              return (
                <tr
                  key={u.id}
                  data-row={u.id}
                  tabIndex={0}
                  aria-current={activeId === u.id || undefined}
                  onClick={() => onOpen(u.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.target === e.currentTarget) onOpen(u.id);
                  }}
                  className={cn(
                    "group h-[53px] cursor-pointer border-b border-separator transition-colors last:border-0 hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                    (s || activeId === u.id) && "bg-primary-soft/60 hover:bg-primary-soft",
                    cursorId === u.id && "shadow-[inset_2px_0_0_var(--primary)]",
                  )}
                >
                  <td className="pl-4">
                    <Checkbox
                      checked={s}
                      onChange={() => onToggle(u.id)}
                      label={tr(`选择 ${u.email}`, `Select ${u.email}`)}
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <KitAvatar
                        name={u.email_pending ? "?" : u.email}
                        size={30}
                        className={u.erased ? "opacity-40 grayscale" : undefined}
                      />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={cn(
                              "truncate font-semibold",
                              u.erased && "font-normal text-muted-foreground line-through decoration-faint",
                            )}
                          >
                            {u.email_pending ? tr("（待绑定邮箱）", "(email pending)") : u.email}
                          </span>
                          <UserMarks u={u} />
                        </div>
                        <div className="tnum truncate text-footnote text-faint">
                          #{u.id.slice(0, 8)} · {tr("注册", "joined")} {dateOnly(u.created_at)}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3">
                    <UserStatus user={u} />
                  </td>
                  <td className="max-w-64 px-3">
                    {u.plan_id ? (
                      <>
                        <div className="mb-0.5 truncate text-footnote font-medium">{u.plan_name}</div>
                        <TrafficCell u={u} />
                      </>
                    ) : (
                      <span className="text-faint">
                        {u.role !== "user" ? tr("管理员不持有套餐", "Admins hold no plan") : "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-3 whitespace-nowrap">{expiry(u)}</td>
                  <td className="px-3 whitespace-nowrap">{lastUsed(u)}</td>
                  {cols.map((c) => (
                    <td
                      key={c}
                      className={cn(
                        "tnum max-w-48 truncate px-3 text-body text-muted-foreground",
                        right(c) && "text-right",
                      )}
                    >
                      {optCell(c, u)}
                    </td>
                  ))}
                  <td className="pr-3">
                    <RowActions u={u} onOpen={onOpen} />
                  </td>
                </tr>
              );
            })}
            {padBottom > 0 && (
              <tr aria-hidden="true">
                <td style={{ height: padBottom }} colSpan={7 + cols.length} />
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Phone list */}
      <ul className="divide-y divide-separator md:hidden" aria-label={tr("用户列表", "Users")}>
        {padTop > 0 && <li aria-hidden="true" style={{ height: padTop }} />}
        {shown.map((u) => {
          const s = sel.has(u.id);
          const body = (
            <>
              {selMode ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex size-[34px] shrink-0 items-center justify-center rounded-full",
                    s ? "bg-primary text-primary-foreground" : "shadow-[inset_0_0_0_1.5px_var(--input)]",
                  )}
                >
                  {s && <Check className="size-4 stroke-[3]" />}
                </span>
              ) : (
                <KitAvatar
                  name={u.email_pending ? "?" : u.email}
                  size={34}
                  className={u.erased ? "opacity-40 grayscale" : undefined}
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={cn("truncate text-body font-medium", u.erased && "text-muted-foreground line-through")}
                  >
                    {u.email_pending ? tr("（待绑定邮箱）", "(email pending)") : u.email}
                  </span>
                  <UserMarks u={u} compact />
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-2 text-footnote">
                  <UserStatus user={u} />
                  <span className="truncate text-muted-foreground">
                    {u.plan_name ?? (u.role === "user" ? tr("无套餐", "No plan") : "")}
                  </span>
                  {u.plan_id && u.expires_at && (
                    <RelDays date={u.expires_at} className="ml-auto shrink-0 text-footnote" />
                  )}
                </span>
                {u.plan_id && (
                  <span className="mt-1.5 block">
                    <TrafficCell u={u} />
                  </span>
                )}
              </span>
            </>
          );
          return (
            <li key={u.id} data-row={u.id} aria-current={activeId === u.id || undefined}>
              {selMode ? (
                <div
                  role="checkbox"
                  aria-checked={s}
                  aria-label={tr(`选择 ${u.email}`, `Select ${u.email}`)}
                  tabIndex={0}
                  onClick={() => onToggle(u.id)}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      onToggle(u.id);
                    }
                  }}
                  className={cn(
                    "flex min-h-[88px] w-full cursor-pointer items-center gap-3 px-4 py-3 text-left active:bg-accent",
                    s && "bg-primary-soft",
                  )}
                >
                  {body}
                </div>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(u.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(u.id);
                  }}
                  className={cn(
                    "flex min-h-[88px] w-full cursor-pointer items-center gap-3 px-4 py-3 text-left active:bg-accent",
                    activeId === u.id && "bg-primary-soft",
                  )}
                >
                  {body}
                </div>
              )}
            </li>
          );
        })}
        {padBottom > 0 && <li aria-hidden="true" style={{ height: padBottom }} />}
      </ul>
    </div>
  );
}

/** The row's ⋯ menu: open, copy the address, reset traffic, renew / ban (in the detail), unban. */
function RowActions({ u, onOpen }: { u: UserRow; onOpen: (id: string) => void }) {
  const tr = useTr();
  const toast = useToast();
  const confirm = useConfirm();
  const [run] = useAction();
  const label = tr("更多操作", "More actions");
  const banned = !u.enabled && u.disabled_reason === "admin" && !u.erased;
  return (
    <span
      role="presentation"
      className="inline-flex"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Menu
        label={label}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            icon={Ellipsis}
            aria-label={label}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          />
        }
      >
        <MenuItem icon={UserRound} onClick={() => onOpen(u.id)}>
          {tr("打开详情", "Open")}
        </MenuItem>
        <MenuItem
          icon={Copy}
          onClick={async () => {
            if (await copyText(u.email)) toast({ tone: "success", title: tr("已复制邮箱", "Address copied") });
          }}
        >
          {tr("复制邮箱", "Copy address")}
        </MenuItem>
        {u.plan_id && !u.erased && (
          <>
            <MenuSeparator />
            <MenuItem icon={CalendarPlus} onClick={() => onOpen(u.id)}>
              {tr("续期…", "Renew…")}
            </MenuItem>
            <MenuItem
              icon={RefreshCcw}
              onClick={async () => {
                const ok = await confirm({
                  title: tr(`重置 ${u.email} 的本周期流量？`, `Reset this period's traffic of ${u.email}?`),
                  tone: "warning",
                  impacts: [
                    { label: tr("已用流量", "Used"), value: `${bytes(u.traffic_used_bytes)} → 0` },
                    { label: tr("到期时间", "Expiry"), value: tr("不变", "unchanged") },
                  ],
                  confirmLabel: tr("重置流量", "Reset traffic"),
                });
                if (ok)
                  await run(() => post(`/users/${u.id}/plan/reset-traffic`, { confirm: true }), {
                    ok: tr("已重置本周期流量", "Traffic reset"),
                  });
              }}
            >
              {tr("重置流量", "Reset traffic")}
            </MenuItem>
          </>
        )}
        {u.role === "user" && !u.erased && (
          <>
            <MenuSeparator />
            {banned ? (
              <MenuItem
                icon={ShieldOff}
                onClick={async () => {
                  const ok = await confirm({
                    title: tr(`解除封禁 ${u.email}？`, `Unban ${u.email}?`),
                    description: tr("订阅链接恢复，用户可以重新使用。", "The subscription works again."),
                    tone: "default",
                    confirmLabel: tr("解除封禁", "Unban"),
                  });
                  if (ok) await run(() => post(`/users/${u.id}/unban`), { ok: tr("已解除封禁", "Unbanned") });
                }}
              >
                {tr("解除封禁…", "Unban…")}
              </MenuItem>
            ) : (
              <MenuItem icon={Ban} danger onClick={() => onOpen(u.id)}>
                {tr("封禁…", "Ban…")}
              </MenuItem>
            )}
          </>
        )}
      </Menu>
    </span>
  );
}
