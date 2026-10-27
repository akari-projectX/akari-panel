<script lang="ts">
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import Clock from '@lucide/svelte/icons/clock';
  import Headphones from '@lucide/svelte/icons/headphones';
  import Mail from '@lucide/svelte/icons/mail';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { orderApi, type MyOrder, type TicketRow } from '@/api';
  import { formatMoney, formatTime, periodText } from '@/lib/format';
  import type { TagView } from '$lib/announcement';
  import { auth, scope } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 仪表盘的提醒（样稿 dashboard.html#notices：关键数字上方的细行，不是彩色卡片；图标单色，警告类琥珀）。
   * 顺序：账户提醒在前（续费范围、邮箱未验证），
   * 页面提醒按急迫程度在后：没付完的订单（components/pending-order.tsx）→ 客服回复了工单 → 流量快用完了（样稿新增）。
   * 最新公告是上面单独的横幅（Overview）。
   */
  let { order, onorderchange, replied, latest, onopen }: {
    order: MyOrder | null;
    onorderchange: () => void;
    replied: TicketRow[];
    /** 最新一条没读过的公告：标题、摘要与标签（卡片左边一道同色细边）；onopen = 点「查看详情」 */
    latest: { title: string; brief: string; tag: TagView | null } | null;
    onopen: () => void;
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

{#if me}
  {#if renewal}
    <div role="status" class="notice">
      <TriangleAlert size={16} strokeWidth={1.75} class="ic-warn" aria-hidden="true" />
      <div class="grow">
        <div class="nt">{me.quota_exhausted ? t('本期流量已用完，服务已暂停') : t('套餐已到期，服务已暂停')}</div>
        <div class="nd wrap2">{me.quota_exhausted
          ? t('购买流量重置包或续费后立即恢复；订阅链接和节点在恢复前不可用。')
          : t('续费后立即恢复；订阅链接和节点在恢复前不可用。')}</div>
      </div>
      <a class="btn sm pri" href={R.shop}>{me.quota_exhausted ? t('去恢复') : t('去续费')}</a>
    </div>
  {/if}

  {#if !me.email_verified && !hidden}
    <div role="status" class="notice">
      <Mail size={16} strokeWidth={1.75} class="ic-brand" aria-hidden="true" />
      <div class="grow">
        <div class="nt">{t('邮箱还没有验证')}</div>
        <div class="nd wrap2">{t('到期提醒、流量提醒和付款收据只发到已验证的邮箱，找回密码也需要它。')}</div>
      </div>
      <div class="nx">
        <button type="button" class="btn sm ghost muted" onclick={later}>{t('稍后')}</button>
        <button type="button" class="btn sm" onclick={verify}>{t('去验证')}</button>
      </div>
    </div>
  {/if}

  {#if order}
    <div role="status" class="notice warn-bg">
      <Clock size={16} strokeWidth={1.75} class="ic-warn" aria-hidden="true" />
      <div class="grow">
        <div class="nt">{t('你有一笔待支付的订单')}</div>
        <div class="nd">{summary} · {expired ? t('即将自动关闭') : tp('{t} 前未支付将自动关闭', { t: formatTime(order.expires_at) })}</div>
      </div>
      <div class="nx">
        <button type="button" class="btn sm ghost muted" disabled={cancelling.busy} onclick={() => cancel(order)}>{t('取消订单')}</button>
        <a class="btn sm pri" href={R.order(order.id)}>{t('去支付')}</a>
      </div>
    </div>
  {/if}

  {#if replied.length > 0}
    <div class="notice">
      <Headphones size={16} strokeWidth={1.75} class="ic-ok" aria-hidden="true" />
      <div class="grow">
        <div class="nt">{t('管理员已回复你的工单')}</div>
        <div class="nd">{replied[0].subject}{#if replied.length > 1}&nbsp;{tp('等 {n} 张', { n: replied.length })}{/if}</div>
      </div>
      <a class="btn sm" href={R.ticket(replied[0].id)}>{t('查看回复')}</a>
    </div>
  {/if}

  {#if latest}
    <div class={['notice', latest.tag && `edge ${latest.tag.cls}`]}>
      <Megaphone size={16} strokeWidth={1.75} class="ic-brand" aria-hidden="true" />
      <div class="grow">
        <div class={['nt', latest.tag && 'tagged']}>
          {#if latest.tag}<span class="tg {latest.tag.cls}">{latest.tag.name}</span>{/if}
          <span class="trunc">{latest.title}</span>
        </div>
        {#if latest.brief}<div class="nd">{latest.brief}</div>{/if}
      </div>
      <button type="button" class="btn sm" onclick={onopen}>{t('查看详情')}</button>
    </div>
  {/if}
{/if}

{#if verifyLoaded}
  {#await import('../VerifyEmailDialog.svelte') then m}<m.default bind:open={verifying} />{/await}
{/if}
