<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Check from '@lucide/svelte/icons/check';
  import Clock from '@lucide/svelte/icons/clock';
  import Copy from '@lucide/svelte/icons/copy';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Wallet from '@lucide/svelte/icons/wallet';
  import X from '@lucide/svelte/icons/x';
  import { untrack } from 'svelte';
  import { orderApi, type MyOrder, type RefundEffect, type RefundRoute } from '@/api';
  import { K } from '@/lib/cache';
  import { ORDER_ACTION, formatDate, formatDateTime, formatMoney, formatTime, orderState, periodText } from '@/lib/format';
  import { outcomeOf, type PayOutcome } from '@/lib/shop';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import Qr from '../components/dash/Qr.svelte';
  import { refresh } from '$lib/auth.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { loc, navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { IN_WECHAT, IS_MOBILE, alipayScheme, isAlipayQr, safeUrl, toneClass } from '$lib/shop';
  import { toast } from '$lib/toast.svelte';

  /*
   * 订单详情与付款（行为同 React 门户 pages/dash/order-detail.tsx；也是易支付 return_url 回来的页面）。
   * 待支付：支付宝二维码（手机上是「打开支付宝付款」+ 给另一台设备扫的码）或跳转类支付的收银台按钮；
   * 每 3 秒查一次状态（面板查订单时会主动去渠道问），变了就弹付款结果（components/shop/PayResult）。
   * 想换支付方式：取消这一单，回商店重新下单。
   * 版式：页头 → 三步进度 → 退款 / 未开通说明 → 宽屏两栏（左：付款区 + 订单信息；右：金额单，跟着滚），窄屏金额单在最前。
   */
  let { params }: { title: string; params?: Record<string, string> } = $props();
  const id = untrack(() => params?.id ?? '');

  const order = resource(() => ({ key: K.order(id), fetch: () => orderApi.get(id) }));
  const data = $derived(order.data);
  const pending = $derived(data?.status === 'pending');
  const qr = $derived(pending ? data?.qr_code ?? null : null);
  const payUrl = $derived(pending && data?.pay_url && safeUrl(data.pay_url) ? data.pay_url : null);
  const alipayJump = $derived(!!qr && IS_MOBILE && isAlipayQr(qr));
  const cancelling = new Pending();
  const copied = new Copied<'no'>();

  /* 付款结果：轮询到状态变化时，或商店当场付清后带着 paid 跳过来时（只放一次：刷新、后退回来都不再弹） */
  let outcome = $state<PayOutcome | null>(null);
  let resultLoaded = $state(false);
  let arrivedPaid = (history.state as { paid?: boolean } | null)?.paid === true;
  function show(o: PayOutcome | null) {
    if (o) resultLoaded = true;
    outcome = o;
  }
  $effect(() => {
    if (!arrivedPaid || !data) return;
    arrivedPaid = false;
    untrack(() => show(outcomeOf(data)));
    navigate(loc.path, { replace: true, state: {} });
  });

  let now = $state(Date.now());
  $effect(() => {
    if (!pending) return;
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });

  /*
   * 待支付就盯着状态：用户是在支付宝 App / 另一个标签页里付的，付完不会有人回来告诉这一页。
   * 「不再待支付」不等于付成功了：超时没付面板会关掉订单（expired）。上一次没回来就不发下一次。
   */
  $effect(() => {
    if (!pending || !id) return;
    let alive = true;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const o = await orderApi.get(id);
        if (!alive) return;
        if (o.status === 'pending') return;
        clearInterval(timer);
        show(outcomeOf(o));
        order.set(o);
        if (o.status === 'paid') void refresh();
      } catch { /* 轮询失败不打扰用户，下一轮再试 */ } finally {
        busy = false;
      }
    }, 3000);
    return () => { alive = false; clearInterval(timer); };
  });

  function cancel() {
    void cancelling.run(async () => {
      try {
        order.set(await orderApi.cancel(id));
        toast.success(t('订单已取消'));
      } catch (e) {
        toast.error(errorText(e));
        order.reload();
      }
    });
  }

  const REFUND_ROUTE: Record<RefundRoute, string> = { original: '原路退回', balance: '退到余额', manual: '支付渠道退款' };
  const REFUND_EFFECT: Record<RefundEffect, string> = {
    none: '套餐不受影响（只退款）。',
    cancel: '这笔订单开通的套餐已同时结束。',
    rollback: '这笔续费增加的时长已同时收回。',
    restore: '已恢复为换套餐之前的套餐。',
  };

  /** 退款去向的说明（原路退回渠道、退到余额、渠道后台退款后登记）与对套餐的影响 */
  function refundLines(o: MyOrder): string[] {
    const toBalance = o.refund_balance_cents ?? 0;
    const external = o.refund_external_cents ?? 0;
    const lines: string[] = [];
    if (external > 0) {
      lines.push(o.refund_route === 'original'
        ? o.payment_method_name
          ? tp('{v} 已原路退回到 {m}。', { v: formatMoney(external), m: o.payment_method_name })
          : tp('{v} 已原路退回。', { v: formatMoney(external) })
        : tp('{v} 已通过支付渠道退回。', { v: formatMoney(external) }));
    }
    if (toBalance > 0) lines.push(tp('{v} 已退回账户余额。', { v: formatMoney(toBalance) }));
    if (o.refund_effect) lines.push(t(REFUND_EFFECT[o.refund_effect]));
    return lines;
  }

  type Step = { label: string; time?: string; state: 'done' | 'current' | 'todo' | 'failed' };

  const view = $derived.by(() => {
    if (!data) return null;
    const closed = data.status === 'expired' || data.status === 'cancelled';
    const unfulfilled = data.status === 'paid' && !data.fulfilled && !data.refunded_at;
    /* 进度：下单 → 付款 → 生效。关闭的订单第二步停在「已关闭」；退款 / 没能开通的第三步标出来 */
    const steps: Step[] = [
      { label: '提交订单', time: formatDateTime(data.created_at), state: 'done' },
      closed
        ? { label: data.status === 'expired' ? '已超时' : '已取消', state: 'failed' }
        : { label: '完成支付', time: data.paid_at ? formatDateTime(data.paid_at) : undefined, state: pending ? 'current' : 'done' },
      data.refunded_at
        ? { label: '已退款', time: formatDateTime(data.refunded_at), state: 'failed' }
        : unfulfilled
          ? { label: '已退回余额', state: 'failed' }
          : { label: '套餐生效', state: data.fulfilled ? 'done' : 'todo' },
    ];
    /* 金额构成：只列出真正发生了的那几项 */
    const lines: [string, number][] = [
      ['价格', data.list_price_cents],
      ...(data.discount_cents ? [['优惠码', -data.discount_cents] as [string, number]] : []),
      ...(data.credit_cents ? [['旧套餐折算抵扣', -data.credit_cents] as [string, number]] : []),
      ...(data.balance_cents ? [['余额抵扣', -data.balance_cents] as [string, number]] : []),
    ];
    const info: [string, string][] = [
      ['订单类型', t(ORDER_ACTION[data.action])],
      ['购买时长', periodText(data.period, data.period_days, t, tp)],
      ['下单时间', formatDateTime(data.created_at)],
      ...(data.coupon_code ? [['优惠码', data.coupon_code] as [string, string]] : []),
      ...(data.payment_method_name ? [['支付方式', data.payment_method_name] as [string, string]] : []),
      ...(data.paid_at ? [['支付时间', formatDateTime(data.paid_at)] as [string, string]] : []),
      ...(data.refunded_at ? [['退款时间', formatDateTime(data.refunded_at)] as [string, string]] : []),
      ...(data.refund_route ? [['退款方式', t(REFUND_ROUTE[data.refund_route])] as [string, string]] : []),
    ];
    const minutesLeft = Math.max(0, Math.ceil((new Date(data.expires_at).getTime() - now) / 60000));
    return { closed, unfulfilled, steps, lines, info, minutesLeft, state: orderState(data) };
  });
</script>

<div class="ph">
  <div>
    <h1>{t('订单详情')}</h1>
    {#if data}<p class="num">{tp('{p} · {n}', { p: data.plan_name, n: data.out_trade_no })}</p>{/if}
  </div>
  <a class="link quiet-link" href={R.orders}><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />{t('返回订单列表')}</a>
</div>

{#if !data && order.loading}
  <Loading rows={6} height={360} />
{:else if !data && order.error}
  <LoadError error={order.error} onretry={order.reload} />
{:else if data && view}
  <ol class="steps" aria-label={t('订单进度')}>
    {#each view.steps as st, i (st.label)}
      <li class={st.state} aria-current={st.state === 'current' ? 'step' : undefined}>
        <span class="dot" aria-hidden="true">
          {#if st.state === 'done'}<Check size={13} strokeWidth={2.6} />{:else if st.state === 'failed'}<X size={13} strokeWidth={2.4} />{:else}{i + 1}{/if}
        </span>
        <div>
          <b>{t(st.label)}</b>
          <span class="num">{st.time ?? (st.state === 'current' ? t('等待付款') : '')}</span>
        </div>
      </li>
    {/each}
  </ol>

  {#if data.refunded_at || data.refund_pending || view.unfulfilled}
    <div class="notes refund">
      <div class={['note', !data.refunded_at && !data.refund_pending && 'warn']} role="status">
        {#if data.refunded_at || data.refund_pending}<Undo2 size={16} strokeWidth={1.75} aria-hidden="true" />{:else}<Wallet size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
        <div class="tx">
          {#if data.refunded_at}
            <b>{tp('这笔订单已于 {d} 退款', { d: formatDate(data.refunded_at) })}</b>
            <ul>{#each refundLines(data) as l (l)}<li>{l}</li>{/each}</ul>
          {:else if data.refund_pending}
            <b>{t('退款处理中')}</b>
            <p>{t('已向支付渠道发起原路退款，渠道确认后款项按原支付方式退回，通常几分钟到几个工作日。')}</p>
          {:else}
            <b>{t('付款成功，但套餐没能开通')}</b>
            <p>{t('付款时套餐已售罄、已下架，或你已经换了别的套餐。款项会退回账户余额，可以用来重新下单或申请提现；有疑问请提交工单。')}</p>
          {/if}
        </div>
        {#if (data.refund_balance_cents ?? 0) > 0}
          <div class="acts"><a class="btn sm" href={R.walletTab('ledger')}>{t('查看钱包')}</a></div>
        {/if}
      </div>
    </div>
  {/if}

  <div class="layout">
    <!-- 金额单：宽屏在右边跟着滚；窄屏在最前（先看到要付多少、还剩几分钟） -->
    <aside class="bill" aria-labelledby="h-bill">
      <div class="bill-in">
        <div class="bill-head">
          <h2 id="h-bill">{t('金额明细')}</h2>
          <span class={toneClass(view.state.tone)}>{t(view.state.text)}</span>
        </div>
        <div class="bill-lines num">
          {#each view.lines as [k, v] (k)}
            <div><span>{t(k)}</span><span>{v < 0 ? `−${formatMoney(-v)}` : formatMoney(v)}</span></div>
          {/each}
        </div>
        <div class="bill-total">
          <span>{pending ? t('应付金额') : t('实付金额')}</span>
          <b class="num">{formatMoney(data.amount_cents)}</b>
        </div>
        {#if pending}
          <p class="bill-note">
            <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {view.minutesLeft > 0
                  ? tp('请在 {t} 前完成支付（还剩 {m} 分钟），超时订单会自动关闭', { t: formatTime(data.expires_at), m: view.minutesLeft })
                  : t('订单即将超时关闭，请尽快完成支付')}
            </span>
          </p>
          <button type="button" class="btn btn-block ghost" disabled={cancelling.busy} onclick={cancel}>{t('取消订单')}</button>
        {:else}
          <p class="bill-note plain">
            {view.closed ? t('这笔订单已关闭，可以重新选购套餐。')
              : data.refunded_at ? t('这笔订单已退款。')
              : view.unfulfilled ? t('款项已退回账户余额。')
              : t('订单已完成。')}
          </p>
          <div class="bill-acts">
            <a class="btn pri" href={R.dashboard}>{t('回到仪表盘')}</a>
            <a class="btn" href={R.shop}>{t('继续选购')}</a>
          </div>
        {/if}
      </div>
    </aside>

    <div class="main">
      {#if pending && (qr || payUrl)}
        <section class="sec" aria-labelledby="h-pay">
          <div class="sh">
            <div>
              <h2 id="h-pay">{payUrl && !qr ? t('前往收银台') : alipayJump ? t('支付宝付款') : t('扫码支付')}</h2>
              <p>{t('支付完成后本页会自动更新，无需手动刷新')}</p>
            </div>
          </div>
          <div class="pay">
            {#if payUrl && !qr}
              <a class="btn pri go" href={payUrl} data-external><ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />{t('去付款')}</a>
            {/if}
            {#if qr}
              <!--
                手机 + 支付宝当面付：主操作是「打开支付宝」，二维码退居其次（给另一台设备扫）。不在拿到链接后自动跳：
                没装支付宝时系统会弹「地址无效」，而且那时已不算用户手势，不少浏览器会直接拦下。
              -->
              {#if alipayJump}
                <div class="jump">
                  {#if IN_WECHAT}
                    <p class="wechat">{t('微信里无法打开支付宝。请点右上角「…」，选择「在浏览器打开」后再付款。')}</p>
                  {:else}
                    <a class="btn pri go" href={alipayScheme(qr)} data-external><Wallet size={16} strokeWidth={1.75} aria-hidden="true" />{t('打开支付宝付款')}</a>
                    <!-- 唤起失败（部分安卓浏览器不认 alipays://）时的退路：支付宝官方的二维码页会再引导打开 App -->
                    <a class="retry" href={qr} data-external>{t('没有自动打开？点这里再试一次')}</a>
                  {/if}
                  <p class="or">{t('或用另一台设备扫码')}</p>
                </div>
              {/if}
              <div class={['qr', alipayJump && 'small']}><Qr value={qr} label={t('付款二维码')} /></div>
              {#if !alipayJump}
                <p class="hint">{isAlipayQr(qr) ? t('打开支付宝，扫描上方二维码完成付款') : t('用对应 App 扫描上方二维码完成付款')}</p>
              {/if}
            {/if}
            <p class="hint">{t('想换一种支付方式：取消这一单，回商店重新下单。')}</p>
          </div>
        </section>
      {/if}
      {#if pending && !qr && !payUrl}
        <section class="sec" aria-labelledby="h-wait">
          <div class="sh"><div><h2 id="h-wait">{t('等待付款')}</h2></div></div>
          <p class="hint left">{t('这笔订单没有在线付款方式，请提交工单联系客服完成付款。')}</p>
        </section>
      {/if}

      <section class="sec" aria-labelledby="h-info">
        <div class="sh"><div><h2 id="h-info">{t('订单信息')}</h2></div></div>
        <dl class="info">
          <div>
            <dt>{t('订单号')}</dt>
            <dd class="no">
              <code>{data.out_trade_no}</code>
              <button type="button" class="iconbtn" aria-label={t('复制订单号')} onclick={() => copied.copy(data.out_trade_no, 'no')}>
                {#if copied.which === 'no'}<Check size={14} strokeWidth={1.75} aria-hidden="true" class="ok" />{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{/if}
              </button>
            </dd>
          </div>
          {#each view.info as [k, v] (k)}
            <div><dt>{t(k)}</dt><dd>{#if k === '优惠码'}<code>{v}</code>{:else}{v}{/if}</dd></div>
          {/each}
        </dl>
      </section>
    </div>
  </div>

  {#if resultLoaded}
    {#await import('../components/shop/PayResult.svelte') then m}
      <m.default order={data} {outcome} onclose={() => show(null)} />
    {/await}
  {/if}
{/if}

<style>
  .ph .link { margin-bottom: 4px; }
  .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 32px; padding: 0; list-style: none; }
  .steps li { position: relative; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .steps li:not(:last-child)::after { content: ''; position: absolute; top: 11px; left: 30px; right: 4px; height: 1px; background: var(--line2); }
  .steps li.done:not(:last-child)::after { background: var(--ok); }
  .dot {
    position: relative; z-index: 1; display: grid; place-items: center; flex: none; width: 22px; height: 22px; border-radius: 50%;
    font-size: 12px; font-weight: 600; color: var(--muted); background: var(--bg); border: 1px solid var(--line2); font-variant-numeric: tabular-nums;
  }
  .done .dot { color: var(--ok); border-color: var(--ok); }
  .current .dot { color: var(--on-brand); background: var(--brand); border-color: var(--brand); }
  .steps div { display: flex; flex-direction: column; min-width: 0; }
  .steps b { font-size: 13.5px; font-weight: 600; color: var(--fg); }
  .todo b { color: var(--muted); font-weight: 500; }
  .failed b { color: var(--muted); }
  .steps span.num { min-height: 18px; margin-top: 2px; font-size: 12px; color: var(--muted); }

  .refund { margin: -8px 0 24px; }
  .refund .tx ul, .refund .tx p { margin-top: 2px; padding: 0; list-style: none; color: var(--muted); }

  .layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 0 56px; align-items: start; border-top: 1px solid var(--line); }
  .main { grid-column: 1; grid-row: 1; min-width: 0; }
  .main > .sec:first-child { border-top: 0; }
  .bill { grid-column: 2; grid-row: 1; position: sticky; top: 84px; padding-top: 32px; }
  .bill-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .bill-head h2 { font-size: 15px; line-height: 24px; font-weight: 600; color: var(--fg); }
  .bill-lines { margin-top: 12px; font-size: 13.5px; }
  .bill-lines div { display: flex; justify-content: space-between; gap: 16px; padding: 4px 0; color: var(--muted); }
  .bill-lines span:last-child { color: var(--body); }
  .bill-total { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-top: 10px; padding-top: 14px; border-top: 1px solid var(--line); }
  .bill-total span { font-size: 13px; color: var(--muted); }
  .bill-total b { font-size: 28px; line-height: 1; font-weight: 600; letter-spacing: -.02em; color: var(--fg); }
  .bill-note { display: flex; align-items: flex-start; gap: 6px; margin: 16px 0 12px; font-size: 12.5px; line-height: 1.7; color: var(--muted); }
  .bill-note :global(svg) { flex: none; margin-top: 3px; }
  .bill-note.plain { display: block; }
  .bill-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }

  .pay { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 4px 0; }
  .go { height: 44px; padding: 0 22px; font-size: 15px; }
  .jump { display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%; max-width: 320px; }
  .jump .go { width: 100%; }
  .retry { font-size: 12.5px; color: var(--muted); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line2); }
  .wechat { font-size: 13px; line-height: 1.8; color: var(--warn); text-align: center; }
  .or { display: flex; align-items: center; gap: 12px; width: 100%; margin-top: 4px; font-size: 12px; color: var(--faint); }
  .or::before, .or::after { content: ''; flex: 1; border-top: 1px solid var(--line); }
  .qr { width: 212px; height: 212px; padding: 12px; border-radius: 8px; background: var(--qr-paper); border: 1px solid var(--line); }
  .qr.small { width: 172px; height: 172px; }
  .hint { font-size: 12.5px; color: var(--muted); text-align: center; }
  .hint.left { margin-top: 16px; text-align: left; }

  .info { display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px; }
  .info div { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 46px; padding: 8px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .info dt { flex: none; color: var(--muted); }
  .info dd { min-width: 0; color: var(--fg); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .info dd.no { display: flex; align-items: center; gap: 2px; }
  .info code { font-family: var(--font-mono); font-size: 12.5px; }
  .info :global(.ok) { color: var(--ok); }

  @media (max-width: 960px) {
    .layout { grid-template-columns: minmax(0, 1fr); }
    .bill { grid-column: 1; grid-row: 1; position: static; padding-bottom: 28px; }
    .main { grid-row: 2; border-top: 1px solid var(--line); }
  }
  @media (max-width: 720px) {
    .steps { gap: 8px; }
    .info { grid-template-columns: 1fr; }
  }
</style>
