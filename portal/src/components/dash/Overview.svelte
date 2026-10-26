<script lang="ts">
  import { contentApi, meApi, orderApi, ticketApi, walletApi, type Announcement, type Announcements } from '@/api';
  import { summarize } from '@/lib/content-text';
  import { K } from '@/lib/cache';
  import { addDays, daysLeft, formatBytes, formatDate, formatMoney, fromNow, siteToday, trafficUsage } from '@/lib/format';
  import { trafficDays } from '@/lib/traffic';
  import { NODES_REFRESH_MS } from '@/lib/node';
  import TrendingUp from '@lucide/svelte/icons/trending-up';
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import PageTitle from '../flat/PageTitle.svelte';
  import PaneHead from '../flat/PaneHead.svelte';
  import Row from '../flat/Row.svelte';
  import Pin from '@lucide/svelte/icons/pin';
  import Section from '../flat/Section.svelte';
  import Split from '../flat/Split.svelte';
  import StatRow, { type Stat } from '../flat/StatRow.svelte';
  import WeekChart from './WeekChart.svelte';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import Access from './Access.svelte';
  import DocsPreview from './DocsPreview.svelte';
  import NodesPreview from './NodesPreview.svelte';
  import Notices from './Notices.svelte';
  import { announcementText } from '$lib/announcement';
  import { att } from '$lib/attention.svelte';
  import { auth } from '$lib/auth.svelte';
  import { i18n, t, tp } from '$lib/i18n.svelte';
  import { autoReload, resource } from '$lib/resource.svelte';
  import { loc } from '$lib/router.svelte';
  import { R } from '$lib/routes';

  /*
   * 仪表盘（full / renewal 范围；banned 是 Banned.svelte）。数据、缓存键、分支与 React 门户 pages/dash/dashboard.tsx 相同，
   * 结构按样稿 design/portal-v2-2026-10/dashboard.html：页头（套餐 · 重置周期）→ 最新未读公告横幅 → 提醒细行 →
   * 四个关键数字 → 流量走势（7 / 30 天）→ 接入配置 | 公告与动态 → 订阅内的线路 | 使用文档。
   * 续费范围（已过期 / 流量用完）：面板不给订阅、线路、流量记录，这几块写明「续费后恢复」，其余照常。
   */
  let { full }: { full: boolean } = $props();

  const me = $derived(auth.me);
  const plan = $derived(auth.plan);
  const hasPlan = $derived(!!plan?.plan);

  const announcements = resource(() => ({ key: K.announcements, fetch: () => contentApi.announcements() }));
  const nodes = resource(() => ({ key: K.nodes, fetch: () => meApi.nodes(), enabled: full }));
  autoReload(() => nodes.reload(), NODES_REFRESH_MS, () => full);
  const balance = resource(() => ({ key: K.balance, fetch: () => walletApi.balance({ limit: 1 }) }));
  const orders = resource(() => ({ key: K.orders, fetch: () => orderApi.list() }));
  const tickets = resource(() => ({ key: K.tickets, fetch: () => ticketApi.list() }));

  /* ── 公告：最新一条没读过的（置顶的优先，面板已经排好）放在横幅里；打开 = 标记已读，导航上的未读数跟着变 ── */
  let notice = $state<Announcement | null>(null);
  const ann = $derived(announcements.data?.announcements ?? []);
  const latest = $derived(ann.find((a) => !a.read));
  const text = (a: Announcement) => announcementText(a, i18n.locale);

  function markRead(a: Announcement) {
    if (a.read) return;
    contentApi.markRead(a.id).catch(() => {});
    const d = announcements.data;
    if (!d) return;
    const next: Announcements = {
      unread: Math.max(0, d.unread - 1),
      announcements: d.announcements.map((x) => (x.id === a.id ? { ...x, read: true } : x)),
    };
    announcements.set(next);
    att.announcements = next;
  }

  /* 公告详情对话框（含 bits-ui）第一次打开时才下载 */
  let dialogLoaded = $state(false);
  function openNotice(a: Announcement) {
    dialogLoaded = true;
    notice = a;
    markRead(a);
  }

  /* ── 页面提醒（按急迫程度：账户提醒 → 没付完的订单 → 客服回复了工单 → 最新公告） ── */
  const openOrder = $derived((orders.data ?? []).find((o) => o.status === 'pending') ?? null);
  const replied = $derived((tickets.data ?? []).filter((x) => x.unread && x.status !== 'closed'));
  const latestInfo = $derived(latest ? { title: text(latest).title, brief: summarize(text(latest).html, 80) } : null);

  /* ── 近 7 天（全站时区的日历日，今天算一天；续费范围的账户面板不给流量记录） ── */
  const to = siteToday();
  const from = addDays(to, -6);
  const traffic = resource(() => ({ key: K.traffic(from, to), fetch: () => meApi.traffic(from, to), enabled: full }));
  const week = $derived(trafficDays(traffic.data));
  const totalDown = $derived(week.reduce((n, d) => n + d.downBytes, 0));
  const totalUp = $derived(week.reduce((n, d) => n + d.upBytes, 0));

  /* ── 关键数字 ── */
  const usage = $derived(trafficUsage(plan?.traffic_used_bytes ?? me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? null));
  const expiresAt = $derived(plan?.expires_at ?? me?.expires_at ?? null);
  const left = $derived(daysLeft(expiresAt));
  const nodeList = $derived(nodes.data ?? []);
  const online = $derived(nodeList.filter((n) => n.status === 'online').length);
  const stats = $derived.by((): Stat[] => [
    hasPlan && !usage.unlimited
      ? {
          k: t('剩余流量'), v: usage.left.toFixed(1), unit: 'GB',
          bar: { pct: usage.leftPct, low: usage.leftPct < 10 },
          x: tp('共 {t} GB，已用 {u} GB', { t: +usage.total.toFixed(1), u: +usage.used.toFixed(1) }),
        }
      : { k: t('已用流量'), v: usage.used.toFixed(1), unit: 'GB', x: hasPlan ? t('套餐不限流量') : t('购买套餐后可用') },
    /* 线路还没取到 / 没取到时写横杠，不写 0：0 条是「全部不可用」的意思 */
    full
      ? {
          k: t('可用线路'), v: nodes.data ? String(online) : '—', unit: nodes.data ? t('条') : '',
          x: nodes.data ? tp('共 {n} 条线路在订阅内', { n: nodes.data.length }) : nodes.error ? t('线路列表没能加载') : t('正在获取线路列表'),
        }
      : { k: t('可用线路'), v: '0', unit: t('条'), x: t('续费后恢复') },
    {
      k: t('套餐剩余'), v: !hasPlan ? '—' : left === null ? t('长期') : String(left), unit: hasPlan && left !== null ? t('天') : '',
      x: expiresAt ? tp('到期 {d}', { d: formatDate(expiresAt) }) : hasPlan ? t('无到期时间') : t('还没有套餐'),
    },
    {
      /* 单一余额：佣金入账就进余额（佣金追回后可以是负数），可提现的是其中一部分 */
      k: t('账户余额'), v: balance.data ? formatMoney(balance.data.balance_cents) : '—',
      x: balance.data ? tp('其中可提现 {v}', { v: formatMoney(balance.data.withdrawable_cents) }) : t('下单时可以抵扣'),
    },
  ]);

  /* 地址带 #subscribe（付款结果的「查看订阅」）：内容画好后滚过去 */
  $effect(() => {
    const id = decodeURIComponent(loc.hash.slice(1));
    if (!id) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' }), 80);
    return () => clearTimeout(timer);
  });
</script>

<PageTitle title={t('仪表盘')} sub={t('你的账号状态、流量走势与订阅信息一览。')}>
  {#snippet notices()}
    <Notices order={openOrder} onorderchange={() => orders.reload()} {replied} latest={latestInfo} onopen={() => latest && openNotice(latest)} />
  {/snippet}
</PageTitle>

<Section>
  <StatRow items={stats} />
</Section>

<!-- 流量走势（续费范围没有） -->
{#if full}
  <Section>
    {#snippet title()}<TrendingUp size={16} strokeWidth={1.75} aria-hidden="true" />{t('近 7 日流量趋势')}{/snippet}
    {#snippet desc()}{#if traffic.data}<span class="tnum">{tp('合计 {t}，其中下行 {d}、上行 {u}', { t: formatBytes(totalDown + totalUp), d: formatBytes(totalDown), u: formatBytes(totalUp) })}</span>{/if}{/snippet}
    {#snippet extra()}{#if traffic.data}<span class="sec-x">{t('计费')} <span class="tnum">{formatBytes(traffic.data.total.billed_bytes)}</span></span>{/if}{/snippet}
    {#if traffic.loading && !traffic.data}
      <Loading block={268} />
    {:else if traffic.error && !traffic.data}
      <LoadError error={traffic.error} onretry={traffic.reload} />
    {:else if totalDown + totalUp === 0}
      <Empty title={t('近 7 天还没有流量记录')} desc={t('连上节点跑一会儿，这里就会有走势了。')} />
    {:else}
      <WeekChart {week} />
    {/if}
  </Section>
{/if}

<!-- 订阅 + 公告（#subscribe：付款结果弹窗的「查看订阅」直达这里） -->
<Section id="subscribe">
  <Split>
    {#snippet left()}<Access {full} />{/snippet}
    {#snippet right()}
      <PaneHead>
        {#snippet title()}<Megaphone size={16} strokeWidth={1.75} aria-hidden="true" />{t('公告与动态')}{/snippet}
        {#snippet desc()}{t('节点变更、维护与活动通知')}{/snippet}
        {#snippet extra()}<a class="btn link-btn" href={R.announcements}>{t('全部公告')}</a>{/snippet}
      </PaneHead>
      {#if announcements.loading && !announcements.data}
        <Loading />
      {:else if announcements.error && !announcements.data}
        <LoadError error={announcements.error} onretry={announcements.reload} />
      {:else if ann.length === 0}
        <Empty title={t('暂时没有公告')} />
      {:else}
        {#each ann.slice(0, 3) as a, i (a.id)}
          {@const at = text(a)}
          <Row first={i === 0} onclick={() => openNotice(a)}>
            {#snippet title()}
              <span class="rt">
                {#if a.pinned}<span class="pinb"><Pin size={12} strokeWidth={1.75} aria-hidden="true" />{t('置顶')}</span>{/if}
                <span class={['trunc', !a.read && 'mid']}>{at.title}</span>
              </span>
            {/snippet}
            {#snippet desc()}<span class="clamp1">{summarize(at.html, 60)}</span>{/snippet}
            {#snippet extra()}<span class="tnum rx">{fromNow(a.created_at, tp)}</span>{/snippet}
          </Row>
        {/each}
      {/if}
    {/snippet}
  </Split>
</Section>

<!-- 文档 + 节点 -->
<Section>
  <Split>
    {#snippet left()}<DocsPreview />{/snippet}
    {#snippet right()}<NodesPreview {nodes} {full} />{/snippet}
  </Split>
</Section>

{#if dialogLoaded}
  {#await import('../AnnouncementDialog.svelte') then m}<m.default item={notice} onclose={() => (notice = null)} />{/await}
{/if}
