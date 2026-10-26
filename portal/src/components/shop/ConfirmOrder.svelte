<script lang="ts">
  import { untrack } from 'svelte';
  import Crown from '@lucide/svelte/icons/crown';
  import CreditCard from '@lucide/svelte/icons/credit-card';
  import CircleDollarSign from '@lucide/svelte/icons/circle-dollar-sign';
  import Gauge from '@lucide/svelte/icons/gauge';
  import QrCode from '@lucide/svelte/icons/qr-code';
  import TicketPercent from '@lucide/svelte/icons/ticket-percent';
  import Wallet from '@lucide/svelte/icons/wallet';
  import Zap from '@lucide/svelte/icons/zap';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { MyOrder, Offer, PayMethod, Shop, ShopPlan } from '@/api';
  import { ORDER_ACTION, PERIOD_MONTHS, formatBytes, formatMoney, periodText } from '@/lib/format';
  import { COUPON_REFUSAL_TEXT, REFUSAL_TEXT, needsMethod, needsSwitchConfirm, offerKey } from '@/lib/shop';
  import Dialog from '../ui/Dialog.svelte';
  import PendingOrder from './PendingOrder.svelte';
  import { t, tp } from '$lib/i18n.svelte';

  /*
   * 确认订单（样稿 shop.html#confirm；行为同 React 门户 pages/dash/shop.tsx 的下单弹窗）。价格全部由面板按「现在下单」算好
   * （/me/shop 的 offers），优惠码、余额抵扣也是让面板重新报价——这里不做任何价格计算（「省 x%」「每月 ¥x」只是标价的换算）。
   *   购买时长（不止一档时）→ 优惠码（选填）→ 换套餐的作废确认 → 支付方式（要付钱且不止一种时）→ 金额明细 → 提交。
   * 有待支付订单时面板拒绝再下单：提醒放在最上面，提交按钮不可用。窄屏是底部抽屉（ui/Dialog）。
   * 第一次打开时才下载（含 bits-ui）。
   */
  let {
    open, plan, offers, offer, shop, loading, coupon, pending, submitting,
    onclose, onpick, oncoupon, onorderchange, onsubmit,
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
    pending: MyOrder | null;
    submitting: boolean;
    onclose: () => void;
    onpick: (key: string) => void;
    oncoupon: (code: string) => void;
    onorderchange: () => void;
    onsubmit: (method: PayMethod | undefined) => void;
  } = $props();

  let couponInput = $state('');
  let methodId = $state<string | null>(null);
  let ack = $state(false);

  /* 每次打开从头来：优惠码输入框空着、作废确认没勾（支付方式记着上次选的，同 React 门户） */
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
  const confirmSwitch = $derived(!!offer && !!shop && needsSwitchConfirm(offer, shop));
  const pickMethod = $derived(!!offer && !!shop && needsMethod(offer, shop));
  const noPayment = $derived(!!offer && amount > 0 && !!shop && !shop.enabled);
  const couponRefusal = $derived(shop?.coupon?.refusal ?? offer?.coupon_refusal ?? null);
  const blocked = $derived(submitting || !offer?.action || !!pending || noPayment || (confirmSwitch && !ack) || (pickMethod && !method));

  function perMonth(o: Offer): string {
    const months = PERIOD_MONTHS[o.period];
    if (o.refusal) return t(REFUSAL_TEXT[o.refusal]);
    if (months && months > 1 && o.amount_cents != null) return tp('每月 {v}', { v: formatMoney(Math.round(o.amount_cents / months)) });
    return '';
  }

  /* 步骤编号：只给显示出来的步骤编号（购买时长只有一档时不显示） */
  const base = $derived(offers.length > 1 ? 1 : 0);

  /* 面板的 icon 是后台填的短名字：认得的换成对应图标（同 React 门户 payment-method-picker） */
  const ICONS: Record<string, typeof QrCode> = { alipay: QrCode, wechat: QrCode, qq: QrCode, balance: Wallet, usdt: CircleDollarSign };
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

<Dialog {open} wide onOpenChange={(o) => { if (!o) onclose(); }} title={t('确认订单')} description={t('价格由服务端计算，下面就是你要付的金额')}>
  {#snippet icon()}<Crown class="dlg-icon" size={20} strokeWidth={1.5} aria-hidden="true" />{/snippet}
  {#if plan}
    <div class="flow-body">
      {#if pending}<PendingOrder order={pending} onchange={onorderchange} compact />{/if}

      <div class="fbox">
        <div class="fbox-h">
          <span>{plan.name}</span>
          {#if offer?.action}<span>{t(ORDER_ACTION[offer.action])}</span>{/if}
        </div>
        <div class="fspec">
          <span><Gauge size={14} strokeWidth={1.75} aria-hidden="true" />{plan.traffic_quota_bytes != null ? `${formatBytes(plan.traffic_quota_bytes)} ${t('流量')}` : t('不限流量')}</span>
          <span><Zap size={14} strokeWidth={1.75} aria-hidden="true" />{plan.speed_limit_mbps ? `${plan.speed_limit_mbps} Mbps` : t('不限速')}</span>
        </div>
      </div>

      {#if offers.length > 1}
        <section class="fstep">
          <div class="fstep-h"><span class="fstep-n">1</span><h3>{t('购买时长')}</h3></div>
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
          <div class="fstep-h"><span class="fstep-n">{base + 1}</span><h3><label for="coupon">{t('优惠码')}</label></h3><span class="fstep-aside">{t('选填')}</span></div>
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
          <div class="fstep-h"><span class="fstep-n">{base + 2}</span><h3>{t('金额明细')}</h3></div>
          <div class="fline">
            <div><span>{t('价格')}</span><span>{formatMoney(offer.price_cents)}</span></div>
            {#if offer.discount_cents > 0}<div class="ok"><span>{t('优惠码')}</span><span>−{formatMoney(offer.discount_cents)}</span></div>{/if}
            {#if offer.credit_cents > 0}<div class="ok"><span>{t('旧套餐折算抵扣')}</span><span>−{formatMoney(offer.credit_cents)}</span></div>{/if}
            {#if offer.forfeited_cents > 0}<div class="warn"><span>{t('折算作废')}</span><span>{formatMoney(offer.forfeited_cents)}</span></div>{/if}
            {#if offer.balance_cents > 0}<div class="ok"><span>{t('余额抵扣')}</span><span>−{formatMoney(offer.balance_cents)}</span></div>{/if}
          </div>
        </section>
      {/if}

      {#if confirmSwitch && offer}
        <label class="ackrow" for="switch-ack">
          <input id="switch-ack" type="checkbox" bind:checked={ack} />
          <span>
            <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
            {offer.forfeited_cents > 0
              ? tp('旧套餐剩余价值里有 {v} 超过了新套餐的价格，换过去后这部分作废，不退回。', { v: formatMoney(offer.forfeited_cents) })
              : t('你现在的套餐长期有效，换成别的套餐后不能再换回来，它的剩余价值也不会退回。')}
            {' '}{t('我已了解。')}
          </span>
        </label>
      {/if}

      {#if pickMethod}
        <section class="fstep">
          <div class="fstep-h"><span class="fstep-n">{base + 3}</span><h3>{t('支付方式')}</h3></div>
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
        <p class="fnote">{t('站点暂未开放在线支付。可以用余额抵扣，或提交工单联系客服。')}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <div class="flow-sum"><div class="k">{t('应付金额')}</div><div class="v">{formatMoney(amount)}</div></div>
    <div class="flow-btns">
      <button type="button" class="btn hide-m" onclick={onclose}>{t('取消')}</button>
      <button type="button" class="btn pri submit" disabled={blocked} onclick={() => onsubmit(amount > 0 ? method : undefined)}>
        {submitting ? t('处理中') : amount === 0 ? t('确认开通') : tp('支付 {v}', { v: formatMoney(amount) })}
      </button>
    </div>
  {/snippet}
</Dialog>

<style>
  .submit { min-width: 128px; }
</style>
