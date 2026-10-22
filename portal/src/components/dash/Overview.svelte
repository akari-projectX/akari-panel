<script lang="ts">
  import ArrowRight from '@lucide/svelte/icons/arrow-right';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Pin from '@lucide/svelte/icons/pin';
  import X from '@lucide/svelte/icons/x';
  import { contentApi, meApi, orderApi, ticketApi, walletApi, type Announcement, type Announcements } from '@/api';
  import { summarize } from '@/lib/content-text';
  import { K } from '@/lib/cache';
  import { daysLeft, formatBytes, formatDate, formatMoney, formatMonthDay, fromNow, resetPeriodText, trafficUsage, yuan } from '@/lib/format';
  import { NODES_REFRESH_MS, nodeUp } from '@/lib/node';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import Access from './Access.svelte';
  import DocsPreview from './DocsPreview.svelte';
  import NodesPreview from './NodesPreview.svelte';
  import Notices from './Notices.svelte';
  import TrafficSection from './TrafficSection.svelte';
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

  /* ── 页面提醒 ── */
  const openOrder = $derived((orders.data ?? []).find((o) => o.status === 'pending') ?? null);
  const replied = $derived((tickets.data ?? []).filter((x) => x.unread && x.status !== 'closed'));

  /* ── 关键数字 ── */
  const usage = $derived(trafficUsage(plan?.traffic_used_bytes ?? me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? null));
  const expiresAt = $derived(plan?.expires_at ?? me?.expires_at ?? null);
  const left = $derived(daysLeft(expiresAt));
  const nextReset = $derived(plan?.plan?.next_reset_at ? formatMonthDay(plan.plan.next_reset_at) : null);
  const limited = $derived(hasPlan && !usage.unlimited);
  const lowPct = $derived(limited && usage.leftPct < 10);
  const low = $derived(full && lowPct
    ? { left: formatBytes(Math.max(0, (plan?.traffic_limit_bytes ?? 0) - (plan?.traffic_used_bytes ?? 0))), pct: Math.floor(usage.leftPct), reset: nextReset }
    : null);
  const nodeList = $derived(nodes.data ?? []);
  const online = $derived(nodeList.filter(nodeUp).length);
  const maint = $derived(nodeList.filter((n) => n.status === 'maintenance').length);
  const offline = $derived(nodeList.filter((n) => n.status === 'offline').length);
  const subtitle = $derived(plan?.plan ? `${plan.plan.name} · ${resetPeriodText(plan.plan.period, t, tp)}` : t('还没有套餐'));

  /* 地址带 #subscribe（付款结果的「查看订阅」）：内容画好后滚过去 */
  $effect(() => {
    const id = decodeURIComponent(loc.hash.slice(1));
    if (!id) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' }), 80);
    return () => clearTimeout(timer);
  });
</script>

<div class="ph">
  <div>
    <h1>{t('仪表盘')}</h1>
    <p>{subtitle}</p>
  </div>
  <a class="link" href={R.shop}>{hasPlan ? t('续费或更换套餐') : t('去选套餐')}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></a>
</div>

{#if latest}
  {@const lt = text(latest)}
  <div class="banner" role="region" aria-label={t('最新公告')}>
    <div class="tx">
      <div class="tt"><span>{lt.title}</span></div>
      {#if summarize(lt.html, 80)}<p class="sm">{summarize(lt.html, 80)}</p>{/if}
    </div>
    <button type="button" class="link go" onclick={() => openNotice(latest)}>{t('查看详情')}</button>
    <button type="button" class="iconbtn" aria-label={t('不再显示这条公告')} onclick={() => markRead(latest)}>
      <X size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  </div>
{/if}

<Notices order={openOrder} onorderchange={() => orders.reload()} {replied} {low} />

<section class="kpis" aria-label={t('账户概况')}>
  <div class="kpi">
    {#if limited}
      <div class="lb">{t('剩余流量')}</div>
      <div class="v">{usage.left.toFixed(1)}<small>GB</small></div>
      <div class={lowPct ? 'meter warn' : 'meter'} role="meter" aria-label={t('剩余流量')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usage.leftPct)}>
        <i style:width="{usage.leftPct}%"></i>
      </div>
      <div class="sub">
        {tp('共 {t} GB，已用 {u} GB', { t: +usage.total.toFixed(1), u: +usage.used.toFixed(1) })}{#if nextReset}&nbsp;· {tp('{d} 重置', { d: nextReset })}{/if}
      </div>
    {:else}
      <div class="lb">{t('已用流量')}</div>
      <div class="v">{usage.used.toFixed(1)}<small>GB</small></div>
      <div class="sub">{hasPlan ? t('套餐不限流量') : t('购买套餐后可用')}</div>
    {/if}
  </div>
  <div class="kpi">
    <div class="lb">{t('套餐剩余')}</div>
    <div class="v">{#if !hasPlan}—{:else if left === null}{t('长期')}{:else}{left}<small>{t('天')}</small>{/if}</div>
    <div class="sub">{expiresAt ? tp('到期 {d}', { d: formatDate(expiresAt) }) : hasPlan ? t('无到期时间') : t('还没有套餐')}</div>
  </div>
  <div class="kpi">
    <div class="lb">{t('可用线路')}</div>
    {#if !full}
      <div class="v">0<small>{t('条')}</small></div>
      <div class="sub">{t('续费后恢复')}</div>
    {:else if nodes.data}
      <div class="v">{online}<small>/ {tp('{n} 条', { n: nodeList.length })}</small></div>
      <div class="sub">
        {#if maint || offline}
          {[maint ? tp('{n} 维护', { n: maint }) : '', offline ? tp('{n} 离线', { n: offline }) : ''].filter(Boolean).join(' · ')}
        {:else}
          {tp('共 {n} 条线路在订阅内', { n: nodeList.length })}
        {/if}
      </div>
    {:else}
      <!-- 线路还没取到 / 没取到时写横杠，不写 0：0 条是「全部不可用」的意思 -->
      <div class="v">—</div>
      <div class="sub">{nodes.error ? t('线路列表没能加载') : t('正在获取线路列表')}</div>
    {/if}
  </div>
  <div class="kpi">
    <div class="lb">{t('账户余额')}</div>
    {#if balance.data}
      {@const cents = balance.data.balance_cents}
      <div class="v">{cents < 0 ? '−' : ''}<span class="ccy">¥</span>{yuan(Math.abs(cents), { always2: true })}</div>
      <div class="sub">{tp('其中可提现 {v}', { v: formatMoney(balance.data.withdrawable_cents) })}</div>
    {:else}
      <div class="v">—</div>
      <div class="sub">{t('下单时可以抵扣')}</div>
    {/if}
  </div>
</section>

{#if full}<TrafficSection />{/if}

<div class="cols">
  <Access {full} />

  <section class="sec" aria-labelledby="h-news">
    <div class="sh">
      <div>
        <h2 id="h-news">{t('公告与动态')}</h2>
        <p>{announcements.data?.unread ? tp('{n} 条未读', { n: announcements.data.unread }) : t('节点变更、维护与活动通知')}</p>
      </div>
      <a class="link" href={R.announcements}>{t('全部公告')}<ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" /></a>
    </div>
    {#if announcements.loading && !announcements.data}
      <Loading />
    {:else if announcements.error && !announcements.data}
      <LoadError error={announcements.error} onretry={announcements.reload} />
    {:else if ann.length === 0}
      <Empty title={t('暂时没有公告')} />
    {:else}
      <div class="list">
        {#each ann.slice(0, 5) as a (a.id)}
          {@const at = text(a)}
          <button type="button" class="li" onclick={() => openNotice(a)}>
            <div class="main">
              <div class="t">
                <span class={a.read ? 'read' : ''}>{at.title}</span>
                {#if !a.read}<i class="unread-dot" aria-label={t('未读')}></i>{/if}
              </div>
              <p class="s">{summarize(at.html, 60)}</p>
            </div>
            <span class="r">
              {#if a.pinned}<span class="pin"><Pin size={13} strokeWidth={1.75} aria-hidden="true" />{t('置顶')}</span>{:else}{fromNow(a.created_at, tp)}{/if}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </section>
</div>

<div class="cols">
  <NodesPreview {nodes} {full} />
  <DocsPreview />
</div>

{#if dialogLoaded}
  {#await import('../AnnouncementDialog.svelte') then m}<m.default item={notice} onclose={() => (notice = null)} />{/await}
{/if}

<style>
  .ph .link { margin-bottom: 4px; }
  .kpis { display: grid; grid-template-columns: 1.25fr 1fr 1fr 1fr; padding: 4px 0 36px; }
  .kpi { min-width: 0; padding: 0 32px; border-left: 1px solid var(--line); }
  .kpi:first-child { padding-left: 0; border-left: 0; }
  .lb { font-size: 13px; color: var(--muted); }
  .v {
    display: flex; align-items: baseline; gap: 4px; margin-top: 6px; color: var(--fg); font-size: 34px; line-height: 40px; font-weight: 600;
    letter-spacing: -.02em; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .v small { font-size: 14px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
  .v .ccy { font-size: 20px; font-weight: 600; margin-right: 1px; }
  .sub { margin-top: 8px; font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .meter { height: 3px; margin-top: 12px; border-radius: 2px; overflow: hidden; background: var(--secondary); }
  .meter i { display: block; height: 100%; border-radius: 2px; background: var(--brand); }
  .meter.warn i { background: var(--warn); }

  @media (max-width: 1080px) {
    .kpi { padding: 0 20px; }
  }
  @media (max-width: 720px) {
    .kpis { grid-template-columns: auto auto auto; gap: 24px 0; padding-bottom: 28px; }
    .kpi { margin-left: 14px; padding: 0 0 0 14px; }
    .kpi:nth-child(-n + 2) { margin-left: 0; padding-left: 0; border-left: 0; }
    .kpi:first-child { grid-column: 1 / -1; }
    .kpi:first-child .v { font-size: 40px; line-height: 44px; }
    .v { margin-top: 4px; font-size: 24px; line-height: 30px; }
    .v small { font-size: 13px; }
    .v .ccy { font-size: 16px; }
    .sub { margin-top: 4px; font-size: 12px; }
  }
</style>
