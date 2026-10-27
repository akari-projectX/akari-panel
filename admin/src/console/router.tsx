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
function parseRoute(pathname: string, search = ""): Route {
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
  // `router.state.location.pathname` still carries the basename, and
  // `navigate` prepends it again: strip it (else "/{prefix}/admin/{prefix}/
  // admin/users" matches nothing and the catch-all sends us to the dashboard).
  const base = (router.basename ?? "/").replace(/\/+$/, "");
  const pathname =
    base && (loc.pathname === base || loc.pathname.startsWith(`${base}/`))
      ? loc.pathname.slice(base.length) || "/"
      : loc.pathname;
  void router.navigate({ pathname, search: search ? `?${search}` : "" }, { replace });
}

/** A query parameter of the current URL with a setter. */
export function useQueryParam(name: string): [string, (v: string | null) => void] {
  const { query } = useRoute();
  return [query.get(name) ?? "", (v) => setQuery({ [name]: v })];
}

/**
 * The query string and a patcher that changes several parameters in one
 * navigation (v2 prototype `useQS`; calling `useQueryParam` setters one after
 * the other would each start from the same old URL). `null` or "" removes a
 * key. Pushes a history entry by default (Back undoes a filter); pass
 * `replace` for typing in a search box.
 */
export function useQS(): [
  URLSearchParams,
  (patch: Record<string, string | null | undefined>, replace?: boolean) => void,
] {
  const { query } = useRoute();
  return [query, (patch, replace = false) => setQuery(patch, replace)];
}
