// The console's views by navigation id, each its own chunk (loaded on
// first visit, prefetched when the pointer rests on its link).
import type { QueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";

type Loader = () => Promise<ComponentType>;

export const PAGES: Record<string, Loader> = {
  dashboard: () => import("./pages/dashboard").then((m) => m.DashboardPage),
  status: () => import("./pages/status").then((m) => m.StatusPage),
  users: () => import("./pages/users").then((m) => m.UsersPage),
  orders: () => import("./pages/orders").then((m) => m.OrdersPage),
  coupons: () => import("./pages/coupons").then((m) => m.CouponsPage),
  finance: () => import("./pages/finance").then((m) => m.FinancePage),
  tickets: () => import("./pages/tickets").then((m) => m.TicketsPage),
  content: () => import("./pages/content").then((m) => m.ContentPage),
  nodes: () => import("./pages/nodes").then((m) => m.NodesPage),
  plans: () => import("./pages/plans").then((m) => m.PlansPage),
  alerts: () => import("./pages/alerts").then((m) => m.AlertsPage),
  updates: () => import("./pages/updates").then((m) => m.UpdatesPage),
  settings: () => import("./pages/settings").then((m) => m.SettingsPage),
  audit: () => import("./pages/audit").then((m) => m.AuditPage),
  account: () => import("./pages/account").then((m) => m.AccountPage),
  more: () => import("./pages/more").then((m) => m.MorePage),
};

/**
 * Full pages below a navigation page (the nav id stays the first path
 * segment, so the sidebar highlights the parent). Own chunks, like PAGES.
 */
export const SUB_PAGES: Record<string, Loader> = {
  // The full-width template editor (v2: /settings/templates; the older address stays).
  "settings/templates": () => import("./pages/mail-templates").then((m) => m.MailTemplatesPage),
  "settings/mail-templates": () => import("./pages/mail-templates").then((m) => m.MailTemplatesPage),
};

/**
 * The first data of the pages switched to most, fetched into the query
 * cache ahead of a visit (same keys and requests as the page itself): the
 * switch then renders at once and refreshes in the background. Each
 * module's `prefetchData` only starts queries that are not cached and fresh.
 */
const DATA: Record<string, () => Promise<{ prefetchData: (qc: QueryClient) => void }>> = {
  users: () => import("./pages/users"),
  nodes: () => import("./pages/nodes"),
  settings: () => import("./pages/settings-overview"),
};

let client: QueryClient | null = null;

/** The query client data prefetches write to (main.tsx). */
export function setPrefetchClient(qc: QueryClient): void {
  client = qc;
}

function prefetchData(id: string): Promise<void> {
  const load = DATA[id];
  const qc = client;
  if (!load || !qc) return Promise.resolve();
  return load()
    .then((m) => m.prefetchData(qc))
    .catch(() => {});
}

/** Start loading a page's chunk (idempotent: the module cache dedupes) and its first data. */
export function prefetchPage(id: string): void {
  void PAGES[id]?.().catch(() => {});
  void prefetchData(id);
}

/** Props for a link to a page: its chunk and data start loading on hover, focus or touch (before the click). */
export function prefetchOn(id: string) {
  const go = () => prefetchPage(id);
  return { onMouseEnter: go, onFocus: go, onTouchStart: go };
}

/**
 * The pages most switched to (the phone's tab bar, and the two pages behind
 * "更多" visited most), loaded one after another once the first page is
 * ready (the first at once, the rest in idle periods), with the first data of those in DATA, so a switch only renders
 * (perf §3: switch ≤ 900 ms on a mid phone).
 * Not on Save-Data / 2G connections. Once per session.
 */
const IDLE_PAGES = ["users", "orders", "tickets", "more", "nodes", "settings", "dashboard"];
let idleStarted = false;

export function prefetchIdle(): void {
  if (idleStarted) return;
  idleStarted = true;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || /2g/.test(conn?.effectiveType ?? "")) return;
  const queue = [...IDLE_PAGES];
  const idle = (f: () => void) =>
    "requestIdleCallback" in window ? requestIdleCallback(f, { timeout: 3000 }) : setTimeout(f, 200);
  const next = () => {
    const id = queue.shift();
    if (!id) return;
    void Promise.all([PAGES[id]().catch(() => {}), prefetchData(id)]).finally(() => idle(next));
  };
  // The first one (users, the page switched to most) starts at once: a tap
  // right after the first screen would otherwise beat the idle callback and
  // wait for its chunk and data.
  next();
}
