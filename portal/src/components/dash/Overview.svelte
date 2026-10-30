<script module lang="ts">
  const Detail = () => import('../AnnouncementDialog.svelte');
</script>

<script lang="ts">
  import { contentApi, type Announcement, type Announcements } from '@/api';
  import { summarize } from '@/lib/content-text';
  import { trafficDays } from '@/lib/traffic';
  import { NODES_REFRESH_MS } from '@/lib/node';
  import Access from './Access.svelte';
  import DocsPreview from './DocsPreview.svelte';
  import Promo from './Promo.svelte';
  import Flow from './Flow.svelte';
  import News from './News.svelte';
  import NodesPreview from './NodesPreview.svelte';
  import Notices from './Notices.svelte';
  import Status from './Status.svelte';
  import { chunk, intent, preloadDialogs } from '$lib/dialogs';
  import { announcementText, tagOf } from '$lib/announcement';
  import { dashSpecs, trafficSpec } from '$lib/dash-data';
  import { att } from '$lib/attention.svelte';
  import { i18n, t } from '$lib/i18n.svelte';
  import { autoReload, resource } from '$lib/resource.svelte';
  import { loc } from '$lib/router.svelte';

  /*
   * 仪表盘（full / renewal 范围；banned 是 Banned.svelte），外观 A · A3（2026-10-30 用户确认）：
   *   左栏：页标题那行（问候 · 套餐 · 状态）→ 提醒（Notices）→ 大字（本期还剩多少、几天后到期）+ 两把尺 + 判断 + 操作 + 四个小事实（Status）
   *         → 流量（7 / 30 天，Flow）→ 公告（News）；
   *   右栏：接入配置（Access / Subscribe，#subscribe）→ 活动位（Promo，站长配置了才有）→ 教程（DocsPreview）；
   *   整宽：线路（NodesPreview）。
   * 样稿里的「活动位」没有数据来源（面板没有活动 / 倒计时 / 优惠码展示的接口），不画。
   * 续费范围（已过期 / 流量用完）：面板不给订阅、线路、流量记录，这几块写明「续费后恢复」，其余照常。
   */
  let { full }: { full: boolean } = $props();

  /* 键与取法与「进页面之前就开始取」共用（lib/dash-data） */
  const spec = dashSpecs();
  const announcements = resource(() => spec.announcements);
  const nodes = resource(() => ({ ...spec.nodes, enabled: full }));
  autoReload(() => nodes.reload(), NODES_REFRESH_MS, () => full);
  const balance = resource(() => spec.balance);
  const orders = resource(() => spec.orders);
  const tickets = resource(() => spec.tickets);

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

  /* 公告详情对话框（含 bits-ui）第一次打开时才挂载；分包在空闲时与行 / 按钮上的意图预载（lib/dialogs） */
  let dialogLoaded = $state(false);
  preloadDialogs(Detail);
  function openNotice(a: Announcement) {
    dialogLoaded = true;
    notice = a;
    markRead(a);
  }

  /* ── 页面提醒（按急迫程度：账户提醒 → 没付完的订单 → 客服回复了工单 → 最新公告） ── */
  const openOrder = $derived((orders.data ?? []).find((o) => o.status === 'pending') ?? null);
  const replied = $derived((tickets.data ?? []).filter((x) => x.unread && x.status !== 'closed'));
  const latestInfo = $derived(latest ? { title: text(latest).title, brief: summarize(text(latest).html, 80), tag: tagOf(latest, i18n.locale) } : null);

  /* ── 流量：默认近 7 天（预取的那一份，也是首屏判断「何时用完」的依据）；切到 30 天才取 30 天（续费范围的账户面板不给流量记录） ── */
  let range = $state<7 | 30>(7);
  const traffic = resource(() => ({ ...(range === 7 ? spec.traffic : trafficSpec(30)), enabled: full, keep: true }));
  const days = $derived(trafficDays(traffic.data));
  const week = $derived(days.slice(-7));

  /* 地址带 #subscribe（付款结果的「查看订阅」）：内容画好后滚过去 */
  $effect(() => {
    const id = decodeURIComponent(loc.hash.slice(1));
    if (!id) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' }), 80);
    return () => clearTimeout(timer);
  });
</script>

<div class="dtop">
  <div class="dmain">
    <Status week={week} nodes={nodes.data} balance={balance.data} {full}>
      {#snippet notices()}
        <Notices order={openOrder} onorderchange={() => orders.reload()} {replied} latest={latestInfo} onopen={() => latest && openNotice(latest)} ondismiss={() => latest && markRead(latest)} openIntent={intent(Detail)} />
      {/snippet}
    </Status>
    {#if full}<Flow {traffic} days={days} bind:range />{/if}
    <News {announcements} onopen={openNotice} openIntent={intent(Detail)} />
  </div>

  <aside class="dside">
    <!-- #subscribe：付款结果弹窗的「查看订阅」直达这里 -->
    <section id="subscribe" class="acc" aria-label={t('接入配置')}><Access {full} /></section>
    <Promo />
    <DocsPreview />
  </aside>
</div>

<NodesPreview {nodes} {full} />

{#if dialogLoaded}
  {#await chunk(Detail) then m}<m.default item={notice} onclose={() => (notice = null)} />{/await}
{/if}
