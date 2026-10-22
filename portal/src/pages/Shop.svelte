<script lang="ts">
  import { orderApi, shopApi, type Offer, type PayMethod, type ShopPlan } from '@/api';
  import { K } from '@/lib/cache';
  import { daysLeft, formatDate, formatMoney, formatSpeed, trafficUsage } from '@/lib/format';
  import { REFUSAL_TEXT, offerKey } from '@/lib/shop';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import PendingOrder from '../components/shop/PendingOrder.svelte';
  import PlanGrid from '../components/shop/PlanGrid.svelte';
  import { auth, refresh } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { safeUrl } from '$lib/shop';
  import { toast } from '$lib/toast.svelte';

  /*
   * 商店（样稿 design/portal-v2-2026-10/shop.html；行为同 React 门户 pages/dash/shop.tsx）。每个周期的价格、动作
   * （新购 / 续费 / 换套餐 / 重置包）和拒绝原因都由面板按「现在下单」算好（GET /me/shop），优惠码、余额抵扣也是让面板重新算——
   * 前端不做任何价格计算。下单一次调用（POST /me/orders）：余额、优惠、折算全额抵扣时订单当场付清（带着 paid 去订单页弹结果），
   * 跳转类支付去收银台，其余去订单页付款。
   */
  let coupon = $state('');
  let useBalance = $state(false);
  const shop = resource(() => ({
    key: K.shop(coupon, useBalance),
    fetch: () => shopApi.get({ coupon: coupon || undefined, useBalance }),
    keep: true,
  }));
  /* 待支付的订单（与订单列表同一个缓存键）：有它时面板拒绝再下新单 */
  const orders = resource(() => ({ key: K.orders, fetch: () => orderApi.list() }));
  const pending = $derived((orders.data ?? []).find((o) => o.status === 'pending') ?? null);

  const me = $derived(auth.me);
  const myPlan = $derived(auth.plan);
  const data = $derived(shop.data);

  /* 续费范围（已过期 / 流量用完）：自己的套餐排最前 */
  const restricted = $derived(!!me && (me.expired || me.quota_exhausted));
  const plans = $derived.by(() => {
    const list = data?.plans ?? [];
    return restricted ? [...list].sort((a, b) => Number(b.current) - Number(a.current)) : list;
  });
  const currentPlan = $derived(plans.find((p) => p.current));
  const resetOffer = $derived(currentPlan?.offers.find((o) => o.period === 'reset'));

  /* 下单：选中的套餐与周期（offerKey）；报价随优惠码 / 余额重新取，按键找回同一档 */
  let buy = $state<{ planId: string; key: string; resetOnly: boolean } | null>(null);
  let dialogLoaded = $state(false);
  const buyPlan = $derived(buy ? plans.find((p) => p.plan_id === buy?.planId) : undefined);
  const buyOffers = $derived(buyPlan ? buyPlan.offers.filter((o) => (buy?.resetOnly ? o.period === 'reset' : o.period !== 'reset')) : []);
  const offer = $derived(buyOffers.find((o) => offerKey(o) === buy?.key));
  const submitting = new Pending();

  /* 优惠码只在确认订单里填：每次打开从空开始，关掉时清掉（列表上的价格不带优惠码） */
  function closeBuy() {
    buy = null;
    coupon = '';
  }

  function openBuy(p: ShopPlan, o: Offer | undefined, resetOnly = false) {
    if (!o) return;
    coupon = '';
    dialogLoaded = true;
    buy = { planId: p.plan_id, key: offerKey(o), resetOnly };
  }

  function submit(method: PayMethod | undefined) {
    void submitting.run(async () => {
      if (!buyPlan || !offer) return;
      try {
        const order = await orderApi.create({
          plan_id: buyPlan.plan_id,
          period: offer.period,
          ...(coupon ? { coupon } : {}),
          ...(useBalance ? { use_balance: true } : {}),
          ...(method ? { method_id: method.id } : {}),
        });
        closeBuy();
        orders.reload();
        shop.reload();
        if (order.status === 'paid') {
          /* 余额 / 优惠 / 折算全额抵扣（含免费订单）：面板当场付清并开通。订单页带着 paid 打开付款结果 */
          await refresh();
          navigate(R.order(order.id), { state: { paid: true } });
          return;
        }
        if (order.pay_url && safeUrl(order.pay_url)) {
          /* 跳转类支付：去收银台；回来（面板的 return_url = 订单页）后订单页会查状态 */
          window.location.href = order.pay_url;
          return;
        }
        navigate(R.order(order.id));
      } catch (e) {
        toast.error(errorText(e));
        shop.reload();
        orders.reload();
      }
    });
  }

  const usage = $derived(trafficUsage(myPlan?.traffic_used_bytes, myPlan?.traffic_limit_bytes ?? null));
  const left = $derived(daysLeft(myPlan?.expires_at));
  const p = $derived(myPlan?.plan);
  const meta = $derived(p
    ? [
        myPlan?.expires_at ? tp('到期 {d}', { d: formatDate(myPlan.expires_at) }) : t('长期有效'),
        left !== null ? tp('还剩 {n} 天', { n: left }) : '',
        t(formatSpeed(p.speed_limit_mbps)),
        data && data.credit_cents > 0 ? tp('换套餐时可折算 {v}', { v: formatMoney(data.credit_cents) }) : '',
      ].filter(Boolean).join(' · ')
    : t('还没有订阅，选一个套餐即可开始使用。'));
</script>

<div class="ph">
  <div>
    <h1>{t('商店')}</h1>
    <p>{t('管理当前订阅，随时续费或更换套餐。')}</p>
  </div>
</div>

{#if pending}<PendingOrder order={pending} onchange={() => orders.reload()} />{/if}

<section class="cur" aria-label={t('当前套餐')}>
  <div>
    <div class="lb">{t('当前套餐')}</div>
    <h2>
      {p ? p.name : t('未订阅')}
      {#if p}
        {#if me?.expired}<span class="st warn">{t('已过期')}</span>
        {:else if me?.quota_exhausted}<span class="st warn">{t('流量已用完')}</span>
        {:else}<span class="st ok">{t('生效中')}</span>{/if}
      {/if}
    </h2>
    <p class="meta num">{meta}</p>
  </div>
  {#if p}
    <div class="tm">
      <div class="top-l">
        <span>{t('流量用量')}</span>
        <span class="num"><b>{usage.used.toFixed(1)}</b>{usage.unlimited ? ' GB' : ` / ${Math.round(usage.total)} GB`}</span>
      </div>
      {#if !usage.unlimited}
        <div class={['meter', usage.leftPct < 10 && 'warn']} role="meter" aria-label={t('流量用量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.usedPct)}>
          <i style:width="{usage.usedPct}%"></i>
        </div>
      {/if}
      <p class="sub num">
        {usage.unlimited
          ? t('套餐不限流量')
          : p.next_reset_at
            ? tp('{d} 重置流量，剩余 {g} GB', { d: formatDate(p.next_reset_at), g: usage.left.toFixed(1) })
            : tp('剩余 {g} GB，此套餐不重置流量', { g: usage.left.toFixed(1) })}
      </p>
    </div>
  {/if}
</section>

{#if data && data.balance_cents > 0}
  <div class="setting balance">
    <div class="tx">
      <b id="balance-label">{t('用余额抵扣')}</b>
      <p class="num">{tp('余额 {v}。开启后下单时先扣余额，不足部分再用所选方式支付。', { v: formatMoney(data.balance_cents) })}</p>
    </div>
    <button
      type="button" class="switch" role="switch" aria-checked={useBalance} aria-labelledby="balance-label"
      data-state={useBalance ? 'checked' : 'unchecked'} onclick={() => (useBalance = !useBalance)}
    ><span class="switch-thumb"></span></button>
  </div>
{/if}

<section class="sec" aria-labelledby="h-plans">
  <div class="sh">
    <div>
      <h2 id="h-plans">{t('选择套餐')}</h2>
      <p>{t('价格为各周期按月折算后的最低价；购买时长在确认订单时选择')}</p>
    </div>
  </div>
  {#if !data && shop.loading}
    <Loading rows={6} height={420} />
  {:else if !data && shop.error}
    <LoadError error={shop.error} onretry={shop.reload} />
  {:else if plans.length === 0}
    <Empty title={t('暂时没有可购买的套餐')} desc={t('站点还没有上架套餐。')} />
  {:else}
    <PlanGrid {plans} {me} onbuy={openBuy} />
  {/if}
</section>

{#if currentPlan && resetOffer}
  {@const cp = currentPlan}
  {@const ro = resetOffer}
  <section class="sec" aria-labelledby="h-addon">
    <div class="sh">
      <div>
        <h2 id="h-addon">{t('流量重置包')}</h2>
        <p>{t('不改变套餐与到期时间，立即把本周期已用流量清零')}</p>
      </div>
    </div>
    <div class="addon">
      <div class="tx">
        <b>{tp('重置「{n}」的流量', { n: cp.name })}</b>
        <p>{ro.refusal ? t(REFUSAL_TEXT[ro.refusal]) : t('付款后立即生效')}</p>
      </div>
      <span class="price num">{formatMoney(ro.amount_cents ?? ro.price_cents)}</span>
      <button type="button" class="btn sm" disabled={!ro.action} onclick={() => openBuy(cp, ro, true)}>{t('购买')}</button>
    </div>
  </section>
{/if}

{#if dialogLoaded}
  {#await import('../components/shop/ConfirmOrder.svelte') then m}
    <m.default
      open={!!buy && !!buyPlan} plan={buyPlan} offers={buyOffers} {offer} shop={data} loading={shop.loading} {coupon} {pending}
      submitting={submitting.busy}
      onclose={closeBuy}
      onpick={(key) => { if (buy) buy = { ...buy, key }; }}
      oncoupon={(c) => (coupon = c)}
      onorderchange={() => orders.reload()}
      onsubmit={submit}
    />
  {/await}
{/if}

<style>
  .cur { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px; align-items: end; padding-bottom: 32px; }
  .lb { font-size: 13px; color: var(--muted); }
  .cur h2 { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin-top: 4px; font-size: 22px; line-height: 30px; font-weight: 600; color: var(--fg); }
  .cur h2 .st { font-size: 12.5px; font-weight: 500; }
  .cur h2 .st.ok { color: var(--ok); }
  .meta { margin-top: 4px; color: var(--muted); }
  .top-l { display: flex; justify-content: space-between; align-items: baseline; font-size: 13px; color: var(--muted); }
  .top-l b { font-size: 15px; font-weight: 600; color: var(--fg); }
  .meter { height: 4px; margin-top: 10px; border-radius: 2px; overflow: hidden; background: var(--secondary); }
  .meter i { display: block; height: 100%; border-radius: 2px; background: var(--brand); }
  .meter.warn i { background: var(--warn); }
  .sub { margin-top: 8px; font-size: 12.5px; color: var(--faint); }
  .balance { align-items: center; padding: 20px 0; border-bottom: 0; }
  .balance .tx { flex: 1; }
  .balance b { font-weight: 500; color: var(--fg); }
  .balance p { font-size: 13px; }
  .addon { display: flex; align-items: center; gap: 16px; padding: 16px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .addon .tx { flex: 1; min-width: 0; }
  .addon b { font-weight: 500; color: var(--fg); }
  .addon p { font-size: 13px; color: var(--muted); }
  .addon .price { font-size: 18px; font-weight: 600; color: var(--fg); }

  @media (max-width: 720px) {
    .cur { grid-template-columns: 1fr; gap: 24px; }
    .addon { flex-wrap: wrap; }
    .addon .tx { flex-basis: 100%; }
    .addon .price { margin-right: auto; }
  }
</style>
