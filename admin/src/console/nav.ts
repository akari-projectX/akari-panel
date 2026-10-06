import type { IconName } from "../shared/ui/icons";

export type NavItem = { id: string; zh: string; en: string; icon: IconName; badge?: "tickets" | "alerts" };
export type NavGroup = { zh: string; en: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    zh: "概览",
    en: "Overview",
    items: [
      { id: "dashboard", zh: "仪表盘", en: "Dashboard", icon: "dashboard" },
      { id: "status", zh: "系统状态", en: "System status", icon: "activity" },
    ],
  },
  {
    zh: "运营",
    en: "Operations",
    items: [
      { id: "users", zh: "用户", en: "Users", icon: "users" },
      { id: "orders", zh: "订单", en: "Orders", icon: "receipt" },
      { id: "coupons", zh: "优惠券", en: "Coupons", icon: "tag" },
      { id: "finance", zh: "资金", en: "Finance", icon: "wallet" },
      { id: "tickets", zh: "工单", en: "Tickets", icon: "ticket", badge: "tickets" },
      { id: "content", zh: "内容", en: "Content", icon: "file" },
    ],
  },
  {
    zh: "资源",
    en: "Resources",
    items: [
      { id: "nodes", zh: "节点", en: "Nodes", icon: "server" },
      { id: "plans", zh: "套餐", en: "Plans", icon: "layers" },
      { id: "alerts", zh: "告警", en: "Alerts", icon: "bell", badge: "alerts" },
      { id: "updates", zh: "更新", en: "Updates", icon: "download" },
    ],
  },
  {
    zh: "系统",
    en: "System",
    items: [
      { id: "settings", zh: "系统设置", en: "Settings", icon: "settings" },
      { id: "audit", zh: "审计日志", en: "Audit log", icon: "history" },
      { id: "account", zh: "我的账户", en: "My account", icon: "user" },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);
