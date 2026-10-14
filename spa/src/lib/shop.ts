import type { CouponRefusal, Me, MyOrder, Offer, OfferAction, OfferRefusal, Shop, ShopPlan } from '@/api';
import { PERIOD_MONTHS } from '@/lib/format';

/**
 * 商店的纯逻辑（有单测）。价格一律由面板算好（/me/shop 的 offers），前端只负责挑选和展示，不做任何价格计算。
 */

/**
 * 默认选中哪一档（移植自面板门户的 preselect，中-1 的前端保护）：
 *   · 当前套餐 + 流量用完 → 流量重置包；
 *   · 当前套餐 + 已过期 → 续费；
 *   · 否则第一个能买的周期（重置包排最后）。
 * 被拒的报价永远不会被选中；什么都买不了返回 undefined。
 */
export function preselect(p: ShopPlan, me: Pick<Me, 'expired' | 'quota_exhausted'>): Offer | undefined {
  const buyable = p.offers.filter((o) => o.action != null);
  if (p.current && me.quota_exhausted) {
    const reset = buyable.find((o) => o.action === 'reset');
    if (reset) return reset;
  }
  if (p.current && me.expired) {
    const renew = buyable.find((o) => o.action === 'renew');
    if (renew) return renew;
  }
  return buyable.find((o) => o.action !== 'reset') ?? buyable[0];
}

/** 一档报价在弹窗里的唯一键（同一个 days 周期可以有多档） */
export const offerKey = (o: Pick<Offer, 'period' | 'days'>) => `${o.period}:${o.days ?? ''}`;

/**
 * 套餐卡片的大字价格（2026-10-14 商店卡片）：只是把面板给的标价换个说法，不算任何应付金额。
 *   · 有按月计的周期 → 各周期按月折算后最低的那个（`per: 'month'`，分取整）；
 *   · 只有按天 / 一次性 → 最便宜那一档的标价（`per: offer`，写它自己的时长）；
 *   · `from`：不止一种周期可选（「起」）；`count`：周期数（不含重置包）；
 *   · `save`：相对月付，折扣最大的长周期省了多少（≥ 5% 才写）。
 */
export type Headline = {
  cents: number;
  per: 'month' | Offer;
  from: boolean;
  count: number;
  only?: Offer;
  save?: { offer: Offer; percent: number };
};

export function headline(p: Pick<ShopPlan, 'offers'>): Headline | undefined {
  const offers = p.offers.filter((o) => o.period !== 'reset');
  if (offers.length === 0) return undefined;
  const monthly = offers.filter((o) => PERIOD_MONTHS[o.period]);
  const base = { from: offers.length > 1, count: offers.length, only: offers.length === 1 ? offers[0] : undefined };
  const month = offers.find((o) => o.period === 'month');
  let save: Headline['save'];
  if (month && month.price_cents > 0) {
    for (const o of monthly) {
      const m = PERIOD_MONTHS[o.period]!;
      if (m <= 1) continue;
      const percent = Math.round((1 - o.price_cents / (month.price_cents * m)) * 100);
      if (percent >= 5 && (!save || percent > save.percent)) save = { offer: o, percent };
    }
  }
  if (monthly.length > 0) {
    const cents = Math.min(...monthly.map((o) => Math.round(o.price_cents / PERIOD_MONTHS[o.period]!)));
    return { ...base, cents, per: 'month', save };
  }
  const cheapest = offers.reduce((a, b) => (b.price_cents < a.price_cents ? b : a));
  return { ...base, cents: cheapest.price_cents, per: cheapest, save };
}

/** 套餐整体为什么买不了（第一个报价的拒绝原因）；能买时为 null */
export function planRefusal(p: ShopPlan): OfferRefusal | null {
  if (p.offers.some((o) => o.action != null)) return null;
  return p.offers.find((o) => o.refusal)?.refusal ?? 'not_for_sale';
}

/**
 * 换套餐需要二次确认的情形（低-3）：有作废的折算金额，或者从一个不过期的套餐换出去（永久套餐的价值不会折算回来）。
 */
export function needsSwitchConfirm(o: Offer, shop: Pick<Shop, 'current'>): boolean {
  if (o.action !== 'switch') return false;
  return o.forfeited_cents > 0 || (shop.current !== null && shop.current.expires_at === null);
}

/** 这一单要不要选支付方式：要付钱、且可选的方式多于一种 */
export function needsMethod(o: Offer, shop: Pick<Shop, 'methods'>): boolean {
  return (o.amount_cents ?? 0) > 0 && shop.methods.length > 1;
}

export const ACTION_TEXT: Record<OfferAction, string> = {
  new: '立即订阅',
  renew: '续费',
  switch: '更换到此套餐',
  reset: '购买重置包',
};

export const REFUSAL_TEXT: Record<OfferRefusal, string> = {
  not_for_sale: '暂不出售',
  sold_out: '已售罄',
  renewal_only: '仅限现有用户续费',
  no_switch: '不能从当前套餐更换到此套餐',
  reset_needs_subscription: '重置包仅限正在使用此套餐的用户',
  no_expiry: '当前套餐长期有效，无需续费',
};

export const COUPON_REFUSAL_TEXT: Record<CouponRefusal, string> = {
  invalid: '优惠码无效',
  not_started: '优惠码尚未生效',
  expired: '优惠码已过期',
  used_up: '优惠码已被领完',
  user_limit: '你已使用过该优惠码',
  new_users_only: '该优惠码仅限新用户首次购买',
  plan: '该优惠码不适用于此套餐',
  period: '该优惠码不适用于此购买时长',
  below_minimum: '订单金额未达到优惠码的最低消费',
};

/** 付款结果弹窗（components/pay-result）的三种样子：付清并开通 / 付了但没能开通（自动退回余额）/ 超时关闭 */
export type PayOutcome = 'success' | 'refunded' | 'expired';

export const outcomeOf = (o: Pick<MyOrder, 'status' | 'fulfilled'>): PayOutcome | null =>
  o.status === 'paid' ? (o.fulfilled ? 'success' : 'refunded') : o.status === 'expired' ? 'expired' : null;
