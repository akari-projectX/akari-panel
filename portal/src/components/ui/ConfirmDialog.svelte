<script lang="ts">
  import type { Snippet } from 'svelte';
  import Dialog from './Dialog.svelte';
  import { t } from '$lib/i18n.svelte';

  /*
   * 确认对话框：标题、可选说明、「会发生什么」的清单、
   * 取消 + 确认。确认按钮等 onconfirm 完成：调用方在成功时把 open 关掉，失败的原因经 error 留在框里。
   * tone：warn（琥珀实底，退出所有设备、只用通行密钥）/ danger（红色实底，删除）/ brand（关闭工单这类普通确认）。
   * 进行中（pending）时不能关掉。role="alertdialog"。
   */
  let {
    open = $bindable(false), title, description, consequences = [], confirmLabel, tone = 'brand', pending = false, error = null, onconfirm, icon,
  }: {
    open?: boolean;
    title: string;
    description?: string;
    consequences?: string[];
    confirmLabel: string;
    tone?: 'brand' | 'warn' | 'danger';
    pending?: boolean;
    error?: string | null;
    onconfirm: () => void;
    icon?: Snippet;
  } = $props();

  function change(o: boolean) {
    if (pending && !o) { open = true; return; }
    open = o;
  }
</script>

<Dialog alert {tone} bind:open onOpenChange={change} {title} {description} {icon}>
  {#if consequences.length || error}
    {#if consequences.length}
      <ul class="cons">
        {#each consequences as c (c)}<li>{c}</li>{/each}
      </ul>
    {/if}
    {#if error}<p class="err-line" role="alert">{error}</p>{/if}
  {/if}
  {#snippet footer()}
    <button type="button" class="btn" disabled={pending} onclick={() => change(false)}>{t('取消')}</button>
    <button type="button" class="btn ok-{tone}" disabled={pending} onclick={onconfirm}>{confirmLabel}</button>
  {/snippet}
</Dialog>

<style>
  /* 「会发生什么」：浅底的清单，每条前面一个语气色的小圆点 */
  .cons { display: flex; flex-direction: column; gap: 8px; margin-top: 20px; padding: 14px 16px; border-radius: calc(var(--radius) * 1.4); background: color-mix(in srgb, var(--hover) 60%, transparent); font-size: 13px; line-height: 1.6; color: var(--body); }
  .cons li { position: relative; padding-left: 16px; }
  .cons li::before { content: ''; position: absolute; left: 0; top: .6em; width: 6px; height: 6px; border-radius: 9999px; background: var(--brand); }
  :global(.dlg[data-tone='warn']) .cons li::before { background: var(--warn); }
  :global(.dlg[data-tone='danger']) .cons li::before { background: var(--danger); }
  .err-line { margin-top: 16px; font-size: 13px; color: var(--danger); }
  .ok-brand { background: var(--brand); border-color: var(--brand); color: var(--on-brand); }
  .ok-warn { background: var(--warn); border-color: var(--warn); color: var(--on-solid); }
  .ok-danger { background: var(--danger); border-color: var(--danger); color: var(--on-solid); }
  .ok-brand:hover:not(:disabled), .ok-warn:hover:not(:disabled), .ok-danger:hover:not(:disabled) { filter: brightness(.95); }
</style>
