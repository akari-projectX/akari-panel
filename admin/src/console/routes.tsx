// The console's routes: one lazy route (= one chunk) per page under the
// root that loads the session (app.tsx). The basename is the admin base
// (`/{prefix}/admin`), so every link and URL below is prefix-relative.
import { createBrowserRouter, Navigate, type RouteObject } from "react-router";
import { adminBase } from "../shared/base";
import { useTr } from "../shared/i18n";
import { ConsoleApp, BootSkeleton } from "./app";
import { PAGES } from "./pages";
import { setRouter } from "./router";

function lazyPage(id: string): RouteObject["lazy"] {
  return async () => ({ Component: await PAGES[id]() });
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
          { index: true, lazy: lazyPage("dashboard") },
          ...pages.map((id) => ({ path: `${id}/*`, lazy: lazyPage(id) })),
          { path: "*", element: <Navigate to="/" replace /> },
        ],
      },
    ],
    { basename: adminBase },
  );
  setRouter(router);
  return router;
}
