// The console's routes: one lazy route (= one chunk) per page under the
// root that loads the session (app.tsx). The basename is the admin base
// (`/{prefix}/admin`), so every link and URL below is prefix-relative.
import { useEffect } from "react";
import { createBrowserRouter, Navigate, useRouteError, type RouteObject } from "react-router";
import { get } from "../shared/api";
import { adminBase } from "../shared/base";
import { useTr } from "../shared/i18n";
import { ErrorState, Skeleton } from "../shared/ui/states";
import { ConsoleApp, BootSkeleton } from "./app";
import { PAGES, SUB_PAGES } from "./pages";
import { setRouter } from "./router";

function lazyPage(id: string): RouteObject["lazy"] {
  return async () => ({ Component: await PAGES[id]() });
}

function lazySubPage(path: string): RouteObject["lazy"] {
  return async () => ({ Component: await SUB_PAGES[path]() });
}

const CHUNK_FAILED = /dynamically imported module|module script failed|loading chunk/i;
const RELOADED = "akari-admin-chunk-reload";

/**
 * A page that failed to render. A page chunk that did not load is either
 * behind an ended session (the console's files answer 404 without one) or
 * gone after an upgrade: ask /me — a 401 there goes to the sign-in page
 * with this view as `next` (api.ts) — else reload once for the new files.
 */
function RouteError() {
  const tr = useTr();
  const error = useRouteError();
  const chunk = error instanceof Error && CHUNK_FAILED.test(error.message);
  useEffect(() => {
    if (!chunk) return;
    get("/me").then(
      () => {
        let again = false;
        try {
          again = sessionStorage.getItem(RELOADED) === location.pathname;
          sessionStorage.setItem(RELOADED, location.pathname);
        } catch {
          // No storage: reload anyway (at worst once per click).
        }
        if (!again) location.reload();
      },
      () => {},
    );
  }, [chunk]);
  if (chunk)
    return (
      <div role="status" aria-label={tr("加载中", "Loading")} className="grid gap-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  return <ErrorState error={error} onRetry={() => location.reload()} />;
}

function Fallback() {
  const tr = useTr();
  return <BootSkeleton label={tr("加载中", "Loading")} />;
}

export function makeRouter() {
  const pages = Object.keys(PAGES).filter((id) => id !== "dashboard");
  const router = createBrowserRouter(
    [
      {
        path: "/",
        Component: ConsoleApp,
        HydrateFallback: Fallback,
        children: [
          {
            ErrorBoundary: RouteError,
            children: [
              { index: true, lazy: lazyPage("dashboard") },
              ...Object.keys(SUB_PAGES).map((path) => ({ path, lazy: lazySubPage(path) })),
              ...pages.map((id) => ({ path: `${id}/*`, lazy: lazyPage(id) })),
              { path: "*", element: <Navigate to="/" replace /> },
            ],
          },
        ],
      },
    ],
    { basename: adminBase },
  );
  setRouter(router);
  return router;
}
