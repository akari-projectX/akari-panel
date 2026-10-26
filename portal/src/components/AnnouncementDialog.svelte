<script lang="ts">
  import Megaphone from '@lucide/svelte/icons/megaphone';
  import Pin from '@lucide/svelte/icons/pin';
  import type { Announcement } from '@/api';
  import { formatDateTime } from '@/lib/format';
  import RichHtml from './RichHtml.svelte';
  import Dialog from './ui/Dialog.svelte';
  import { announcementText, tagOf } from '$lib/announcement';
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
  const tag = $derived(n ? tagOf(n, i18n.locale) : null);
</script>

<Dialog open={!!item} onOpenChange={(o) => { if (!o) onclose(); }} reading title={text?.title ?? ''}>
  {#snippet meta()}
    {#if n}
      <Megaphone class="rd-ann" size={14} strokeWidth={1.75} aria-hidden="true" />
      {#if n.pinned}<span class="bdg brandbadge an-pinb2"><Pin size={12} strokeWidth={1.75} aria-hidden="true" />{t('置顶')}</span>{/if}
      {#if tag}<span class="tg {tag.cls}">{tag.name}</span>{/if}
      <span class="tnum">{formatDateTime(n.created_at)}</span>
    {/if}
  {/snippet}
  {#if text}<RichHtml html={text.html} />{/if}
  {#snippet footer()}
    <div class="ok-row"><button type="button" class="btn" onclick={onclose}>{t('我知道了')}</button></div>
  {/snippet}
</Dialog>

<style>
  :global(.rd-ann) { color: var(--brand); }
  .ok-row { display: flex; justify-content: flex-end; }
  .ok-row .btn { height: 32px; }
</style>
