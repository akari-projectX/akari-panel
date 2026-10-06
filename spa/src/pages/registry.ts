import { lazyRetry } from '@/lib/lazy';

/*
 * 所有页面都按需加载。
 *
 * 入口只有框架与外壳；页面分包在启动画面后面下载（外层 Suspense 的占位会拖住
 * 启动画面，见 lib/boot.ts），用户看到的是启动画面淡出后一张完整的首屏。
 *
 * 页面清单单独放在这里：App 的路由表和 lib/prefetch 的空闲预载用的是同一批组件，
 * 预载调的是组件自己的 preload()，这样之后第一次进页面是同步渲染的，见 lib/lazy。
 */
export const Login = lazyRetry(() => import('@/pages/auth').then((m) => ({ default: m.Login })));
export const Register = lazyRetry(() => import('@/pages/auth').then((m) => ({ default: m.Register })));
export const Forgot = lazyRetry(() => import('@/pages/auth').then((m) => ({ default: m.Forgot })));
export const Reset = lazyRetry(() => import('@/pages/auth').then((m) => ({ default: m.Reset })));
export const Dashboard = lazyRetry(() => import('@/pages/dash/dashboard'));
export const Nodes = lazyRetry(() => import('@/pages/dash/nodes'));
export const Traffic = lazyRetry(() => import('@/pages/dash/traffic'));
export const Shop = lazyRetry(() => import('@/pages/dash/shop'));
export const Orders = lazyRetry(() => import('@/pages/dash/orders'));
export const OrderDetail = lazyRetry(() => import('@/pages/dash/order-detail'));
export const Wallet = lazyRetry(() => import('@/pages/dash/wallet'));
export const Invite = lazyRetry(() => import('@/pages/dash/invite'));
export const Tickets = lazyRetry(() => import('@/pages/dash/tickets'));
export const Help = lazyRetry(() => import('@/pages/dash/help'));
export const Announcements = lazyRetry(() => import('@/pages/dash/announcements'));
export const Account = lazyRetry(() => import('@/pages/dash/account'));
export const Terms = lazyRetry(() => import('@/pages/terms'));
export const Privacy = lazyRetry(() => import('@/pages/privacy'));
export const Faq = lazyRetry(() => import('@/pages/faq'));

/** 站点页（条款、常见问题、登录注册）空闲时预载的那一批 */
export const SITE_PAGES = [Terms, Privacy, Faq, Login];

/** 进入用户中心后空闲时预载的那一批 */
export const DASH_PAGES = [
  Dashboard, Nodes, Traffic, Shop, Orders, OrderDetail, Wallet, Invite, Tickets, Help, Announcements, Account,
];
