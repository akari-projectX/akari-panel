import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Loading } from "./components/status";
import { FixedLocale, LocaleSwitch, useHtmlLang, useLocale, useT } from "./i18n";
import { ApiError, appBase, get, logout as apiLogout, type Me, type TotpStatus } from "./lib/api";
import { errorText } from "./lib/errors";
import { navigate, usePath } from "./lib/router";
import { resetAfterLogout } from "./lib/session";
import { AdminNodes } from "./pages/admin-nodes";
import { AdminPlans } from "./pages/admin-plans";
import { AdminUpdates } from "./pages/admin-updates";
import { AdminOrders } from "./pages/admin-orders";
import { AdminSettings } from "./pages/admin-settings";
import { AdminUsers } from "./pages/admin-users";
import { AdminAudit } from "./pages/audit";
import { Login } from "./pages/login";
import { PasswordCard, Portal } from "./pages/portal";
import { Billing } from "./pages/purchase";
import { EnrollPage, TwoFactorCard } from "./pages/two-factor";

// Admin console views; each is a URL under /{prefix}/app (deep links and
// the back button work; the server serves the SPA for every /app/* path).
export const VIEWS = [
  { id: "users", label: "用户" },
  { id: "plans", label: "套餐" },
  { id: "orders", label: "订单" },
  { id: "nodes", label: "节点" },
  { id: "updates", label: "更新" },
  { id: "audit", label: "审计" },
  { id: "settings", label: "系统设置" },
  { id: "account", label: "账户" },
] as const;
export type View = (typeof VIEWS)[number]["id"];

/** The admin view named by the path ("/{prefix}/app/<view>[/...]"); users by default. */
export function viewOf(path: string): View {
  const rest = path.startsWith(appBase) ? path.slice(appBase.length) : "";
  const seg = rest.split("/").filter(Boolean)[0];
  return VIEWS.find((v) => v.id === seg)?.id ?? "users";
}

function App() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/me") });
  // With auth.require_admin_2fa an admin without 2FA has an
  // enrollment-only session: /me is 401 but /me/totp says stage "enroll".
  const unauthorized = me.isError && me.error instanceof ApiError && me.error.status === 401;
  const totp = useQuery({
    queryKey: ["totp"],
    queryFn: () => get<TotpStatus>("/me/totp"),
    enabled: unauthorized,
    retry: false,
  });
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function logout() {
    setLogoutError(null);
    try {
      await apiLogout();
    } catch (err) {
      // Surface it: a silently swallowed failure here is how REVIEW P0 #1
      // (logout posted to a rejected 404 path) went unnoticed.
      setLogoutError(err instanceof Error ? err.message : String(err));
      return;
    }
    // No previous-user data may survive, and the "me" observer must see the
    // 401 so the app actually leaves the dashboard.
    await resetAfterLogout(queryClient);
    navigate(appBase); // "/app/" (trailing slash) is not a route: the panel rejects it
  }

  if (me.isPending || (unauthorized && totp.isPending))
    return <UserSurface>{(t) => <Loading label={t("common.loading")} />}</UserSurface>;
  if (me.isError) {
    if (unauthorized && totp.data?.stage === "enroll") {
      return (
        <AdminSurface>
          <EnrollPage status={totp.data} onLogout={logout} />
        </AdminSurface>
      );
    }
    if (!unauthorized) {
      return (
        <UserSurface>
          {(t) => (
            <main className="mx-auto max-w-md px-4 py-16">
              <p role="alert" className="text-sm text-destructive">
                {errorText(me.error, t)}
              </p>
              <Button className="mt-4" variant="outline" onClick={() => void me.refetch()}>
                {t("common.retry")}
              </Button>
            </main>
          )}
        </UserSurface>
      );
    }
    return <UserSurface>{() => <Login />}</UserSurface>;
  }

  const user = me.data;
  if (user.role === "admin") {
    return (
      <AdminSurface>
        <AdminConsole user={user} onLogout={logout} logoutError={logoutError} />
      </AdminSurface>
    );
  }
  return (
    <UserSurface>
      {(t) => (
        <div className="min-h-screen">
          <header className="border-b border-border bg-card">
            <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
              <span className="text-sm font-semibold tracking-tight">{t("common.appName")}</span>
              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <span className="max-w-[10rem] truncate text-sm text-muted-foreground">{user.login}</span>
                <LocaleSwitch />
                <Button variant="outline" size="sm" onClick={logout}>
                  {t("common.logout")}
                </Button>
              </div>
              {logoutError && (
                <p role="alert" className="w-full text-sm text-destructive">
                  {t("common.logoutFailed", { message: logoutError })}
                </p>
              )}
            </div>
          </header>
          <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
            <div className="space-y-6">
              <Portal me={user} />
              <Billing />
            </div>
          </main>
        </div>
      )}
    </UserSurface>
  );
}

// User-facing surface: the visitor's language (switchable).
function UserSurface({ children }: { children: (t: ReturnType<typeof useT>) => React.ReactNode }) {
  const locale = useLocale();
  useHtmlLang(locale);
  const t = useT();
  return <>{children(t)}</>;
}

// Admin console: Chinese only (R18).
function AdminSurface({ children }: { children: React.ReactNode }) {
  useHtmlLang("zh");
  return <FixedLocale locale="zh">{children}</FixedLocale>;
}

const BANNER_KEY = "akari.2fa-banner-dismissed";

function bannerDismissed(id: string): boolean {
  try {
    return window.localStorage.getItem(BANNER_KEY) === id;
  } catch {
    return false;
  }
}

function AdminConsole({ user, onLogout, logoutError }: { user: Me; onLogout: () => void; logoutError: string | null }) {
  const path = usePath();
  const view = viewOf(path);
  const totp = useQuery({ queryKey: ["totp"], queryFn: () => get<TotpStatus>("/me/totp") });
  const [dismissed, setDismissed] = useState(() => bannerDismissed(user.id));
  const showBanner = totp.data && !totp.data.enabled && !dismissed && view !== "account";

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(BANNER_KEY, user.id);
    } catch {
      // Storage blocked: dismissed for this page only.
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-sm font-semibold tracking-tight">Akari 管理后台</span>
            <nav aria-label="主导航" className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1">
              {VIEWS.map((v) => (
                <a
                  key={v.id}
                  href={`${appBase}/${v.id}`}
                  aria-current={view === v.id ? "page" : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(`${appBase}/${v.id}`);
                  }}
                  className={`inline-flex h-8 shrink-0 items-center rounded-lg px-3 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    view === v.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {v.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Badge variant="secondary">管理员</Badge>
            <span className="max-w-[10rem] truncate text-sm text-muted-foreground">{user.login}</span>
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
      {showBanner && (
        <div role="region" aria-label="安全建议" className="border-b border-amber-300 bg-amber-50 text-amber-900">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm sm:px-6">
            <p>
              建议开启两步验证：管理员账户一旦密码泄露，影响整个面板。
              <a
                className="ml-1 font-medium underline"
                href={`${appBase}/account`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`${appBase}/account`);
                }}
              >
                去设置
              </a>
            </p>
            <Button variant="ghost" size="sm" onClick={dismiss} aria-label="不再提示两步验证建议">
              不再提示
            </Button>
          </div>
        </div>
      )}
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        {view === "plans" ? (
          <AdminPlans />
        ) : view === "orders" ? (
          <AdminOrders />
        ) : view === "nodes" ? (
          <AdminNodes />
        ) : view === "updates" ? (
          <AdminUpdates />
        ) : view === "audit" ? (
          <AdminAudit />
        ) : view === "settings" ? (
          <AdminSettings />
        ) : view === "account" ? (
          <div className="space-y-6">
            <PasswordCard />
            <TwoFactorCard />
          </div>
        ) : (
          <AdminUsers />
        )}
      </main>
    </div>
  );
}

export { App };
