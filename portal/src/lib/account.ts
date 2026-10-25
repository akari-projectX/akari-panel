import { daysLeft, trafficUsage } from '@/lib/format';
import { openTickets, pendingOrders, repliedTickets } from './attention.svelte';
import { auth, scope } from './auth.svelte';
import { tp } from './i18n.svelte';
import { R, allowed } from './routes';

/*
 * 导航（桌面顶栏、「更多」下拉、账号卡片、窄屏菜单）共用的条目与账号那根线的数据（v1.4.0 的 layouts/dash-layout + lib/account-line）。
 * 都是函数：在模板里调用时读 $state，跟着变。
 */

/** icon = 菜单卡片里图标的键（components/menu-icons.ts；图标只随卡片一起加载，不进首屏） */
export type IconKey = 'dashboard' | 'shop' | 'docs' | 'invite' | 'tickets' | 'nodes' | 'traffic' | 'news' | 'orders' | 'settings';

export type NavLink = { to: string; label: string; icon: IconKey; desc?: string; meta?: string; attention?: boolean };

/**
 * 顶部五项（2026-10-13 用户：仪表盘 · 商店 · 文档 · 邀请 · 工单 · 更多）。
 * 「邀请」是合并后的钱包与邀请页（/wallet）；过期 / 流量用完的账户没有邀请，同一项显示为「钱包」。
 * 每一项按账户范围显示（routes.ts 的 PAGE_SCOPES）：过期 / 流量用完的看不到节点、流量，被封禁的只剩仪表盘和工单。
 */
const PRIMARY: NavLink[] = [
  { to: R.dashboard, label: '仪表盘', icon: 'dashboard' },
  { to: R.shop, label: '商店', icon: 'shop' },
  { to: R.help, label: '文档', icon: 'docs' },
  { to: R.wallet, label: '邀请', icon: 'invite' },
  { to: R.tickets, label: '工单', icon: 'tickets' },
];

/** 折起来的几项（顺序按「离服务由近到远」）；desc 是「更多」里每项的一句说明 */
const MORE: NavLink[] = [
  { to: R.nodes, label: '节点状态', desc: '当前可用线路与倍率', icon: 'nodes' },
  { to: R.traffic, label: '使用明细', desc: '上下行走势与每日用量', icon: 'traffic' },
  { to: R.announcements, label: '公告与动态', desc: '节点变更与维护计划', icon: 'news' },
  { to: R.orders, label: '我的订单', desc: '消费记录与支付状态', icon: 'orders' },
  { to: R.account, label: '设置', desc: '账号、邮箱、密码与通行密钥', icon: 'settings' },
];

/** 「更多」里的编号从主导航之后接着数 */
export const MORE_START = 5;

/** 账号那根线：剩余流量占总量的比例（不限流量、没有套餐时不画） */
export function accountLine() {
  const { me, plan } = auth;
  const usage = trafficUsage(plan?.traffic_used_bytes ?? me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? me?.traffic_limit_bytes ?? null);
  const has = !!plan?.plan && !usage.unlimited && usage.total > 0;
  return {
    email: me?.email ?? '',
    plan: plan?.plan?.name,
    days: daysLeft(plan?.expires_at ?? me?.expires_at),
    usage,
    has,
    value: has ? Math.round(usage.leftPct) : 0,
    tone: has && usage.leftPct < 10 ? ('warn' as const) : undefined,
  };
}

const hasWallet = (s: string | undefined) => s === 'full';

/** 顶部导航（桌面）：meta 不显示，只有工单上的「新回复」点 */
export function primaryItems(): NavLink[] {
  const s = scope();
  return PRIMARY.filter((n) => allowed(n.to, s)).map((n) => ({
    ...n,
    label: n.to === R.wallet && !hasWallet(s) ? '钱包' : n.label,
    attention: n.to === R.tickets && repliedTickets() > 0,
  }));
}

/** meta 带单位（笔 / 张 / GB），语序随语言变，所以在这里用 tp 组装 */
function moreMeta(to: string): string | undefined {
  if (to === R.traffic) {
    const a = accountLine();
    return a.has ? tp('{a} / {b} GB', { a: a.usage.used.toFixed(1), b: Math.round(a.usage.total) }) : undefined;
  }
  if (to === R.orders) return pendingOrders() ? tp('{n} 笔待支付', { n: pendingOrders() }) : undefined;
  return undefined;
}

/** 折起来的几项（「更多」下拉与窄屏卡片的第二组） */
export function moreItems(): NavLink[] {
  const s = scope();
  return MORE.filter((n) => allowed(n.to, s)).map((n) => ({
    ...n,
    meta: moreMeta(n.to),
    attention: n.to === R.orders && pendingOrders() > 0,
  }));
}

/** 窄屏卡片的两组（全部带图标；需要你处理的数字前面加一个圆点） */
export function menuGroups(): NavLink[][] {
  const first = primaryItems().map((p) => p.to === R.tickets
    ? { ...p, meta: openTickets() ? tp('{n} 张未关闭', { n: openTickets() }) : undefined }
    : p);
  return [first, moreItems()].filter((g) => g.length > 0);
}

/** 宽屏账号卡片里的导航：订单与设置（只有能买东西的账户有） */
export function accountItems(): NavLink[] {
  return moreItems().filter((n) => n.to === R.orders || n.to === R.account);
}

/** 「有事等你」：工单有客服的新回复、或者有待支付的订单 */
export function attentionDot(): boolean {
  return repliedTickets() > 0 || pendingOrders() > 0;
}

/** 菜单按钮的读屏名字：说出那根线、那个圆点是什么意思 */
export function linesLabel(t: (s: string) => string): string {
  const replied = repliedTickets();
  if (replied > 0) return tp('菜单，{n} 张工单有新回复', { n: replied });
  if (pendingOrders() > 0) return t('菜单，有待支付的订单');
  const a = accountLine();
  return a.has ? tp('菜单，剩余流量 {n}%', { n: a.value }) : t('打开菜单');
}

/** 当前页：同一路径或它下面的子路径（/orders/x 算「我的订单」） */
export function isCurrent(to: string, path: string): boolean {
  return to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`);
}
