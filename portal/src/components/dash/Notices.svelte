<script lang="ts">
  import Clock from '@lucide/svelte/icons/clock';
  import Headphones from '@lucide/svelte/icons/headphones';
  import Mail from '@lucide/svelte/icons/mail';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { orderApi, type MyOrder, type TicketRow } from '@/api';
  import { formatMoney, formatTime, periodText } from '@/lib/format';
  import { auth, scope } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 仪表盘的提醒（样稿 dashboard.html#notices：关键数字上方的细行，不是彩色卡片；图标单色，警告类琥珀）。
   * 顺序与 React 门户相同：账户提醒在前（components/account-banners.tsx：续费范围、邮箱未验证），
   * 页面提醒按急迫程度在后：没付完的订单（components/pending-order.tsx）→ 客服回复了工单 → 流量快用完了（样稿新增）。
   * 最新公告是上面单独的横幅（Overview）。
   */
  let { order, onorderchange, replied, low }: {
    order: MyOrder | null;
    onorderchange: () => void;
    replied: TicketRow[];
    /** 有额度的套餐剩下不到一成：剩余字节、百分比、下次重置（可无） */
    low: { left: string; pct: number; reset: string | null } | null;
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

  const any = $derived(renewal || (me && !me.email_verified && !hidden) || order || replied.length > 0 || low);
</script>

{#if me && any}
  <div class="notes" data-page-notices>
    {#if renewal}
      <div class="note warn" role="status">
        <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        <p class="tx">
          <b>{me.quota_exhausted ? t('本期流量已用完，服务已暂停') : t('套餐已到期，服务已暂停')}</b><span class="gap"></span>
          <span>{me.quota_exhausted
            ? t('购买流量重置包或续费后立即恢复；订阅链接和节点在恢复前不可用。')
            : t('续费后立即恢复；订阅链接和节点在恢复前不可用。')}</span>
        </p>
        <div class="acts"><a class="btn sm pri" href={R.shop}>{me.quota_exhausted ? t('去恢复') : t('去续费')}</a></div>
      </div>
    {/if}

    {#if !me.email_verified && !hidden}
      <div class="note" role="status">
        <Mail size={16} strokeWidth={1.75} aria-hidden="true" />
        <p class="tx">
          <b>{t('邮箱还没有验证')}</b><span class="gap"></span>
          <span>{t('到期提醒、流量提醒和付款收据只发到已验证的邮箱，找回密码也需要它。')}</span>
        </p>
        <div class="acts">
          <button type="button" class="btn sm ghost" onclick={later}>{t('稍后')}</button>
          <button type="button" class="btn sm" onclick={verify}>{t('去验证')}</button>
        </div>
      </div>
    {/if}

    {#if order}
      <div class="note" role="status">
        <Clock size={16} strokeWidth={1.75} aria-hidden="true" />
        <p class="tx">
          <b>{t('你有一笔待支付的订单')}</b><span class="gap"></span>
          <span class="num">{summary} · {expired ? t('即将自动关闭') : tp('{t} 前未支付将自动关闭', { t: formatTime(order.expires_at) })}</span>
        </p>
        <div class="acts">
          <button type="button" class="btn sm ghost" disabled={cancelling.busy} onclick={() => cancel(order)}>{t('取消订单')}</button>
          <a class="btn sm pri" href={R.order(order.id)}>{t('去支付')}</a>
        </div>
      </div>
    {/if}

    {#if replied.length > 0}
      <div class="note">
        <Headphones size={16} strokeWidth={1.75} aria-hidden="true" />
        <p class="tx">
          <b>{t('管理员已回复你的工单')}</b><span class="gap"></span>
          <span>{replied[0].subject}{#if replied.length > 1}&nbsp;{tp('等 {n} 张', { n: replied.length })}{/if}</span>
        </p>
        <div class="acts"><a class="btn sm" href={R.ticket(replied[0].id)}>{t('查看回复')}</a></div>
      </div>
    {/if}

    {#if low}
      <div class="note warn" role="status">
        <TriangleAlert size={16} strokeWidth={1.75} aria-hidden="true" />
        <p class="tx">
          <b>{t('流量快用完了')}</b><span class="gap"></span>
          <span class="num">{low.reset
            ? tp('只剩 {v}（{p}%），{d} 重置。', { v: low.left, p: low.pct, d: low.reset })
            : tp('只剩 {v}（{p}%）。', { v: low.left, p: low.pct })}</span>
        </p>
        <div class="acts"><a class="btn sm" href={R.shop}>{t('购买重置包')}</a></div>
      </div>
    {/if}
  </div>
{/if}

{#if verifyLoaded}
  {#await import('../VerifyEmailDialog.svelte') then m}<m.default bind:open={verifying} />{/await}
{/if}
