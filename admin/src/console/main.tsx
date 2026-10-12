import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import "../shared/index.css";
import { loadFontsAfterFirstScreen } from "../shared/fonts";
import { LangProvider } from "../shared/i18n";
import { applyTheme, initialTheme } from "../shared/theme";
import { ConfirmProvider } from "../shared/ui/confirm";
import { Toaster } from "../shared/ui/toast";
import { get, setUnauthorizedHandler } from "../shared/api";
import { adminBase, loadPage, loginUrl } from "../shared/base";
import { invalidateOnWrite, makeQueryClient } from "./data";
import { setPrefetchClient } from "./pages";
import { PAGES } from "./pages";
import { makeRouter } from "./routes";

applyTheme(initialTheme());
loadFontsAfterFirstScreen();

const client = makeQueryClient();
setPrefetchClient(client);
invalidateOnWrite(client);

// First screen without a waterfall: the session, the site facts, the
// current page's chunk and (on the dashboard) its data all start now, in
// parallel, instead of one after another (entry → page chunk → /me →
// /settings → page data). Same query keys and functions as their users
// (app.tsx, session.tsx, dashboard.tsx, servers.ts), so these are just
// earlier starts of the same requests.
setUnauthorizedHandler(() => loadPage(loginUrl()));
const prefetch = (key: string[], path: string) =>
  void client.prefetchQuery({ queryKey: key, queryFn: () => get(path) });
prefetch(["me"], "/me");
prefetch(["settings"], "/settings");
prefetch(["settings", "branding"], "/settings/branding");
prefetch(["admin-badges"], "/admin-badges");
const first = location.pathname.slice(adminBase.length).split("/")[1] || "dashboard";
void PAGES[first]?.().catch(() => {});
if (first === "dashboard") {
  prefetch(["dashboard"], "/dashboard");
  prefetch(["servers"], "/servers");
}
const router = makeRouter();

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <LangProvider>
          <ConfirmProvider>
            <RouterProvider router={router} />
            <Toaster />
          </ConfirmProvider>
        </LangProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
