import type { CouponRefusal, Me, Offer, OfferAction, OfferRefusal, Shop, ShopPlan } from '@/api';

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
