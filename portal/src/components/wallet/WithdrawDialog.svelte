<script lang="ts">
  import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { walletApi, type MyInvite, type UsdtChain } from '@/api';
  import { formatMoney, parseYuan } from '@/lib/format';
  import TextField from '../TextField.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { errorText } from '$lib/errors';
  import { FieldErrors, Pending, fieldOf } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { toast } from '$lib/toast.svelte';
  import { ADDRESS_HINT, usdtEstimate } from '$lib/wallet';

  /*
   * 申请提现（第一次点「申请提现」时才下载这里与 bits-ui；同 React 门户 wallet.tsx 的 FlowDialog）：金额（元）、USDT 网络（只列后台开着的）、
   * 收款地址（按网络给格式提示）、TON 的 Memo（选填）。novalidate + 内联错误：提交时逐项检查，第一个出错的字段被聚焦，按钮不预先置灰；
   * 面板的错误码能对上字段的画在字段下面，其余用提示条。提交成功：关闭、清空、提示，页面刷新余额与记录（onsent）。
   * 关掉再打开时保留填了一半的内容（组件第一次打开后一直挂着），错误清掉。
   */
  let { open = $bindable(false), invite, withdrawable, onsent }: {
    open?: boolean;
    invite: MyInvite | undefined;
    withdrawable: number;
    onsent: () => void;
  } = $props();

  let amount = $state('');
  let picked = $state<UsdtChain | null>(null);
  let address = $state('');
  let memo = $state('');
  const busy = new Pending();
  const f = new FieldErrors(['amount', 'address', 'memo'] as const);

  const chains = $derived(invite?.usdt_chains ?? []);
  const chain = $derived(picked && chains.some((c) => c.id === picked) ? picked : chains[0]?.id ?? null);
  const cents = $derived(parseYuan(amount));
  const min = $derived(invite?.min_withdrawal_cents ?? 0);
  const estimate = $derived(cents !== null && cents > 0 && cents <= withdrawable ? usdtEstimate(cents, invite?.usdt_rate_cents) : null);
  const help = $derived(estimate
    ? tp('约 {v} USDT（按参考汇率，以实际打款为准）', { v: estimate })
    : min > 0 ? tp('可提现 {v}，最低 {m}', { v: formatMoney(withdrawable), m: formatMoney(min) }) : tp('可提现 {v}', { v: formatMoney(withdrawable) }));

  $effect(() => {
    if (open) f.check({});
  });

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const ok = f.check({
      amount: !amount.trim() ? t('请输入提现金额')
        : !cents ? t('请输入正确的金额，最多两位小数')
        : cents > withdrawable ? tp('超过了可提现金额（{v}）', { v: formatMoney(withdrawable) })
        : min > 0 && cents < min ? tp('最低提现 {v}', { v: formatMoney(min) })
        : undefined,
      address: !address.trim() && t('请输入收款地址'),
    });
    if (!ok || !cents || !chain) return;
    const net = chain;
    void busy.run(async () => {
      try {
        await walletApi.withdraw({
          amount_cents: cents, chain: net, address: address.trim(),
          ...(net === 'ton' && memo.trim() ? { memo: memo.trim() } : {}),
        });
        open = false;
        amount = '';
        address = '';
        memo = '';
        toast.success(t('提现申请已提交'), { description: t('金额已从余额扣除，审核通过后以 USDT 打款；撤回或驳回会退回余额') });
        onsent();
      } catch (err) {
        const k = fieldOf(err, {
          'withdrawal.amount_range': 'amount', 'withdrawal.below_minimum': 'amount', 'withdrawal.exceeds': 'amount',
          'balance.insufficient': 'amount', 'withdrawal.address_invalid': 'address',
          'withdrawal.memo_invalid': 'memo', 'withdrawal.memo_unexpected': 'memo',
        } as const);
        if (k) f.set(k, errorText(err));
        else toast.error(errorText(err));
      }
    });
  }
</script>

<Dialog bind:open title={t('申请提现')} description={t('提交后金额立即从余额扣除，管理员核对后以 USDT 打款到你的地址')}>
  {#snippet icon()}<ArrowDownToLine class="dlg-icon" size={20} strokeWidth={1.5} aria-hidden="true" />{/snippet}
  <form id="withdraw-form" class="form" novalidate onsubmit={submit}>
    <TextField
      {...f.field('amount', 'w-amount')}
      label={t('提现金额（元）')} inputmode="decimal" autocomplete="off" placeholder="0.00"
      bind:value={amount} {help}
    />
    <div class="field">
      <div class="field-label"><label for="w-chain">{t('USDT 网络')}</label></div>
      <div class="select">
        <select id="w-chain" class="input" aria-describedby="w-chain-msg" value={chain ?? ''} onchange={(e) => (picked = e.currentTarget.value as UsdtChain)}>
          {#each chains as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
        </select>
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" />
      </div>
      <p id="w-chain-msg" class="field-msg">{t('网络选错资金无法找回：请和收款方（钱包或交易所充值页）显示的网络保持一致。')}</p>
    </div>
    <TextField
      {...f.field('address', 'w-address')}
      label={t('收款地址')} maxlength={200} spellcheck={false} autocomplete="off" class="mono-in"
      bind:value={address}
      placeholder={chain ? ADDRESS_HINT[chain].placeholder : ''}
      help={chain ? t(ADDRESS_HINT[chain].hint) : undefined}
    />
    {#if chain === 'ton'}
      <TextField
        {...f.field('memo', 'w-memo')}
        label={t('Memo（选填）')} maxlength={120} spellcheck={false} autocomplete="off"
        bind:value={memo}
      />
    {/if}
  </form>
  {#snippet footer()}
    <div class="flow-sum">{t('可提现')} <b class="tnum" style="font-size: 15px; font-weight: 400; color: var(--fg)">{formatMoney(withdrawable)}</b></div>
    <div class="flow-btns">
      <button type="button" class="btn" onclick={() => (open = false)}>{t('取消')}</button>
      <button type="submit" form="withdraw-form" class="btn pri" disabled={busy.busy}>{busy.busy ? t('提交中') : t('提交申请')}</button>
    </div>
  {/snippet}
</Dialog>

<style>
  .select { position: relative; color: var(--faint); }
  .select select { appearance: none; padding-right: 36px; color: var(--fg); cursor: pointer; }
  .select :global(svg) { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; }
  :global(.dlg .mono-in) { font-family: var(--font-mono); font-size: 13px; }
</style>
