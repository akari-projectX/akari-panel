<script lang="ts">
  import '../styles/pages.css';
  import { orderApi, shopApi, type Offer, type PayMethod, type ShopPlan } from '@/api';
  import { K } from '@/lib/cache';
  import { daysLeft, formatDate, formatMoney, formatSpeed, trafficUsage } from '@/lib/format';
  import { REFUSAL_TEXT, offerKey } from '@/lib/shop';
  import Crown from '@lucide/svelte/icons/crown';
  import Ticket from '@lucide/svelte/icons/ticket';
  import Wallet from '@lucide/svelte/icons/wallet';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Row from '../components/flat/Row.svelte';
  import Section from '../components/flat/Section.svelte';
  import Switch from '../components/ui/Switch.svelte';
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
        t(formatSpeed(p.speed_limit_mbps)),
        data && data.credit_cents > 0 ? tp('换套餐时可折算 {v}', { v: formatMoney(data.credit_cents) }) : '',
      ].filter(Boolean).join(' · ')
    : t('还没有订阅，选一个套餐即可开始使用。'));
</script>

<PageTitle title={t('商店')} sub={t('管理当前订阅，随时续费或更换套餐。')} />

{#if pending}<PendingOrder order={pending} onchange={() => orders.reload()} className="mt5" />{/if}

<!-- ── 当前订阅 ── -->
<Section>
  <div class="sec-head">
    <div>
      <div class="sec-title">
        <Crown size={16} strokeWidth={1.75} aria-hidden="true" />
        {t('当前套餐')}{p ? ` · ${p.name}` : ''}
        {#if p}
          {#if me?.expired}<span class="bdg warn12 ml">{t('已过期')}</span>
          {:else if me?.quota_exhausted}<span class="bdg warn12 ml">{t('流量已用完')}</span>
          {:else}<span class="bdg ok12 ml">{t('生效中')}</span>{/if}
        {:else}<span class="bdg sec-b ml">{t('未订阅')}</span>{/if}
      </div>
      <div class="sec-desc">{meta}</div>
    </div>
  </div>

  {#if p}
    <div class="shop-cur">
      <div>
        <div class="shop-cap">{t('套餐剩余')}</div>
        <div class="hero-line" style="margin-top: 6px">
          <span class="hero-num">{left === null ? t('长期') : left}</span>
          {#if left !== null}<span class="shop-cap" style="font-size: inherit">{t('天')}</span>{/if}
        </div>
      </div>
      <div class="shop-use">
        <div class="shop-use-h">
          <span>{t('流量用量')}</span>
          <span><b>{usage.used.toFixed(1)}</b><span class="shop-cap" style="font-size: inherit">{usage.unlimited ? ' GB' : ` / ${Math.round(usage.total)} GB`}</span></span>
        </div>
        {#if !usage.unlimited}
          <div class="prog" role="progressbar" aria-label={t('流量用量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.usedPct)}><i style:transform="translateX(-{100 - Math.min(100, Math.max(0, usage.usedPct))}%)"></i></div>
        {/if}
        <div class="shop-use-x">
          {usage.unlimited
            ? t('套餐不限流量')
            : p.next_reset_at
              ? tp('{d} 重置流量，剩余 {g} GB', { d: formatDate(p.next_reset_at), g: usage.left.toFixed(1) })
              : tp('剩余 {g} GB，此套餐不重置流量', { g: usage.left.toFixed(1) })}
        </div>
      </div>
    </div>
  {/if}
</Section>

<!-- ── 余额：面板按它重新给每一档报价（优惠码在确认订单里填） ── -->
{#if data && data.balance_cents > 0}
  <Section>
    <label class="shop-bal">
      <Wallet size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>{tp('用余额抵扣（余额 {v}）', { v: formatMoney(data.balance_cents) })}</span>
      <Switch bind:checked={useBalance} label={t('用余额抵扣')} />
    </label>
  </Section>
{/if}

<!-- ── 套餐列表 ── -->
<Section>
  {#snippet title()}{t('选择套餐')}{/snippet}
  {#snippet desc()}{t('价格为各周期按月折算后的最低价；购买时长在确认订单时选择')}{/snippet}
  {#if !data && shop.loading}
    <Loading block={420} />
  {:else if !data && shop.error}
    <LoadError error={shop.error} onretry={shop.reload} />
  {:else if plans.length === 0}
    <Empty title={t('暂时没有可购买的套餐')} desc={t('站点还没有上架套餐。')} />
  {:else}
    <PlanGrid {plans} {me} onbuy={openBuy} />
  {/if}
</Section>

<!-- ── 流量重置包：当前套餐配了才有 ── -->
{#if currentPlan && resetOffer}
  {@const cp = currentPlan}
  {@const ro = resetOffer}
  <Section>
    {#snippet title()}{t('流量重置包')}{/snippet}
    {#snippet desc()}{t('不改变套餐与到期时间，立即把本周期已用流量清零')}{/snippet}
    <Row first>
      {#snippet title()}<span class="rl"><Ticket size={16} strokeWidth={1.75} aria-hidden="true" />{tp('重置「{n}」的流量', { n: cp.name })}</span>{/snippet}
      {#snippet desc()}{ro.refusal ? t(REFUSAL_TEXT[ro.refusal]) : t('付款后立即生效')}{/snippet}
      {#snippet extra()}
        <span class="tnum" style="font-size: 20px; font-weight: 500">{formatMoney(ro.amount_cents ?? ro.price_cents)}</span>
        <button type="button" class="btn sm" disabled={!ro.action} onclick={() => openBuy(cp, ro, true)}>{t('购买')}</button>
      {/snippet}
    </Row>
  </Section>
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
