import {
  Activity,
  BadgePercent,
  Bell,
  Download,
  FileText,
  Globe,
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
      { id: "dns", zh: "DNS", en: "DNS", icon: Globe, tint: "#0ea5e9" },
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

/** The navigation item (and its group) of a page id; "more" has no group. */
export function navOf(id: string): { group?: NavGroup; item: NavItem } {
  for (const g of NAV) for (const it of g.items) if (it.id === id) return { group: g, item: it };
  return { item: id === "more" ? MORE : ALL_NAV[0] };
}

/**
 * Full sub-pages under a page (tabs that are routes): their breadcrumb
 * label. Other sub-paths are objects (a server, a ticket, a settings
 * section) whose name the page reports with `useCrumb`.
 */
export const SUB_LABELS: Record<string, { zh: string; en: string }> = {
  "content/announcements": { zh: "公告", en: "Announcements" },
  "content/kb": { zh: "知识库", en: "Knowledge base" },
  "finance/withdrawals": { zh: "提现审核", en: "Withdrawals" },
  "finance/balances": { zh: "余额", en: "Balances" },
  "finance/commissions": { zh: "返利", en: "Commissions" },
  "plans/groups": { zh: "节点组", en: "Node groups" },
  "coupons/batches": { zh: "批量码", en: "Code batches" },
  "alerts/outbox": { zh: "通知记录", en: "Deliveries" },
};

/** Generic names for an object opened with `?open=` before (or without) its own name. */
export const OPEN_LABELS: Record<string, { zh: string; en: string }> = {
  users: { zh: "用户详情", en: "User" },
  orders: { zh: "订单详情", en: "Order" },
  alerts: { zh: "告警详情", en: "Alert" },
  audit: { zh: "审计记录", en: "Audit entry" },
  coupons: { zh: "优惠券详情", en: "Coupon" },
};
