<script lang="ts">
  import { Dialog } from 'bits-ui';
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n.svelte';

  /*
   * 对话框（bits-ui Dialog：焦点困在框里、Esc、点遮罩、锁滚动、关闭后焦点还给触发它的元素、aria-modal / 标题 / 说明）。
   * 版式是样稿 shop.html#confirm 的 .dlg：标题 + 一行说明、正文、底部右对齐的按钮；窄屏（≤ 720px）变成底部抽屉，按钮等宽。
   * dismissible=false：不可关闭（没有关闭按钮，遮罩和 Esc 都不起作用，例如「绑定邮箱」）。
   */
  let {
    open = $bindable(false), onOpenChange, dismissible = true, title, description, icon, children, footer,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    dismissible?: boolean;
    title: string;
    description?: string;
    icon?: Snippet;
    children?: Snippet;
    footer?: Snippet;
  } = $props();
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="dlg-overlay" />
    <Dialog.Content
      class="dlg"
      escapeKeydownBehavior={dismissible ? 'close' : 'ignore'}
      interactOutsideBehavior={dismissible ? 'close' : 'ignore'}
    >
      <header>
        <div class="dlg-head">
          {@render icon?.()}
          <div>
            <Dialog.Title level={2}>{title}</Dialog.Title>
            {#if description}<Dialog.Description>{description}</Dialog.Description>{/if}
          </div>
        </div>
        {#if dismissible}
          <Dialog.Close class="iconbtn" aria-label={t('关闭')}><X size={16} strokeWidth={1.75} aria-hidden="true" /></Dialog.Close>
        {/if}
      </header>
      {#if children}<div class="bd">{@render children()}</div>{/if}
      {#if footer}<footer>{@render footer()}</footer>{/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
