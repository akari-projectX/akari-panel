import type { Component } from 'svelte';
import { R } from './routes';

/**
 * 页面表：地址 → 页面组件（按需加载）、布局、标题。
 *   · dash   —— 用户中心：要登录，账户范围由 routes.ts 的 PAGE_SCOPES 决定；
 *   · guest  —— 登录、注册、找回密码：已登录的人直接去 ?redirect= 指的那一页；
 *   · public —— 重置密码、注销结果、条款、隐私：谁都能看（访客布局）。
 * 还没迁移的页面是 Placeholder（页面名 + 「此页面迁移中」），后续 PR 逐个换成真页面。
 */
export type Layout = 'dash' | 'guest' | 'public';
export type PageProps = { title: string; params?: Record<string, string> };
/** 页面组件收到 title、params；用不到它们的页面可以不声明 props */
export type PageModule = { default: Component<PageProps> | Component<Record<string, never>> };
export type Page = { path: string; title: string; layout: Layout; load: () => Promise<PageModule> };

const placeholder = () => import('../pages/Placeholder.svelte');

const dash = (path: string, title: string, load: Page['load'] = placeholder): Page => ({ path, title, layout: 'dash', load });
const guest = (path: string, title: string, load: Page['load']): Page => ({ path, title, layout: 'guest', load });
const pub = (path: string, title: string, load: Page['load']): Page => ({ path, title, layout: 'public', load });
const legal = () => import('../pages/Legal.svelte');

export const PAGES: Page[] = [
  dash(R.dashboard, '仪表盘', () => import('../pages/Dashboard.svelte')),
  dash(R.shop, '商店', () => import('../pages/Shop.svelte')),
  dash(R.nodes, '线路', () => import('../pages/Nodes.svelte')),
  dash(R.traffic, '用量', () => import('../pages/Traffic.svelte')),
  dash(R.orders, '订单', () => import('../pages/Orders.svelte')),
  dash('/orders/:id', '订单详情', () => import('../pages/OrderDetail.svelte')),
  dash(R.wallet, '钱包', () => import('../pages/Wallet.svelte')),
  dash(R.tickets, '工单', () => import('../pages/Tickets.svelte')),
  dash(R.help, '文档', () => import('../pages/Help.svelte')),
  dash(R.announcements, '公告', () => import('../pages/Announcements.svelte')),
  dash(R.account, '账户设置', () => import('../pages/Account.svelte')),
  guest(R.login, '登录', () => import('../pages/Login.svelte')),
  guest(R.register, '注册', () => import('../pages/Register.svelte')),
  guest(R.forgot, '找回密码', () => import('../pages/Forgot.svelte')),
  pub(R.reset, '重置密码', () => import('../pages/Reset.svelte')),
  pub(R.deleted, '账户已注销', () => import('../pages/Deleted.svelte')),
  pub(R.terms, '服务条款', legal),
  pub(R.privacy, '隐私政策', legal),
];

/** 旧地址：`/invite` → 钱包页的邀请分页（邮件、收藏夹里的链接） */
export const REDIRECTS: Record<string, string> = {
  [R.invite]: R.walletTab('invite'),
};

/** 按地址找页面；`:id` 段匹配任意一段非空路径。找不到 = undefined（显示「找不到页面」） */
export function match(path: string): { page: Page; params: Record<string, string> } | undefined {
  const parts = trim(path).split('/');
  for (const page of PAGES) {
    const want = trim(page.path).split('/');
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < want.length && ok; i++) {
      if (want[i].startsWith(':') && parts[i]) params[want[i].slice(1)] = safeDecode(parts[i]);
      else ok = want[i] === parts[i];
    }
    if (ok) return { page, params };
  }
  return undefined;
}

const safeDecode = (s: string) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/* 去掉末尾的 /（`/shop/` 与 `/shop` 同一页） */
const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, '') : p);
