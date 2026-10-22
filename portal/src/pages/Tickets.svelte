<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import { ticketApi, type TicketRow } from '@/api';
  import { K } from '@/lib/cache';
  import { formatDateTime, fromNow } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import { att } from '$lib/attention.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { loc, navigate } from '$lib/router.svelte';
  import { CATEGORY, PRIORITY, STATE } from '$lib/tickets';

  /*
   * 工单（行为同 React 门户 pages/dash/tickets.tsx）：四个数字（全部 / 等待客服 / 已回复 / 已关闭）、我的工单（细线行：标题、
   * 客服回了还没看 = 品牌蓝点、分类 · 优先级 · 更新时间、状态）、提交新工单（对话框）、对话（对话框：消息、回复、关闭）。
   * 客服的新回复由面板记未读（打开详情即已读），换设备也一致。被封禁的账户也能用（这是他们唯一的申诉渠道）。
   * 仪表盘「客服回复了」带着 ?id= 过来：列表到了就直接打开那一张，并把参数去掉。两个对话框都是第一次打开时才下载。
   */
  const tickets = resource(() => ({ key: K.tickets, fetch: () => ticketApi.list() }));
  const list = $derived(tickets.data ?? []);
  const waiting = $derived(list.filter((x) => x.status === 'open').length);
  const replied = $derived(list.filter((x) => x.status === 'answered').length);
  const closed = $derived(list.filter((x) => x.status === 'closed').length);

  /* 导航上的「工单新回复」跟着这一页的数据走 */
  $effect(() => { if (tickets.data) att.tickets = tickets.data; });

  let current = $state<TicketRow | null>(null);
  let threadLoaded = $state(false);
  let creating = $state(false);
  let newLoaded = $state(false);

  function openThread(x: TicketRow) {
    threadLoaded = true;
    current = x;
  }

  function openNew() {
    newLoaded = true;
    creating = true;
  }

  /* ?id=：列表到了就打开那一张（找不到就算了），然后把参数去掉 */
  let handled = '';
  $effect(() => {
    const wanted = new URLSearchParams(loc.search).get('id') ?? '';
    const data = tickets.data;
    if (!wanted || !data || handled === wanted) return;
    handled = wanted;
    const hit = data.find((x) => x.id === wanted);
    if (hit) openThread(hit);
    navigate(loc.path, { replace: true, keepScroll: true });
  });

  /* 新工单提交成功：取一遍列表，直接打开它 */
  async function created(id: string) {
    creating = false;
    const fresh = await ticketApi.list().catch(() => null);
    if (!fresh) { tickets.reload(); return; }
    tickets.set(fresh);
    const hit = fresh.find((x) => x.id === id);
    if (hit) openThread(hit);
  }

  const level = (x: TicketRow) => tp('{level}优先级', { level: t(PRIORITY[x.priority].text) });
</script>

<div class="ph">
  <div>
    <h1>{t('工单')}</h1>
    <p>{t('遇到问题在这里提交，客服的回复也会出现在同一条对话里。')}</p>
  </div>
</div>

<section class="stats" aria-label={t('工单概况')}>
  <div>
    <div class="lb">{t('全部工单')}</div>
    <div class="v num">{list.length}<small>{t(' 张')}</small></div>
    <div class="sub">{list[0] ? tp('最近更新 {t}', { t: fromNow(list[0].updated_at, tp) }) : t('还没有提交过工单')}</div>
  </div>
  <div>
    <div class="lb">{t('等待客服')}</div>
    <div class="v num">{waiting}<small>{t(' 张')}</small></div>
    <div class="sub">{t('已提交，等待处理')}</div>
  </div>
  <div>
    <div class="lb">{t('已回复')}</div>
    <div class="v num">{replied}<small>{t(' 张')}</small></div>
    <div class="sub">{t('等待你的确认')}</div>
  </div>
  <div>
    <div class="lb">{t('已关闭')}</div>
    <div class="v num">{closed}<small>{t(' 张')}</small></div>
    <div class="sub">{t('问题已经了结')}</div>
  </div>
</section>

<section class="sec" aria-labelledby="h-tickets">
  <div class="sh">
    <div>
      <h2 id="h-tickets">{t('我的工单')}</h2>
      <p>{t('点击任意工单查看完整对话')}</p>
    </div>
    <button type="button" class="btn pri sm" onclick={openNew}><Plus size={14} strokeWidth={1.75} aria-hidden="true" />{t('提交工单')}</button>
  </div>

  {#if tickets.loading && !tickets.data}
    <Loading />
  {:else if tickets.error && !tickets.data}
    <LoadError error={tickets.error} onretry={tickets.reload} />
  {:else if list.length === 0}
    <Empty title={t('还没有工单')} desc={t('遇到问题时点右上角提交，我们会在这里回复。')} />
  {:else}
    <div class="list">
      {#each list as x (x.id)}
        {@const fresh = x.unread && x.status !== 'closed'}
        <button type="button" class="li" class:dim={x.status === 'closed'} onclick={() => openThread(x)}>
          <div class="main">
            <div class="t">
              <span>{x.subject}</span>
              {#if fresh}<i class="unread-dot" title={t('客服有新回复')}></i><span class="sr">{t('客服有新回复')}</span>{/if}
            </div>
            <p class="s">
              {t(CATEGORY[x.category])}<span class="m-only"> · <span class={PRIORITY[x.priority].cls}>{level(x)}</span></span>
              · <span class="num">{tp('更新于 {d}', { d: formatDateTime(x.updated_at) })}</span>
            </p>
          </div>
          <span class="end">
            <span class="d-only pr {PRIORITY[x.priority].cls}">{level(x)}</span>
            <span class={STATE[x.status].cls}>{t(STATE[x.status].text)}</span>
          </span>
        </button>
      {/each}
    </div>
  {/if}
</section>

{#if newLoaded}
  {#await import('../components/tickets/NewTicket.svelte') then m}<m.default bind:open={creating} oncreated={created} />{/await}
{/if}
{#if threadLoaded}
  {#await import('../components/tickets/Thread.svelte') then m}
    <m.default ticket={current} onclose={() => (current = null)} onchanged={() => tickets.reload()} />
  {/await}
{/if}

<style>
  .stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 4px 0 32px; }
  .stats > div { min-width: 0; padding: 0 28px; border-left: 1px solid var(--line); }
  .stats > div:first-child { padding-left: 0; border-left: 0; }
  .lb { font-size: 13px; color: var(--muted); }
  .v { display: flex; align-items: baseline; gap: 4px; margin-top: 6px; font-size: 28px; line-height: 36px; font-weight: 600; letter-spacing: -.02em; color: var(--fg); white-space: nowrap; }
  .v small { font-size: 14px; font-weight: 500; letter-spacing: 0; color: var(--muted); }
  .sub { margin-top: 6px; font-size: 12.5px; color: var(--muted); }

  .sh .btn { flex: none; align-self: center; }
  .li .s { white-space: normal; }
  .li .end { display: flex; align-items: center; gap: 16px; flex: none; }
  .pr { font-size: 12.5px; color: var(--muted); white-space: nowrap; }
  .pr-normal { color: var(--body); }
  .pr-high { color: var(--warn); }
  .pr-urgent { color: var(--danger); }
  .m-only { display: none; }

  @media (max-width: 960px) {
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px 0; }
    .stats > div:nth-child(3) { padding-left: 0; border-left: 0; }
  }
  @media (max-width: 720px) {
    .v { font-size: 22px; line-height: 28px; }
    .stats > div { padding: 0 0 0 16px; }
    .sub { font-size: 12px; }
    .m-only { display: inline; }
  }
</style>
