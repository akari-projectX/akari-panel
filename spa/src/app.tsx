import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { Button } from "./components/ui/button";
import { Loading } from "./components/status";
import { LocaleSwitch, useHtmlLang, useLocale, useT } from "./i18n";
import {
  ApiError,
  adminBase,
  appBase,
  authOptions,
  get,
  logout as apiLogout,
  put,
  type AuthOptions,
  type Me,
  type TotpStatus,
} from "./lib/api";
import { errorText } from "./lib/errors";
import { loadPage, navigate, usePath } from "./lib/router";
import { resetAfterLogout } from "./lib/session";
import { useDocumentTitle } from "./lib/title";
import { Login } from "./pages/login";
import { Register } from "./pages/register";
import { ForgotPassword, ResetPassword } from "./pages/reset";
import { viewHref, viewOf, viewsFor, type PortalView } from "./portal-views";

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

  // W15: mails go out in the account's language; keep it in step with the
  // language the visitor uses here (best effort, once per change).
  const locale = useLocale();
  const accountLocale = me.data?.role === "user" ? me.data.locale : undefined;
  useEffect(() => {
    if (accountLocale && accountLocale !== locale) {
      put("/me/locale", { locale }).catch(() => undefined);
    }
  }, [accountLocale, locale]);

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
    return <UserSurface>{() => <PublicPages />}</UserSurface>;
  }

  return <PortalShell me={me.data} onLogout={logout} logoutError={logoutError} />;
}

/**
 * W20 (M1): the signed-in portal — header, a nav entry per view (top on
 * desktop, a bottom tab bar on phones) and the current view, chosen by URL
 * (deep links and Back work).
 */
function PortalShell({ me, onLogout, logoutError }: { me: Me; onLogout: () => void; logoutError: string | null }) {
  const t = useT();
  const path = usePath();
  const locale = useLocale();
  useHtmlLang(locale);
  const views = viewsFor(me);
  const view = viewOf(path, views);
  useDocumentTitle(t(view.label));
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // A view change starts at the top; focus goes to the new heading so
    // screen readers announce it (not on the first render).
    if (first.current) {
      first.current = false;
      return;
    }
    document.documentElement.scrollTop = 0;
    main.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [view.id]);

  const go = (e: React.MouseEvent<HTMLAnchorElement>, v: PortalView) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(viewHref(v));
  };

  return (
    <div className="min-h-screen pb-20 sm:pb-0">
      <header className="sticky top-0 z-30 border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
          <span className="text-sm font-semibold tracking-tight">{t("common.appName")}</span>
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <span className="hidden max-w-[12rem] truncate text-sm text-muted-foreground sm:inline">{me.login}</span>
            <LocaleSwitch />
            <Button variant="outline" size="sm" onClick={onLogout}>
              {t("common.logout")}
            </Button>
          </div>
        </div>
        {logoutError && (
          <p role="alert" className="mx-auto max-w-5xl px-4 pb-2 text-sm text-destructive sm:px-6">
            {t("common.logoutFailed", { message: logoutError })}
          </p>
        )}
        <nav aria-label={t("nav.label")} className="hidden border-t border-border sm:block">
          <ul className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 sm:px-6">
            {views.map((v) => (
              <li key={v.id}>
                <a
                  href={viewHref(v)}
                  onClick={(e) => go(e, v)}
                  aria-current={v === view ? "page" : undefined}
                  className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    v === view
                      ? "border-primary font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {v.icon()}
                  {t(v.label)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main ref={main} className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <h1 tabIndex={-1} className="mb-5 text-xl font-semibold tracking-tight outline-none sm:text-2xl">
          {t(view.label)}
        </h1>
        <div key={view.id}>{view.render(me)}</div>
      </main>
      <nav
        aria-label={t("nav.label")}
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-card pb-[env(safe-area-inset-bottom)] sm:hidden"
      >
        <ul className="flex">
          {views.map((v) => (
            <li key={v.id} className="min-w-0 flex-1">
              <a
                href={viewHref(v)}
                onClick={(e) => go(e, v)}
                aria-current={v === view ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 px-0.5 text-[11px] leading-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  v === view ? "font-medium text-primary" : "text-muted-foreground"
                }`}
              >
                {v.icon()}
                <span className="max-w-full truncate">{t(v.short)}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** The signed-out pages: sign in, and (W15, only when enabled) sign up / password reset. */
export function PublicPages() {
  const path = usePath();
  const options = useQuery({ queryKey: ["auth-options"], queryFn: authOptions, retry: false, staleTime: 60_000 });
  const opts: AuthOptions = options.data ?? {
    register: false,
    invite_required: false,
    email_domains: [],
    reset: false,
  };
  if (path === `${appBase}/reset`) return <ResetPassword />;
  if (path === `${appBase}/forgot` && opts.reset) return <ForgotPassword />;
  if (path === `${appBase}/register` && opts.register) return <Register options={opts} />;
  return <Login options={opts} />;
}

// User-facing surface: the visitor's language (switchable).
function UserSurface({ children }: { children: (t: ReturnType<typeof useT>) => React.ReactNode }) {
  const locale = useLocale();
  useHtmlLang(locale);
  const t = useT();
  return <>{children(t)}</>;
}

export { App };
