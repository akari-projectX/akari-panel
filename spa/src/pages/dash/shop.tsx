import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Crown, Ticket, TicketPercent, TriangleAlert, Wallet } from 'lucide-react';
import { DUR, NUDGE, enterProps, stagger, useEnter } from '@/lib/motion';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FlowDialog, FlowFooter, FlowStep } from '@/components/ui/panels';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { PageTitle, Row, Section } from '@/components/flat';
import { LoadError, Loading, Empty } from '@/components/data-state';
import PlanContent from '@/components/plan-content';
import PlanSpecs from '@/components/plan-specs';
import OpenOrderNotice from '@/components/pending-order';
import PaymentMethodPicker from '@/components/payment-method-picker';
import { useOpenOrder } from '@/hooks/use-open-order';
import { orderApi, shopApi, type Offer, type ShopPlan } from '@/api';
import { useApi, usePending } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { useAuth } from '@/lib/auth';
import { useErrorText } from '@/lib/errors';
import {
  PERIOD_MONTHS, daysLeft, formatDate, formatMoney, formatSpeed, periodText, trafficUsage, yuan,
} from '@/lib/format';
import {
  ACTION_TEXT, COUPON_REFUSAL_TEXT, REFUSAL_TEXT, needsMethod, needsSwitchConfirm, offerKey, planRefusal, preselect,
} from '@/lib/shop';
import { R } from '@/lib/routes';
import { cn, safeUrl } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

/**
 * 商店。每个周期的价格、动作（新购 / 续费 / 换套餐 / 重置包）和拒绝原因都由面板按「现在下单」算好
 * （GET /me/shop），优惠码、余额抵扣也是让面板重新算一遍——前端不做任何价格计算。
 * 下单一次调用（POST /me/orders），金额在面板的 SQL 里算；余额、优惠、折算全额抵扣时订单立即付清。
 */
export default function Shop() {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const errText = useErrorText();
  const nav = useNavigate();
  const { me, plan: myPlan, refresh: refreshAuth } = useAuth();
  const openOrder = useOpenOrder();

  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState('');
  const [useBalance, setUseBalance] = useState(false);
  const shop = useApi(
    () => shopApi.get({ coupon: coupon || undefined, useBalance }),
    [coupon, useBalance],
    { key: K.shop(coupon, useBalance), keepPrevious: true },
  );
  const data = shop.data;

  /* 续费范围：自己的套餐排最前 */
  const restricted = !!me && (me.expired || me.quota_exhausted);
  const plans = useMemo(() => {
    const list = data?.plans ?? [];
    return restricted ? [...list].sort((a, b) => Number(b.current) - Number(a.current)) : list;
  }, [data, restricted]);
  const currentPlan = plans.find((p) => p.current);
  const resetOffer = currentPlan?.offers.find((o) => o.period === 'reset');

  /* 下单弹窗：选中的套餐与周期（offerKey）；报价随优惠码 / 余额重新取，按键找回同一档 */
  const [buy, setBuy] = useState<{ planId: string; key: string; resetOnly: boolean } | null>(null);
  const buyPlan = buy ? plans.find((p) => p.plan_id === buy.planId) : undefined;
  const buyOffers = buyPlan ? buyPlan.offers.filter((o) => (buy?.resetOnly ? o.period === 'reset' : o.period !== 'reset')) : [];
  const offer = buyOffers.find((o) => offerKey(o) === buy?.key);
  const [methodId, setMethodId] = useState<string | null>(null);
  const method = data?.methods.find((m) => m.id === methodId) ?? (data?.methods.length === 1 ? data.methods[0] : undefined);
  const [ack, setAck] = useState(false);
  const [submitting, run] = usePending();

  /* 优惠码只在确认订单里填：每次打开弹窗从空开始，关掉时清掉（列表上的价格不带优惠码） */
  const clearCoupon = () => { setCoupon(''); setCouponInput(''); };
  const closeBuy = () => { setBuy(null); clearCoupon(); };
  const openBuy = (p: ShopPlan, o: Offer | undefined, resetOnly = false) => {
    if (!o) return;
    setAck(false);
    clearCoupon();
    setBuy({ planId: p.plan_id, key: offerKey(o), resetOnly });
  };

  const applyCoupon = () => setCoupon(couponInput.trim());

  const submit = () => run(async () => {
    if (!buyPlan || !offer) return;
    try {
      const order = await orderApi.create({
        plan_id: buyPlan.plan_id,
        period: offer.period,
        ...(coupon ? { coupon } : {}),
        ...(useBalance ? { use_balance: true } : {}),
        ...(method && (offer.amount_cents ?? 0) > 0 ? { method_id: method.id } : {}),
      });
      closeBuy();
      openOrder.reload();
      shop.reload();
      if (order.status === 'paid') {
        /* 余额 / 优惠 / 折算全额抵扣：面板当场付清并开通 */
        toast.success(tr('支付成功，套餐已生效'));
        await refreshAuth();
      } else if (order.pay_url && safeUrl(order.pay_url)) {
        /* 跳转类支付：去收银台；回来后订单页会查状态 */
        window.location.href = order.pay_url;
        return;
      }
      nav(R.order(order.id));
    } catch (e) {
      toast.error(errText(e));
      shop.reload();
      openOrder.reload();
    }
  });

  const usage = trafficUsage(myPlan?.traffic_used_bytes, myPlan?.traffic_limit_bytes ?? null);
  const left = daysLeft(myPlan?.expires_at);
  const p = myPlan?.plan;
  const couponRefusal = data?.coupon?.refusal;

  return (
    <>
      <PageTitle title={tr('商店')} sub={tr('管理当前订阅，随时续费或更换套餐。')} />

      {openOrder.order && <OpenOrderNotice order={openOrder.order} onChanged={openOrder.reload} className="mt-5" />}

      {/* ── 当前订阅 ── */}
      <Section>
        <div className="sec-head">
          <div>
            <div className="sec-title">
              <Crown className="size-4 text-brand" />
              {tr('当前套餐')}{p ? ` · ${p.name}` : ''}
              {p
                ? (me?.expired
                  ? <Badge className="ml-1 rounded-full bg-amber-500/12 text-warning">{tr('已过期')}</Badge>
                  : me?.quota_exhausted
                    ? <Badge className="ml-1 rounded-full bg-amber-500/12 text-warning">{tr('流量已用完')}</Badge>
                    : <Badge className="ml-1 rounded-full bg-emerald-500/12 text-success">{tr('生效中')}</Badge>)
                : <Badge variant="secondary" className="ml-1 rounded-full">{tr('未订阅')}</Badge>}
            </div>
            <div className="sec-desc">
              {p
                ? [
                    myPlan?.expires_at ? tp('到期 {d}', { d: formatDate(myPlan.expires_at) }) : tr('长期有效'),
                    tr(formatSpeed(p.speed_limit_mbps)),
                    data && data.credit_cents > 0 ? tp('换套餐时可折算 {v}', { v: formatMoney(data.credit_cents) }) : null,
                  ].filter(Boolean).join(' · ')
                : tr('还没有订阅，选一个套餐即可开始使用。')}
            </div>
          </div>
        </div>

        {p && (
          <div className="grid gap-7 sm:grid-cols-[auto_1fr]">
            <div>
              <div className="text-[13px] text-muted-foreground">{tr('套餐剩余')}</div>
              <div className="hero-line mt-1.5">
                <span className="hero-num grad-text">{left === null ? tr('长期') : left}</span>
                {left !== null && <span className="text-muted-foreground">{tr('天')}</span>}
              </div>
            </div>
            <div className="max-w-190">
              <div className="mb-2 flex items-baseline justify-between text-[13px]">
                <span className="text-muted-foreground">{tr('流量用量')}</span>
                <span>
                  <b>{usage.used.toFixed(1)}</b>
                  <span className="text-muted-foreground">{usage.unlimited ? ' GB' : ` / ${Math.round(usage.total)} GB`}</span>
                </span>
              </div>
              {!usage.unlimited && <Progress value={usage.usedPct} className="h-2" />}
              <div className="mt-2 text-[12.5px] text-muted-foreground">
                {usage.unlimited
                  ? tr('套餐不限流量')
                  : p.next_reset_at
                    ? tp('{d} 重置流量，剩余 {g} GB', { d: formatDate(p.next_reset_at), g: usage.left.toFixed(1) })
                    : tp('剩余 {g} GB，此套餐不重置流量', { g: usage.left.toFixed(1) })}
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* ── 余额：面板按它重新给每一档报价（优惠码在确认订单里填） ── */}
      {data && data.balance_cents > 0 && (
        <Section>
          <label className="flex items-center gap-3 text-[13.5px]">
            <Wallet className="size-4 text-brand" />
            <span>{tp('用余额抵扣（余额 {v}）', { v: formatMoney(data.balance_cents) })}</span>
            <Switch checked={useBalance} onCheckedChange={setUseBalance} aria-label={tr('用余额抵扣')} />
          </label>
        </Section>
      )}

      {/* ── 套餐列表 ── */}
      <Section title={tr('选择套餐')} desc={tr('价格按你现在下单计算：续费从到期日顺延，换套餐时旧套餐按剩余价值折算')}>
        {shop.loading && !data ? <Loading block={420} />
          : shop.error && !data ? <LoadError error={shop.error} onRetry={shop.reload} />
          : plans.length === 0 ? <Empty title="暂时没有可购买的套餐" desc="站点还没有上架套餐。" />
          : (
            <div className="plan-cols">
              {plans.map((pl, i) => {
                const first = me ? preselect(pl, me) : undefined;
                const refusal = planRefusal(pl);
                const head = first ?? pl.offers.find((o) => o.period !== 'reset') ?? pl.offers[0];
                const cycles = pl.offers.filter((o) => o.period !== 'reset');
                const best = bestMonthly(cycles);
                return (
                  <div
                    key={pl.plan_id}
                    {...enter({ delay: stagger(i) })}
                    className={cn('plan-col', pl.current && 'is-current', refusal && !pl.current && 'opacity-55')}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[17px] font-medium">{pl.name}</span>
                      {pl.current ? <Badge className="shrink-0 rounded-full bg-emerald-500/12 text-success">{tr('当前套餐')}</Badge>
                        : pl.sold_out ? <Badge variant="secondary" className="shrink-0 rounded-full">{tr('已售罄')}</Badge>
                        : pl.remaining != null && <Badge className="shrink-0 rounded-full bg-amber-500/12 text-warning">{tp('仅剩 {n} 个名额', { n: pl.remaining })}</Badge>}
                    </div>

                    {head && (
                      <div className="hero-line my-4">
                        <span className="text-[15px] text-muted-foreground">¥</span>
                        <span key={`${offerKey(head)}-${head.amount_cents}`} {...enterProps(true, { y: NUDGE, duration: DUR.fast })} className="hero-num">
                          {yuan(head.amount_cents ?? head.price_cents)}
                        </span>
                        <span className="text-sm text-muted-foreground">/ {periodText(head.period, head.days, tr, tp)}</span>
                      </div>
                    )}
                    <div className="space-y-1 text-[12.5px] text-muted-foreground">
                      {head && head.amount_cents != null && head.amount_cents !== head.price_cents && (
                        <div>{tp('原价 {v}', { v: formatMoney(head.price_cents) })}</div>
                      )}
                      <div>
                        {cycles.length > 1
                          ? tp('可选 {list}', { list: cycles.map((o) => periodText(o.period, o.days, tr, tp)).join(' · ') })
                          : tr('仅此一个周期')}
                      </div>
                      {best && head && offerKey(best.offer) !== offerKey(head) && (
                        <div className="text-success">
                          {tp('{p}折合每月 {v}', { p: periodText(best.offer.period, best.offer.days, tr, tp), v: formatMoney(best.monthly) })}
                        </div>
                      )}
                    </div>

                    <PlanSpecs plan={pl} className="my-5" />
                    <PlanContent content={pl.description} className="mb-5.5 flex-1" />

                    <Button
                      variant={pl.current ? 'default' : 'outline'} className="h-10 w-full"
                      disabled={!first}
                      onClick={() => openBuy(pl, first, first?.action === 'reset')}
                    >
                      {first?.action ? tr(ACTION_TEXT[first.action]) : tr(REFUSAL_TEXT[refusal ?? 'not_for_sale'])}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
      </Section>

      {/* ── 流量重置包：当前套餐配了才有 ── */}
      {currentPlan && resetOffer && (
        <Section title={tr('流量重置包')} desc={tr('不改变套餐与到期时间，立即把本周期已用流量清零')}>
          <Row
            index={0}
            title={
              <span className="flex items-center gap-2">
                <Ticket className="size-4 text-brand" />
                {tp('重置「{n}」的流量', { n: currentPlan.name })}
              </span>
            }
            desc={resetOffer.refusal ? tr(REFUSAL_TEXT[resetOffer.refusal]) : tr('付款后立即生效')}
            extra={
              <>
                <span className="tnum text-xl font-medium">{formatMoney(resetOffer.amount_cents ?? resetOffer.price_cents)}</span>
                <Button variant="outline" size="sm" disabled={!resetOffer.action} onClick={() => openBuy(currentPlan, resetOffer, true)}>
                  {tr('购买')}
                </Button>
              </>
            }
          />
        </Section>
      )}

      {/* ── 确认下单 ── */}
      <FlowDialog
        open={!!buy && !!buyPlan} onOpenChange={(o) => !o && closeBuy()}
        icon={<Crown />}
        title={tr('确认订单')}
        description={tr('价格由服务端计算，下面就是你要付的金额')}
      >
        {buyPlan && (() => {
          let n = 0;
          const amount = offer?.amount_cents ?? 0;
          const confirmSwitch = !!offer && !!data && needsSwitchConfirm(offer, data);
          const pickMethod = !!offer && !!data && needsMethod(offer, data);
          const noPayment = !!offer && amount > 0 && !!data && !data.enabled;
          return (
            <>
              {openOrder.order && <OpenOrderNotice order={openOrder.order} onChanged={openOrder.reload} compact />}

              <div className="rounded-xl border border-border px-4 py-3.5">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="truncate text-[15px] font-medium">{buyPlan.name}</span>
                  {offer?.action && <span className="shrink-0 text-[13px] text-muted-foreground">{tr(ACTION_TEXT[offer.action])}</span>}
                </div>
                <PlanSpecs plan={buyPlan} className="mt-2" showReset={false} />
              </div>

              {buyOffers.length > 1 && (
                <FlowStep n={++n} title={tr('购买时长')}>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {buyOffers.map((o) => {
                      const on = offer && offerKey(o) === offerKey(offer);
                      const months = PERIOD_MONTHS[o.period];
                      return (
                        <button
                          key={offerKey(o)} type="button" disabled={!o.action}
                          onClick={() => { setAck(false); setBuy((b) => (b ? { ...b, key: offerKey(o) } : b)); }}
                          aria-pressed={on}
                          title={o.refusal ? tr(REFUSAL_TEXT[o.refusal]) : undefined}
                          className={cn('rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                            on ? 'border-brand bg-brand/5' : 'border-border hover:bg-muted/50')}
                        >
                          <div className={cn('text-[13px] font-medium', on && 'text-brand')}>{periodText(o.period, o.days, tr, tp)}</div>
                          <div className="tnum mt-0.5 text-[15px] font-medium">{formatMoney(o.amount_cents ?? o.price_cents)}</div>
                          <div className="text-[11.5px] text-muted-foreground">
                            {o.refusal ? tr(REFUSAL_TEXT[o.refusal])
                              : months && months > 1 && o.amount_cents != null ? tp('每月 {v}', { v: formatMoney(Math.round(o.amount_cents / months)) })
                              : o.action ? tr(ACTION_TEXT[o.action]) : ''}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </FlowStep>
              )}

              {offer && (
                <FlowStep n={++n} title={tr('优惠码')} aside={tr('选填')}>
                  <form
                    onSubmit={(e) => { e.preventDefault(); applyCoupon(); }}
                    className="flex gap-2.5"
                  >
                    <div className="relative flex-1">
                      <TicketPercent aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
                      <Input
                        aria-label={tr('优惠码')} value={couponInput} onChange={(e) => setCouponInput(e.target.value)}
                        placeholder={tr('有优惠码就填在这里')} className="h-10 pl-9"
                      />
                    </div>
                    <Button type="submit" variant="outline" className="h-10 shrink-0" disabled={shop.loading || couponInput.trim() === coupon}>
                      {tr('使用')}
                    </Button>
                    {coupon && (
                      <Button type="button" variant="ghost" className="h-10 shrink-0 text-muted-foreground" onClick={clearCoupon}>
                        {tr('清除')}
                      </Button>
                    )}
                  </form>
                  {coupon && data?.coupon && !shop.loading && (
                    couponRefusal || offer.coupon_refusal
                      ? <p role="alert" className="text-[12.5px] text-destructive">{tr(COUPON_REFUSAL_TEXT[(couponRefusal ?? offer.coupon_refusal)!])}</p>
                      : <p role="status" className="text-[12.5px] text-success">{tp('优惠码 {c} 已生效，优惠 {v}', { c: data.coupon.code, v: formatMoney(offer.discount_cents) })}</p>
                  )}
                </FlowStep>
              )}

              {offer && (
                <FlowStep n={++n} title={tr('金额明细')}>
                  <div className="space-y-1.5 text-[13px]">
                    <Line k={tr('价格')} v={formatMoney(offer.price_cents)} />
                    {offer.discount_cents > 0 && <Line k={tr('优惠码')} v={`−${formatMoney(offer.discount_cents)}`} tone="text-success" />}
                    {offer.credit_cents > 0 && <Line k={tr('旧套餐折算抵扣')} v={`−${formatMoney(offer.credit_cents)}`} tone="text-success" />}
                    {offer.forfeited_cents > 0 && <Line k={tr('折算作废')} v={formatMoney(offer.forfeited_cents)} tone="text-warning" />}
                    {offer.balance_cents > 0 && <Line k={tr('余额抵扣')} v={`−${formatMoney(offer.balance_cents)}`} tone="text-success" />}
                  </div>
                </FlowStep>
              )}

              {confirmSwitch && offer && (
                <label className="flex items-start gap-3 rounded-xl bg-amber-500/[.08] px-4 py-3.5 text-[12.5px] leading-[1.8]">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 accent-[var(--brand)]" />
                  <span>
                    <TriangleAlert className="mr-1 inline size-3.5 text-warning" />
                    {offer.forfeited_cents > 0
                      ? tp('旧套餐剩余价值里有 {v} 超过了新套餐的价格，换过去后这部分作废，不退回。', { v: formatMoney(offer.forfeited_cents) })
                      : tr('你现在的套餐长期有效，换成别的套餐后不能再换回来，它的剩余价值也不会退回。')}
                    {' '}{tr('我已了解。')}
                  </span>
                </label>
              )}

              {pickMethod && data && (
                <FlowStep n={++n} title={tr('支付方式')}>
                  <PaymentMethodPicker methods={data.methods} value={method?.id ?? null} onValueChange={setMethodId} />
                </FlowStep>
              )}
              {noPayment && (
                <p className="rounded-xl bg-muted/60 px-4 py-3 text-[12.5px] leading-[1.8] text-muted-foreground">
                  {tr('站点暂未开放在线支付。可以用余额抵扣，或提交工单联系客服。')}
                </p>
              )}

              <FlowFooter
                summary={
                  <div>
                    <div className="text-[11.5px]">{tr('应付金额')}</div>
                    <div className="tnum text-[22px] leading-tight font-medium tracking-[-0.02em] text-brand">{formatMoney(amount)}</div>
                  </div>
                }
              >
                <Button variant="outline" className="hidden sm:inline-flex" onClick={closeBuy}>{tr('取消')}</Button>
                <Button
                  disabled={submitting || !offer?.action || !!openOrder.order || noPayment
                    || (confirmSwitch && !ack) || (pickMethod && !method)}
                  onClick={submit} className="h-10 min-w-[128px]"
                >
                  {submitting ? tr('处理中') : amount === 0 ? tr('确认开通') : tp('支付 {v}', { v: formatMoney(amount) })}
                </Button>
              </FlowFooter>
            </>
          );
        })()}
      </FlowDialog>
    </>
  );
}

function Line({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted-foreground">{k}</span>
      <span className={cn('tnum', tone)}>{v}</span>
    </div>
  );
}

/** 周期性报价里折合每月最便宜的一档（只是展示用的除法，价格本身来自面板）；少于两档时为 null */
function bestMonthly(offers: Offer[]): { offer: Offer; monthly: number } | null {
  const opts = offers
    .filter((o) => o.action && o.amount_cents != null && PERIOD_MONTHS[o.period])
    .map((o) => ({ offer: o, monthly: Math.round((o.amount_cents ?? 0) / (PERIOD_MONTHS[o.period] ?? 1)) }));
  if (opts.length < 2) return null;
  return opts.reduce((a, b) => (b.monthly < a.monthly ? b : a));
}

