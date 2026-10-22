<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { meApi } from '@/api';
  import Dialog from './ui/Dialog.svelte';
  import { refresh } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Pending } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { toast } from '$lib/toast.svelte';

  /*
   * 重置订阅的确认对话框（触发按钮在 ResetSubscription.svelte，第一次点它才下载这里与 bits-ui）。
   * 面板一次做三件事（高-3）：换新链接、轮换所有入口上的凭据、断开现有连接——所有设备立即断线。每小时最多 5 次。
   * 确认按钮等请求完成才关对话框：「重置中」看得见，失败的原因留在对话框里。
   */
  let { open = $bindable(false) }: { open?: boolean } = $props();

  let error = $state<string | null>(null);
  const busy = new Pending();

  function change(o: boolean) {
    if (busy.busy) return;
    if (o) error = null;
    open = o;
  }

  function reset() {
    void busy.run(async () => {
      error = null;
      try {
        const r = await meApi.resetSubscription();
        await refresh();
        open = false;
        toast.success(t('订阅已重置'), {
          description: tp('已轮换 {n} 个入口的凭据，请在所有设备上重新导入订阅', { n: r.credentials_rotated }),
        });
      } catch (e) {
        error = errorText(e);
      }
    });
  }

  const consequences = ['旧的订阅链接立即失效', '所有设备会立即断线，节点上的旧凭据同时作废', '所有设备都要重新导入订阅', '此操作不可撤销'];
</script>

<Dialog alert bind:open onOpenChange={change} title={t('重置订阅？')} description={t('链接泄露时重置。所有设备都会断开，需要重新导入。')}>
  {#snippet icon()}<TriangleAlert class="dlg-icon warn-icon" size={20} strokeWidth={1.5} aria-hidden="true" />{/snippet}
  <ul class="cons">
    {#each consequences as c (c)}<li>{t(c)}</li>{/each}
  </ul>
  {#if error}<p class="err-line" role="alert">{error}</p>{/if}
  {#snippet footer()}
    <button type="button" class="btn" disabled={busy.busy} onclick={() => change(false)}>{t('取消')}</button>
    <button type="button" class="btn danger" disabled={busy.busy} onclick={reset}>{busy.busy ? t('重置中') : t('确认重置')}</button>
  {/snippet}
</Dialog>

<style>
  :global(.dlg .warn-icon) { color: var(--warn); }
  .cons { display: flex; flex-direction: column; gap: 6px; padding-left: 18px; list-style: disc; font-size: 13.5px; color: var(--body); }
  .cons li::marker { color: var(--faint); }
  .err-line { margin-top: 14px; font-size: 13px; color: var(--danger); }
  .danger { background: var(--warn); border-color: var(--warn); color: var(--on-solid); }
  .danger:hover:not(:disabled) { border-color: var(--warn); filter: brightness(.95); }
</style>
