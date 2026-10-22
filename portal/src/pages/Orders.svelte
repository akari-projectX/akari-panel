<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { orderApi, walletApi, type MyOrder } from '@/api';
  import { K } from '@/lib/cache';
  import { ORDER_ACTION, formatDateTime, formatMoney, orderState, periodText, yuan } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';
  import { toneClass } from '$lib/shop';
  import { toast } from '$lib/toast.svelte';

  /*
   * 我的订单（行为同 React 门户 pages/dash/orders.tsx；没有样稿，按 dashboard / shop 的语言：页头 → 四个关键数字 →
   * 文字筛选 → 宽屏细线表格、窄屏一行一笔（点整行进详情））。面板给最近 50 笔，筛选只在前端做。
   */
  const TABS: { key: string; label: string; test: (o: MyOrder) => boolean }[] = [
    { key: 'all', label: '全部', test: () => true },
    { key: 'pending', label: '待支付', test: (o) => o.status === 'pending' },
    { key: 'paid', label: '已付款', test: (o) => o.status === 'paid' && !o.refunded_at },
    { key: 'refunded', label: '已退款', test: (o) => !!o.refunded_at },
    { key: 'closed', label: '已关闭', test: (o) => o.status === 'expired' || o.status === 'cancelled' },
  ];

  /** 实际付过、没退款的（含余额支付的部分） */
  const spent = (o: MyOrder) => (o.status === 'paid' && !o.refunded_at ? o.amount_cents + o.balance_cents : 0);

  let tab = $state('all');
  const orders = resource(() => ({ key: K.orders, fetch: () => orderApi.list() }));
  const balance = resource(() => ({ key: K.balance, fetch: () => walletApi.balance({ limit: 1 }) }));
  const cancelling = new Pending();

  const all = $derived(orders.data ?? []);
  const list = $derived(all.filter((TABS.find((x) => x.key === tab) ?? TABS[0]).test));
  const paidTotal = $derived(all.reduce((n, o) => n + spent(o), 0));
  const pendingCount = $derived(all.filter((o) => o.status === 'pending').length);
  const last = $derived(all[0]);

  function cancel(o: MyOrder) {
    void cancelling.run(async () => {
      try {
        await orderApi.cancel(o.id);
        toast.success(t('订单已取消'));
      } catch (e) {
        toast.error(errorText(e));
      } finally {
        orders.reload();
      }
    });
  }

  const typeText = (o: MyOrder) => t(ORDER_ACTION[o.action]);
</script>

<div class="ph">
  <div>
    <h1>{t('我的订单')}</h1>
    <p>{t('全部消费记录与支付状态。')}</p>
  </div>
  <a class="link" href={R.shop}>{t('去选套餐')}<ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /></a>
</div>

<section class="stats" aria-label={t('订单概况')}>
  <div>
    <div class="lb">{t('累计消费')}</div>
    <div class="v num"><span class="ccy">¥</span>{yuan(paidTotal, { always2: true })}</div>
    <div class="sub">{t('已付款、未退款的订单（含余额支付）')}</div>
  </div>
  <div>
    <div class="lb">{t('订单总数')}</div>
    <div class="v num">{all.length}<small>{t(' 笔')}</small></div>
    <div class="sub num">{last ? tp('最近一笔 {d}', { d: formatDateTime(last.created_at) }) : t('还没有下过单')}</div>
  </div>
  <div>
    <div class="lb">{t('待支付')}</div>
    <div class="v num">{pendingCount}<small>{t(' 笔')}</small></div>
    <div class="sub">{t('超时未支付将自动关闭')}</div>
  </div>
  <div>
    <div class="lb">{t('账户余额')}</div>
    <div class="v num">{#if balance.data}<span class="ccy">¥</span>{yuan(balance.data.balance_cents, { always2: true })}{:else}—{/if}</div>
    <div class="sub">{t('下单时可以选择抵扣')}</div>
  </div>
</section>

<section class="sec" aria-labelledby="h-orders">
  <div class="sh">
    <div>
      <h2 id="h-orders">{t('订单记录')}</h2>
      {#if list.length}<p>{tp('共 {n} 笔订单', { n: list.length })}</p>{/if}
    </div>
  </div>

  <div class="filters" role="group" aria-label={t('按状态筛选')}>
    {#each TABS as x (x.key)}
      <button type="button" aria-pressed={tab === x.key} onclick={() => (tab = x.key)}>{t(x.label)}</button>
    {/each}
  </div>

  {#if !orders.data && orders.loading}
    <Loading rows={5} />
  {:else if !orders.data && orders.error}
    <LoadError error={orders.error} onretry={orders.reload} />
  {:else if list.length === 0}
    <Empty title={t('这里还没有订单')} desc={t('选一个套餐下单后，记录会出现在这里。')}>
      {#snippet action()}<a class="btn sm" href={R.shop}>{t('去选套餐')}</a>{/snippet}
    </Empty>
  {:else}
    <!-- 窄屏：八列的表放不下，一行一笔订单，点整行进详情 -->
    <div class="rows list">
      {#each list as o (o.id)}
        {@const st = orderState(o)}
        <a class="li" href={R.order(o.id)}>
          <div class="main">
            <div class="t"><span>{o.plan_name}</span></div>
            <div class="s num">{[typeText(o), periodText(o.period, o.period_days, t, tp), formatDateTime(o.created_at)].join(' · ')}</div>
          </div>
          <div class="end">
            <b class="num">{formatMoney(o.amount_cents)}</b>
            <span class={toneClass(st.tone)}>{t(st.text)}</span>
          </div>
        </a>
      {/each}
    </div>
    <div class="tbl">
      <table>
        <thead>
          <tr>
            <th>{t('订单号')}</th><th>{t('套餐')}</th><th>{t('类型')}</th><th>{t('周期')}</th>
            <th class="r">{t('金额')}</th><th>{t('状态')}</th><th>{t('下单时间')}</th><th class="r">{t('操作')}</th>
          </tr>
        </thead>
        <tbody>
          {#each list as o (o.id)}
            {@const st = orderState(o)}
            <tr>
              <td><code>{o.out_trade_no}</code></td>
              <td class="plan" title={o.plan_name}>{o.plan_name}</td>
              <td>{typeText(o)}</td>
              <td>{periodText(o.period, o.period_days, t, tp)}</td>
              <td class="r num amt">{formatMoney(o.amount_cents)}</td>
              <td><span class={toneClass(st.tone)}>{t(st.text)}</span></td>
              <td class="num muted">{formatDateTime(o.created_at)}</td>
              <td class="r acts">
                <a class="link" href={R.order(o.id)}>{o.status === 'pending' ? t('去支付') : t('详情')}</a>
                {#if o.status === 'pending'}
                  <button type="button" class="link quiet-link" disabled={cancelling.busy} onclick={() => cancel(o)}>{t('取消')}</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .ph .link { margin-bottom: 4px; }
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 4px 0 32px; }
  .stats > div { min-width: 0; padding: 0 28px; border-left: 1px solid var(--line); }
  .stats > div:first-child { padding-left: 0; border-left: 0; }
  .lb { font-size: 13px; color: var(--muted); }
  .v { display: flex; align-items: baseline; gap: 4px; margin-top: 6px; font-size: 28px; line-height: 36px; font-weight: 600; letter-spacing: -.02em; color: var(--fg); white-space: nowrap; }
  .v small { font-size: 14px; font-weight: 500; letter-spacing: 0; color: var(--muted); }
  .v .ccy { margin-right: 1px; font-size: 18px; }
  .sub { margin-top: 6px; font-size: 12.5px; color: var(--muted); }

  .filters { display: flex; flex-wrap: wrap; gap: 4px 24px; margin-bottom: 8px; border-bottom: 1px solid var(--line); }
  .filters button { position: relative; padding: 0 0 10px; border: 0; border-radius: 0; background: none; color: var(--muted); font: inherit; font-size: 13.5px; }
  .filters button:hover { color: var(--fg); }
  .filters button[aria-pressed='true'] { color: var(--fg); font-weight: 600; }
  .filters button[aria-pressed='true']::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--brand); }

  .rows { display: none; border-top: 0; }
  .li .end { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
  .li .end b { font-size: 15px; font-weight: 500; color: var(--fg); }

  .tbl { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  th { padding: 12px 12px 10px; border-bottom: 1px solid var(--line); font-size: 12.5px; font-weight: 500; color: var(--faint); text-align: left; white-space: nowrap; }
  td { padding: 13px 12px; border-bottom: 1px solid var(--line); color: var(--body); white-space: nowrap; }
  th:first-child, td:first-child { padding-left: 0; }
  th:last-child, td:last-child { padding-right: 0; }
  tbody tr:hover td { background: var(--hover); }
  .r { text-align: right; }
  code { font-family: var(--font-mono); font-size: 12.5px; color: var(--fg); }
  .plan { max-width: 220px; overflow: hidden; text-overflow: ellipsis; color: var(--fg); font-weight: 500; }
  .amt { font-weight: 500; color: var(--fg); }
  .muted { color: var(--muted); }
  .acts { display: flex; justify-content: flex-end; gap: 14px; }

  @media (max-width: 960px) {
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 0; }
    .stats > div:nth-child(3) { padding-left: 0; border-left: 0; }
  }
  @media (max-width: 720px) {
    .rows { display: block; }
    .tbl { display: none; }
    .v { font-size: 22px; line-height: 28px; }
    .stats > div { padding: 0 0 0 16px; }
    .sub { font-size: 12px; }
  }
</style>
