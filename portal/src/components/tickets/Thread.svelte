<script lang="ts">
  import Headphones from '@lucide/svelte/icons/headphones';
  import Send from '@lucide/svelte/icons/send';
  import UserRound from '@lucide/svelte/icons/user-round';
  import { ticketApi, type TicketDetail, type TicketRow } from '@/api';
  import { K } from '@/lib/cache';
  import { formatDateTime } from '@/lib/format';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import ConfirmDialog from '../ui/ConfirmDialog.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { CATEGORY, PRIORITY, SEND_KEY, STATE } from '$lib/tickets';
  import { toast } from '$lib/toast.svelte';

  /*
   * 工单对话（与 React 门户 tickets.tsx 的 ReadingDialog 相同）：标题、分类 · 优先级 · 状态 · 创建时间，关联订单，
   * 消息（客服在左、我在右；客服只显示为「客服」，面板不透露是哪一位），回复框贴在底部（⌘/Ctrl + Enter 发送），
   * 「问题已解决，关闭工单」先确认。已关闭的只说明「请新开一张」。打开、发出回复后滚到最新一条。
   * 打开详情时面板就把回复标成已读了：详情一到，onchanged 让页面重新取列表（未读点去掉）。
   */
  let { ticket, onclose, onchanged }: { ticket: TicketRow | null; onclose: () => void; onchanged: () => void } = $props();

  /* 关闭时 ticket 先变成 null、对话框后退场：退场期间接着显示刚才那张 */
  let shown = $state<TicketRow | null>(null);
  $effect(() => { if (ticket) shown = ticket; });
  const th = $derived(ticket ?? shown);

  const detail = resource<TicketDetail>(() => ({
    key: th ? K.ticket(th.id) : 'ticket:none',
    fetch: () => ticketApi.get(th!.id),
    enabled: !!ticket,
  }));

  const status = $derived((ticket && detail.data?.id === ticket.id && detail.data.status) || th?.status);
  const closed = $derived(status === 'closed');
  let reply = $state('');
  $effect(() => { if (ticket) reply = ''; });
  const replying = new Pending();
  const closing = new Pending();
  let asking = $state(false);

  /* 这一次打开的详情取回来了（面板此时已标为已读）：列表跟着去掉未读，每次打开一回 */
  let reported = false;
  $effect(() => {
    if (!ticket) { reported = false; return; }
    if (!reported && !detail.loading && detail.data?.id === ticket.id) { reported = true; onchanged(); }
  });

  /* 打开、发出回复后滚到最新一条 */
  let end = $state<HTMLDivElement>();
  $effect(() => {
    const n = detail.data?.messages.length ?? 0;
    void detail.data?.id;
    if (n) requestAnimationFrame(() => end?.scrollIntoView({ block: 'end' }));
  });

  function send() {
    void replying.run(async () => {
      if (!ticket || !reply.trim()) return;
      try {
        await ticketApi.reply(ticket.id, reply.trim());
        reply = '';
        detail.reload();
        onchanged();
      } catch (e) {
        toast.error(errorText(e));
      }
    });
  }

  function close() {
    void closing.run(async () => {
      if (!ticket) return;
      try {
        await ticketApi.close(ticket.id);
        asking = false;
        toast.success(t('工单已关闭'));
        onclose();
        onchanged();
      } catch (e) {
        toast.error(errorText(e));
      }
    });
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  }
</script>

<Dialog open={!!ticket} onOpenChange={(o) => { if (!o) onclose(); }} reading title={th?.subject ?? ''} description={th ? t(CATEGORY[th.category]) : ''}>
  {#snippet meta()}
    {#if th}
      <span>{t(CATEGORY[th.category])}</span>
      <span class={['bdg', 'rd-pill', PRIORITY[th.priority].bdg]}>{tp('{level}优先级', { level: t(PRIORITY[th.priority].text) })}</span>
      {#if status}<span class={['bdg', STATE[status].bdg]}>{t(STATE[status].text)}</span>{/if}
      <span class="tnum">{formatDateTime(th.created_at)}</span>
    {/if}
  {/snippet}
  <div class="msgs">
    {#if detail.loading && !detail.data}
      <Loading rows={2} />
    {:else if detail.error && !detail.data}
      <LoadError error={detail.error} onretry={detail.reload} />
    {:else if detail.data}
      {#if detail.data.order_no}<p class="order">{tp('关联订单 {n}', { n: detail.data.order_no })}</p>{/if}
      {#each detail.data.messages as m (m.id)}
        <div class="msg" class:mine={!m.staff}>
          <div class="av">{#if m.staff}<Headphones size={14} strokeWidth={1.75} aria-hidden="true" />{:else}<UserRound size={14} strokeWidth={2.2} aria-hidden="true" />{/if}</div>
          <div class="col">
            <div class="who"><b>{m.staff ? t('客服') : t('我')}</b><span class="tnum">{formatDateTime(m.created_at)}</span></div>
            <div class="bubble">{m.body}</div>
          </div>
        </div>
      {/each}
      <div bind:this={end}></div>
    {/if}
  </div>
  {#snippet footer()}
    {#if closed}
      <p class="closed">{t('这张工单已关闭，如果问题再次出现，请新开一张。')}</p>
    {:else}
      <div class="reply">
        <label for="ticket-reply" class="sr">{t('回复此工单…')}</label>
        <textarea id="ticket-reply" class="input" rows="2" placeholder={t('回复此工单…')} bind:value={reply} onkeydown={key}></textarea>
        <div class="acts">
          <button type="button" class="btn ghost sm muted quiet" disabled={closing.busy} onclick={() => (asking = true)}>{t('问题已解决，关闭工单')}</button>
          <span class="keys">{SEND_KEY}</span>
          <button type="button" class="btn pri" disabled={replying.busy || !reply.trim()} onclick={send}>
            <Send size={14} strokeWidth={1.75} aria-hidden="true" />{replying.busy ? t('发送中') : t('发送')}
          </button>
        </div>
      </div>
    {/if}
  {/snippet}
</Dialog>

<ConfirmDialog
  bind:open={asking}
  title={t('关闭这张工单？')}
  consequences={[t('关闭后不能再回复'), t('问题再次出现时请新开一张')]}
  confirmLabel={t('关闭工单')}
  pending={closing.busy}
  onconfirm={close}
/>

<style>
  .msgs > * + * { margin-top: 20px; }
  .order { font-size: 12.5px; color: var(--muted); }
  .msg { display: flex; gap: 10px; }
  .msg.mine { flex-direction: row-reverse; }
  .av { display: grid; place-items: center; flex: none; width: 28px; height: 28px; border-radius: 50%; background: color-mix(in srgb, #10b981 12%, transparent); color: var(--ok); font-size: 11px; font-weight: 500; }
  .mine .av { background: linear-gradient(135deg, var(--brand), var(--brand-hover)); color: #fff; }
  .col { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; max-width: 80%; }
  .mine .col { align-items: flex-end; }
  .who { display: flex; align-items: baseline; gap: 8px; }
  .mine .who { flex-direction: row-reverse; }
  .who b { font-size: 12.5px; font-weight: 600; }
  .who span { font-size: 11.5px; color: var(--muted); }
  .bubble {
    margin-top: 6px; padding: 10px 14px; border-radius: 16px 16px 16px 6px; background: var(--hover); color: var(--body);
    font-size: 14px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .mine .bubble { border-radius: 16px 16px 6px 16px; background: var(--brand); color: var(--on-brand); }
  .closed { font-size: 12.5px; line-height: 1.7; color: var(--muted); }
  .reply { display: flex; flex-direction: column; gap: 10px; }
  .reply textarea { height: 64px; min-height: 64px; max-height: 160px; padding: 8px 10px; line-height: 20px; resize: none; }
  .acts { display: flex; align-items: center; gap: 8px; }
  .acts .quiet { margin-left: -10px; }
  .keys { margin-left: auto; font-size: 11.5px; color: var(--muted); }
  .acts .btn.pri { flex: none; height: 32px; }
  .acts { height: 32px; }
  @media (max-width: 639px) {
    .keys { display: none; }
    .acts .btn.pri { margin-left: auto; }
  }
</style>
