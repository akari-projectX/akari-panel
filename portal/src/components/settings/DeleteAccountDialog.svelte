<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import { untrack } from 'svelte';
  import { accountApi, passkeyApi, type DeleteImpact } from '@/api';
  import { isUserCancel } from '@/api/webauthn';
  import { K } from '@/lib/cache';
  import { formatMoney } from '@/lib/format';
  import HolderConfirm from './HolderConfirm.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { forget } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { FieldErrors, Pending, fieldOf } from '$lib/forms.svelte';
  import { Holder } from '$lib/holder.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 自助注销：先列出会失去什么（每次打开都重新取 `GET /me/delete-impact`）；
   * 其中有可提现的钱时单独提醒「先去钱包提现」。有待支付订单或待审核提现时面板拒绝（409）：这里直接说要先处理哪一样、给出去处的链接，
   * 没有注销按钮（只有「知道了」）。要确认是本人（当前密码 / 通行密钥，面板校验）并勾选「不可恢复」才能提交；密码不对时错误画在密码框下面并聚焦它。
   * 成功后面板清掉会话：先去结果页，再收掉本地登录态。
   */
  let { open = $bindable(false) }: { open?: boolean } = $props();

  let impact = $state<{ data?: DeleteImpact; error?: unknown; loading: boolean }>({ loading: false });
  let gen = 0;
  function loadImpact() {
    const mine = ++gen;
    impact = { data: impact.data, loading: true };
    accountApi.deleteImpact().then(
      (d) => { if (mine === gen) impact = { data: d, loading: false }; },
      (e: unknown) => { if (mine === gen) impact = { data: impact.data, error: e, loading: false }; },
    );
  }
  /* 每次打开都重新取（untrack：取数本身读写 impact，不能让它变成这个 effect 的依赖） */
  $effect(() => { if (open) untrack(loadImpact); });

  const methods = resource(() => ({ key: K.passkeys, fetch: () => passkeyApi.list(), enabled: open }));
  const holder = new Holder(methods);
  let ack = $state(false);
  const busy = new Pending();
  const f = new FieldErrors(['password', 'ack'] as const);
  f.field('password', 'delete-password');
  f.field('ack', 'delete-ack');

  const d = $derived(impact.data);
  const blocked = $derived(!!d && (d.pending_orders > 0 || d.pending_withdrawals > 0));

  function clear() {
    ack = false;
    holder.reset();
    f.check({});
  }

  function change(o: boolean) {
    if (busy.busy) return;
    if (!o) clear();
    open = o;
  }

  function go(to: string) {
    clear();
    open = false;
    navigate(to);
  }

  function remove(e: SubmitEvent) {
    e.preventDefault();
    if (!d || blocked) return;
    if (!f.check({
      password: holder.mode === 'password' && !holder.password && t('请输入当前密码'),
      ack: !ack && t('请先勾选确认'),
    })) return;
    void busy.run(async () => {
      try {
        await accountApi.deleteAccount(await holder.proof());
        /* 面板已清掉会话 cookie：先离开受保护的页面，再收尾本地登录态 */
        navigate(R.deleted, { replace: true, state: { anonymized: d.anonymized } });
        forget();
      } catch (err) {
        if (isUserCancel(err)) return;
        if (fieldOf(err, { 'account.invalid_password': 'password', 'account.password_required': 'password', 'account.passkey_failed': 'password' } as const)) {
          holder.reset();
          f.set('password', errorText(err));
        } else {
          toast.error(errorText(err));
          loadImpact();
        }
      }
    });
  }

  const lose = $derived(d ? [
    ...(d.plan ? [tp('套餐「{p}」立即失效，剩余时长作废', { p: d.plan.name })] : []),
    ...(d.balance_cents !== 0 ? [tp('账户余额 {v} 作废，不能再提现', { v: formatMoney(d.balance_cents) })] : []),
    ...(d.pending_commission_cents > 0 ? [tp('{n} 笔还在冻结期的邀请返利（{v}）不再入账', { n: d.pending_commissions, v: formatMoney(d.pending_commission_cents) })] : []),
    ...(d.invitees > 0 ? [tp('你邀请的 {n} 位用户之后的消费不再给你返利', { n: d.invitees })] : []),
    ...(d.unfulfilled_orders > 0 ? [tp('{n} 笔已付款但未开通的订单不再处理', { n: d.unfulfilled_orders })] : []),
    t('订阅链接、通行密钥、工单、流量明细全部删除，所有设备立即断线'),
    d.anonymized ? t('账户有付款记录：财务记录匿名保留，其余个人数据删除') : t('账户会被整个删除'),
  ] : []);
</script>

<Dialog bind:open onOpenChange={change} tone="danger" title={t('注销账户')} description={t('这是不可恢复的操作，请先看清会失去什么。')}>
  {#if impact.loading && !d}
    <Loading rows={3} />
  {:else if impact.error && !d}
    <LoadError error={impact.error} onretry={loadImpact} />
  {:else if d}
    <form id="delete-account" novalidate onsubmit={remove} class="form">
      <div role="note" class="lose">
        <b>{t('注销后你将失去')}</b>
        <ul>{#each lose as l (l)}<li>{l}</li>{/each}</ul>
      </div>
      {#if d.withdrawable_cents > 0 && !blocked}
        <div class="warn-line">
          <span>{tp('其中 {v} 可以先提现', { v: formatMoney(d.withdrawable_cents) })}</span>
          <button type="button" class="link" onclick={() => go(R.walletTab('ledger'))}>{t('去钱包')}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
      {/if}
      {#if blocked}
        <ul role="alert" class="blocked">
          <li class="h">{t('还不能注销，请先处理：')}</li>
          {#if d.pending_orders > 0}
            <li>
              <span>{tp('还有 {n} 笔待支付订单：请先在订单页取消', { n: d.pending_orders })}</span>
              <a class="link" href={R.orders} onclick={() => change(false)}>{t('去订单页')}</a>
            </li>
          {/if}
          {#if d.pending_withdrawals > 0}
            <li>
              <span>{tp('还有 {n} 笔待审核的提现（{v}）：请先在钱包页撤回', { n: d.pending_withdrawals, v: formatMoney(d.pending_withdrawal_cents) })}</span>
              <a class="link" href={R.walletTab('ledger')} onclick={() => change(false)}>{t('去钱包')}</a>
            </li>
          {/if}
        </ul>
      {:else}
        <HolderConfirm h={holder} id="delete-password" label={t('输入当前密码确认')} error={f.errors.password} oninput={() => f.dismiss('password')} />
        <div>
          <label class="ack" for="delete-ack">
            <input
              id="delete-ack" type="checkbox" bind:checked={ack} onchange={() => f.dismiss('ack')}
              aria-invalid={f.errors.ack ? true : undefined} aria-describedby={f.errors.ack ? 'delete-ack-msg' : undefined}
            />
            <span>{t('我已了解：注销后账户和上面这些内容都不可恢复')}</span>
          </label>
          {#if f.errors.ack}<p id="delete-ack-msg" role="alert" class="field-msg bad">{f.errors.ack}</p>{/if}
        </div>
      {/if}
    </form>
  {/if}
  {#snippet footer()}
    {#if blocked}
      <button type="button" class="btn pri" onclick={() => change(false)}>{t('知道了')}</button>
    {:else}
      <button type="button" class="btn" disabled={busy.busy} onclick={() => change(false)}>{t('取消')}</button>
      <button type="submit" form="delete-account" class="btn danger" disabled={busy.busy || !d || !holder.usable}>
        {busy.busy ? t('注销中') : t('永久注销')}
      </button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .form { display: flex; flex-direction: column; gap: 18px; }
  .lose { padding: 12px 14px; border-radius: 8px; background: var(--secondary); }
  .lose b { font-size: 13.5px; font-weight: var(--fw-strong); color: var(--fg); }
  .lose ul { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; padding-left: 18px; list-style: disc; font-size: 13px; line-height: 1.7; color: var(--body); }
  .lose li::marker { color: var(--danger); }
  .warn-line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 10px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 13px; color: var(--warn); }
  .blocked { display: flex; flex-direction: column; gap: 8px; padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 13px; line-height: 1.7; color: var(--body); list-style: none; }
  .blocked .h { font-weight: var(--fw-strong); color: var(--warn); }
  .blocked li:not(.h) { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 12px; }
  .ack { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 13px; line-height: 1.6; color: var(--body); cursor: pointer; }
  .ack input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--danger); }
  .danger { background: var(--danger); border-color: var(--danger); color: var(--on-solid); }
  .danger:hover:not(:disabled) { border-color: var(--danger); filter: brightness(.95); }
</style>
