import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { ErrorText, Loading } from "./components/status";
import { FixedLocale, useHtmlLang } from "./i18n";
import { ApiError, adminBase, appBase, get, logout as apiLogout, type Me, type TotpStatus } from "./lib/api";
import { adminErrorText } from "./lib/errors";
import { loadPage, navigate, usePath } from "./lib/router";
import { AdminNodes } from "./pages/admin-nodes";
import { AdminOrders } from "./pages/admin-orders";
import { AdminPlans } from "./pages/admin-plans";
import { AdminSettings } from "./pages/admin-settings";
import { AdminUpdates } from "./pages/admin-updates";
import { AdminUsers } from "./pages/admin-users";
import { AdminAudit } from "./pages/audit";
import { PasswordCard } from "./pages/portal";
import { EnrollPage, TwoFactorCard } from "./pages/two-factor";

// The admin console bundle (/{prefix}/admin, R23): built separately from
// the user portal and served only to admin sessions (src/spa.rs). Chinese
// only (R18). Signing in happens on the shared login page at /{prefix}/app,
// which sends admins here.

// Console views; each is a URL under /{prefix}/admin (deep links and the
// back button work; the server serves the console for every /admin/* path).
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

/** The view named by the path ("/{prefix}/admin/<view>[/...]"); users by default. */
export function viewOf(path: string): View {
  const rest = path.startsWith(adminBase) ? path.slice(adminBase.length) : "";
  const seg = rest.split("/").filter(Boolean)[0];
  return VIEWS.find((v) => v.id === seg)?.id ?? "users";
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
      <AdminRoot />
    </FixedLocale>
  );
}

function AdminRoot() {
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
  // The session ended (logout elsewhere, revoked, expired) or is no longer
  // an admin's: back to the login page, a full page load into the portal.
  const leave =
    (unauthorized && !totp.isPending && totp.data?.stage !== "enroll") || (me.data && me.data.role !== "admin");

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

  if (me.isPending || (unauthorized && totp.isPending) || leave) return <Loading label="加载中…" />;
  if (me.isError) {
    if (unauthorized && totp.data?.stage === "enroll") return <EnrollPage status={totp.data} onLogout={logout} />;
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
                  href={`${adminBase}/${v.id}`}
                  aria-current={view === v.id ? "page" : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(`${adminBase}/${v.id}`);
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
                href={`${adminBase}/account`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`${adminBase}/account`);
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

export { AdminApp };
