<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import OctagonX from '@lucide/svelte/icons/octagon-x';
  import X from '@lucide/svelte/icons/x';
  import { t } from '$lib/i18n.svelte';
  import { dismiss, hold, toasts } from '$lib/toast.svelte';

  /*
   * 提示条（lib/toast.svelte.ts）：桌面在右下角（右上角会压住账户菜单），窄屏在顶部居中；
   * 一条 = 圆底线性图标（成功绿 / 失败红，配文字）+ 标题 + 可选说明（v1.4.0 的 sonner 样子；关闭钮悬停 / 聚焦时才出现）。读屏经 aria-live 读出来。
   */
</script>

<section class="toasts" aria-label={t('通知')} aria-live="polite">
  {#each toasts as x (x.id)}
    <div
      class="toast"
      data-kind={x.kind}
      role={x.kind === 'error' ? 'alert' : 'status'}
      onpointerenter={() => hold(x.id, true)}
      onpointerleave={() => hold(x.id, false)}
      onfocusin={() => hold(x.id, true)}
      onfocusout={() => hold(x.id, false)}
    >
      <span class="toast-i">
        {#if x.kind === 'success'}
          <CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" />
        {:else}
          <OctagonX size={16} strokeWidth={1.75} aria-hidden="true" />
        {/if}
      </span>
      <div class="toast-tx">
        <b>{x.title}</b>
        {#if x.description}<span>{x.description}</span>{/if}
      </div>
      <button type="button" class="toast-x" aria-label={t('关闭')} onclick={() => dismiss(x.id)}>
        <X size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  {/each}
</section>
