<script lang="ts">
  import LifeBuoy from '@lucide/svelte/icons/life-buoy';
  import {
    TICKET_CATEGORIES, TICKET_MAX_BODY, TICKET_MAX_SUBJECT, TICKET_PRIORITIES, orderApi, ticketApi,
    type TicketCategory, type TicketPriority,
  } from '@/api';
  import { K } from '@/lib/cache';
  import TextField from '../TextField.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { scope } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { FieldErrors, Pending, fieldOf } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { CATEGORY, PRIORITY } from '$lib/tickets';
  import { toast } from '$lib/toast.svelte';

  /*
   * 提交新工单（与 React 门户 tickets.tsx 的 FlowDialog 相同）：标题、分类、关联订单（封禁账户看不了订单，不出现）、
   * 优先级（四档并排点选，选中的那一档说明它意味着什么）、详细描述；底部写着还能写多少字。
   * noValidate + 内联错误：提交时检查，第一个出错的字段被聚焦（按钮不预先置灰）。成功后由页面打开这张新工单。
   */
  let { open = $bindable(false), oncreated }: { open?: boolean; oncreated: (id: string) => void } = $props();

  let subject = $state('');
  let category = $state<TicketCategory>('general');
  let priority = $state<TicketPriority>('normal');
  let orderId = $state('none');
  let message = $state('');
  const busy = new Pending();
  const f = new FieldErrors(['subject', 'message'] as const);
  f.field('message', 'ticket-message');

  const banned = $derived(scope() === 'banned');
  const orders = resource(() => ({ key: K.orders, fetch: () => orderApi.list(), enabled: open && !banned }));

  function change(o: boolean) {
    if (o) f.check({});
    open = o;
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!f.check({
      subject: !subject.trim() && t('请填写问题标题'),
      message: !message.trim() && t('请描述遇到的问题'),
    })) return;
    void busy.run(async () => {
      try {
        const r = await ticketApi.create({
          subject: subject.trim(), category, priority, message: message.trim(),
          ...(orderId !== 'none' ? { order_id: orderId } : {}),
        });
        toast.success(t('工单已提交'), { description: t('客服回复后这一页会显示新消息') });
        subject = '';
        message = '';
        orderId = 'none';
        oncreated(r.id);
      } catch (err) {
        const k = fieldOf(err, {
          'ticket.subject_required': 'subject', 'ticket.subject_long': 'subject', 'ticket.subject_multiline': 'subject',
          'ticket.message_required': 'message', 'ticket.message_long': 'message',
        } as const);
        if (k) f.set(k, errorText(err));
        else toast.error(errorText(err));
      }
    });
  }
</script>

<Dialog bind:open onOpenChange={change} wide title={t('提交新工单')} description={t('把现象、时间和用的客户端写清楚，能省掉一轮来回')}>
  {#snippet icon()}<LifeBuoy class="dlg-icon" size={20} strokeWidth={1.5} aria-hidden="true" />{/snippet}
  <form id="ticket-form" novalidate onsubmit={submit} class="form">
    <TextField
      {...f.field('subject', 'ticket-subject')}
      label={t('问题标题')} maxlength={TICKET_MAX_SUBJECT} autocomplete="off" placeholder={t('例如：香港节点无法连接')}
      bind:value={subject}
    />
    <div class="two">
      <div class="field">
        <div class="field-label"><label for="ticket-category">{t('分类')}</label></div>
        <select id="ticket-category" class="input" bind:value={category}>
          {#each TICKET_CATEGORIES as c (c)}<option value={c}>{t(CATEGORY[c])}</option>{/each}
        </select>
      </div>
      {#if !banned}
        <div class="field">
          <div class="field-label"><label for="ticket-order">{t('关联订单')}</label></div>
          <select id="ticket-order" class="input" bind:value={orderId}>
            <option value="none">{t('不关联')}</option>
            {#each (orders.data ?? []).slice(0, 20) as o (o.id)}<option value={o.id}>{o.plan_name} · {o.out_trade_no}</option>{/each}
          </select>
        </div>
      {/if}
    </div>
    <fieldset class="prio">
      <legend>{t('优先级')}</legend>
      <div class="opts">
        {#each TICKET_PRIORITIES as v (v)}
          <label class:on={priority === v}>
            <input type="radio" name="ticket-priority" value={v} bind:group={priority} class="sr" />
            {t(PRIORITY[v].text)}
          </label>
        {/each}
      </div>
      <p class="hint">{t(PRIORITY[priority].hint)}</p>
    </fieldset>
    <div class="field">
      <div class="field-label"><label for="ticket-message">{t('详细描述')}</label></div>
      <textarea
        id="ticket-message" class="input" rows="6" maxlength={TICKET_MAX_BODY} bind:value={message}
        oninput={() => f.dismiss('message')}
        aria-invalid={f.errors.message ? true : undefined}
        aria-describedby={f.errors.message ? 'ticket-message-msg' : undefined}
        placeholder={t('请描述问题现象、出现时间、使用的节点与客户端版本，以便我们更快定位。')}
      ></textarea>
      {#if f.errors.message}<p id="ticket-message-msg" role="alert" class="field-msg bad">{f.errors.message}</p>{/if}
    </div>
  </form>
  {#snippet footer()}
    <span class="left num">{tp('还能写 {n} 字', { n: TICKET_MAX_BODY - message.length })}</span>
    <button type="button" class="btn" onclick={() => change(false)}>{t('取消')}</button>
    <button type="submit" form="ticket-form" class="btn pri" disabled={busy.busy}>{busy.busy ? t('提交中') : t('提交工单')}</button>
  {/snippet}
</Dialog>

<style>
  .form { display: flex; flex-direction: column; gap: 16px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .prio { margin: 0; padding: 0; border: 0; min-width: 0; }
  .prio legend { margin-bottom: 6px; padding: 0; font-size: 13px; font-weight: 500; color: var(--body); }
  .opts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .opts label {
    display: grid; place-items: center; height: 38px; border: 1px solid var(--line2); border-radius: 8px;
    font-size: 13.5px; color: var(--body); cursor: pointer; transition: border-color var(--dur-hover) var(--ease-out);
  }
  .opts label:hover { border-color: color-mix(in srgb, var(--fg) 28%, transparent); }
  .opts label.on { border-color: var(--brand); color: var(--brand); font-weight: 500; box-shadow: inset 0 0 0 1px var(--brand); }
  .opts label:has(:focus-visible) { box-shadow: var(--focus); }
  .hint { margin-top: 6px; font-size: 12.5px; color: var(--muted); }
  .left { margin-right: auto; align-self: center; font-size: 12.5px; color: var(--muted); }
  @media (max-width: 720px) {
    .two { grid-template-columns: 1fr; }
    .left { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .opts label { transition: none; }
  }
</style>
