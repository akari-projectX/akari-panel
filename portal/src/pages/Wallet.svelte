<script lang="ts">
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import { tick } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import { inviteApi, walletApi, type LedgerEntry } from '@/api';
  import { K } from '@/lib/cache';
  import { formatMoney, yuan } from '@/lib/format';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import InviteDetails from '../components/wallet/InviteDetails.svelte';
  import InviteLink from '../components/wallet/InviteLink.svelte';
  import Ledger from '../components/wallet/Ledger.svelte';
  import Withdrawals from '../components/wallet/Withdrawals.svelte';
  import { scope } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { loc, navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 邀请与钱包（同 React 门户 pages/dash/wallet.tsx；主地址 /wallet，旧地址 /invite 来到 ?tab=invite）。
   * 面板只有一个余额（佣金入账就进余额，下单可以抵扣），其中「可提现」的部分可以申请 USDT 提现；佣金被追回时余额只扣到 0，差额记为欠款。
   *   概览   左：账户余额（大数字）、可提现 / 审核中 / 最低提现 + 申请提现；右（仅 full）：邀请链接 + 返佣条款。
   *   分页   邀请返佣（收益、邀请码、返佣明细）/ 收支流水 / 提现记录，地址 ?tab=；full 默认「邀请返佣」，标题「邀请」。
   * 续费范围（过期 / 流量用完）只有流水：面板对它们不开放提现与邀请，这一页就是「钱包」。
   */
  type Tab = 'invite' | 'ledger' | 'withdrawals';
  const PAGE = 30;

  const full = scope() === 'full';
  const narrow = new MediaQuery('max-width: 720px');

  const balance = resource(() => ({ key: K.balance, fetch: () => walletApi.balance({ limit: PAGE }) }));
  const withdrawals = resource(() => ({ key: K.withdrawals, fetch: () => walletApi.withdrawals(), enabled: full }));
  const invite = resource(() => ({ key: K.invite, fetch: () => inviteApi.get(), enabled: full }));
  const codes = resource(() => ({ key: K.inviteCodes, fetch: () => inviteApi.codes(), enabled: full }));

  /* ── 分页：地址 ?tab=，换分页替换当前历史记录、不回到顶部；←→ Home End 在分页之间移动（WAI-ARIA tabs） ── */
  const TABS: { id: Tab; label: string }[] = full
    ? [{ id: 'invite', label: '邀请返佣' }, { id: 'ledger', label: '收支流水' }, { id: 'withdrawals', label: '提现记录' }]
    : [{ id: 'ledger', label: '收支流水' }];
  const tab = $derived.by(() => {
    const asked = new URLSearchParams(loc.search).get('tab');
    return TABS.find((x) => x.id === asked)?.id ?? TABS[0].id;
  });

  function setTab(id: Tab) {
    navigate(`${R.wallet}?tab=${id}`, { replace: true, keepScroll: true });
  }

  async function tabKey(e: KeyboardEvent) {
    const i = TABS.findIndex((x) => x.id === tab);
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length
      : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setTab(TABS[next].id);
    await tick();
    document.getElementById(`tab-${TABS[next].id}`)?.focus();
  }

  /* ── 流水按 id 倒序翻页（keyset：before = 已显示的最小 id） ── */
  let older = $state<LedgerEntry[]>([]);
  let exhausted = $state(false);
  const paging = new Pending();
  const entries = $derived([...(balance.data?.entries ?? []), ...older]);
  const more = $derived(!exhausted && (balance.data?.entries.length ?? 0) >= PAGE);

  function loadMore() {
    void paging.run(async () => {
      const last = entries.at(-1);
      if (!last) return;
      try {
        const page = await walletApi.balance({ before: last.id, limit: PAGE });
        older = [...older, ...page.entries];
        if (page.entries.length < PAGE) exhausted = true;
      } catch (e) {
        toast.error(errorText(e));
      }
    });
  }

  function refresh() {
    older = [];
    exhausted = false;
    balance.reload();
    withdrawals.reload();
  }

  /* ── 提现 ── */
  const pending = $derived((withdrawals.data ?? []).filter((w) => w.status === 'pending'));
  const pendingCents = $derived(pending.reduce((n, w) => n + w.amount_cents, 0));
  const withdrawable = $derived(balance.data?.withdrawable_cents ?? 0);
  const min = $derived(invite.data?.min_withdrawal_cents ?? 0);
  const chains = $derived(invite.data?.usdt_chains ?? []);
  let dialogOpen = $state(false);
  let dialogLoaded = $state(false);
  const cancelling = new Pending();

  function openDialog() {
    dialogLoaded = true;
    dialogOpen = true;
  }

  function cancel(id: string) {
    void cancelling.run(async () => {
      try {
        await walletApi.cancelWithdrawal(id);
        toast.success(t('提现申请已撤回'), { description: t('金额已退回余额') });
      } catch (e) {
        toast.error(errorText(e));
      }
      refresh();
    });
  }

  /* 按钮置灰时说清楚为什么（只说一条，按优先级）；否则说明打款方式 */
  const why = $derived(
    pending.length > 0 ? t('同一时间只能有一笔待审核的提现申请。')
      : invite.data && chains.length === 0 ? t('暂未开放提现。')
      : balance.data && withdrawable <= 0 ? t('现在没有可提现的金额：佣金过了冻结期才能提现。')
      : t('提现以 USDT 打款到你填写的链上地址。'),
  );

  const title = full ? t('邀请') : t('钱包');
  const sub = full
    ? t('把邀请链接发给需要的人，对方付费后你按比例拿佣金。佣金进入账户余额，可以抵扣订单或提现为 USDT。')
    : t('账户余额与收支流水。余额可以在下单时抵扣。');
</script>

<div class="ph">
  <div>
    <h1>{title}</h1>
    <p>{sub}</p>
  </div>
</div>

{#if balance.loading && !balance.data}
  <Loading rows={5} height={280} />
{:else if balance.error && !balance.data}
  <LoadError error={balance.error} onretry={balance.reload} />
{:else}
  {@const cents = balance.data?.balance_cents ?? 0}
  <div class={full ? 'cols over' : 'over'}>
    <section class="sec" aria-labelledby="h-balance">
      <div class="sh">
        <div>
          <h2 id="h-balance">{t('账户余额')}</h2>
          <p>{t('下单时可以选择抵扣')}</p>
        </div>
      </div>
      <div class="big num">{cents < 0 ? '−' : ''}<span class="ccy">¥</span>{yuan(Math.abs(cents), { always2: true })}</div>
      <dl class="mini">
        <div><dt>{t('可提现')}</dt><dd>{formatMoney(withdrawable)}</dd></div>
        {#if full}<div><dt>{t('审核中')}</dt><dd>{formatMoney(pendingCents)}</dd></div>{/if}
        {#if min > 0}<div><dt>{t('最低提现')}</dt><dd>{formatMoney(min)}</dd></div>{/if}
      </dl>
      {#if full}
        <div class="wd">
          <button type="button" class="btn pri" disabled={withdrawable <= 0 || pending.length > 0 || chains.length === 0} onclick={openDialog}>
            <ArrowDownToLine size={15} strokeWidth={1.75} aria-hidden="true" />{t('申请提现')}
          </button>
          <p>{why}</p>
        </div>
      {/if}
    </section>
    {#if full}<InviteLink {codes} {invite} />{/if}
  </div>

  <section class="sec tabs-sec">
    {#if TABS.length > 1}
      <div class="ptabs" role="tablist" aria-label={title}>
        {#each TABS as x (x.id)}
          <button
            type="button" role="tab" id="tab-{x.id}" aria-controls="panel-{x.id}" aria-selected={tab === x.id}
            tabindex={tab === x.id ? 0 : -1} onclick={() => setTab(x.id)} onkeydown={tabKey}
          >{t(x.label)}</button>
        {/each}
      </div>
    {:else}
      <div class="sh"><div><h2>{t('收支流水')}</h2></div></div>
    {/if}
    <div role={TABS.length > 1 ? 'tabpanel' : undefined} id="panel-{tab}" aria-labelledby={TABS.length > 1 ? `tab-${tab}` : undefined}>
      {#if tab === 'invite'}
        <InviteDetails {codes} {invite} narrow={narrow.current} />
      {:else if tab === 'ledger'}
        <Ledger {entries} {more} busy={paging.busy} onmore={loadMore} narrow={narrow.current} />
      {:else}
        <Withdrawals {withdrawals} cancelling={cancelling.busy} oncancel={cancel} narrow={narrow.current} />
      {/if}
    </div>
  </section>
{/if}

{#if dialogLoaded}
  {#await import('../components/wallet/WithdrawDialog.svelte') then m}
    <m.default bind:open={dialogOpen} invite={invite.data} {withdrawable} onsent={refresh} />
  {/await}
{/if}

<style>
  .over > :global(.sec) { border-top: 0; padding-top: 4px; }
  .big {
    display: flex; align-items: baseline; color: var(--fg); font-size: 34px; line-height: 40px; font-weight: 600; letter-spacing: -.02em; white-space: nowrap;
  }
  .big .ccy { margin-right: 2px; font-size: 20px; }
  .mini { margin-top: 20px; }
  .wd { margin-top: 24px; }
  .wd .btn { height: 40px; padding: 0 18px; }
  .wd p { margin-top: 10px; font-size: 12.5px; line-height: 1.7; color: var(--muted); }
  .tabs-sec { padding-top: 24px; }
  @media (max-width: 960px) {
    .over > :global(.sec + .sec) { border-top: 1px solid var(--line); padding-top: 28px; }
  }
  @media (max-width: 720px) {
    .big { font-size: 34px; }
  }
</style>
