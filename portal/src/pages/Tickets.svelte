<script lang="ts">
  import Headphones from '@lucide/svelte/icons/headphones';
  import MessageCircle from '@lucide/svelte/icons/message-circle';
  import Plus from '@lucide/svelte/icons/plus';
  import { ticketApi, type TicketRow } from '@/api';
  import { K } from '@/lib/cache';
  import { formatDateTime, fromNow } from '@/lib/format';
  import Empty from '../components/Empty.svelte';
  import LoadError from '../components/LoadError.svelte';
  import Loading from '../components/Loading.svelte';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Row from '../components/flat/Row.svelte';
  import Section from '../components/flat/Section.svelte';
  import StatRow from '../components/flat/StatRow.svelte';
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

<PageTitle title={t('工单')} sub={t('遇到问题在这里提交，客服的回复也会出现在同一条对话里。')} />

<Section>
  <StatRow items={[
    { k: t('全部工单'), v: String(list.length), unit: t(' 张'), x: list[0] ? tp('最近更新 {t}', { t: fromNow(list[0].updated_at, tp) }) : t('还没有提交过工单') },
    { k: t('等待客服'), v: String(waiting), unit: t(' 张'), x: t('已提交，等待处理') },
    { k: t('已回复'), v: String(replied), unit: t(' 张'), x: t('等待你的确认') },
    { k: t('已关闭'), v: String(closed), unit: t(' 张'), x: t('问题已经了结') },
  ]} />
</Section>

<Section>
  {#snippet title()}<Headphones size={16} strokeWidth={1.75} aria-hidden="true" />{t('我的工单')}{/snippet}
  {#snippet desc()}{t('点击任意工单查看完整对话')}{/snippet}
  {#snippet extra()}<button type="button" class="btn pri tk-new" onclick={openNew}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />{t('提交工单')}</button>{/snippet}

  {#if tickets.loading && !tickets.data}
    <Loading />
  {:else if tickets.error && !tickets.data}
    <LoadError error={tickets.error} onretry={tickets.reload} />
  {:else if list.length === 0}
    <Empty title={t('还没有工单')} desc={t('遇到问题时点右上角提交，我们会在这里回复。')} />
  {:else}
    {#each list as x (x.id)}
      {@const fresh = x.unread && x.status !== 'closed'}
      <Row onclick={() => openThread(x)}>
        {#snippet avatar()}
          <span class="tk-av">
            <MessageCircle size={18} strokeWidth={1.75} aria-hidden="true" />
            {#if fresh}<i class="tk-dot" title={t('客服有新回复')}></i><span class="sr">{t('客服有新回复')}</span>{/if}
          </span>
        {/snippet}
        {#snippet title()}{x.subject}{/snippet}
        {#snippet desc()}{t(CATEGORY[x.category])}<span class="sm-hide">{' · '}{level(x)}</span>{' · '}<span class="tk-nw">{tp('更新于 {d}', { d: formatDateTime(x.updated_at) })}</span>{/snippet}
        {#snippet extra()}
          <span class="tk-end">
            <span class={['bdg', 'tk-pr', PRIORITY[x.priority].bdg]}>{level(x)}</span>
            <span class={['bdg', STATE[x.status].bdg]}>{t(STATE[x.status].text)}</span>
          </span>
        {/snippet}
      </Row>
    {/each}
  {/if}
</Section>

{#if newLoaded}
  {#await import('../components/tickets/NewTicket.svelte') then m}<m.default bind:open={creating} oncreated={created} />{/await}
{/if}
{#if threadLoaded}
  {#await import('../components/tickets/Thread.svelte') then m}
    <m.default ticket={current} onclose={() => (current = null)} onchanged={() => tickets.reload()} />
  {/await}
{/if}

<style>
  .tk-new { height: 36px; }
  .tk-av { position: relative; display: flex; color: var(--faint); transition: color .15s; }
  :global(.rowline:hover) .tk-av { color: var(--brand); }
  .tk-dot { position: absolute; top: -2px; right: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--brand); box-shadow: 0 0 0 2px var(--bg); }
  .tk-nw { white-space: nowrap; }
  .tk-end { display: flex; align-items: center; gap: 13px; }
  @media (max-width: 639px) { .tk-pr { display: none; } }
  @media (min-width: 640px) { .sm-hide { display: none; } }
</style>
