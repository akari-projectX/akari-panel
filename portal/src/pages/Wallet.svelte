<script module lang="ts">
  const Withdraw = () => import('../components/wallet/WithdrawDialog.svelte');
</script>

<script lang="ts">
  import '../styles/pages/wallet.css';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Section from '../components/flat/Section.svelte';
  import StatRow, { type Stat } from '../components/flat/StatRow.svelte';
  import Tabs from '../components/flat/Tabs.svelte';
  import { inviteApi, walletApi, type LedgerEntry } from '@/api';
  import { K } from '@/lib/cache';
  import { formatMoney, formatMonthDay, signedMoney } from '@/lib/format';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import InviteDetails from '../components/wallet/InviteDetails.svelte';
  import InviteLink from '../components/wallet/InviteLink.svelte';
  import Ledger from '../components/wallet/Ledger.svelte';
  import Withdrawals from '../components/wallet/Withdrawals.svelte';
  import { chunk, intent, preloadDialogs } from '$lib/dialogs';
  import { scope } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { loc, navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';
  import { LEDGER_TEXT } from '$lib/wallet';

  /*
   * 邀请与钱包（地址 /wallet，外观 A）。
   * 面板只有一个余额（佣金入账就进余额，下单可以抵扣），其中「可提现」的部分可以申请 USDT 提现；佣金被追回时余额只扣到 0，差额记为欠款。
   *   页头   一句「余额 ¥x」。
   *   三个数 余额、可提现（审核中 / 最低提现）、待结算（冻结中的佣金）。
   *   两栏   左：邀请好友（返佣条款、邀请链接 + 复制、申请提现与置灰原因）；右：余额明细（最近四笔，「全部 →」到收支流水分页）。
   *   分页   邀请返佣（收益、邀请码、返佣明细）/ 收支流水 / 提现记录，地址 ?tab=；full 默认「邀请返佣」，标题「邀请」。
   * 续费范围（过期 / 流量用完）只有流水：面板对它们不开放提现与邀请，这一页就是「钱包」。
   */
  type Tab = 'invite' | 'ledger' | 'withdrawals';
  const PAGE = 30;

  const full = scope() === 'full';

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
  /* 提现对话框第一次打开时才挂载；分包在空闲时与按钮上的意图预载（lib/dialogs） */
  preloadDialogs(Withdraw);
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

  const title = $derived(full ? t('邀请') : t('钱包'));
  const cents = $derived(balance.data?.balance_cents ?? 0);
  const stats = $derived<Stat[]>([
    { k: t('余额'), v: formatMoney(cents), x: t('下单时可以选择抵扣') },
    {
      k: t('可提现'), v: formatMoney(withdrawable),
      x: pendingCents > 0 ? tp('审核中 {v}', { v: formatMoney(pendingCents) }) : min > 0 ? tp('最低提现 {v}', { v: formatMoney(min) }) : t('提现为 USDT'),
    },
    { k: t('待结算'), v: formatMoney(invite.data?.pending_cents ?? 0), x: invite.data ? tp('冻结 {n} 天后入账', { n: invite.data.hold_days }) : '' },
  ]);
  /* 右栏的余额明细：最近四笔 */
  const recent = $derived(entries.slice(0, 4));
</script>

<PageTitle {title} lead={balance.data ? tp('余额 {v}', { v: formatMoney(cents) }) : undefined} />

{#if balance.loading && !balance.data}
  <Loading />
{:else if balance.error && !balance.data}
  <LoadError error={balance.error} onretry={balance.reload} />
{:else}
  {#if full}
    <div class="wl-stats"><StatRow items={stats} /></div>

    <div class="wl-two">
      <section class="wl-pane" aria-labelledby="h-invite">
        <div class="wl-sh"><h2 id="h-invite">{t('邀请好友')}</h2>{#if invite.data?.enabled}<span>{tp('返 {n}% 现金', { n: invite.data.rate_percent })}</span>{/if}</div>
        <InviteLink {codes} {invite} />
        <div class="wl-wd">
          <button type="button" class="btn" disabled={withdrawable <= 0 || pending.length > 0 || chains.length === 0} {@attach intent(Withdraw)} onclick={openDialog}>{t('申请提现')}</button>
          <!-- 按钮置灰时说清楚为什么（只说一条，按优先级）；否则说明打款方式 -->
          <p class="wd-why">{why}</p>
        </div>
      </section>
      <section class="wl-pane" aria-labelledby="h-recent">
        <div class="wl-sh"><h2 id="h-recent">{t('余额明细')}</h2>{#if tab !== 'ledger'}<button type="button" class="wl-all" onclick={() => setTab('ledger')}>{t('全部 →')}</button>{/if}</div>
        {#if recent.length === 0}
          <p class="wl-none">{t('还没有收支记录')}</p>
        {:else}
          <ul class="wl-list">
            {#each recent as e (e.id)}
              <li>
                <span class="tnum wl-d">{formatMonthDay(e.created_at)}</span>
                <span class="wl-k">{t(LEDGER_TEXT[e.kind])}{#if e.out_trade_no ?? e.reason}<small>{' · '}{e.out_trade_no ?? e.reason}</small>{/if}</span>
                <span class={['tnum wl-a', e.amount_cents < 0 ? 'neg' : 'pos']}>{signedMoney(e.amount_cents)}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}

  <Section>
    {#if TABS.length > 1}
      <Tabs mb7 px3 label={title} value={tab} onchange={(k) => setTab(k as Tab)} tabs={TABS.map((x) => ({ key: x.id, label: t(x.label) }))} />
    {/if}
    <div class="tp-sm" role={TABS.length > 1 ? 'tabpanel' : undefined} id="panel-{tab}" aria-labelledby={TABS.length > 1 ? `tab-${tab}` : undefined}>
      {#if tab === 'invite'}
        <InviteDetails {codes} {invite} />
      {:else if tab === 'ledger'}
        <Ledger {entries} {more} busy={paging.busy} onmore={loadMore} />
      {:else}
        <Withdrawals {withdrawals} cancelling={cancelling.busy} oncancel={cancel} />
      {/if}
    </div>
  </Section>
{/if}

{#if dialogLoaded}
  {#await chunk(Withdraw) then m}
    <m.default bind:open={dialogOpen} invite={invite.data} {withdrawable} onsent={refresh} />
  {/await}
{/if}
