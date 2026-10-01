// Test harness: a fake fetch that answers by "METHOD /path" (path relative
// to /api/v1) and records every request, plus a fresh QueryClient.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

import { FixedLocale } from "../i18n";

export interface Call {
  method: string;
  path: string;
  /** The query string ("?limit=50&offset=0"), "" when none. */
  search: string;
  body: unknown;
}

export type Routes = Record<string, unknown | ((body: unknown) => { status: number; body?: unknown })>;

export function fakeApi(routes: Routes): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const parsed = new URL(url, "http://localhost");
      const path = parsed.pathname.replace(/^.*\/api\/v1/, "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, search: parsed.search, body });
      const route = routes[`${method} ${path}`];
      if (route === undefined) {
        return new Response(JSON.stringify({ error: `no route ${method} ${path}` }), { status: 404 });
      }
      const res = typeof route === "function" ? route(body) : { status: 200, body: route };
      if (res.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(res.body ?? {}), {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

export function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Render an admin-console component the way the app does (Chinese pinned). */
export function renderAdmin(ui: ReactElement) {
  return renderWithClient(<FixedLocale locale="zh">{ui}</FixedLocale>);
}
