<script lang="ts">
  import type { Announcement } from '@/api';
  import { formatDateTime } from '@/lib/format';
  import RichHtml from './RichHtml.svelte';
  import Dialog from './ui/Dialog.svelte';
  import { announcementText } from '$lib/announcement';
  import { i18n, t } from '$lib/i18n.svelte';

  /*
   * 公告详情（仪表盘与公告页共用；与 React 门户 announcement-dialog.tsx 相同）：标题、发布时间（置顶的注明）、
   * 面板渲染并清洗好的正文（RichHtml）、「我知道了」。关闭时 item 先变成 null、对话框后退场：退场那一下接着显示刚才那一条。
   */
  let { item, onclose }: { item: Announcement | null; onclose: () => void } = $props();

  let shown = $state<Announcement | null>(null);
  $effect(() => { if (item) shown = item; });
  const n = $derived(item ?? shown);
  const text = $derived(n ? announcementText(n, i18n.locale) : null);
  const meta = $derived(n ? `${formatDateTime(n.created_at)}${n.pinned ? ` · ${t('置顶')}` : ''}` : '');
</script>

<Dialog open={!!item} onOpenChange={(o) => { if (!o) onclose(); }} title={text?.title ?? ''} description={meta}>
  {#if text}<RichHtml html={text.html} />{/if}
  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>{t('我知道了')}</button>
  {/snippet}
</Dialog>
