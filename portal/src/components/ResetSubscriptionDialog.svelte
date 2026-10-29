<script lang="ts">
  import { untrack } from 'svelte';
  import { meApi } from '@/api';
  import ConfirmDialog from './ui/ConfirmDialog.svelte';
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

  /* 每次打开都从干净的状态开始：上一次失败的原因不留到下一次 */
  $effect(() => {
    if (open) untrack(() => { error = null; });
  });

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

  const consequences = $derived(['旧的订阅链接立即失效', '所有设备会立即断线，节点上的旧凭据同时作废', '所有设备都要重新导入订阅', '此操作不可撤销'].map((c) => t(c)));
</script>

<!-- 语气同「退出所有设备」：琥珀色（会断开所有设备，但不删任何东西） -->
<ConfirmDialog bind:open tone="warn" title={t('重置订阅？')} description={t('用于订阅链接泄露的情况。')} {consequences}
  confirmLabel={busy.busy ? t('重置中') : t('确认重置')} pending={busy.busy} {error} onconfirm={reset}>
</ConfirmDialog>
