// URL helpers over react-router 7 (2026-10 redesign: the hand-written
// history router is gone). The view is the URL — `/{prefix}/admin/<page>
// [/<sub>…]`, the router's basename is the admin base — and dialog and
// filter state live in the query string, so deep links and Back work.
// `navigate`/`setQuery` work outside React (command palette actions,
// dashboard links) through the router instance routes.tsx registers.
import { useLocation, type createBrowserRouter } from "react-router";

type AppRouter = ReturnType<typeof createBrowserRouter>;
let router: AppRouter | null = null;

export function setRouter(r: AppRouter): void {
  router = r;
}

/** Go to a console path ("/users?open=…"; "" = the dashboard). */
export function navigate(to: string, replace = false): void {
  void router?.navigate(to === "" ? "/" : to, { replace });
}

export type Route = { page: string; sub: string[]; query: URLSearchParams };

/** Page id, sub-path segments and query of a console-relative path. */
export function parseRoute(pathname: string, search = ""): Route {
  const segs = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  return { page: segs[0] ?? "dashboard", sub: segs.slice(1), query: new URLSearchParams(search) };
}

export function useRoute(): Route {
  const loc = useLocation();
  return parseRoute(loc.pathname, loc.search);
}

/** Change query parameters of the current URL (null = remove). */
export function setQuery(patch: Record<string, string | null | undefined>, replace = true): void {
  if (!router) return;
  const loc = router.state.location;
  const q = new URLSearchParams(loc.search);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") q.delete(k);
    else q.set(k, v);
  }
  const search = q.toString();
  if (`?${search}` === loc.search || (search === "" && loc.search === "")) return;
  void router.navigate({ pathname: loc.pathname, search: search ? `?${search}` : "" }, { replace });
}

/** A query parameter of the current URL with a setter. */
export function useQueryParam(name: string): [string, (v: string | null) => void] {
  const { query } = useRoute();
  return [query.get(name) ?? "", (v) => setQuery({ [name]: v })];
}
