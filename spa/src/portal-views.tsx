// W20 (M1): the portal's views. Each view is a URL (/{prefix}/app/<id>,
// the dashboard is /{prefix}/app) with a nav entry — top nav on desktop,
// bottom tab bar on phones. Adding a view = one entry here (label keys in
// the `nav` i18n namespace). `restricted: true` = also shown to the R21
// renewal scope (expired / quota-exhausted), whose sessions only reach the
// ShopUser endpoints.
import type { ReactNode } from "react";

import {
  AccountIcon,
  HomeIcon,
  NodesIcon,
  OrdersIcon,
  ShopIcon,
  TicketsIcon,
  TrafficIcon,
  WalletIcon,
} from "./components/nav-icons";
import type { MessageKey } from "./i18n";
import { appBase, type Me } from "./lib/api";
import { Dashboard } from "./pages/dashboard";
import { AccountSettings } from "./pages/portal";
import { NodesCard } from "./pages/portal-nodes";
import { TrafficCard } from "./pages/portal-traffic";
import { OrdersView, ShopView } from "./pages/purchase";
import { Tickets } from "./pages/tickets";
import { Wallet } from "./pages/wallet";

export interface PortalView {
  /** URL segment after /app ("" = the dashboard at /app itself). */
  id: string;
  /** Nav label and page heading. */
  label: MessageKey;
  /** Short label for the phone tab bar. */
  short: MessageKey;
  icon: () => ReactNode;
  /** Available to expired / quota-exhausted accounts (renewal scope). */
  restricted: boolean;
  render: (me: Me) => ReactNode;
}

export const PORTAL_VIEWS: PortalView[] = [
  {
    id: "",
    label: "nav.dashboard",
    short: "nav.dashboardShort",
    icon: HomeIcon,
    restricted: true,
    render: (me) => <Dashboard me={me} />,
  },
  {
    id: "shop",
    label: "nav.shop",
    short: "nav.shopShort",
    icon: ShopIcon,
    restricted: true,
    render: (me) => <ShopView me={me} />,
  },
  {
    id: "nodes",
    label: "nav.nodes",
    short: "nav.nodesShort",
    icon: NodesIcon,
    restricted: false,
    render: (me) => <NodesCard me={me} />,
  },
  {
    // W22: /me/traffic refuses the renewal scope (AuthUser).
    id: "traffic",
    label: "nav.traffic",
    short: "nav.trafficShort",
    icon: TrafficIcon,
    restricted: false,
    render: () => <TrafficCard />,
  },
  {
    id: "orders",
    label: "nav.orders",
    short: "nav.ordersShort",
    icon: OrdersIcon,
    restricted: true,
    render: () => <OrdersView />,
  },
  {
    id: "wallet",
    label: "nav.wallet",
    short: "nav.walletShort",
    icon: WalletIcon,
    restricted: true,
    render: (me) => <Wallet me={me} />,
  },
  {
    id: "tickets",
    label: "nav.tickets",
    short: "nav.ticketsShort",
    icon: TicketsIcon,
    restricted: true,
    render: () => <Tickets />,
  },
  {
    id: "account",
    label: "nav.account",
    short: "nav.accountShort",
    icon: AccountIcon,
    restricted: true,
    render: (me) => <AccountSettings me={me} />,
  },
];

/** The views `me` may open. */
export function viewsFor(me: Me): PortalView[] {
  const restricted = me.expired || me.quota_exhausted;
  return PORTAL_VIEWS.filter((v) => v.restricted || !restricted);
}

/** The view for a location path (unknown sub-paths show the dashboard). */
export function viewOf(path: string, views: PortalView[]): PortalView {
  const rest = path.startsWith(appBase) ? path.slice(appBase.length) : "";
  const id = rest.replace(/^\//, "").split("/")[0] ?? "";
  return views.find((v) => v.id === id) ?? views[0];
}

/** The URL of a view. */
export function viewHref(v: PortalView): string {
  return v.id ? `${appBase}/${v.id}` : appBase;
}
