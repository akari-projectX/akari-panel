import BookOpen from '@lucide/svelte/icons/book-open';
import CreditCard from '@lucide/svelte/icons/credit-card';
import Headphones from '@lucide/svelte/icons/headphones';
import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
import Megaphone from '@lucide/svelte/icons/megaphone';
import Settings from '@lucide/svelte/icons/settings';
import Share2 from '@lucide/svelte/icons/share-2';
import ShoppingBag from '@lucide/svelte/icons/shopping-bag';
import TrendingUp from '@lucide/svelte/icons/trending-up';
import Wifi from '@lucide/svelte/icons/wifi';
import type { IconKey } from '$lib/account';

/* 导航图标（v1.4.0 的 lucide 线性图标）：桌面顶栏与「更多」下拉（2026-10-31 起，所以随顶栏进首屏）、账号卡片 / 窄屏菜单的每一行 */
export const ICONS = {
  dashboard: LayoutDashboard, shop: ShoppingBag, docs: BookOpen, invite: Share2, tickets: Headphones,
  nodes: Wifi, traffic: TrendingUp, news: Megaphone, orders: CreditCard, settings: Settings,
} satisfies Record<IconKey, unknown>;
