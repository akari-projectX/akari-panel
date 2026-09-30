import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { appBase, get, logout as apiLogout } from "./lib/api";
import { navigate } from "./lib/router";
import { Login } from "./pages/login";
import { AdminUsers } from "./pages/admin-users";
import { AdminNodes } from "./pages/admin-nodes";
import { Portal } from "./pages/portal";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";

type View = "users" | "nodes";

function App() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<import("./lib/api").Me>("/me") });
  const [view, setView] = useState<View>(() =>
    location.pathname.endsWith("/nodes") ? "nodes" : "users",
  );
  const [logoutError, setLogoutError] = useState<string | null>(null);

  if (me.isPending) return null;
  if (me.isError) return <Login />;

  const user = me.data;
  const isAdmin = user.role === "admin";

  async function logout() {
    setLogoutError(null);
    try {
      await apiLogout();
    } catch (err) {
      // Surface it: a silently swallowed failure here is how REVIEW P0 #1
      // (logout posted to a decoy 404) went unnoticed.
      setLogoutError(err instanceof Error ? `Log out failed: ${err.message}` : "Log out failed");
      return;
    }
    // Drop every cached query so no previous-user data survives the session.
    queryClient.clear();
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
