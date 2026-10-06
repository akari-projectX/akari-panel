/**
 * 接口数据缓存：先拿上一次的结果把页面画出来，同时在后台取最新的。
 *
 * 为什么要有它：接口是异步的，每个区块都要等请求回来，先出骨架、再一块块填进去，
 * 切页、刷新时观感生硬。有了缓存，看过的页面再进来就是「一次到位」的；
 * 最新数据回来后原地替换，用户察觉不到。
 *
 * 存在 sessionStorage 而不是 localStorage：
 *   · 刷新页面还在，所以刷新也能直接出内容；
 *   · 关掉标签页就没了，账号数据不会长期留在这台设备上；
 *   · 订阅令牌不进缓存（见下面 K 的说明）。
 * 登录、退出时整体清空，换账号不会看到上一个人的数据。
 */

const PREFIX = 'akari.cache:';
const mem = new Map<string, unknown>();
const inflight = new Map<string, Promise<unknown>>();
/*
 * 缓存的「代」。每次清空（退出、登录、换账号）加一。
 * 清空前已经发出的请求回来时代号对不上，结果就不再写进缓存——
 * 否则上一个账号的数据会在退出之后又回到 sessionStorage 里，
 * 同一个标签页换了账号时，新账号的第一屏还会先闪出上一个人的流量和订单。
 */
let generation = 0;

export function readCache<T>(key: string): T | undefined {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    if (raw !== null) {
      const v = JSON.parse(raw) as T;
      mem.set(key, v);
      return v;
    }
  } catch { /* 隐私模式或数据损坏，当作没有缓存 */ }
  return undefined;
}

export function writeCache(key: string, value: unknown) {
  mem.set(key, value);
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch { /* 超出配额就只留在内存里，本次会话照样能用 */ }
}

export function clearCache() {
  generation++;
  mem.clear();
  inflight.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
  } catch { /* 同上 */ }
}

/**
 * 取数并写入缓存。同一个 key 的请求在途时直接复用那一个 Promise——
 * 空闲预取和页面自己的请求常常撞在一起，没必要打两遍。
 */
export function load<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const gen = generation;
  const p = fetcher()
    .then((v) => {
      /* undefined 只来自 304（没有正文），不能把旧缓存覆盖成空；清空过的就是上一个账号的，丢掉 */
      if (v !== undefined && gen === generation) writeCache(key, v);
      return v;
    })
    .finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/**
 * 缓存键集中在这里定义：页面取数与空闲预取必须用同一个键，写散了就对不上。
 *
 * /me 只由 AuthProvider 写：它带着订阅令牌（面板对这个响应加了 no-store），
 * 存进 sessionStorage 的那份去掉了 sub_token / sub_url，令牌只留在内存里。
 */
export const K = {
  me: 'me',
  plan: 'me.plan',
  nodes: 'me.nodes',
  traffic: (from: string, to: string) => `me.traffic:${from}:${to}`,
  shop: (coupon: string, balance: boolean) => `shop:${coupon}:${balance ? 1 : 0}`,
  orders: 'orders',
  order: (id: string) => `order:${id}`,
  balance: 'balance',
  withdrawals: 'withdrawals',
  invite: 'invite',
  inviteCodes: 'invite.codes',
  tickets: 'tickets',
  ticket: (id: string) => `ticket:${id}`,
  announcements: 'announcements',
  help: (q = '') => `help:${q}`,
  article: (id: string) => `help.article:${id}`,
  passkeys: 'passkeys',
} as const;
