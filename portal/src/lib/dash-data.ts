import { contentApi, meApi, orderApi, ticketApi, walletApi } from '@/api';
import { K } from '@/lib/cache';
import { addDays, siteToday } from '@/lib/format';

/**
 * 仪表盘的首屏数据（缓存键 + 取法）：页面（components/dash/Overview）与「进页面之前就开始取」（lib/prefetch 的 prefetchCurrent）
 * 共用这一份——键对不上就等于预取白做。近 7 天 = 站点时区的日历日，今天算一天。
 */
export function dashSpecs() {
  return {
    announcements: { key: K.announcements, fetch: () => contentApi.announcements() },
    nodes: { key: K.nodes, fetch: () => meApi.nodes() },
    balance: { key: K.balance, fetch: () => walletApi.balance({ limit: 1 }) },
    orders: { key: K.orders, fetch: () => orderApi.list() },
    tickets: { key: K.tickets, fetch: () => ticketApi.list() },
    traffic: trafficSpec(7),
    help: { key: K.help(), fetch: () => contentApi.help() },
  };
}

/** 近 n 天的流量（站点时区的日历日，今天算一天）：仪表盘默认 7 天（预取的就是它），切到 30 天才取 30 天 */
export function trafficSpec(days: 7 | 30) {
  const to = siteToday();
  const from = addDays(to, -(days - 1));
  return { key: K.traffic(from, to), fetch: () => meApi.traffic(from, to) };
}
