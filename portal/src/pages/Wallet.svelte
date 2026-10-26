<script lang="ts">
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import Share2 from '@lucide/svelte/icons/share-2';
  import WalletIcon from '@lucide/svelte/icons/wallet';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import PaneHead from '../components/flat/PaneHead.svelte';
  import Section from '../components/flat/Section.svelte';
  import Split from '../components/flat/Split.svelte';
  import Tabs from '../components/flat/Tabs.svelte';
  import { inviteApi, walletApi, type LedgerEntry } from '@/api';
  import { K } from '@/lib/cache';
  import { formatMoney } from '@/lib/format';
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
  const sub = $derived(full
    ? t('把邀请链接发给需要的人，对方付费后你按比例拿佣金。佣金进入账户余额，可以抵扣订单或提现为 USDT。')
    : t('账户余额与收支流水。余额可以在下单时抵扣。'));
</script>

{#snippet balancePane()}
  {@const cents = balance.data?.balance_cents ?? 0}
  <PaneHead>
    {#snippet title()}<WalletIcon size={16} strokeWidth={1.75} aria-hidden="true" />{t('账户余额')}{/snippet}
    {#snippet desc()}{t('下单时可以选择抵扣')}{/snippet}
  </PaneHead>
  <div class="stat-v">{formatMoney(cents)}</div>
  <dl class="mini-stats" style="margin-top: 20px">
    <div><dt>{t('可提现')}</dt><dd>{formatMoney(withdrawable)}</dd></div>
    {#if full}<div><dt>{t('审核中')}</dt><dd>{formatMoney(pendingCents)}</dd></div>{/if}
    {#if min > 0}<div><dt>{t('最低提现')}</dt><dd>{formatMoney(min)}</dd></div>{/if}
  </dl>
  {#if full}
    <div style="margin-top: 24px">
      <button type="button" class="btn pri wd-btn" disabled={withdrawable <= 0 || pending.length > 0 || chains.length === 0} onclick={openDialog}>
        <ArrowDownToLine size={16} strokeWidth={1.75} aria-hidden="true" />{t('申请提现')}
      </button>
      <!-- 按钮置灰时说清楚为什么（只说一条，按优先级）；否则说明打款方式 -->
      <p class="wd-why">{why}</p>
    </div>
  {/if}
{/snippet}

<PageTitle {title} {sub} />

{#if balance.loading && !balance.data}
  <Loading />
{:else if balance.error && !balance.data}
  <LoadError error={balance.error} onretry={balance.reload} />
{:else}
  <Section>
    {#if full}
      <Split left={balancePane}>
        {#snippet right()}
          <PaneHead>
            {#snippet title()}<Share2 size={16} strokeWidth={1.75} aria-hidden="true" />{t('你的邀请链接')}{/snippet}
            {#snippet desc()}{t('通过链接注册的人会记在你名下')}{/snippet}
          </PaneHead>
          <InviteLink {codes} {invite} />
        {/snippet}
      </Split>
    {:else}
      {@render balancePane()}
    {/if}
  </Section>

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
  {#await import('../components/wallet/WithdrawDialog.svelte') then m}
    <m.default bind:open={dialogOpen} invite={invite.data} {withdrawable} onsent={refresh} />
  {/await}
{/if}
