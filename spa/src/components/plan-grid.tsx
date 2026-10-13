import { useState } from 'react';
import type { Me, Offer, ShopPlan } from '@/api';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PlanContent from '@/components/plan-content';
import { PERIOD_MONTHS, formatBytes, formatMoney, periodText, resetPeriodText, yuan } from '@/lib/format';
import { ACTION_TEXT, REFUSAL_TEXT, defaultPeriod, offerKey, periodChoices, planRefusal, preselect } from '@/lib/shop';
import { useT, useTp } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * 商店的套餐列表（2026-10-13 改版）：顶上一个时长切换（月付 / 季付 / 年付 …），每张卡显示这一时长的价格，
 * 套餐之间横向比较的是同一个周期；下面是对齐的规格行（流量、重置、速率）与站长写的说明（设备、线路等），最下面是操作。
 *
 * 价格全部来自面板（/me/shop）：大字是该周期的标价；面板算出的本次应付（换套餐的折算、余额抵扣）不同时另起一行写出来。
 * 状态用一行小字，不用徽章：当前套餐 / 已售罄 / 仅剩 N 个名额 / 仅限现有用户续费。
 * 没有这个时长的套餐写明「没有{时长}」并给一个「看 {它有的时长}」的按钮（切换整个列表）。
 * 流量用完的当前套餐，操作仍是重置包（preselect，中-1）。
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
  const choices = periodChoices(plans);
  const [picked, setPicked] = useState<string | undefined>();
  const key = picked && choices.some((o) => offerKey(o) === picked) ? picked : defaultPeriod(plans, me);
  const label = (o: Pick<Offer, 'period' | 'days'>) => periodText(o.period, o.days, tr, tp);
  const keyOffer = choices.find((o) => offerKey(o) === key);

  return (
    <>
      {choices.length > 1 && (
        <div className="mb-7 flex flex-wrap items-center gap-x-4 gap-y-2">
          <Tabs value={key} onValueChange={setPicked}>
            <TabsList aria-label={tr('购买时长')} className="h-9 max-w-full overflow-x-auto">
              {choices.map((o) => <TabsTrigger key={offerKey(o)} value={offerKey(o)} className="px-3">{label(o)}</TabsTrigger>)}
            </TabsList>
          </Tabs>
        </div>
      )}

      <div className="plan-cols" data-count={Math.min(plans.length, 6)}>
        {plans.map((pl) => {
          const sel = pl.offers.find((o) => offerKey(o) === key);
          const pre = me ? preselect(pl, me) : undefined;
          /* 流量用完的当前套餐：操作是重置包（价格仍按所选时长显示） */
          const act = pre?.action === 'reset' ? pre : sel;
          const refusal = planRefusal(pl);
          const fallback = !sel ? pl.offers.find((o) => o.period !== 'reset' && o.action) ?? pl.offers.find((o) => o.period !== 'reset') : undefined;
          const months = sel ? PERIOD_MONTHS[sel.period] : undefined;
          const amount = sel?.amount_cents;
          const status = pl.current ? { t: tr('当前套餐'), c: 'text-brand' }
            : pl.sold_out ? { t: tr('已售罄'), c: 'text-muted-foreground' }
            : refusal === 'renewal_only' ? { t: tr('仅限现有用户续费'), c: 'text-muted-foreground' }
            : pl.remaining != null ? { t: tp('仅剩 {n} 个名额', { n: pl.remaining }), c: 'text-warning' }
            : null;
          const off = !!refusal && !pl.current;

          return (
            <article key={pl.plan_id} className={cn('plan-col', pl.current && 'is-current', off && 'is-off')} aria-label={pl.name}>
              <header className="flex items-baseline justify-between gap-3">
                <h3 className="text-[17px] font-semibold tracking-[-0.01em]">{pl.name}</h3>
                {status && <span className={cn('shrink-0 text-[12.5px] font-medium', status.c)}>{status.t}</span>}
              </header>

              {/* 价格：所选时长的标价；没有这个时长时写明 */}
              <div className="mt-4 min-h-[76px]">
                {sel ? (
                  <>
                    <div className="flex items-baseline gap-1.5">
                      <span className="tnum text-[34px] leading-none font-semibold tracking-[-0.03em]">
                        <span className="mr-0.5 align-[0.32em] text-[17px] font-medium">¥</span>{yuan(sel.price_cents)}
                      </span>
                      <span className="text-[13.5px] text-muted-foreground">/ {label(sel)}</span>
                    </div>
                    <div className="mt-2 space-y-0.5 text-[12.5px] text-muted-foreground">
                      {months && months > 1 && <div className="tnum">{tp('折合每月 {v}', { v: formatMoney(Math.round(sel.price_cents / months)) })}</div>}
                      {amount != null && amount !== sel.price_cents && (
                        <div className="tnum text-foreground">
                          {tp('本次应付 {v}', { v: formatMoney(amount) })}
                          {sel.credit_cents > 0 && <span className="text-muted-foreground">{tp('（已折算旧套餐 {v}）', { v: formatMoney(sel.credit_cents) })}</span>}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="pt-1 text-[13.5px] text-muted-foreground">
                    <div className="text-[34px] leading-none font-semibold text-faint">—</div>
                    {keyOffer && <div className="mt-2">{tp('没有{p}', { p: label(keyOffer) })}</div>}
                  </div>
                )}
              </div>

              {/* 规格：每张卡同样三行，横向对齐着比 */}
              <dl className="plan-specs">
                <div><dt>{tr('流量')}</dt><dd>{pl.traffic_quota_bytes != null ? formatBytes(pl.traffic_quota_bytes) : tr('不限流量')}</dd></div>
                <div><dt>{tr('重置')}</dt><dd>{pl.traffic_quota_bytes != null ? resetPeriodText(pl.period, tr, tp) : '—'}</dd></div>
                <div><dt>{tr('速率')}</dt><dd>{pl.speed_limit_mbps ? `${pl.speed_limit_mbps} Mbps` : tr('不限速')}</dd></div>
              </dl>

              <PlanContent content={pl.description} className="mt-5 flex-1" />
              {!pl.description.trim() && <div className="flex-1" />}

              <div className="mt-6">
                {act?.action ? (
                  <Button
                    variant={pl.current ? 'default' : 'outline'} className="h-10 w-full"
                    onClick={() => onBuy(pl, act, act.action === 'reset')}
                  >
                    {tr(ACTION_TEXT[act.action])}
                  </Button>
                ) : !sel && fallback ? (
                  <Button variant="ghost" className="h-10 w-full text-muted-foreground" onClick={() => setPicked(offerKey(fallback))}>
                    {tp('看{p}', { p: label(fallback) })}
                  </Button>
                ) : (
                  <Button variant="outline" disabled className="h-10 w-full">
                    {tr(REFUSAL_TEXT[sel?.refusal ?? refusal ?? 'not_for_sale'])}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
