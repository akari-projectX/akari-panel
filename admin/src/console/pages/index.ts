import type { ComponentType } from "react";
import { AccountPage } from "./account";
import { AlertsPage } from "./alerts";
import { AuditPage } from "./audit";
import { ContentPage } from "./content";
import { CouponsPage } from "./coupons";
import { DashboardPage } from "./dashboard";
import { FinancePage } from "./finance";
import { NodesPage } from "./nodes";
import { OrdersPage } from "./orders";
import { PlansPage } from "./plans";
import { SettingsPage } from "./settings";
import { StatusPage } from "./status";
import { TicketsPage } from "./tickets";
import { UpdatesPage } from "./updates";
import { UsersPage } from "./users";

/** The console's views by navigation id (nav.ts). */
export const PAGES: Record<string, ComponentType> = {
  dashboard: DashboardPage,
  status: StatusPage,
  users: UsersPage,
  orders: OrdersPage,
  coupons: CouponsPage,
  finance: FinancePage,
  tickets: TicketsPage,
  content: ContentPage,
  nodes: NodesPage,
  plans: PlansPage,
  alerts: AlertsPage,
  updates: UpdatesPage,
  settings: SettingsPage,
  audit: AuditPage,
  account: AccountPage,
};
