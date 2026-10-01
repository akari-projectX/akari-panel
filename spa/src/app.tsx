import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, appBase, get, logout as apiLogout, type TotpStatus } from "./lib/api";
import { navigate } from "./lib/router";
import { resetAfterLogout } from "./lib/session";
import { Login } from "./pages/login";
import { AdminUsers } from "./pages/admin-users";
import { AdminNodes } from "./pages/admin-nodes";
import { Portal } from "./pages/portal";
import { AdminAudit } from "./pages/audit";
import { EnrollPage, TwoFactorCard } from "./pages/two-factor";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";

type View = "users" | "nodes" | "audit" | "account";

const VIEWS: View[] = ["users", "nodes", "audit", "account"];

function App() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<import("./lib/api").Me>("/me") });
  // An admin without 2FA has an enrollment-only session: /me is 401 but
  // /me/totp answers with stage "enroll".
  const unauthorized = me.isError && me.error instanceof ApiError && me.error.status === 401;
  const totp = useQuery({
    queryKey: ["totp"],
    queryFn: () => get<TotpStatus>("/me/totp"),
    enabled: unauthorized,
    retry: false,
  });
  const [view, setView] = useState<View>(
    () => VIEWS.find((v) => location.pathname.endsWith(`/${v}`)) ?? "users",
  );
  const [logoutError, setLogoutError] = useState<string | null>(null);

  if (me.isPending) return null;
  if (me.isError) {
    if (unauthorized && totp.isPending) return null;
    if (unauthorized && totp.data?.stage === "enroll") {
      return <EnrollPage status={totp.data} onLogout={logout} />;
    }
    return <Login />;
  }

  const user = me.data;
  const isAdmin = user.role === "admin";

  async function logout() {
    setLogoutError(null);
    try {
      await apiLogout();
    } catch (err) {
      // Surface it: a silently swallowed failure here is how REVIEW P0 #1
      // (logout posted to a rejected 404 path) went unnoticed.
      setLogoutError(err instanceof Error ? `Log out failed: ${err.message}` : "Log out failed");
      return;
    }
    // No previous-user data may survive, and the "me" observer must see the
    // 401 so the app actually leaves the dashboard.
    await resetAfterLogout(queryClient);
    navigate(`${appBase}/`);
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold tracking-tight">Console</span>
            {isAdmin && (
              <nav className="flex gap-1">
                <Button variant={view === "users" ? "default" : "ghost"} size="sm" onClick={() => setView("users")}>
                  Users
                </Button>
                <Button variant={view === "nodes" ? "default" : "ghost"} size="sm" onClick={() => setView("nodes")}>
                  Nodes
                </Button>
                <Button variant={view === "audit" ? "default" : "ghost"} size="sm" onClick={() => setView("audit")}>
                  Audit
                </Button>
                <Button variant={view === "account" ? "default" : "ghost"} size="sm" onClick={() => setView("account")}>
                  Account
                </Button>
              </nav>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="secondary">{user.role}</Badge>
            <span className="text-sm text-muted-foreground">{user.login}</span>
            {logoutError && (
              <span role="alert" className="text-sm text-destructive">
                {logoutError}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={logout}>
              Log out
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        {isAdmin ? (
          view === "nodes" ? (
            <AdminNodes />
          ) : view === "audit" ? (
            <AdminAudit />
          ) : view === "account" ? (
            <TwoFactorCard />
          ) : (
            <AdminUsers />
          )
        ) : (
          <Portal me={user} />
        )}
      </main>
    </div>
  );
}

export { App };
