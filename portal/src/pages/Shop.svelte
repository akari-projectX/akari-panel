<script module lang="ts">
  const Confirm = () => import('../components/shop/ConfirmOrder.svelte');
</script>

<script lang="ts">
  import '../styles/pages/shop.css';
  import { orderApi, shopApi, walletApi, type Offer, type PayMethod, type ShopPlan } from '@/api';
  import { K } from '@/lib/cache';
  import { daysLeft, formatDate, formatMoney, formatSpeed, trafficUsage } from '@/lib/format';
  import { offerKey } from '@/lib/shop';
  import Crown from '@lucide/svelte/icons/crown';
  import Hero from '../components/flat/Hero.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Section from '../components/flat/Section.svelte';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import PendingOrder from '../components/shop/PendingOrder.svelte';
  import PlanGrid from '../components/shop/PlanGrid.svelte';
  import { chunk, intent, preloadDialogs } from '$lib/dialogs';
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
   * 商店。每个周期的价格、动作
   * （新购 / 续费 / 换套餐 / 重置包）和拒绝原因都由面板按「现在下单」算好（GET /me/shop），优惠码、余额抵扣也是让面板重新算——
   * 前端不做任何价格计算。余额抵扣在确认订单里逐单打开（列表上的价格不带余额）。下单一次调用（POST /me/orders）：余额、优惠、折算全额抵扣时订单当场付清（带着 paid 去订单页弹结果），
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
  /* 余额与可提现（与仪表盘同一个缓存键） */
  const balance = resource(() => ({ key: K.balance, fetch: () => walletApi.balance({ limit: 1 }) }));
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
  /* 确认订单第一次打开时才挂载；分包在空闲时与购买按钮上的意图预载（lib/dialogs） */
  let dialogLoaded = $state(false);
  preloadDialogs(Confirm);
  const buyPlan = $derived(buy ? plans.find((p) => p.plan_id === buy?.planId) : undefined);
  const buyOffers = $derived(buyPlan ? buyPlan.offers.filter((o) => (buy?.resetOnly ? o.period === 'reset' : o.period !== 'reset')) : []);
  const offer = $derived(buyOffers.find((o) => offerKey(o) === buy?.key));
  const submitting = new Pending();

  /* 优惠码、余额抵扣只在确认订单里选：每次打开从头来，关掉时清掉（列表上的价格两样都不带） */
  function closeBuy() {
    buy = null;
    coupon = '';
    useBalance = false;
  }

  function openBuy(p: ShopPlan, o: Offer | undefined, resetOnly = false) {
    if (!o) return;
    coupon = '';
    useBalance = false;
    dialogLoaded = true;
    buy = { planId: p.plan_id, key: offerKey(o), resetOnly };
  }

  function submit(method: PayMethod | undefined, acceptForfeit: boolean) {
    void submitting.run(async () => {
      if (!buyPlan || !offer) return;
      try {
        const order = await orderApi.create({
          plan_id: buyPlan.plan_id,
          period: offer.period,
          ...(coupon ? { coupon } : {}),
          ...(useBalance ? { use_balance: true } : {}),
          ...(acceptForfeit ? { accept_forfeit: true } : {}),
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
  /* 右上「流量用完？买重置包」：当前套餐配了重置包且现在能买才出现，点开就是重置包的确认订单 */
  const resetBuy = $derived(currentPlan && resetOffer?.action ? { plan: currentPlan, offer: resetOffer } : null);
</script>

<PageTitle title={t('商店')} sub={t('管理当前订阅，随时续费或更换套餐。')} />

{#if pending}<PendingOrder order={pending} onchange={() => orders.reload()} className="mt5" />{/if}

<!-- ── 当前订阅：天数大字 + 本期流量分段条，右侧到期 / 速率 / 余额 / 重置包 ── -->
<Section>
  {#if p}
    <Hero
      value={left === null ? t('长期') : String(left)}
      unit={left === null ? t('有效') : me?.expired ? t('天 · 已过期') : t('天后到期')}
      meter={usage.unlimited ? null : { pct: usage.leftPct, low: usage.leftPct < 10 }}
      label={t('本期流量')}
      capL={usage.unlimited ? t('套餐不限流量') : tp('本期流量 剩余 {l} / {t} GB', { l: +usage.left.toFixed(1), t: +usage.total.toFixed(1) })}
      capR={p.next_reset_at ? tp('{d} 重置', { d: formatDate(p.next_reset_at) }) : usage.unlimited ? undefined : t('此套餐不重置流量')}
    >
      {#snippet head()}
        <Crown size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{t('当前套餐')} · {p.name}</span>
        {#if me?.expired}<span class="pill warn"><i></i>{t('已过期')}</span>
        {:else if me?.quota_exhausted}<span class="pill warn"><i></i>{t('流量已用完')}</span>
        {:else}<span class="pill"><i></i>{t('生效中')}</span>{/if}
      {/snippet}
      {#snippet facts()}
        <div><span>{t('到期')}</span><span>{myPlan?.expires_at ? formatDate(myPlan.expires_at) : t('长期有效')}</span></div>
        <div><span>{t('速率')}</span><span>{t(formatSpeed(p.speed_limit_mbps))}</span></div>
        <div><span>{t('余额')}</span><span>{balance.data ? formatMoney(balance.data.balance_cents) : data ? formatMoney(data.balance_cents) : '—'}{#if balance.data}<small>{tp('可提现 {v}', { v: formatMoney(balance.data.withdrawable_cents) })}</small>{/if}</span></div>
        {#if data && data.credit_cents > 0}<div><span>{t('换套餐可折算')}</span><span>{formatMoney(data.credit_cents)}</span></div>{/if}
        {#if resetBuy}
          {@const rb = resetBuy}
          <div><span>{t('流量用完？')}</span><button type="button" class="go" {@attach intent(Confirm)} onclick={() => openBuy(rb.plan, rb.offer, true)}>{tp('买重置包 {v} →', { v: formatMoney(rb.offer.amount_cents ?? rb.offer.price_cents) })}</button></div>
        {/if}
      {/snippet}
    </Hero>
  {:else}
    <div class="hx-head"><Crown size={14} strokeWidth={1.75} aria-hidden="true" /><span>{t('当前套餐')}</span><span class="pill off"><i></i>{t('未订阅')}</span></div>
    <p class="shop-none">{t('还没有订阅，选一个套餐即可开始使用。')}</p>
  {/if}
</Section>

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
    <PlanGrid {plans} {me} onbuy={openBuy} buyIntent={intent(Confirm)} />
  {/if}
</Section>

{#if dialogLoaded}
  {#await chunk(Confirm) then m}
    <m.default
      open={!!buy && !!buyPlan} plan={buyPlan} offers={buyOffers} {offer} shop={data} loading={shop.loading} {coupon} {useBalance} {pending}
      submitting={submitting.busy}
      onclose={closeBuy}
      onpick={(key) => { if (buy) buy = { ...buy, key }; }}
      oncoupon={(c) => (coupon = c)}
      onbalance={(v) => (useBalance = v)}
      onorderchange={() => orders.reload()}
      onsubmit={submit}
    />
  {/await}
{/if}
