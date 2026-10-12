// The console's views by navigation id, each its own chunk (loaded on
// first visit, prefetched when the pointer rests on its link).
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

/** Start loading a page's chunk (idempotent: the module cache dedupes). */
export function prefetchPage(id: string): void {
  void PAGES[id]?.().catch(() => {});
}
