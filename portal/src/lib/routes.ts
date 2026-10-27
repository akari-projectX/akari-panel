/**
 * 门户的路由表（面板测试 access::tests::routes_match_the_portal 读它，与 access::PORTAL_PAGES 一起改）。
 *
 * 路由名与面板邮件里的链接一致（到期提醒 `/shop`、重置密码 `/reset#token=…`、邀请 `/register?invite=…`）。
 * 面板只对这里的顶层路径返回 index.html（akari-panel `access::PORTAL_PAGES`；面板测试
 * `routes_match_the_portal` 读这个文件比对：下面 R 的写法（单引号路径、末尾 as const）不能改）。
 */
export const R = {
  dashboard: '/',
  shop: '/shop',
  nodes: '/nodes',
  traffic: '/traffic',
  orders: '/orders',
  order: (id: string) => `/orders/${encodeURIComponent(id)}`,
  /** 邀请与钱包（合并页）；section = 页内分页 */
  wallet: '/wallet',
  walletTab: (section: 'invite' | 'ledger' | 'withdrawals') => `/wallet?tab=${section}`,
  tickets: '/tickets',
  ticket: (id: string) => `/tickets?id=${encodeURIComponent(id)}`,
  help: '/help',
  announcements: '/announcements',
  account: '/account',
  login: '/login',
  register: '/register',
  forgot: '/forgot',
  reset: '/reset',
  /** 注销账户之后的结果页（公开：那时已经没有会话） */
  deleted: '/deleted',
  terms: '/terms',
  privacy: '/privacy',
} as const;

/**
 * 账户范围（面板 README 的 Renewal scope / Portal scope）：
 *   · full    —— 正常账户，全部功能；
 *   · renewal —— 已过期或流量用完：只剩商店、订单、钱包、工单、帮助、公告、账户；
 *   · banned  —— 被封禁：只看封禁说明和工单。
 */
export type Scope = 'full' | 'renewal' | 'banned';

export function scopeOf(me: { banned: boolean; expired: boolean; quota_exhausted: boolean }): Scope {
  if (me.banned) return 'banned';
  if (me.expired || me.quota_exhausted) return 'renewal';
  return 'full';
}

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
};

/** 某个范围能不能进这一页（path = 顶层路径，`/orders/x` 按 `/orders` 算） */
export function allowed(path: string, scope: Scope | undefined): boolean {
  if (!scope) return false;
  const top = path === '/' ? '/' : `/${path.split('/')[1] ?? ''}`;
  if (top === R.dashboard) return true;
  const s = PAGE_SCOPES[top];
  return !s || s.includes(scope);
}

/**
 * 登录后该去哪：拦截前想去的那一页，没有就进仪表盘。只接受站内路径——
 * `//evil.example` 会被浏览器当成协议相对的外链。
 */
export function safeRedirect(redirect: string | null): string {
  if (!redirect || !redirect.startsWith('/') || redirect.startsWith('//') || redirect.includes('\\')) return '/';
  return redirect;
}
