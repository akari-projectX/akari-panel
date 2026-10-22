<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import type { InviteCodes, MyInvite } from '@/api';
  import { formatDate, formatMoney } from '@/lib/format';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { toast } from '$lib/toast.svelte';
  import { anyClawback, commissionStatus, inviteLink } from '$lib/wallet';

  /*
   * 「邀请返佣」分页（同 React 门户 wallet-invite.tsx 的 InviteDetails）：收益四个数（不放大）、我的邀请码（每个账户一个，
   * 不能删除或重新生成；单次使用的站点上写明「只能使用一次」）、返佣明细（只显示被邀请人的非个人标签，不显示对方邮箱）。
   * 宽屏表格、窄屏一行一笔。
   */
  let { codes, invite, narrow }: { codes: Resource<InviteCodes>; invite: Resource<MyInvite>; narrow: boolean } = $props();

  const copied = new Copied<'code' | 'link'>(2000);
  const c = $derived(codes.data);
  const i = $derived(invite.data);
  const mine = $derived(c?.code ?? null);

  async function copy(text: string, which: 'code' | 'link') {
    await copied.copy(text, which);
    if (copied.which === which) toast.success(tp('{what}已复制', { what: which === 'code' ? t('邀请码') : t('邀请链接') }));
  }
</script>

<div class="details">
  {#if invite.loading && !i}
    <Loading rows={1} />
  {:else if invite.error && !i}
    <LoadError error={invite.error} onretry={invite.reload} />
  {:else if i}
    <div>
      <dl class="mini">
        <div><dt>{t('已邀请')}</dt><dd>{tp('{n} 人', { n: i.invited_count })}</dd></div>
        <div><dt>{t('冻结中')}</dt><dd>{formatMoney(i.pending_cents)}</dd></div>
        <div><dt>{t('已入账')}</dt><dd>{formatMoney(i.credited_cents)}</dd></div>
        <div><dt>{t('已追回')}</dt><dd>{formatMoney(i.reversed_cents)}</dd></div>
      </dl>
      {#if anyClawback(i)}
        <p class="note-l">{t('被追回的佣金因订单退款从余额里扣回，余额不够时差额记为欠款，从之后入账的佣金里抵扣（余额不会变成负数）。')}</p>
      {/if}
    </div>
  {/if}

  <div>
    <h3>
      {t('我的邀请码')}
      <span>{c?.single_use ? t('每个账户一个，只能使用一次') : t('每个账户一个，长期有效')}</span>
    </h3>
    {#if codes.loading && !c}
      <Loading rows={1} />
    {:else if codes.error && !c}
      <LoadError error={codes.error} onretry={codes.reload} />
    {:else if c && !c.user_invites}
      <Empty title={t('邀请已关闭')} desc={t('本站暂时关闭了用户邀请；重新开放后你的邀请码会恢复。')} />
    {:else if c && !mine}
      <Empty title={t('还没有邀请码')} desc={t('站点开放注册后会自动为你生成。')} />
    {:else if c && mine}
      <div class="code">
        <span class="code-l">
          <code data-testid="invite-code">{mine.code}</code>
          <span>{tp('已用 {n} 次', { n: mine.uses })}</span>
        </span>
        <span class="acts">
          <button type="button" class="btn sm ghost" aria-label={t('复制邀请码')} onclick={() => copy(mine.code, 'code')}>
            {#if copied.which === 'code'}<Check size={14} strokeWidth={2} aria-hidden="true" />{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{/if}
            <span class="d-only">{t('复制邀请码')}</span>
          </button>
          <button type="button" class="btn sm ghost" aria-label={t('复制链接')} onclick={() => copy(inviteLink(mine.code, c.link_base), 'link')}>
            {#if copied.which === 'link'}<Check size={14} strokeWidth={2} aria-hidden="true" />{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{/if}
            <span class="d-only">{t('复制链接')}</span>
          </button>
        </span>
      </div>
    {/if}
  </div>

  <div>
    <h3>{i?.commissions.length ? tp('返佣明细 · 共 {n} 条', { n: i.commissions.length }) : t('返佣明细')}</h3>
    {#if invite.loading && !i}
      <Loading rows={2} />
    {:else if i && i.commissions.length === 0}
      <Empty title={t('还没有返佣记录')} desc={t('被你邀请的人完成付费后，明细会出现在这里。')} />
    {:else if i && narrow}
      <div class="list">
        {#each i.commissions as x (x.id)}
          <div class="li">
            <div class="main">
              <div class="t"><span>{x.invitee_label}</span></div>
              <p class="s num">
                {formatDate(x.created_at)} · {tp('订单 {v}', { v: formatMoney(x.base_cents) })}{#if x.status === 'pending'}&nbsp;· {tp('{d} 入账', { d: formatDate(x.available_at) })}{/if}
              </p>
            </div>
            <span class="right">
              <b class="num">{formatMoney(x.amount_cents)}</b>
              <span class="st {commissionStatus(x).tone}">{t(commissionStatus(x).text)}</span>
            </span>
          </div>
        {/each}
      </div>
    {:else if i}
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>{t('日期')}</th>
              <th>{t('被邀请人')}</th>
              <th class="n">{t('订单金额')}</th>
              <th class="n">{t('佣金')}</th>
              <th>{t('状态')}</th>
            </tr>
          </thead>
          <tbody>
            {#each i.commissions as x (x.id)}
              <tr>
                <td class="when">{formatDate(x.created_at)}</td>
                <td>{x.invitee_label}</td>
                <td class="n q">{formatMoney(x.base_cents)}</td>
                <td class="n"><span class="strong">{formatMoney(x.amount_cents)}</span> <span class="rate">({x.rate_percent}%)</span></td>
                <td>
                  <span class="st {commissionStatus(x).tone}">{t(commissionStatus(x).text)}</span>
                  {#if x.status === 'pending'}<span class="when-l">{tp('{d} 入账', { d: formatDate(x.available_at) })}</span>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

<style>
  .details { display: flex; flex-direction: column; gap: 40px; padding-top: 16px; }
  .note-l { max-width: 72ch; margin-top: 12px; font-size: 12.5px; line-height: 1.7; color: var(--muted); }
  h3 { margin-bottom: 8px; font-size: 14px; font-weight: 600; color: var(--fg); }
  h3 span { margin-left: 8px; font-weight: 400; font-size: 13px; color: var(--muted); }
  .code { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .code-l { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .code-l code { overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); font-size: 14px; color: var(--fg); }
  .code-l span { flex: none; font-size: 12px; color: var(--muted); }
  .acts { display: flex; flex: none; gap: 4px; }
  .acts .btn { gap: 6px; }
  .rate { font-size: 12px; color: var(--muted); }
  .when-l { margin-left: 8px; font-size: 12.5px; color: var(--muted); white-space: nowrap; }
  .right { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 4px; }
  .right b { font-weight: 500; color: var(--fg); }
</style>
