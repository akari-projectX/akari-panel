import type { Scope } from '@/lib/auth';

/**
 * 门户的路由表（BrowserRouter，相对 api/base 的 routerBase）。README「路由表」是它的说明。
 *
 * 路由名与面板邮件里写死的链接一致（到期提醒 `…/shop`、重置密码 `…/reset#token=…`、
 * 邀请 `…/register?invite=…`）：③ 把门户挪到根路径之后，面板只需把邮件链接的 `/app` 前缀去掉，路径不变。
 */
export const R = {
  dashboard: '/',
  shop: '/shop',
  nodes: '/nodes',
  traffic: '/traffic',
  orders: '/orders',
  order: (id: string) => `/orders/${encodeURIComponent(id)}`,
  wallet: '/wallet',
  invite: '/invite',
  tickets: '/tickets',
  ticket: (id: string) => `/tickets?id=${encodeURIComponent(id)}`,
  help: '/help',
  announcements: '/announcements',
  account: '/account',
  login: '/login',
  register: '/register',
  forgot: '/forgot',
  reset: '/reset',
  terms: '/terms',
  privacy: '/privacy',
  faq: '/faq',
} as const;

/** 旧地址（主题旧路由名）→ 新地址，书签和旧链接不至于 404 */
export const ALIASES: [string, string][] = [
  ['/dashboard', R.dashboard],
  ['/plans', R.shop],
  ['/settings', R.account],
  ['/guide', R.help],
  ['/referral', R.invite],
];

const FULL: Scope[] = ['full'];
const SHOP: Scope[] = ['full', 'renewal'];
const TICKETS: Scope[] = ['full', 'renewal', 'banned'];

/**
 * 每个用户中心页面对哪些账户范围开放（与面板接口的守卫一致：AuthUser = full，ShopUser = full + renewal，
 * PortalUser = 再加 banned）。仪表盘对所有范围开放，按范围显示不同内容。
 */
export const PAGE_SCOPES: Record<string, Scope[]> = {
  [R.shop]: SHOP,
  [R.orders]: SHOP,
  [R.wallet]: SHOP,
  [R.help]: SHOP,
  [R.announcements]: SHOP,
  [R.account]: SHOP,
  [R.tickets]: TICKETS,
  [R.nodes]: FULL,
  [R.traffic]: FULL,
  [R.invite]: FULL,
};

/** 某个范围能不能进这一页 */
export function allowed(path: string, scope: Scope | undefined): boolean {
  if (!scope) return false;
  if (path === R.dashboard) return true;
  const s = PAGE_SCOPES[path];
  return !s || s.includes(scope);
}
