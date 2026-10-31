<script lang="ts">
  import { orderApi, type MyOrder } from '@/api';
  import { K } from '@/lib/cache';
  import { ORDER_ACTION, formatDateTime, formatMoney, orderState, periodText } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Row from '../components/flat/Row.svelte';
  import Tabs from '../components/flat/Tabs.svelte';
  import { navigate } from '$lib/router.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 我的订单（外观 A）：页头一句（几笔等待支付 / 共几笔）→ 状态筛选（胶囊）→ 宽屏细线表格（订单号、项目、时间、状态点、金额、
   * 待支付的「支付」/ 其余「详情」）、窄屏一行一笔（点整行进详情）。面板给最近 50 笔，筛选只在前端做。
   */
  const TABS: { key: string; label: string; test: (o: MyOrder) => boolean }[] = [
    { key: 'all', label: '全部', test: () => true },
    { key: 'pending', label: '待支付', test: (o) => o.status === 'pending' },
    { key: 'paid', label: '已付款', test: (o) => o.status === 'paid' && !o.refunded_at },
    { key: 'refunded', label: '已退款', test: (o) => !!o.refunded_at },
    { key: 'closed', label: '已关闭', test: (o) => o.status === 'expired' || o.status === 'cancelled' },
  ];

  let tab = $state('all');
  const orders = resource(() => ({ key: K.orders, fetch: () => orderApi.list() }));
  const cancelling = new Pending();

  const all = $derived(orders.data ?? []);
  const list = $derived(all.filter((TABS.find((x) => x.key === tab) ?? TABS[0]).test));
  const pendingCount = $derived(all.filter((o) => o.status === 'pending').length);

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

<PageTitle title={t('账单')} lead={orders.data ? (pendingCount ? tp('{n} 笔订单等待支付', { n: pendingCount }) : all.length ? tp('共 {n} 笔订单', { n: all.length }) : t('还没有订单')) : undefined} />

<div class="or-bar">
  <Tabs inline label={t('按状态筛选')} value={tab} onchange={(k) => (tab = k)} tabs={TABS.map((x) => ({ key: x.key, label: t(x.label) }))} />
</div>

<div class="or-list">
  {#if !orders.data && orders.loading}
    <Loading />
  {:else if !orders.data && orders.error}
    <LoadError error={orders.error} onretry={orders.reload} />
  {:else if list.length === 0}
    <Empty title={t('这里还没有订单')} desc={t('选一个套餐下单后，记录会出现在这里。')}>
      {#snippet action()}<button type="button" class="btn sm" onclick={() => navigate(R.shop)}>{t('去选套餐')}</button>{/snippet}
    </Empty>
  {:else}
    <!-- 窄屏：表格放不下，改成一行一笔订单，点整行进详情 -->
    <div class="md-hide">
      {#each list as o, i (o.id)}
        {@const st = orderState(o)}
        <Row first={i === 0} onclick={() => navigate(R.order(o.id))}>
          {#snippet title()}{o.plan_name}{/snippet}
          {#snippet desc()}{[typeText(o), periodText(o.period, o.period_days, t, tp), formatDateTime(o.created_at)].filter(Boolean).join(' · ')}{/snippet}
          {#snippet extra()}
            <span class="oend">
              <span class="tnum" style="font-size: 15px; font-weight: var(--fw-strong)">{formatMoney(o.amount_cents)}</span>
              <span class={['sdot', st.tone]}><i></i>{t(st.text)}</span>
            </span>
          {/snippet}
        </Row>
      {/each}
    </div>
    <div class="md-only tbl-w">
      <table class="tbl flat-head">
        <thead>
          <tr>
            <th style="width: 200px">{t('订单号')}</th><th>{t('项目')}</th><th style="width: 160px">{t('时间')}</th>
            <th style="width: 120px">{t('状态')}</th><th class="r" style="width: 112px">{t('金额')}</th><th class="r" style="width: 136px"><span class="sr-only">{t('操作')}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each list as o (o.id)}
            {@const st = orderState(o)}
            <tr>
              <td><code class="or-no">{o.out_trade_no}</code></td>
              <td>{o.plan_name}<span class="or-sub">{[typeText(o), periodText(o.period, o.period_days, t, tp)].filter(Boolean).join(' · ')}</span></td>
              <td class="tnum or-mu">{formatDateTime(o.created_at)}</td>
              <td><span class={['sdot', st.tone]}><i></i>{t(st.text)}</span></td>
              <td class={['tnum r', o.refunded_at ? 'or-mu' : 'or-amt']}>{formatMoney(o.amount_cents)}</td>
              <td class="r">
                {#if o.status === 'pending'}
                  <button type="button" class="btn link-btn or-cancel" disabled={cancelling.busy} onclick={() => cancel(o)}>{t('取消')}</button>
                  <a class="btn pri sm" href={R.order(o.id)}>{t('去支付')}</a>
                {:else}
                  <a class="or-go" href={R.order(o.id)}>{t('详情')}</a>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .oend { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
  .or-bar { margin-top: 32px; }
  .or-list { margin-top: 20px; border-top: 1px solid var(--line); }
  .or-no { font-size: 12.5px; color: var(--muted); }
  .or-sub { margin-left: 8px; font-size: 12.5px; color: var(--muted); }
  .or-mu { color: var(--muted); font-size: 13.5px; }
  .or-amt { font-weight: var(--fw-strong); }
  .or-go { font-size: 13.5px; font-weight: var(--fw-strong); color: var(--brand); }
  .or-go:hover { text-decoration: underline; text-underline-offset: 3px; }
  .or-cancel { margin-right: 4px; }
</style>
