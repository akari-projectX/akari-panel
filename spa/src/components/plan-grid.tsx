import type { Me, Offer, OfferAction, ShopPlan } from '@/api';
import { Button } from '@/components/ui/button';
import PlanBlocks from '@/components/plan-blocks';
import { planSummary } from '@/lib/content-text';
import { formatBytes, periodText, yuan } from '@/lib/format';
import { ACTION_TEXT, REFUSAL_TEXT, headline, planRefusal, preselect } from '@/lib/shop';
import { useT, useTp } from '@/i18n';
import { cn } from '@/lib/utils';

/** 按钮下面的一行说明（新购没有） */
const ACTION_NOTE: Partial<Record<OfferAction, string>> = {
  renew: '从到期日顺延',
  switch: '旧套餐剩余价值自动抵扣',
  reset: '不改变套餐与到期时间',
};

/**
 * 商店的套餐卡片（2026-10-14，按用户确认的样稿 design/shop-cards-2026-10）：卡片上方**没有**周期切换，
 * 周期只在确认订单弹窗里选。每张卡 = 名称 + 状态标签（当前套餐 / 已售罄 / 仅续费 / 推荐 / 仅剩 N 个名额；「推荐」= 后台套餐的推荐开关，淡灰色小标签，
 * 买得了时按钮用主色，与样稿一致）
 * + 一行简介（说明开头的段落）→ 大字「¥x /月 起」（各周期按月折算的最低价，lib/shop 的 headline；只有按天 / 一次性的写那一档自己的价格）
 * +「N 种周期可选 · 年付省 x%」→ 三格规格（流量 / 重置 / 速率）→ 功能清单（说明其余部分）→ 一个按钮 + 一行说明。
 *
 * 价格全部来自面板（/me/shop 的标价），这里只是换算成每月的说法；本次应付（折算、余额、优惠码）在确认订单弹窗里。
 * 按钮的动作就是 preselect（流量用完的当前套餐 = 重置包，中-1）；买不了的套餐按钮置灰并写原因。
 * 当前套餐描品牌色边框。列数随套餐数（1 个最宽 420px，2/3 栏，4 个在宽屏四栏，5–6 个三栏；平板两栏，手机一栏）。
 */
export default function PlanGrid({
  plans, me, onBuy,
}: {
  plans: ShopPlan[];
  me: Pick<Me, 'expired' | 'quota_exhausted'> | undefined;
  onBuy: (plan: ShopPlan, offer: Offer, resetOnly: boolean) => void;
}) {
  const tr = useT();
  const tp = useTp();
  const ok = me ?? { expired: false, quota_exhausted: false };

  const reset = (p: ShopPlan['period']) => {
    if (p === 'monthly') return tr('每月');
    const m = /^days-(\d+)$/.exec(p);
    return m ? tp('每 {n} 天', { n: m[1] }) : tr('不重置');
  };

  return (
    <div className="plan-cols" data-count={Math.min(plans.length, 6)}>
      {plans.map((pl) => {
        const act = preselect(pl, ok);
        const refusal = planRefusal(pl);
        const h = headline(pl);
        const { summary, rest } = planSummary(pl.description);
        const tag = pl.current ? { t: tr('当前套餐'), c: 'is-brand' }
          : pl.sold_out ? { t: tr('已售罄'), c: 'is-warn' }
          : refusal === 'renewal_only' ? { t: tr('仅续费'), c: 'is-warn' }
          : pl.recommended ? { t: tr('推荐'), c: 'is-rec' }
          : pl.remaining != null ? { t: tp('仅剩 {n} 个名额', { n: pl.remaining }), c: 'is-warn' }
          : null;
        const off = !!refusal && !pl.current;
        const note = act?.action ? ACTION_NOTE[act.action] : undefined;

        return (
          <article key={pl.plan_id} className={cn('plan-card', pl.current && 'is-current', off && 'is-off')} aria-label={pl.name}>
            <div className="plan-card-body">
              <header className="flex min-h-[22px] items-center gap-2">
                <h3 className="truncate text-[16px] font-semibold">{pl.name}</h3>
                {tag && <span className={cn('plan-tag', tag.c)}>{tag.t}</span>}
              </header>
              <p className="mt-1 min-h-[21px] text-[13px] text-muted-foreground">{summary}</p>

              {/* 价格：按月折算的最低价（或唯一 / 最便宜那一档的标价） */}
              <div className="mt-[18px] flex items-baseline gap-1" data-testid="plan-price">
                {h ? (
                  <>
                    <span className="self-start pt-1.5 text-[15px] font-semibold">¥</span>
                    <span className="tnum text-[34px] leading-[1.1] font-semibold tracking-[-0.02em]">{yuan(h.cents)}</span>
                    <span className="text-[13px] text-muted-foreground">
                      {h.per === 'month' ? tr('/月') : `/ ${periodText(h.per.period, h.per.days, tr, tp)}`}
                      {h.from && ` ${tr('起')}`}
                    </span>
                  </>
                ) : <span className="text-[34px] leading-[1.1] font-semibold text-faint">—</span>}
              </div>
              <div className="min-h-5 text-[12.5px] text-muted-foreground">
                {h && (h.only ? periodText(h.only.period, h.only.days, tr, tp) : tp('{n} 种周期可选', { n: h.count }))}
                {h?.save && (
                  <>
                    {' · '}
                    <b className="font-medium whitespace-nowrap text-success">
                      {tp('{p}省 {n}%', { p: periodText(h.save.offer.period, h.save.offer.days, tr, tp), n: h.save.percent })}
                    </b>
                  </>
                )}
              </div>

              {/* 规格：三格，每张卡对齐着比 */}
              <dl className="plan-specs">
                <div><dd>{pl.traffic_quota_bytes != null ? formatBytes(pl.traffic_quota_bytes) : tr('不限')}</dd><dt>{tr('流量')}</dt></div>
                <div><dd>{pl.traffic_quota_bytes != null ? reset(pl.period) : '—'}</dd><dt>{tr('重置')}</dt></div>
                <div><dd>{pl.speed_limit_mbps ? `${pl.speed_limit_mbps} Mbps` : tr('不限速')}</dd><dt>{tr('速率')}</dt></div>
              </dl>

              <PlanBlocks blocks={rest} className="mt-4" />
            </div>

            <div className="mt-[18px]">
              {act?.action ? (
                <Button
                  variant={pl.current || pl.recommended ? 'default' : 'outline'} className="h-[42px] w-full"
                  onClick={() => onBuy(pl, act, act.action === 'reset')}
                >
                  {tr(ACTION_TEXT[act.action])}
                </Button>
              ) : (
                <Button variant="outline" disabled className="h-[42px] w-full">
                  {tr(REFUSAL_TEXT[refusal ?? 'not_for_sale'])}
                </Button>
              )}
              <p className="mt-2 min-h-[18px] text-center text-[12px] text-faint">{note ? tr(note) : ''}</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
