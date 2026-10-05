import { useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type ComponentType, type LazyExoticComponent } from "react";

import { AdminConfirmProvider } from "./admin-confirm";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ScrollFade } from "./components/ui/table";
import { ErrorText, Loading } from "./components/status";
import { FixedLocale, useHtmlLang } from "./i18n";
import { ApiError, adminBase, appBase, get, logout as apiLogout, type Me } from "./lib/api";
import { adminErrorText } from "./lib/admin-errors";
import { loadPage, navigate, usePath } from "./lib/router";
import { useSiteName } from "./lib/title";
import { PasswordCard } from "./pages/portal";

// W21: every view is its own chunk (the console passed 500 kB in one
// file). CSP-safe: chunks are same-origin modules imported with relative
// specifiers, resolved against the importing chunk's URL under the secret
// prefix (vite.config.ts: no module-preload helper, one CSS file).
const view = <K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
): LazyExoticComponent<ComponentType> => lazy(() => load().then((m) => ({ default: m[name] })));
const AdminDashboard = view(() => import("./pages/admin-dashboard"), "AdminDashboard");
const AdminUsers = view(() => import("./pages/admin-users"), "AdminUsers");
const AdminPlans = view(() => import("./pages/admin-plans"), "AdminPlans");
const AdminOrders = view(() => import("./pages/admin-orders"), "AdminOrders");
const AdminCoupons = view(() => import("./pages/admin-coupons"), "AdminCoupons");
const AdminFinance = view(() => import("./pages/admin-finance"), "AdminFinance");
const AdminTickets = view(() => import("./pages/admin-tickets"), "AdminTickets");
const AdminContent = view(() => import("./pages/admin-content"), "AdminContent");
const AdminNodes = view(() => import("./pages/admin-nodes"), "AdminNodes");
const AdminAlerts = view(() => import("./pages/admin-alerts"), "AdminAlerts");
const AdminUpdates = view(() => import("./pages/admin-updates"), "AdminUpdates");
const AdminAudit = view(() => import("./pages/audit"), "AdminAudit");
const AdminSettings = view(() => import("./pages/admin-settings"), "AdminSettings");

// The admin console bundle (/{prefix}/admin, R23): built separately from
// the user portal and served only to admin sessions (src/spa.rs). Chinese
// only (R18). Signing in happens on the shared login page at /{prefix}/app,
// which sends admins here.

// Console views; each is a URL under /{prefix}/admin (deep links and the
// back button work; the server serves the console for every /admin/* path).
export const VIEWS = [
  { id: "dashboard", label: "仪表盘" },
  { id: "users", label: "用户" },
  { id: "plans", label: "套餐" },
  { id: "orders", label: "订单" },
  { id: "coupons", label: "优惠券" },
  { id: "finance", label: "资金" },
  { id: "tickets", label: "工单" },
  { id: "content", label: "内容" },
  { id: "nodes", label: "节点" },
  { id: "alerts", label: "告警" },
  { id: "updates", label: "更新" },
  { id: "audit", label: "审计" },
  { id: "settings", label: "系统设置" },
  { id: "account", label: "账户" },
] as const;
export type View = (typeof VIEWS)[number]["id"];

/** The view named by the path ("/{prefix}/admin/<view>[/...]"); the dashboard by default. */
export function viewOf(path: string): View {
  const rest = path.startsWith(adminBase) ? path.slice(adminBase.length) : "";
  const seg = rest.split("/").filter(Boolean)[0];
  return VIEWS.find((v) => v.id === seg)?.id ?? "dashboard";
}

/** The browser title of a view (W21, audit Minor 12). */
export function titleOf(v: View, site: string): string {
  return `${VIEWS.find((x) => x.id === v)?.label ?? ""} · ${site} 管理后台`;
}

/** The sign-in URL for a console path whose session ended: /admin/<view> -> /app/<view> (the login sends it back). */
export function loginTarget(path: string): string {
  const rest = path.startsWith(adminBase) ? path.slice(adminBase.length) : "";
  return rest.startsWith("/") && rest.length > 1 ? `${appBase}${rest}` : appBase;
}

function AdminApp() {
  useHtmlLang("zh");
  return (
    <FixedLocale locale="zh">
      <AdminConfirmProvider>
        <AdminRoot />
      </AdminConfirmProvider>
    </FixedLocale>
  );
}

function AdminRoot() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/me") });
  const unauthorized = me.isError && me.error instanceof ApiError && me.error.status === 401;
  const [logoutError, setLogoutError] = useState<string | null>(null);
  // The session ended (logout elsewhere, revoked, expired) or is no longer
  // an admin's: back to the login page, a full page load into the portal.
  const leave = unauthorized || (me.data && me.data.role !== "admin");

  useEffect(() => {
    if (leave) loadPage(loginTarget(location.pathname));
  }, [leave]);

  async function logout() {
    setLogoutError(null);
    try {
      await apiLogout();
    } catch (err) {
      setLogoutError(err instanceof Error ? err.message : String(err));
      return;
    }
    // Nothing of the console survives: leave the bundle entirely.
    queryClient.clear();
    loadPage(appBase);
  }

  if (me.isPending || leave) return <Loading label="加载中…" />;
  if (me.isError) {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <ErrorText>{adminErrorText(me.error)}</ErrorText>
        <Button className="mt-4" variant="outline" onClick={() => void me.refetch()}>
          重试
        </Button>
      </main>
    );
  }
  return <AdminConsole user={me.data} onLogout={logout} logoutError={logoutError} />;
}

// W17: navigation counters (unread tickets, firing alerts).
interface Badges {
  tickets_open: number;
  tickets_unread: number;
  alerts_firing: number;
}

function AdminConsole({ user, onLogout, logoutError }: { user: Me; onLogout: () => void; logoutError: string | null }) {
  const path = usePath();
  const view = viewOf(path);
  const badges = useQuery({
    queryKey: ["admin-badges"],
    queryFn: () => get<Badges>("/admin-badges"),
    refetchInterval: 30_000,
  });
  const count = (id: View) =>
    id === "tickets" ? badges.data?.tickets_unread : id === "alerts" ? badges.data?.alerts_firing : undefined;
  // 站点名称 (系统设置 → 站点) for the header and the browser title.
  const site = useSiteName();
  useEffect(() => {
    document.title = titleOf(view, site);
  }, [view, site]);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-screen-2xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex w-full min-w-0 flex-wrap items-center gap-x-4 gap-y-2 lg:w-auto lg:flex-1">
            <span className="shrink-0 text-sm font-semibold tracking-tight">{site} 管理后台</span>
            <ScrollFade className="min-w-0 flex-1">
              <nav aria-label="主导航" className="flex w-max gap-1 px-1 py-0.5">
                {VIEWS.map((v) => (
                  <a
                    key={v.id}
                    href={`${adminBase}/${v.id}`}
                    aria-current={view === v.id ? "page" : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate(`${adminBase}/${v.id}`);
                    }}
                    className={`inline-flex h-9 shrink-0 items-center rounded-lg px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      view === v.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                    }`}
                  >
                    {v.label}
                    {(count(v.id) ?? 0) > 0 && (
                      <span
                        className="ml-1 rounded-full bg-destructive px-1.5 text-[10px] leading-4 text-destructive-foreground"
                        aria-label={`${count(v.id)} 条待处理`}
                      >
                        {count(v.id)}
                      </span>
                    )}
                  </a>
                ))}
              </nav>
            </ScrollFade>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Badge variant="secondary">管理员</Badge>
            <span className="max-w-[10rem] truncate text-sm text-muted-foreground">{user.email}</span>
            <Button variant="outline" size="sm" onClick={onLogout}>
              退出登录
            </Button>
          </div>
          {logoutError && (
            <p role="alert" className="w-full text-sm text-destructive">
              退出失败：{logoutError}
            </p>
          )}
        </div>
      </header>
      <main className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6 sm:py-8">
        <Suspense fallback={<Loading label="加载中…" />}>
          {view === "users" ? (
            <AdminUsers />
          ) : view === "plans" ? (
            <AdminPlans />
          ) : view === "orders" ? (
            <AdminOrders />
          ) : view === "coupons" ? (
            <AdminCoupons />
          ) : view === "finance" ? (
            <AdminFinance />
          ) : view === "tickets" ? (
            <AdminTickets />
          ) : view === "content" ? (
            <AdminContent />
          ) : view === "nodes" ? (
            <AdminNodes />
          ) : view === "alerts" ? (
            <AdminAlerts />
          ) : view === "updates" ? (
            <AdminUpdates />
          ) : view === "audit" ? (
            <AdminAudit />
          ) : view === "settings" ? (
            <AdminSettings />
          ) : view === "account" ? (
            <div className="mx-auto max-w-3xl space-y-6">
              <h1 className="text-xl font-semibold tracking-tight">账户</h1>
              <PasswordCard />
            </div>
          ) : (
            <AdminDashboard />
          )}
        </Suspense>
      </main>
    </div>
  );
}

export { AdminApp };
