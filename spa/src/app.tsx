import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "./components/ui/button";
import { Loading } from "./components/status";
import { LocaleSwitch, useHtmlLang, useLocale, useT } from "./i18n";
import { ApiError, adminBase, appBase, get, logout as apiLogout, type Me, type TotpStatus } from "./lib/api";
import { errorText } from "./lib/errors";
import { loadPage, navigate } from "./lib/router";
import { resetAfterLogout } from "./lib/session";
import { Login } from "./pages/login";
import { Portal } from "./pages/portal";
import { Billing } from "./pages/purchase";
import { Wallet } from "./pages/wallet";

// The user portal bundle (/{prefix}/app): login (shared with admins),
// portal, purchase and orders. It holds no admin code (R23): an admin
// session is sent to the separately built console at /{prefix}/admin,
// which the server serves to admin sessions only.

/** The console URL for an admin who opened `path` (the /app sub-path is kept: /app/nodes -> /admin/nodes). */
export function adminTarget(path: string): string {
  const rest = path.startsWith(appBase) ? path.slice(appBase.length) : "";
  return rest.startsWith("/") && rest.length > 1 ? `${adminBase}${rest}` : adminBase;
}

function App() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<Me>("/me") });
  // With auth.require_admin_2fa an admin without 2FA has an
  // enrollment-only session: /me is 401 but /me/totp says stage "enroll".
  // The enrollment page belongs to the console.
  const unauthorized = me.isError && me.error instanceof ApiError && me.error.status === 401;
  const totp = useQuery({
    queryKey: ["totp"],
    queryFn: () => get<TotpStatus>("/me/totp"),
    enabled: unauthorized,
    retry: false,
  });
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const toConsole = me.data?.role === "admin" || (unauthorized && totp.data?.stage === "enroll");

  useEffect(() => {
    // A full page load: the console is a different bundle.
    if (toConsole) loadPage(adminTarget(location.pathname));
  }, [toConsole]);

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

  if (me.isPending || (unauthorized && totp.isPending) || toConsole)
    return <UserSurface>{(t) => <Loading label={t("common.loading")} />}</UserSurface>;
  if (me.isError) {
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
              <Wallet me={user} />
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

export { App };
