import {
  Activity,
  BadgePercent,
  Bell,
  Download,
  FileText,
  Gauge,
  History,
  LayoutGrid,
  Layers,
  LifeBuoy,
  Receipt,
  Server,
  Settings,
  UserRound,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  id: string;
  zh: string;
  en: string;
  icon: LucideIcon;
  /** Tile colour on the phone's "More" page (system-settings style). */
  tint: string;
  badge?: "tickets" | "alerts";
};
export type NavGroup = { zh: string; en: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    zh: "概览",
    en: "Overview",
    items: [
      { id: "dashboard", zh: "仪表盘", en: "Dashboard", icon: Gauge, tint: "#2563eb" },
      { id: "status", zh: "系统状态", en: "System status", icon: Activity, tint: "#16a34a" },
    ],
  },
  {
    zh: "运营",
    en: "Operations",
    items: [
      { id: "users", zh: "用户", en: "Users", icon: Users, tint: "#2563eb" },
      { id: "orders", zh: "订单", en: "Orders", icon: Receipt, tint: "#ea580c" },
      { id: "coupons", zh: "优惠券", en: "Coupons", icon: BadgePercent, tint: "#db2777" },
      { id: "finance", zh: "资金", en: "Finance", icon: Wallet, tint: "#0d9488" },
      { id: "tickets", zh: "工单", en: "Tickets", icon: LifeBuoy, tint: "#7c3aed", badge: "tickets" },
      { id: "content", zh: "内容", en: "Content", icon: FileText, tint: "#64748b" },
    ],
  },
  {
    zh: "资源",
    en: "Resources",
    items: [
      { id: "nodes", zh: "节点", en: "Nodes", icon: Server, tint: "#0891b2" },
      { id: "plans", zh: "套餐", en: "Plans", icon: Layers, tint: "#4f46e5" },
      { id: "alerts", zh: "告警", en: "Alerts", icon: Bell, tint: "#dc2626", badge: "alerts" },
      { id: "updates", zh: "更新", en: "Updates", icon: Download, tint: "#0284c7" },
    ],
  },
  {
    zh: "系统",
    en: "System",
    items: [
      { id: "settings", zh: "系统设置", en: "Settings", icon: Settings, tint: "#6b7280" },
      { id: "audit", zh: "审计日志", en: "Audit log", icon: History, tint: "#6b7280" },
      { id: "account", zh: "我的账户", en: "My account", icon: UserRound, tint: "#6b7280" },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);

/** The "More" page (phones): every page in one screen. */
export const MORE: NavItem = { id: "more", zh: "更多", en: "More", icon: LayoutGrid, tint: "#6b7280" };

/** Phone bottom tabs (SPRINT admin-redesign-1012 ⑦): dashboard, users, orders, tickets, more. */
export const TABS: NavItem[] = [
  ...["dashboard", "users", "orders", "tickets"].map((id) => ALL_NAV.find((n) => n.id === id) as NavItem),
  MORE,
];

export const pathOf = (id: string) => (id === "dashboard" ? "/" : `/${id}`);
