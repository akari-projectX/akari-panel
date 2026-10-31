<script module lang="ts">
  const Confirm = () => import('../components/shop/ConfirmOrder.svelte');
</script>

<script lang="ts">
  import '../styles/pages/shop.css';
  import { orderApi, shopApi, type Offer, type PayMethod, type ShopPlan } from '@/api';
  import { K } from '@/lib/cache';
  import { formatMoney } from '@/lib/format';
  import { offerKey } from '@/lib/shop';
  import PageTitle from '../components/flat/PageTitle.svelte';
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
  const pending = $derived((orders.data ?? []).find((o) => o.status === 'pending') ?? null);

  const me = $derived(auth.me);
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

  const resetBuy = $derived(currentPlan && resetOffer?.action ? { plan: currentPlan, offer: resetOffer } : null);
</script>

<PageTitle title={t('商店')} lead={t('选一个适合你的套餐')}>
  {#snippet extra()}<span>{t('价格按月折算 · 购买时长在下单时选择')}</span>{/snippet}
</PageTitle>

{#if pending}<PendingOrder order={pending} onchange={() => orders.reload()} className="mt5" />{/if}

<!-- ── 套餐列（细线分隔，上面一道细线） ── -->
<div class="shop-plans">
  {#if !data && shop.loading}
    <Loading block={420} />
  {:else if !data && shop.error}
    <LoadError error={shop.error} onretry={shop.reload} />
  {:else if plans.length === 0}
    <Empty title={t('暂时没有可购买的套餐')} desc={t('站点还没有上架套餐。')} />
  {:else}
    <PlanGrid {plans} {me} onbuy={openBuy} buyIntent={intent(Confirm)} />
  {/if}
</div>

<!-- ── 流量重置包：当前套餐配了重置包且现在能买才出现，点开就是重置包的确认订单（流量用完时当前套餐卡的按钮已经是它） ── -->
{#if resetBuy && !me?.quota_exhausted}
  {@const rb = resetBuy}
  <div class="shop-reset">
    <div>
      <b>{tp('流量重置包 · {v}', { v: formatMoney(rb.offer.amount_cents ?? rb.offer.price_cents) })}</b>
      <p>{t('立即把本期已用流量清零，到期日和重置日不变。只对当前套餐有效。')}</p>
    </div>
    <button type="button" class="btn" {@attach intent(Confirm)} onclick={() => openBuy(rb.plan, rb.offer, true)}>{t('购买重置包')}</button>
  </div>
{/if}

{#if data && plans.length > 0}
  <p class="shop-fine">{t('价格以人民币计。续费从当前到期日顺延；换套餐按剩余价值抵扣，多出的部分作废。')}</p>
{/if}

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
