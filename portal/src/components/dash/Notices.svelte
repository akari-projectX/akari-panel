<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import X from '@lucide/svelte/icons/x';
  import { orderApi, type MyOrder, type TicketRow } from '@/api';
  import { formatMoney, formatTime, periodText } from '@/lib/format';
  import type { TagView } from '$lib/announcement';
  import { auth, scope } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { dismiss, dismissMark, isDismissed } from '$lib/notice-dismiss';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 仪表盘的提示胶囊（design/portal-polish-2026-10：页标题下面，每条一行，按急迫程度从上到下）：
   * 左边带颜色的类别、加粗标题、一句说明、右边操作；窄屏变成圆角小卡片（类别 + 标题一行，说明与操作换到下一行）。
   *   红「已暂停」（续费范围：已到期 / 流量用完）→ 橙「待支付」（取消订单 + 去支付）→ 蓝「邮箱」（去验证）
   *   → 绿「工单」（整枚链到那张工单）→ 公告（标签色，整枚打开公告详情）。
   * 除了红色那条，每枚右端都有 ×：公告 = 标为已读（下一条未读的顶上来）；工单 = 直到客服再回复；
   * 邮箱 = 本次会话不再提示（原「稍后」）；待支付 = 这一笔订单不再提示（订单页与导航的数字照旧）。工单与订单记在 lib/notice-dismiss。
   */
  let { order, onorderchange, replied, latest, onopen, ondismiss }: {
    order: MyOrder | null;
    onorderchange: () => void;
    replied: TicketRow[];
    /** 最新一条没读过的公告：标题、摘要与标签（胶囊里的小标签用标签色）；onopen = 点胶囊 */
    latest: { title: string; brief: string; tag: TagView | null } | null;
    onopen: () => void;
    /** 公告的 ×：标为已读 */
    ondismiss: () => void;
  } = $props();

  const NUDGE_KEY = 'akari.verify-nudge';
  let hidden = $state(readNudge());
  let verifying = $state(false);
  let verifyLoaded = $state(false);
  const cancelling = new Pending();

  function readNudge(): boolean {
    try { return sessionStorage.getItem(NUDGE_KEY) === '1'; } catch { return false; }
  }

  function later() {
    hidden = true;
    try { sessionStorage.setItem(NUDGE_KEY, '1'); } catch { /* 隐私模式 */ }
  }

  function verify() {
    verifyLoaded = true;
    verifying = true;
  }

  const me = $derived(auth.me);
  const renewal = $derived(scope() === 'renewal');
  /* 挂载时取一次「现在」就够：这条提醒不需要秒级倒计时，进订单页才有 */
  const now = Date.now();
  const expired = $derived(order ? new Date(order.expires_at).getTime() <= now : false);
  const summary = $derived(order
    ? [order.plan_name, periodText(order.period, order.period_days, t, tp), formatMoney(order.amount_cents)].join(' · ')
    : '');

  /* 关掉的订单与工单回复（这一版）：内容变了再出现 */
  let closedOrder = $state<string | null>(null);
  let closedTicket = $state<string | null>(null);
  const orderMark = $derived(order ? dismissMark(order.id) : '');
  const reply = $derived(replied[0] ?? null);
  const replyMark = $derived(reply ? dismissMark(reply.id, reply.updated_at) : '');
  const showOrder = $derived(!!order && closedOrder !== orderMark && !isDismissed('order', orderMark));
  const showReply = $derived(!!reply && closedTicket !== replyMark && !isDismissed('ticket', replyMark));

  function closeOrder() {
    dismiss('order', orderMark);
    closedOrder = orderMark;
  }

  function closeReply() {
    dismiss('ticket', replyMark);
    closedTicket = replyMark;
  }

  function cancel(o: MyOrder) {
    void cancelling.run(async () => {
      try {
        await orderApi.cancel(o.id);
        toast.success(t('订单已取消'));
      } catch (e) {
        toast.error(errorText(e));
      }
      onorderchange();
    });
  }

</script>

{#snippet close(label: string, onclick: () => void)}
  <button type="button" class="cap-close" aria-label={label} title={label} {onclick}><X size={14} strokeWidth={1.75} aria-hidden="true" /></button>
{/snippet}

{#if me}
  {#if renewal}
    <div role="status" class="cap c-red">
      <span class="cap-main">
        <span class="cap-tag"><i></i>{t('已暂停')}</span>
        <b class="cap-t">{me.quota_exhausted ? t('本期流量已用完，服务已暂停') : t('套餐已到期，服务已暂停')}</b>
        <span class="cap-d">{me.quota_exhausted
          ? t('购买流量重置包或续费后立即恢复；订阅链接和节点在恢复前不可用。')
          : t('续费后立即恢复；订阅链接和节点在恢复前不可用。')}</span>
      </span>
      <span class="cap-x"><a class="btn sm ink" href={R.shop}>{me.quota_exhausted ? t('去恢复') : t('去续费')}</a></span>
    </div>
  {/if}

  {#if order && showOrder}
    <div role="status" class="cap c-orange">
      <span class="cap-main">
        <span class="cap-tag"><i></i>{t('待支付')}</span>
        <b class="cap-t">{summary}</b>
        <span class="cap-d">{expired ? t('即将自动关闭') : tp('{t} 前未支付将自动关闭', { t: formatTime(order.expires_at) })}</span>
      </span>
      <span class="cap-x">
        <button type="button" class="btn sm ghost muted" disabled={cancelling.busy} onclick={() => cancel(order)}>{t('取消订单')}</button>
        <a class="btn sm ink" href={R.order(order.id)}>{t('去支付')}</a>
      </span>
      {@render close(t('关闭'), closeOrder)}
    </div>
  {/if}

  {#if !me.email_verified && !hidden}
    <div role="status" class="cap c-brand">
      <span class="cap-main">
        <span class="cap-tag"><i></i>{t('邮箱')}</span>
        <b class="cap-t">{t('邮箱还没有验证')}</b>
        <span class="cap-d">{t('到期提醒、流量提醒和付款收据只发到已验证的邮箱，找回密码也需要它。')}</span>
      </span>
      <span class="cap-x"><button type="button" class="btn sm ink" onclick={verify}>{t('去验证')}</button></span>
      {@render close(t('关闭'), later)}
    </div>
  {/if}

  {#if reply && showReply}
    <div class="cap c-green">
      <a class="cap-main" href={R.ticket(reply.id)}>
        <span class="cap-tag"><i></i>{t('工单')}</span>
        <b class="cap-t">{t('管理员已回复你的工单')}</b>
        <span class="cap-d">{reply.subject}{#if replied.length > 1}&nbsp;{tp('等 {n} 张', { n: replied.length })}{/if}</span>
        <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
      </a>
      {@render close(t('关闭'), closeReply)}
    </div>
  {/if}

  {#if latest}
    <div class={['cap', latest.tag?.cls ?? 'c-brand']}>
      <button type="button" class="cap-main" onclick={onopen}>
        <span class="cap-tag"><i></i>{latest.tag?.name ?? t('公告')}</span>
        <b class="cap-t">{latest.title}</b>
        {#if latest.brief}<span class="cap-d">{latest.brief}</span>{/if}
        <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {@render close(t('关闭'), ondismiss)}
    </div>
  {/if}
{/if}

{#if verifyLoaded}
  {#await import('../VerifyEmailDialog.svelte') then m}<m.default bind:open={verifying} />{/await}
{/if}
