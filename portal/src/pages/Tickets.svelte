<script module lang="ts">
  const NewTicket = () => import('../components/tickets/NewTicket.svelte');
  const Thread = () => import('../components/tickets/Thread.svelte');
</script>

<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';
  import { ticketApi, type TicketRow, type TicketStatus } from '@/api';
  import { K } from '@/lib/cache';
  import { fromNow } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import { chunk, intent, preloadDialogs } from '$lib/dialogs';
  import { att } from '$lib/attention.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { loc, navigate } from '$lib/router.svelte';
  import { CATEGORY, PRIORITY, STATE } from '$lib/tickets';
  import { thumb } from '$lib/thumb';

  /*
   * 工单（外观 A，同仪表盘的细线列表）：页头一句话（几张在等客服）+ 右侧「提交工单」；有工单时一排状态筛选（全部 / 待处理 / 已回复 / 已关闭，带张数）；
   * 下面是细线行：客服回了还没看 = 品牌蓝点 + 加粗标题，一行 分类 · 优先级（高 / 紧急才写）· 多久前更新，右边状态（色点 + 字）与 →。
   * 点一行打开对话（阅读对话框：消息、回复、关闭）；提交新工单也是对话框，两个都是第一次打开时才下载。
   * 客服的新回复由面板记未读（打开详情即已读），换设备也一致。被封禁的账户也能用（这是他们唯一的申诉渠道）。
   * 仪表盘「客服回复了」带着 ?id= 过来：列表到了就直接打开那一张，并把参数去掉。
   */
  const tickets = resource(() => ({ key: K.tickets, fetch: () => ticketApi.list() }));
  const list = $derived(tickets.data ?? []);
  const count = (st: TicketStatus) => list.filter((x) => x.status === st).length;
  const waiting = $derived(count('open'));
  let only = $state<TicketStatus | null>(null);
  const shown = $derived(only ? list.filter((x) => x.status === only) : list);
  const FILTERS: TicketStatus[] = ['open', 'answered', 'closed'];

  /* 导航上的「工单新回复」跟着这一页的数据走 */
  $effect(() => { if (tickets.data) att.tickets = tickets.data; });

  let current = $state<TicketRow | null>(null);
  /* 两个对话框第一次打开时才挂载；分包在空闲时与按钮 / 行上的意图预载（lib/dialogs） */
  preloadDialogs(NewTicket, Thread);
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
    only = null;
    const fresh = await ticketApi.list().catch(() => null);
    if (!fresh) { tickets.reload(); return; }
    tickets.set(fresh);
    const hit = fresh.find((x) => x.id === id);
    if (hit) openThread(hit);
  }
</script>

<PageTitle title={t('支持')} lead={waiting > 0 ? tp('{n} 张工单等待客服回复', { n: waiting }) : t('有问题，随时找我们')}>
  {#snippet extra()}
    <button type="button" class="btn pri tk-new" {@attach intent(NewTicket)} onclick={openNew}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />{t('提交工单')}</button>
  {/snippet}
</PageTitle>

{#if tickets.loading && !tickets.data}
  <Loading />
{:else if tickets.error && !tickets.data}
  <LoadError error={tickets.error} onretry={tickets.reload} />
{:else if list.length === 0}
  <div class="tk-empty"><Empty title={t('还没有工单')} desc={t('遇到问题时点右上角提交，我们会在这里回复。')} /></div>
{:else}
  <div class="tabs-pill tk-filter" {@attach thumb} role="group" aria-label={t('按状态筛选')}>
    <button type="button" aria-pressed={only === null} onclick={() => (only = null)}>{t('全部')} <span class="n tnum">{list.length}</span></button>
    {#each FILTERS as st (st)}
      <button type="button" aria-pressed={only === st} onclick={() => (only = st)}>{t(STATE[st].text)} <span class="n tnum">{count(st)}</span></button>
    {/each}
  </div>
  {#if shown.length === 0}
    <div class="tk-empty"><Empty title={t('这一类里没有工单')} /></div>
  {:else}
    <div class="tk-list">
      {#each shown as x (x.id)}
        {@const fresh = x.unread && x.status !== 'closed'}
        <button type="button" class={['rowline', 'tk-row', fresh && 'fresh']} {@attach intent(Thread)} onclick={() => openThread(x)}>
          <span class="tk-main">
            <span class="tk-t">
              {#if fresh}<i class="tk-dot" aria-hidden="true"></i><span class="sr">{t('客服有新回复')}</span>{/if}
              <b>{x.subject}</b>
            </span>
            <small>
              {t(CATEGORY[x.category])}
              {#if x.priority === 'high' || x.priority === 'urgent'}{' · '}<span class={PRIORITY[x.priority].cls}>{tp('{level}优先级', { level: t(PRIORITY[x.priority].text) })}</span>{/if}
              {' · '}{tp('{t}更新', { t: fromNow(x.updated_at, tp) })}
            </small>
          </span>
          <span class={['tk-st', x.status]}><i aria-hidden="true"></i>{t(STATE[x.status].text)}</span>
          <span class="drow-go" aria-hidden="true">→</span>
        </button>
      {/each}
    </div>
  {/if}
{/if}

{#if newLoaded}
  {#await chunk(NewTicket) then m}<m.default bind:open={creating} oncreated={created} />{/await}
{/if}
{#if threadLoaded}
  {#await chunk(Thread) then m}
    <m.default ticket={current} onclose={() => (current = null)} onchanged={() => tickets.reload()} />
  {/await}
{/if}

<style>
  .tk-new { height: 40px; }
  .tk-empty { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line); }
  .tk-filter { max-width: 100%; margin: 28px 0 24px; overflow-x: auto; scrollbar-width: none; }
  .tk-filter > button { flex: none; }
  .tk-filter .n { font-size: 11.5px; opacity: .7; }

  /* 细线行：标题与一行说明、状态、→；客服回了还没看 = 蓝点 + 加粗 */
  .tk-list { border-top: 1px solid var(--line); }
  .tk-row {
    display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 18px; width: 100%; padding: 18px 0;
    border: 0; border-bottom: 1px solid var(--line); background: none; color: var(--body); font: inherit; text-align: left; cursor: pointer;
    transition: padding-left var(--dur-fast) var(--ease-out);
  }
  .tk-row:hover { padding-left: 6px; }
  .tk-row:hover .drow-go { translate: 3px 0; color: var(--fg); }
  .tk-main { min-width: 0; }
  .tk-t { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .tk-t b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: var(--fw-regular); color: var(--fg); }
  .tk-row.fresh .tk-t b { font-weight: var(--fw-strong); }
  .tk-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--brand); }
  .tk-main small { display: block; margin-top: 4px; font-size: 13px; color: var(--muted); }
  .tk-main small .pr-high { color: var(--amber); }
  .tk-main small .pr-urgent { color: var(--danger); }
  .tk-st { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--muted); white-space: nowrap; }
  .tk-st > i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
  .tk-st.open > i { background: var(--brand); }
  .tk-st.answered { color: var(--fg); }
  .tk-st.answered > i { background: var(--ok); }
  @media (max-width: 639px) {
    .tk-row { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; }
    .tk-row .drow-go { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .tk-row { transition: none; } }
</style>
