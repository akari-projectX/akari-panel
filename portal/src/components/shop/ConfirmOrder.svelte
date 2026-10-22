<script lang="ts">
  import { untrack } from 'svelte';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { MyOrder, Offer, PayMethod, Shop, ShopPlan } from '@/api';
  import { ORDER_ACTION, PERIOD_MONTHS, formatBytes, formatMoney, periodText } from '@/lib/format';
  import { COUPON_REFUSAL_TEXT, REFUSAL_TEXT, needsMethod, needsSwitchConfirm, offerKey } from '@/lib/shop';
  import Dialog from '../ui/Dialog.svelte';
  import PendingOrder from './PendingOrder.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { methodHint, savePercent } from '$lib/shop';

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
  const description = $derived(plan
    ? [
        plan.name,
        offer?.action ? t(ORDER_ACTION[offer.action]) : '',
        plan.traffic_quota_bytes != null ? formatBytes(plan.traffic_quota_bytes) : t('不限流量'),
        plan.speed_limit_mbps ? `${plan.speed_limit_mbps} Mbps` : t('不限速'),
      ].filter(Boolean).join(' · ')
    : '');

  function perMonth(o: Offer): string {
    const months = PERIOD_MONTHS[o.period];
    if (o.refusal) return t(REFUSAL_TEXT[o.refusal]);
    if (months && months > 1 && o.amount_cents != null) return tp('每月 {v}', { v: formatMoney(Math.round(o.amount_cents / months)) });
    return '';
  }

  function applyCoupon(e: SubmitEvent) {
    e.preventDefault();
    oncoupon(couponInput.trim());
  }

  function clearCoupon() {
    couponInput = '';
    oncoupon('');
  }
</script>

<Dialog {open} wide onOpenChange={(o) => { if (!o) onclose(); }} title={t('确认订单')} {description}>
  {#if plan}
    {#if pending}<PendingOrder order={pending} onchange={onorderchange} />{/if}

    {#if offers.length > 1}
      <p class="k" id="k-period">{t('购买时长')}</p>
      <div class="opts" role="radiogroup" aria-labelledby="k-period">
        {#each offers as o (offerKey(o))}
          {@const on = !!offer && offerKey(o) === offerKey(offer)}
          {@const save = savePercent(offers, o)}
          <label class={['opt', on && 'on', !o.action && 'off']}>
            <input type="radio" name="period" checked={on} disabled={!o.action} onchange={() => pick(offerKey(o))} />
            <span class="rd" aria-hidden="true"></span>
            <b>{periodText(o.period, o.days, t, tp)}</b>
            {#if save}<span class="save">{tp('省 {n}%', { n: save })}</span>{/if}
            <span class="r num">{formatMoney(o.amount_cents ?? o.price_cents)}{#if perMonth(o)}<small>{perMonth(o)}</small>{/if}</span>
          </label>
        {/each}
      </div>
    {/if}

    {#if offer}
      <p class="k"><label for="coupon">{t('优惠码')}</label><em>{t('选填')}</em></p>
      <form class="field-row" novalidate onsubmit={applyCoupon}>
        <input id="coupon" class="input" bind:value={couponInput} placeholder={t('有优惠码就填在这里')} autocomplete="off" />
        <button type="submit" class="btn side" disabled={loading || couponInput.trim() === coupon}>{t('使用')}</button>
        {#if coupon}<button type="button" class="btn side ghost" onclick={clearCoupon}>{t('清除')}</button>{/if}
      </form>
      {#if coupon && shop?.coupon && !loading}
        {#if couponRefusal}
          <p class="field-msg bad" role="alert">{t(COUPON_REFUSAL_TEXT[couponRefusal])}</p>
        {:else}
          <p class="field-msg ok" role="status">{tp('优惠码 {c} 已生效，优惠 {v}', { c: shop.coupon.code, v: formatMoney(offer.discount_cents) })}</p>
        {/if}
      {/if}
    {/if}

    {#if confirmSwitch && offer}
      <label class="ack">
        <input type="checkbox" bind:checked={ack} />
        <span>
          <TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
          {offer.forfeited_cents > 0
            ? tp('旧套餐剩余价值里有 {v} 超过了新套餐的价格，换过去后这部分作废，不退回。', { v: formatMoney(offer.forfeited_cents) })
            : t('你现在的套餐长期有效，换成别的套餐后不能再换回来，它的剩余价值也不会退回。')}
          {t('我已了解。')}
        </span>
      </label>
    {/if}

    {#if pickMethod}
      <p class="k" id="k-method">{t('支付方式')}</p>
      <div class="opts pay" role="radiogroup" aria-labelledby="k-method">
        {#each methods as m (m.id)}
          {@const on = method?.id === m.id}
          {@const hint = methodHint(m)}
          <label class={['opt', on && 'on']}>
            <input type="radio" name="method" checked={on} onchange={() => (methodId = m.id)} />
            <span class="rd" aria-hidden="true"></span>
            <span class="mt"><b>{m.display_name}</b>{#if hint}<span class="m">{t(hint)}</span>{/if}</span>
          </label>
        {/each}
      </div>
    {/if}
    {#if noPayment}
      <p class="quiet-note">{t('站点暂未开放在线支付。可以用余额抵扣，或提交工单联系客服。')}</p>
    {/if}

    {#if offer}
      <div class="sum num">
        <div><span>{plan.name} · {periodText(offer.period, offer.days, t, tp)}</span><span>{formatMoney(offer.price_cents)}</span></div>
        {#if offer.discount_cents > 0}<div><span>{t('优惠码')}</span><span>−{formatMoney(offer.discount_cents)}</span></div>{/if}
        {#if offer.credit_cents > 0}<div><span>{t('旧套餐折算抵扣')}</span><span>−{formatMoney(offer.credit_cents)}</span></div>{/if}
        {#if offer.forfeited_cents > 0}<div class="warn"><span>{t('折算作废')}</span><span>{formatMoney(offer.forfeited_cents)}</span></div>{/if}
        {#if offer.balance_cents > 0}<div><span>{t('余额抵扣')}</span><span>−{formatMoney(offer.balance_cents)}</span></div>{/if}
        <div class="total"><span>{t('应付金额')}</span><span>{formatMoney(amount)}</span></div>
      </div>
    {/if}
  {/if}

  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>{t('取消')}</button>
    <button type="button" class="btn pri submit" disabled={blocked} onclick={() => onsubmit(amount > 0 ? method : undefined)}>
      {submitting ? t('处理中') : amount === 0 ? t('确认开通') : tp('支付 {v}', { v: formatMoney(amount) })}
    </button>
  {/snippet}
</Dialog>

<style>
  .k { display: flex; justify-content: space-between; align-items: baseline; margin: 20px 0 8px; font-size: 12.5px; color: var(--faint); }
  .k label { color: var(--faint); }
  .k em { font-style: normal; }
  .opts { display: grid; gap: 8px; }
  .opts.pay { grid-template-columns: 1fr 1fr; }
  .opt {
    position: relative; display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid var(--line2); border-radius: 8px;
    font-size: 13.5px; cursor: pointer; transition: border-color var(--dur-hover) var(--ease-out);
  }
  .opts.pay .opt { padding: 10px 12px; }
  .opt:hover { border-color: color-mix(in srgb, var(--fg) 28%, transparent); }
  .opt input { position: absolute; opacity: 0; pointer-events: none; }
  .opt:has(input:focus-visible) { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .opt.off { cursor: not-allowed; opacity: .5; }
  .rd { display: grid; place-items: center; flex: none; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--line2); }
  .opt.on { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
  .opt.on .rd { border-color: var(--brand); }
  .opt.on .rd::after { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--brand); }
  .opt b { font-weight: 500; color: var(--fg); }
  .save { font-size: 12.5px; color: var(--ok); }
  .r { margin-left: auto; text-align: right; font-weight: 500; color: var(--fg); }
  .r small { display: block; font-size: 12px; font-weight: 400; color: var(--faint); }
  .mt { display: flex; flex-direction: column; min-width: 0; }
  .mt b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m { font-size: 12.5px; color: var(--faint); }
  .field-msg.ok { color: var(--ok); }
  .ack { display: flex; align-items: flex-start; gap: 10px; margin-top: 20px; padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 12.5px; line-height: 1.8; color: var(--body); cursor: pointer; }
  .ack input { flex: none; width: 16px; height: 16px; margin-top: 4px; accent-color: var(--brand); }
  .ack :global(svg) { display: inline; margin: -2px 2px 0 0; color: var(--warn); vertical-align: middle; }
  .quiet-note { margin-top: 16px; font-size: 12.5px; line-height: 1.8; color: var(--muted); }
  .sum { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 13.5px; }
  .sum div { display: flex; justify-content: space-between; gap: 16px; padding: 3px 0; color: var(--muted); }
  .sum div span:last-child { color: var(--body); white-space: nowrap; }
  .sum .warn span:last-child { color: var(--warn); }
  .sum .total { align-items: baseline; margin-top: 8px; padding-top: 12px; border-top: 1px solid var(--line); }
  .sum .total span:first-child { font-weight: 500; color: var(--fg); }
  .sum .total span:last-child { font-size: 22px; font-weight: 600; color: var(--fg); }
  .submit { min-width: 128px; }

  @media (max-width: 720px) {
    .k { margin: 16px 0 8px; }
    .opt { padding: 8px 12px; }
    .sum { margin-top: 16px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .opt { transition: none; }
  }
</style>
