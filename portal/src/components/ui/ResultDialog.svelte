<script lang="ts">
  import { Dialog } from 'bits-ui';
  import X from '@lucide/svelte/icons/x';
  import type { Snippet } from 'svelte';
  import { t } from '$lib/i18n.svelte';

  /*
   * 结果弹窗（v1.4.0 panels.tsx 的 ResultDialog）：付款成功、订单超时。窄（400px）、居中、上面一个大图标（调用方给，带自己的动效），
   * 下面标题、说明、小结与两个等宽按钮。可以关闭（Esc、遮罩、右上角）——结果已经发生，关掉不会丢任何东西。
   */
  let { open = $bindable(true), onOpenChange, mark, title, description, children, actions }: {
    open?: boolean;
    onOpenChange?: (o: boolean) => void;
    mark: Snippet;
    title: string;
    description?: string;
    children?: Snippet;
    actions: Snippet;
  } = $props();
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="dlg-overlay" />
    <Dialog.Content class="dlg result">
      <div class="rd-mark">{@render mark()}</div>
      <Dialog.Title level={2} class="rd-title">{title}</Dialog.Title>
      {#if description}<Dialog.Description class="rd-desc">{description}</Dialog.Description>{/if}
      {@render children?.()}
      <div class="rd-acts">{@render actions()}</div>
      <Dialog.Close class="dlg-x" aria-label={t('关闭')}><X size={16} strokeWidth={1.75} aria-hidden="true" /></Dialog.Close>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
