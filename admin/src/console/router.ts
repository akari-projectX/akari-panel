// Console routing without a router library: the view is the URL
// (`/{prefix}/admin/<page>[/<sub>…]`, deep links and back work), drawer and
// filter state live in the query string.
import { useEffect, useState } from "react";
import { adminBase } from "../shared/base";

const EVENT = "akari:route";

function current(): string {
  return location.pathname + location.search;
}

export function usePath(): string {
  const [path, setPath] = useState(current);
  useEffect(() => {
    const sync = () => setPath(current());
    window.addEventListener("popstate", sync);
    window.addEventListener(EVENT, sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener(EVENT, sync);
    };
  }, []);
  return path;
}

/** Go to a console path ("/users?open=…"; "" = the dashboard). */
export function navigate(to: string, replace = false): void {
  const url = `${adminBase}${to}`;
  if (url === current()) return;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  window.dispatchEvent(new Event(EVENT));
  if (!replace) window.scrollTo(0, 0);
}

export type Route = { page: string; sub: string[]; query: URLSearchParams };

export function parseRoute(path: string): Route {
  const [p, q = ""] = path.split("?");
  const rest = p.startsWith(adminBase) ? p.slice(adminBase.length) : "";
  const segs = rest.split("/").filter(Boolean).map(decodeURIComponent);
  return { page: segs[0] ?? "dashboard", sub: segs.slice(1), query: new URLSearchParams(q) };
}

export function useRoute(): Route {
  return parseRoute(usePath());
}

/** Change query parameters of the current URL (null = remove). */
export function setQuery(patch: Record<string, string | null | undefined>, replace = true): void {
  const url = new URL(location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  const to = url.pathname + url.search;
  if (to === current()) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
}

/** A query parameter of the current URL with a setter. */
export function useQueryParam(name: string): [string, (v: string | null) => void] {
  const { query } = useRoute();
  return [query.get(name) ?? "", (v) => setQuery({ [name]: v })];
}
