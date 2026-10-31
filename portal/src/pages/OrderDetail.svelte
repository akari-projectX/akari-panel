<script module lang="ts">
  const Result = () => import('../components/shop/PayResult.svelte');
</script>

<script lang="ts">
  import '../styles/pages/order-detail.css';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Check from '@lucide/svelte/icons/check';
  import Clock from '@lucide/svelte/icons/clock';
  import Copy from '@lucide/svelte/icons/copy';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import Wallet from '@lucide/svelte/icons/wallet';
  import FileText from '@lucide/svelte/icons/file-text';
  import XCircle from '@lucide/svelte/icons/circle-x';
  import { untrack } from 'svelte';
  import { orderApi, type MyOrder, type RefundEffect, type RefundRoute } from '@/api';
  import { K } from '@/lib/cache';
  import { ORDER_ACTION, formatDate, formatDateTime, formatMoney, formatTime, orderState, periodText } from '@/lib/format';
  import { outcomeOf, type PayOutcome } from '@/lib/shop';
  import LoadError from '../components/LoadError.svelte';
  import DashSkeleton from '../components/DashSkeleton.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Section from '../components/flat/Section.svelte';
  import Qr from '../components/dash/Qr.svelte';
  import { chunk, preloadDialogs } from '$lib/dialogs';
  import { refresh } from '$lib/auth.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { loc, navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { IN_WECHAT, IS_MOBILE, alipayScheme, isAlipayQr, safeUrl } from '$lib/shop';
  import { toast } from '$lib/toast.svelte';

  /*
   * 订单详情与付款（也是易支付 return_url 回来的页面）。
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
  /* 结果对话框没有触发按钮（轮询到变化时弹出）：分包在空闲时预载（lib/dialogs） */
  preloadDialogs(Result);
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

{#if !data && order.loading}
  <DashSkeleton />
{:else if !data && order.error}
  <PageTitle title={t('订单详情')} />
  <LoadError error={order.error} onretry={order.reload} />
{:else if data && view}
  <PageTitle title={t('订单详情')} lead={tp('{p} · {a} · {s}', { p: data.plan_name, a: formatMoney(data.amount_cents), s: t(view.state.text) })} sub={data.out_trade_no}>
    {#snippet extra()}<a class="btn" style="height: 36px" href={R.orders}><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />{t('返回订单列表')}</a>{/snippet}
  </PageTitle>

  <!-- ── 进度条：一眼看出这笔订单走到哪一步 ── -->
  <Section>
    <ol class="od-steps" aria-label={t('订单进度')}>
      {#each view.steps as st, i (st.label)}
        <li aria-current={st.state === 'current' ? 'step' : undefined}>
          {#if i < view.steps.length - 1}
            <span aria-hidden="true" class={['od-link', st.state === 'done' && view.steps[i + 1].state !== 'todo' && 'on']}></span>
          {/if}
          <span class={['od-dot', st.state]}>
            {#if st.state === 'done'}<Check size={14} strokeWidth={2.6} aria-hidden="true" />{:else if st.state === 'failed'}<XCircle size={14} strokeWidth={1.75} aria-hidden="true" />{:else}{i + 1}{/if}
          </span>
          <div class={['od-lb', st.state === 'todo' && 'todo']}>{t(st.label)}</div>
          <div class="od-tm tnum">{st.time ?? (st.state === 'current' && pending ? t('等待付款') : ' ')}</div>
        </li>
      {/each}
    </ol>
  </Section>

  {#if data.refunded_at || data.refund_pending || view.unfulfilled}
    <div role="status" class="notice od-refund">
      {#if data.refunded_at || data.refund_pending}<Undo2 size={16} strokeWidth={1.75} class="ic-brand" aria-hidden="true" />{:else}<Wallet size={16} strokeWidth={1.75} class="ic-warn" aria-hidden="true" />{/if}
      <div class="grow od-rtx">
        {#if data.refunded_at}
          <div class="od-b">{tp('这笔订单已于 {d} 退款', { d: formatDate(data.refunded_at) })}</div>
          <ul>{#each refundLines(data) as l (l)}<li>{l}</li>{/each}</ul>
        {:else if data.refund_pending}
          <div class="od-b">{t('退款处理中')}</div>
          <div class="od-m">{t('已向支付渠道发起原路退款，渠道确认后款项按原支付方式退回，通常几分钟到几个工作日。')}</div>
        {:else}
          <div class="od-b">{t('付款成功，但套餐没能开通')}</div>
          <div class="od-m">{t('付款时套餐已售罄、已下架，或你已经换了别的套餐。款项会退回账户余额，可以用来重新下单或申请提现；有疑问请提交工单。')}</div>
        {/if}
      </div>
      {#if (data.refund_balance_cents ?? 0) > 0}
        <a class="btn sm" href={R.walletTab('ledger')}>{t('查看钱包')}</a>
      {/if}
    </div>
  {/if}

  <!-- 宽屏两栏：左边付款方式 + 订单信息，右边金额单吊在侧边跟着滚；手机上一栏：金额单 → 付款 → 订单信息 -->
  <div class="od-grid">
    <aside class="od-aside">
      <div class="od-bill">
        <div class="od-bh">
          <span>{t('金额明细')}</span>
          <span class={['bdg', view.state.tone]}>{t(view.state.text)}</span>
        </div>
        <div class="od-lines">
          {#each view.lines as [k, v] (k)}
            <div><span>{t(k)}</span><span class="tnum">{v < 0 ? `−${formatMoney(-v)}` : formatMoney(v)}</span></div>
          {/each}
        </div>
        <hr class="od-sep" />
        <div class="od-tot">
          <span>{pending ? t('应付金额') : t('实付金额')}</span>
          <span class="tnum">{formatMoney(data.amount_cents)}</span>
        </div>
        {#if pending}
          <p class="od-note">
            <Clock size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {view.minutesLeft > 0
                ? tp('请在 {t} 前完成支付（还剩 {m} 分钟），超时订单会自动关闭', { t: formatTime(data.expires_at), m: view.minutesLeft })
                : t('订单即将超时关闭，请尽快完成支付')}
            </span>
          </p>
          <button type="button" class="btn ghost muted od-cancel" disabled={cancelling.busy} onclick={cancel}><XCircle size={14} strokeWidth={1.75} aria-hidden="true" />{t('取消订单')}</button>
        {:else}
          <p class="od-note plain">
            {view.closed ? t('这笔订单已关闭，可以重新选购套餐。')
              : data.refunded_at ? t('这笔订单已退款。')
              : view.unfulfilled ? t('款项已退回账户余额。')
              : t('订单已完成。')}
          </p>
          <div class="od-acts">
            <a class="btn pri" href={R.dashboard}>{t('回到仪表盘')}</a>
            <a class="btn" href={R.shop}>{t('继续选购')}</a>
          </div>
        {/if}
      </div>
    </aside>

    <div class="od-main">
      <!-- ── 待支付：二维码 / 收银台 ── -->
      {#if pending && (qr || payUrl)}
        <Section>
          {#snippet title()}{payUrl && !qr ? t('前往收银台') : alipayJump ? t('支付宝付款') : t('扫码支付')}{/snippet}
          {#snippet desc()}{t('支付完成后本页会自动更新，无需手动刷新')}{/snippet}
          <div class="od-pay">
            {#if payUrl && !qr}
              <a class="btn pri od-go" href={payUrl} data-external><ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />{t('去付款')}</a>
            {/if}
            {#if qr}
              <!--
                手机 + 支付宝当面付：主操作是「打开支付宝」，二维码退居其次（给另一台设备扫）。不在拿到链接后自动跳：
                没装支付宝时系统会弹「地址无效」，而且那时已不算用户手势，不少浏览器会直接拦下。
              -->
              {#if alipayJump}
                <div class="od-jump">
                  {#if IN_WECHAT}
                    <p class="od-wechat">{t('微信里无法打开支付宝。请点右上角「…」，选择「在浏览器打开」后再付款。')}</p>
                  {:else}
                    <a class="btn od-go od-ali" href={alipayScheme(qr)} data-external><Wallet size={16} strokeWidth={1.75} aria-hidden="true" />{t('打开支付宝付款')}</a>
                    <!-- 唤起失败（部分安卓浏览器不认 alipays://）时的退路：支付宝官方的二维码页会再引导打开 App -->
                    <a class="od-retry" href={qr} data-external>{t('没有自动打开？点这里再试一次')}</a>
                  {/if}
                  <div class="od-or"><span></span>{t('或用另一台设备扫码')}<span></span></div>
                </div>
              {/if}
              <div class={['od-qr', alipayJump && 'small']}><Qr value={qr} label={t('付款二维码')} /></div>
              {#if !alipayJump}
                <p class="od-h13">{isAlipayQr(qr) ? t('打开支付宝，扫描上方二维码完成付款') : t('用对应 App 扫描上方二维码完成付款')}</p>
              {/if}
            {/if}
            <p class="od-h12">{t('想换一种支付方式：取消这一单，回商店重新下单。')}</p>
          </div>
        </Section>
      {/if}
      {#if pending && !qr && !payUrl}
        <Section>
          {#snippet title()}{t('等待付款')}{/snippet}
          <p class="od-wait">{t('这笔订单没有在线付款方式，请提交工单联系客服完成付款。')}</p>
        </Section>
      {/if}
    </div>

    <!-- 与上面隔一条线（手机上上面是付款区或金额单；宽屏上面是付款区，没有付款区时不画） -->
    <div class={['od-info', !pending && 'nob']}>
      <Section>
        {#snippet title()}<FileText size={16} strokeWidth={1.75} aria-hidden="true" />{t('订单信息')}{/snippet}
        <div class="od-dl">
          <div>
            <span class="k">{t('订单号')}</span>
            <span class="v">
              <span class="no">
                <code>{data.out_trade_no}</code>
                <button type="button" aria-label={t('复制订单号')} onclick={() => copied.copy(data.out_trade_no, 'no')}>
                  {#if copied.which === 'no'}<Check size={14} strokeWidth={1.75} aria-hidden="true" class="ic-ok" />{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{/if}
                </button>
              </span>
            </span>
          </div>
          {#each view.info as [k, v] (k)}
            <div><span class="k">{t(k)}</span><span class="v">{#if k === '优惠码'}<code>{v}</code>{:else}{v}{/if}</span></div>
          {/each}
        </div>
      </Section>
    </div>
  </div>

  {#if resultLoaded}
    {#await chunk(Result) then m}
      <m.default order={data} {outcome} onclose={() => show(null)} />
    {/await}
  {/if}
{/if}
