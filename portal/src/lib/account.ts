import { daysLeft, formatMoney, trafficUsage } from '@/lib/format';
import { att, openTickets, pendingOrders, repliedTickets } from './attention.svelte';
import { auth, scope } from './auth.svelte';
import { tp } from './i18n.svelte';
import { R, allowed } from './routes';

/*
 * 导航（桌面顶栏、头像菜单、窄屏菜单）共用的条目与账号那根线的数据（2026-10-30 外观 A · 纸面简约：N1 文字导航 + 头像菜单）。
 * 都是函数：在模板里调用时读 $state，跟着变。
 */

/** icon = 菜单卡片里图标的键（components/menu-icons.ts；图标只随卡片一起加载，不进首屏） */
export type IconKey = 'dashboard' | 'shop' | 'docs' | 'invite' | 'tickets' | 'nodes' | 'traffic' | 'news' | 'orders' | 'settings';

export type NavLink = { to: string; label: string; icon: IconKey; meta?: string; attention?: boolean };

/**
 * 顶栏（2026-10-31 用户确认：名称方案 ①）：常用的五项 `总览 · 套餐 · 节点 · 指南 · 支持` 摆在外面，
 * 不常用的三项 `流量明细 · 账单 · 动态` 收进「更多」（桌面是一个下拉；窄屏菜单里全部平铺，先五项后三项）。
 * 地址不变（旧链接照样能开）。每一项按账户范围显示（routes.ts 的 PAGE_SCOPES）：过期 / 流量用完的看不到节点、流量明细，
 * 被封禁的只剩总览和支持（「更多」里一项都没有时不显示「更多」）。
 */
const PRIMARY: NavLink[] = [
  { to: R.dashboard, label: '总览', icon: 'dashboard' },
  { to: R.shop, label: '套餐', icon: 'shop' },
  { to: R.nodes, label: '节点', icon: 'nodes' },
  { to: R.help, label: '指南', icon: 'docs' },
  { to: R.tickets, label: '支持', icon: 'tickets' },
];

const MORE: NavLink[] = [
  { to: R.traffic, label: '流量明细', icon: 'traffic' },
  { to: R.orders, label: '账单', icon: 'orders' },
  { to: R.announcements, label: '动态', icon: 'news' },
];

/**
 * 头像菜单里的两项：钱包与邀请（/wallet）、设置。
 * 过期 / 流量用完的账户没有邀请，同一项显示为「钱包」。
 */
const ACCOUNT: NavLink[] = [
  { to: R.wallet, label: '邀请', icon: 'invite' },
  { to: R.account, label: '设置', icon: 'settings' },
];

/** 账号那根线：剩余流量占总量的比例（不限流量、没有套餐时不画） */
export function accountLine() {
  const { me, plan } = auth;
  const usage = trafficUsage(plan?.traffic_used_bytes ?? me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? me?.traffic_limit_bytes ?? null);
  const has = !!plan?.plan && !usage.unlimited && usage.total > 0;
  const email = me?.email ?? '';
  return {
    email,
    /* 头像：邮箱的第一个字母（账号没有昵称与头像图片） */
    initial: (email.match(/[\p{L}\p{N}]/u)?.[0] ?? '·').toUpperCase(),
    plan: plan?.plan?.name,
    days: daysLeft(plan?.expires_at ?? me?.expires_at),
    usage,
    has,
    value: has ? Math.round(usage.leftPct) : 0,
    tone: has && usage.leftPct < 10 ? ('warn' as const) : undefined,
  };
}

const hasWallet = (s: string | undefined) => s === 'full';

const withAttention = (list: NavLink[]): NavLink[] => {
  const s = scope();
  return list.filter((n) => allowed(n.to, s)).map((n) => ({
    ...n,
    attention: (n.to === R.tickets && repliedTickets() > 0) || (n.to === R.orders && pendingOrders() > 0),
  }));
};

/** 顶部导航（桌面）外面的五项：不显示数字，只有工单新回复上的小圆点 */
export function primaryItems(): NavLink[] {
  return withAttention(PRIMARY);
}

/** 「更多」里的三项（账单有待支付订单时带圆点，「更多」按钮上也挂一个） */
export function moreItems(): NavLink[] {
  return withAttention(MORE);
}

/** 窄屏菜单里的导航：同样八项（先五项后三项），右边挂实时数字（数字带单位，语序随语言变，所以用 tp 组装） */
export function navItems(): NavLink[] {
  return [...primaryItems(), ...moreItems()].map((n) => {
    if (n.to === R.tickets) {
      const replied = repliedTickets();
      const meta = replied ? tp('{n} 条新回复', { n: replied }) : openTickets() ? tp('{n} 张未关闭', { n: openTickets() }) : undefined;
      return { ...n, meta };
    }
    if (n.to === R.orders) return { ...n, meta: pendingOrders() ? tp('{n} 笔待支付', { n: pendingOrders() }) : undefined };
    return n;
  });
}

/** 头像菜单里的账户项（钱包 / 邀请、设置；被封禁的账户没有） */
export function accountItems(): NavLink[] {
  const s = scope();
  return ACCOUNT.filter((n) => allowed(n.to, s)).map((n) => (n.to === R.wallet
    ? { ...n, label: hasWallet(s) ? n.label : '钱包', meta: att.balance ? formatMoney(att.balance.balance_cents) : undefined }
    : n));
}

/** 「有事等你」：工单有客服的新回复、或者有待支付的订单 */
export function attentionDot(): boolean {
  return repliedTickets() > 0 || pendingOrders() > 0;
}

/** 窄屏菜单按钮的读屏名字：说出头像上那个圆点是什么意思，没有事时说剩余流量 */
export function linesLabel(t: (s: string) => string): string {
  const replied = repliedTickets();
  if (replied > 0) return tp('菜单，{n} 张工单有新回复', { n: replied });
  if (pendingOrders() > 0) return t('菜单，有待支付的订单');
  const a = accountLine();
  return a.has ? tp('菜单，剩余流量 {n}%', { n: a.value }) : t('打开菜单');
}

/** 当前页：同一路径或它下面的子路径（/orders/x 算「账单」） */
export function isCurrent(to: string, path: string): boolean {
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
}
