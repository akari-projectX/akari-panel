<script lang="ts">
  import { AlertDialog, Dialog } from 'bits-ui';
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n.svelte';
  import { trackViewport } from '$lib/visual-viewport';

  /*
   * 对话框（bits-ui Dialog：焦点困在框里、Esc、点遮罩、锁滚动、关闭后焦点还给触发它的元素、aria-modal / 标题 / 说明）。
   * 版式是 v1.4.0 的弹窗（居中的卡片，手机上也居中、四边留 12px）：流程弹窗 = 图标 + 标题 + 一行说明、可滚动的正文、底部一条不动的按钮栏；
   * alert（确认）= 窄的一版（420px），按钮等宽并排。tone 决定图标底色（brand / warn / danger）。
   * alert：确认 / 破坏性操作用 role="alertdialog"，aria-labelledby / aria-describedby 指向标题和说明。
   * dismissible=false：不可关闭（没有关闭按钮，遮罩和 Esc 都不起作用，例如「绑定邮箱」）。wide：520px（确认订单，样稿同宽）。
   */
  let {
    open = $bindable(false), onOpenChange, dismissible = true, wide = false, alert = false, reading = false, meta, tone = 'brand', title, description, icon, children, footer,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    dismissible?: boolean;
    wide?: boolean;
    alert?: boolean;
    reading?: boolean;
    meta?: Snippet;
    tone?: 'brand' | 'warn' | 'danger';
    title: string;
    description?: string;
    icon?: Snippet;
    children?: Snippet;
    footer?: Snippet;
  } = $props();

  /* 开着时跟踪可见视口：手机弹出软键盘，弹窗挪到键盘上方（v1.4.0） */
  $effect(() => (open ? trackViewport() : undefined));

  /* AlertDialog 与 Dialog 共用同一份根状态（Title / Description / Close 通用），只换 Root 与 Content 的角色 */
  const D = $derived(alert ? AlertDialog : Dialog);
</script>

<D.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="dlg-overlay" />
    <D.Content
      class={['dlg', wide && 'wide', alert && 'confirm', reading && 'reading']}
      data-tone={tone}
      escapeKeydownBehavior={dismissible ? 'close' : 'ignore'}
      interactOutsideBehavior={dismissible ? 'close' : 'ignore'}
    >
      {#if reading}
        <header>
          {#if meta}<div class="rd-meta">{@render meta()}</div>{/if}
          <Dialog.Title level={2}>{title}</Dialog.Title>
          {#if description}<Dialog.Description class="sr">{description}</Dialog.Description>{/if}
          <Dialog.Close class="dlg-x" aria-label={t('关闭')}><X size={16} strokeWidth={1.75} aria-hidden="true" /></Dialog.Close>
        </header>
      {:else}
        <header>
          <div class="dlg-head">
            {@render icon?.()}
            <div>
              <Dialog.Title level={2}>{title}</Dialog.Title>
              {#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
            </div>
          </div>
          {#if dismissible}
            <Dialog.Close class="dlg-x" aria-label={t('关闭')}><X size={16} strokeWidth={1.75} aria-hidden="true" /></Dialog.Close>
          {/if}
        </header>
      {/if}
      {#if children}<div class="bd">{#if reading}<div class="rd-in">{@render children()}</div>{:else}{@render children()}{/if}</div>{/if}
      {#if footer}<footer>{@render footer()}</footer>{/if}
    </D.Content>
  </Dialog.Portal>
</D.Root>
