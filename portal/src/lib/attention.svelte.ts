import {
  contentApi, inviteApi, meApi, orderApi, ticketApi,
  walletApi, type Announcements, type MyBalance, type MyInvite, type MyNode, type MyOrder, type TicketRow,
} from '@/api';
import { K, load, readCache } from '@/lib/cache';
import type { Scope } from './routes';

/**
 * 导航上「点进去之前就该知道的数字」：待付款订单、工单的新回复、未读公告（启动画面收起后取，不挡首屏），
 * 余额与返利比例（打开账户菜单时取）、线路可用数（打开窄屏菜单时取）。拉不到就让这些位置空着，不挡路。
 * 与页面共用 sessionStorage 缓存（同一个键），已经看过的数字立刻就有。
 *
 * 账户范围：订单、公告、余额 = full + renewal；邀请、线路 = full；工单 = 全部（含 banned）。
 */

export const att = $state<{
  orders?: MyOrder[];
  tickets?: TicketRow[];
  announcements?: Announcements;
  balance?: MyBalance;
  invite?: MyInvite;
  nodes?: MyNode[];
}>({});

const shop = (s: Scope | undefined) => s === 'full' || s === 'renewal';

function fetchInto<K extends keyof typeof att>(field: K, key: string, fetcher: () => Promise<NonNullable<(typeof att)[K]>>) {
  const hit = readCache<(typeof att)[K]>(key);
  if (hit !== undefined) att[field] = hit;
  load(key, fetcher).then((v) => { if (v !== undefined) att[field] = v; }, () => {});
}

/** 启动画面收起后、以及换了账户范围时调用 */
export function loadAttention(s: Scope | undefined) {
  reset();
  if (!s) return;
  fetchInto('tickets', K.tickets, () => ticketApi.list());
  if (!shop(s)) return;
  fetchInto('orders', K.orders, () => orderApi.list());
  fetchInto('announcements', K.announcements, () => contentApi.announcements());
}

/** 账户菜单打开：余额、返利比例 */
export function loadMenuFacts(s: Scope | undefined) {
  if (!shop(s)) return;
  /* 只要余额：limit 1，键与钱包页（K.balance，整页明细）分开 */
  fetchInto('balance', 'menu.balance', () => walletApi.balance({ limit: 1 }));
  if (s === 'full') fetchInto('invite', K.invite, () => inviteApi.get());
}

/** 窄屏菜单打开：再加线路可用数 */
export function loadSheetFacts(s: Scope | undefined) {
  loadMenuFacts(s);
  if (s === 'full') fetchInto('nodes', K.nodes, () => meApi.nodes());
}

function reset() {
  att.orders = undefined;
  att.tickets = undefined;
  att.announcements = undefined;
  att.balance = undefined;
  att.invite = undefined;
  att.nodes = undefined;
}

/** 待付款订单数 */
export const pendingOrders = () => (att.orders ?? []).filter((o) => o.status === 'pending').length;
/** 有新回复（客服回了、还没看）的未关闭工单数 */
export const repliedTickets = () => (att.tickets ?? []).filter((t) => t.unread && t.status !== 'closed').length;
/** 未关闭的工单数 */
export const openTickets = () => (att.tickets ?? []).filter((t) => t.status !== 'closed').length;
