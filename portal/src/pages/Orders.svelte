<script lang="ts">
  import { orderApi, walletApi, type MyOrder } from '@/api';
  import { K } from '@/lib/cache';
  import { ORDER_ACTION, formatDateTime, formatMoney, orderState, periodText } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Row from '../components/flat/Row.svelte';
  import Section from '../components/flat/Section.svelte';
  import StatRow from '../components/flat/StatRow.svelte';
  import Tabs from '../components/flat/Tabs.svelte';
  import { navigate } from '$lib/router.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';
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

<PageTitle title={t('我的订单')} sub={t('全部消费记录与支付状态。')} />

<Section>
  <StatRow items={[
    { k: t('累计消费'), v: formatMoney(paidTotal), x: t('已付款、未退款的订单（含余额支付）') },
    { k: t('订单总数'), v: String(all.length), unit: t(' 笔').trim(), x: last ? tp('最近一笔 {d}', { d: formatDateTime(last.created_at) }) : t('还没有下过单') },
    { k: t('待支付'), v: String(pendingCount), unit: t(' 笔').trim(), x: t('超时未支付将自动关闭') },
    { k: t('账户余额'), v: balance.data ? formatMoney(balance.data.balance_cents) : '—', x: t('下单时可以选择抵扣') },
  ]} />
</Section>

<Section>
  {#snippet title()}{t('订单记录')}{/snippet}
  {#snippet desc()}{#if list.length}{tp('共 {n} 笔订单', { n: list.length })}{/if}{/snippet}
  <Tabs mb inline label={t('按状态筛选')} value={tab} onchange={(k) => (tab = k)} tabs={TABS.map((x) => ({ key: x.key, label: t(x.label) }))} />

  {#if !orders.data && orders.loading}
    <Loading />
  {:else if !orders.data && orders.error}
    <LoadError error={orders.error} onretry={orders.reload} />
  {:else if list.length === 0}
    <Empty title={t('这里还没有订单')} desc={t('选一个套餐下单后，记录会出现在这里。')}>
      {#snippet action()}<button type="button" class="btn sm" onclick={() => navigate(R.shop)}>{t('去选套餐')}</button>{/snippet}
    </Empty>
  {:else}
    <!-- 窄屏：八列的表放不下，改成一行一笔订单，点整行进详情 -->
    <div class="md-hide">
      {#each list as o, i (o.id)}
        {@const st = orderState(o)}
        <Row first={i === 0} onclick={() => navigate(R.order(o.id))}>
          {#snippet title()}{o.plan_name}{/snippet}
          {#snippet desc()}{[typeText(o), periodText(o.period, o.period_days, t, tp), formatDateTime(o.created_at)].filter(Boolean).join(' · ')}{/snippet}
          {#snippet extra()}
            <span class="oend">
              <span class="tnum" style="font-size: 15px; font-weight: 500">{formatMoney(o.amount_cents)}</span>
              <span class={['bdg', st.tone]}>{t(st.text)}</span>
            </span>
          {/snippet}
        </Row>
      {/each}
    </div>
    <div class="md-only tbl-w">
      <table class="tbl flat-head">
        <thead>
          <tr>
            <th style="min-width: 180px">{t('订单号')}</th><th style="width: 128px">{t('套餐')}</th><th style="width: 112px">{t('类型')}</th><th style="width: 112px">{t('周期')}</th>
            <th style="width: 96px">{t('金额')}</th><th style="width: 96px">{t('状态')}</th><th style="width: 160px">{t('下单时间')}</th><th class="r" style="width: 128px">{t('操作')}</th>
          </tr>
        </thead>
        <tbody>
          {#each list as o (o.id)}
            {@const st = orderState(o)}
            <tr>
              <td><code>{o.out_trade_no}</code></td>
              <td><span class="bdg brandbadge trunc" title={o.plan_name}><span>{o.plan_name}</span></span></td>
              <td style="font-size: 14px">{typeText(o)}</td>
              <td style="font-size: 14px">{periodText(o.period, o.period_days, t, tp)}</td>
              <td class="tnum" style="font-weight: 500">{formatMoney(o.amount_cents)}</td>
              <td><span class={['bdg', st.tone]}>{t(st.text)}</span></td>
              <td class="tnum" style="color: var(--muted); font-size: 14px">{formatDateTime(o.created_at)}</td>
              <td class="r">
                <a class="btn link-btn" href={R.order(o.id)}>{o.status === 'pending' ? t('去支付') : t('详情')}</a>
                {#if o.status === 'pending'}
                  <button type="button" class="btn link-btn" disabled={cancelling.busy} onclick={() => cancel(o)}>{t('取消')}</button>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</Section>

<style>
  .oend { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
</style>
