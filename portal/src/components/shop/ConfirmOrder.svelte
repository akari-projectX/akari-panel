<script lang="ts">
  import { untrack } from 'svelte';
  import CreditCard from '@lucide/svelte/icons/credit-card';
  import CircleDollarSign from '@lucide/svelte/icons/circle-dollar-sign';
  import QrCode from '@lucide/svelte/icons/qr-code';
  import TicketPercent from '@lucide/svelte/icons/ticket-percent';
  import Wallet from '@lucide/svelte/icons/wallet';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { MyOrder, Offer, PayMethod, Shop, ShopPlan } from '@/api';
  import { ORDER_ACTION, PERIOD_MONTHS, formatMoney, periodText } from '@/lib/format';
  import { COUPON_REFUSAL_TEXT, REFUSAL_TEXT, needsMethod, needsSwitchConfirm, offerKey } from '@/lib/shop';
  import Dialog from '../ui/Dialog.svelte';
  import Switch from '../ui/Switch.svelte';
  import PendingOrder from './PendingOrder.svelte';
  import { t, tp } from '$lib/i18n.svelte';

  /*
   * 确认订单（design/portal-polish-2026-10 的 30 / 31 号稿）。价格全部由面板按「现在下单」算好
   * （/me/shop 的 offers），优惠码、余额抵扣也是让面板重新报价——这里不做任何价格计算（「省 x%」「每月 ¥x」只是标价的换算）。
   *   标题下一行 = 套餐 · 动作 → 购买时长（不止一档时）→ 优惠码（选填）→「用余额抵扣」开关（有余额时，逐单打开）
   *   → 原价 / 各项抵扣 / 还需支付 → 换套餐的作废确认 → 支付方式（还要付钱且不止一种时）→ 取消 / 去支付（余额等全额付清时是「确认购买」）。
   * 有待支付订单时面板拒绝再下单：提醒放在最上面，提交按钮不可用。窄屏是底部抽屉（ui/Dialog）。
   * 第一次打开时才下载（含 bits-ui）。
   */
  let {
    open, plan, offers, offer, shop, loading, coupon, useBalance, pending, submitting,
    onclose, onpick, oncoupon, onbalance, onorderchange, onsubmit,
  }: {
    open: boolean;
    plan: ShopPlan | undefined;
    /** 可选的档（重置包单独一组） */
    offers: Offer[];
    offer: Offer | undefined;
    shop: Shop | undefined;
    /** 正在重新报价（换了优惠码 / 余额抵扣） */
    loading: boolean;
    /** 已经交给面板报价的优惠码 */
    coupon: string;
    /** 这一单用余额抵扣（已经交给面板报价） */
    useBalance: boolean;
    pending: MyOrder | null;
    submitting: boolean;
    onclose: () => void;
    onpick: (key: string) => void;
    oncoupon: (code: string) => void;
    onbalance: (on: boolean) => void;
    onorderchange: () => void;
    onsubmit: (method: PayMethod | undefined, acceptForfeit: boolean) => void;
  } = $props();

  let couponInput = $state('');
  let methodId = $state<string | null>(null);
  let ack = $state(false);

  /* 每次打开从头来：优惠码输入框空着、作废确认没勾 */
  $effect(() => {
    if (!open) return;
    untrack(() => {
      couponInput = '';
      ack = false;
    });
  });

  /* 换了一档：作废确认重新勾 */
  function pick(key: string) {
    ack = false;
    onpick(key);
  }

  const methods = $derived(shop?.methods ?? []);
  const method = $derived(methods.find((m) => m.id === methodId) ?? (methods.length === 1 ? methods[0] : undefined));
  const amount = $derived(offer?.amount_cents ?? 0);
  const confirmSwitch = $derived(!!offer && !!shop && needsSwitchConfirm(offer));
  const pickMethod = $derived(!!offer && !!shop && needsMethod(offer, shop));
  const noPayment = $derived(!!offer && amount > 0 && !!shop && !shop.payments_available);
  const couponRefusal = $derived(shop?.coupon?.refusal ?? offer?.coupon_refusal ?? null);
  const blocked = $derived(submitting || !offer?.action || !!pending || noPayment || (confirmSwitch && !ack) || (pickMethod && !method));

  function perMonth(o: Offer): string {
    const months = PERIOD_MONTHS[o.period];
    if (o.refusal) return t(REFUSAL_TEXT[o.refusal]);
    if (months && months > 1 && o.amount_cents != null) return tp('每月 {v}', { v: formatMoney(Math.round(o.amount_cents / months)) });
    return '';
  }

  const isReset = $derived(offer?.period === 'reset');
  const subtitle = $derived(plan ? (isReset ? `${t('流量重置包')} · ${plan.name}` : offer?.action ? `${plan.name} · ${t(ORDER_ACTION[offer.action])}` : plan.name) : '');

  /* 面板的 icon 是后台填的短名字：认得的换成对应图标 */
  const ICONS: Record<string, typeof QrCode> = { alipay: QrCode, wechat: QrCode, qq: QrCode, balance: Wallet, usdt: CircleDollarSign, crypto: CircleDollarSign };
  const methodIcon = (m: PayMethod) => ICONS[m.icon ?? m.kind] ?? CreditCard;

  function applyCoupon(e: SubmitEvent) {
    e.preventDefault();
    oncoupon(couponInput.trim());
  }

  function clearCoupon() {
    couponInput = '';
    oncoupon('');
  }
</script>

<Dialog {open} wide onOpenChange={(o) => { if (!o) onclose(); }} title={t('确认订单')} description={subtitle}>
  {#if plan}
    <div class="flow-body">
      {#if pending}<PendingOrder order={pending} onchange={onorderchange} compact />{/if}
      {#if isReset}<p class="fsub">{t('立即把本周期已用流量清零，不改变套餐与到期时间。')}</p>{/if}

      {#if offers.length > 1}
        <section class="fstep">
          <div class="fstep-h"><h3>{t('购买时长')}</h3></div>
          <div class="popt">
            {#each offers as o (offerKey(o))}
              {@const on = !!offer && offerKey(o) === offerKey(offer)}
              <button type="button" disabled={!o.action} aria-pressed={on} title={o.refusal ? t(REFUSAL_TEXT[o.refusal]) : undefined} onclick={() => pick(offerKey(o))}>
                <b>{periodText(o.period, o.days, t, tp)}</b>
                <span class="pv">{formatMoney(o.amount_cents ?? o.price_cents)}</span>
                <small>{perMonth(o) || (o.action ? t(ORDER_ACTION[o.action]) : '')}</small>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if offer}
        <section class="fstep">
          <div class="fstep-h"><h3><label for="coupon">{t('优惠码')}</label></h3><span class="fstep-aside">{t('选填')}</span></div>
          <form class="cpn" novalidate onsubmit={applyCoupon}>
            <div>
              <TicketPercent size={16} strokeWidth={1.75} aria-hidden="true" />
              <input id="coupon" class="input" bind:value={couponInput} placeholder={t('有优惠码就填在这里')} autocomplete="off" />
            </div>
            <button type="submit" class="btn" disabled={loading || couponInput.trim() === coupon}>{t('使用')}</button>
            {#if coupon}<button type="button" class="btn ghost muted" onclick={clearCoupon}>{t('清除')}</button>{/if}
          </form>
          {#if coupon && shop?.coupon && !loading}
            {#if couponRefusal}
              <p class="cpn-msg bad" role="alert">{t(COUPON_REFUSAL_TEXT[couponRefusal])}</p>
            {:else}
              <p class="cpn-msg ok" role="status">{tp('优惠码 {c} 已生效，优惠 {v}', { c: shop.coupon.code, v: formatMoney(offer.discount_cents) })}</p>
            {/if}
          {/if}
        </section>

        <section class="fstep">
          {#if shop && shop.balance_cents > 0}
            <label class="fbal">
              <span>{t('用余额抵扣')}<small>{tp('可用 {v}', { v: formatMoney(shop.balance_cents) })}</small></span>
              <Switch bind:checked={() => useBalance, (v) => onbalance(v)} disabled={loading && !useBalance} label={t('用余额抵扣')} />
            </label>
          {/if}
          <div class="fline">
            <div><span>{isReset ? t('价格') : t('原价')}</span><span>{formatMoney(offer.price_cents)}</span></div>
            {#if offer.discount_cents > 0}<div class="ok"><span>{t('优惠码')}</span><span>− {formatMoney(offer.discount_cents)}</span></div>{/if}
            {#if offer.credit_cents > 0}<div class="ok"><span>{t('旧套餐折算抵扣')}</span><span>− {formatMoney(offer.credit_cents)}</span></div>{/if}
            {#if offer.forfeited_cents > 0}<div class="warn"><span>{t('折算作废')}</span><span>{formatMoney(offer.forfeited_cents)}</span></div>{/if}
            {#if offer.balance_cents > 0}<div class="ok"><span>{t('余额抵扣')}</span><span>− {formatMoney(offer.balance_cents)}</span></div>{/if}
            <div class="ftot"><span>{t('还需支付')}</span><span>{formatMoney(amount)}</span></div>
          </div>
          {#if amount === 0 && offer.balance_cents > 0}<p class="fhint">{t('余额足够支付，确认后直接开通，无需跳转。')}</p>{/if}
        </section>
      {/if}

      {#if confirmSwitch && offer}
        <label class="ackrow" for="switch-ack">
          <input id="switch-ack" type="checkbox" bind:checked={ack} />
          <span>
            <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
            {#if offer.forfeits_permanent}{t('你现在的套餐长期有效。换成别的套餐后，它剩下的长期权益会作废，不折算、不退回，也不能换回来。')}{' '}{/if}
            {#if offer.forfeited_cents > 0}{tp('旧套餐剩余价值里有 {v} 超过了新套餐的价格，换过去后这部分作废，不退回。', { v: formatMoney(offer.forfeited_cents) })}{' '}{/if}
            {t('我已了解。')}
          </span>
        </label>
      {/if}

      {#if pickMethod}
        <section class="fstep">
          <div class="fstep-h"><h3>{t('支付方式')}</h3></div>
          <fieldset class="pmeth">
            <legend class="sr">{t('支付方式')}</legend>
            {#each methods as m (m.id)}
              {@const Icon = methodIcon(m)}
              <div>
                <input id="pm-{m.id}" type="radio" name="method" checked={method?.id === m.id} onchange={() => (methodId = m.id)} />
                <label for="pm-{m.id}"><Icon size={16} strokeWidth={1.75} aria-hidden="true" /><span>{m.display_name}</span></label>
              </div>
            {/each}
          </fieldset>
        </section>
      {/if}
      {#if noPayment}
        <p class="fnote">{offer?.balance_only
          ? t('站点暂未开放在线支付。这个套餐可以用余额全额支付：请打开上面的「用余额抵扣」。')
          : t('站点暂未开放在线支付。可以用余额抵扣，或提交工单联系客服。')}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <div class="flow-btns">
      <button type="button" class="btn" onclick={onclose}>{t('取消')}</button>
      <button type="button" class="btn ink submit" disabled={blocked} onclick={() => onsubmit(amount > 0 ? method : undefined, confirmSwitch && ack)}>
        {submitting ? t('处理中') : amount === 0 ? t('确认购买') : t('去支付')}
      </button>
    </div>
  {/snippet}
</Dialog>

<style>
  .submit { min-width: 112px; }
</style>
