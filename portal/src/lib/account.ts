import { formatBytes, formatMoney } from '@/lib/format';
import { att, nodesUp, pendingOrders, repliedTickets, unreadAnnouncements } from './attention.svelte';
import { auth, scope } from './auth.svelte';
import { t, tp } from './i18n.svelte';
import { R, allowed } from './routes';

/*
 * 导航（桌面顶栏、账户菜单、窄屏菜单）共用的条目与右侧的提示文字。都是函数：在模板里调用时读 $state，跟着变。
 */

export type NavItem = { to: string; label: string; meta?: string; dot?: string };

/** 套餐名（没有套餐时「暂无套餐」） */
export function planName(): string {
  return auth.plan?.plan?.name ?? t('暂无套餐');
}

/** 账户菜单抬头的第二行：套餐 · 余额 */
export function menuLine(): string {
  if (scope() === 'banned') return t('账户已被封禁');
  const bal = att.balance ? tp('余额 {v}', { v: formatMoney(att.balance.balance_cents) }) : '';
  return bal ? `${planName()} · ${bal}` : planName();
}

/** 窄屏菜单抬头的第二行：套餐 · 剩余流量 */
export function sheetLine(): string {
  if (scope() === 'banned') return t('账户已被封禁');
  const me = auth.me;
  if (!me || me.traffic_limit_bytes === null || !auth.plan?.plan) return planName();
  const left = Math.max(0, me.traffic_limit_bytes - me.traffic_used_bytes);
  return `${planName()} · ${tp('剩 {v}', { v: formatBytes(left) })}`;
}

/** 顶栏左组（用服务）与右组（看信息 / 求助），按账户范围过滤 */
export function navGroups(): NavItem[][] {
  const s = scope();
  const unread = unreadAnnouncements();
  const replied = repliedTickets();
  const up = nodesUp();
  const service: NavItem[] = [
    { to: R.dashboard, label: t('仪表盘') },
    { to: R.shop, label: t('商店') },
    { to: R.nodes, label: t('线路'), meta: up ? tp('{a} / {b} 可用', { a: up.up, b: up.all }) : undefined },
    { to: R.traffic, label: t('用量') },
  ];
  const info: NavItem[] = [
    {
      to: R.announcements, label: t('公告'),
      meta: unread ? tp('{n} 条未读', { n: unread }) : undefined,
      dot: unread ? tp('{n} 条未读', { n: unread }) : undefined,
    },
    { to: R.help, label: t('文档') },
    {
      to: R.tickets, label: t('工单'),
      meta: replied ? tp('{n} 张工单有新回复', { n: replied }) : undefined,
      dot: replied ? tp('{n} 张工单有新回复', { n: replied }) : undefined,
    },
  ];
  return [service, info].map((g) => g.filter((n) => allowed(n.to, s))).filter((g) => g.length > 0);
}

/** 账户菜单 / 窄屏菜单「账户」组：订单 · 钱包 · 邀请 · 账户设置（banned 没有） */
export function accountItems(): NavItem[] {
  const s = scope();
  const pending = pendingOrders();
  const items: NavItem[] = [
    { to: R.orders, label: t('订单'), meta: pending ? tp('{n} 笔待付款', { n: pending }) : undefined },
    { to: R.wallet, label: t('钱包'), meta: att.balance ? formatMoney(att.balance.balance_cents) : undefined },
  ];
  if (s === 'full') {
    items.push({
      to: R.walletTab('invite'), label: t('邀请'),
      meta: att.invite?.enabled ? tp('返利 {n}%', { n: att.invite.rate_percent }) : undefined,
    });
  }
  items.push({ to: R.account, label: t('账户设置') });
  return items.filter((n) => allowed(n.to.split('?')[0], s));
}

/** 当前页：同一路径或它下面的子路径（/orders/x 算「订单」）；带 ?tab= 的条目（邀请）还要分页对得上 */
export function isCurrent(to: string, path: string, search = ''): boolean {
  const [base, query] = to.split('?');
  const tab = new URLSearchParams(search).get('tab');
  if (query) return path === base && tab === new URLSearchParams(query).get('tab');
  if (base === R.wallet && tab === 'invite') return false;
  return base === '/' ? path === '/' : path === base || path.startsWith(`${base}/`);
}
