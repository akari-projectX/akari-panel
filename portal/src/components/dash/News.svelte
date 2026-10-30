<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import type { Announcement, Announcements } from '@/api';
  import { summarize } from '@/lib/content-text';
  import { formatMonthDay } from '@/lib/format';
  import Empty from '../Empty.svelte';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import { announcementText, tagOf } from '$lib/announcement';
  import { i18n, t } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { R } from '$lib/routes';

  /*
   * 仪表盘的「公告」（外观 A）：细线列表，每条一行——日期、标签（标签色的字）、加粗标题、一句摘要、→。
   * 置顶的在前（面板已经排好），最多三条；点一行打开公告详情（Overview 里的对话框，打开即标为已读）。
   */
  let { announcements, onopen, openIntent }: {
    announcements: Resource<Announcements>;
    onopen: (a: Announcement) => void;
    openIntent: Attachment<HTMLElement>;
  } = $props();

  const list = $derived((announcements.data?.announcements ?? []).slice(0, 3));
</script>

<section class="dsec" aria-labelledby="h-news">
  <div class="dsh">
    <h2 id="h-news">{t('公告')}</h2>
    <a class="dsh-more" href={R.announcements}>{t('全部公告')} →</a>
  </div>
  {#if announcements.loading && !announcements.data}
    <Loading rows={3} />
  {:else if announcements.error && !announcements.data}
    <LoadError error={announcements.error} onretry={announcements.reload} />
  {:else if list.length === 0}
    <Empty title={t('暂时没有公告')} />
  {:else}
    <div class="dlist">
      {#each list as a (a.id)}
        {@const at = announcementText(a, i18n.locale)}
        {@const tg = tagOf(a, i18n.locale)}
        <button type="button" class={['drow', !a.read && 'unread']} {@attach openIntent} onclick={() => onopen(a)}>
          <time class="tnum" datetime={a.created_at}>{formatMonthDay(a.created_at)}</time>
          <span class="drow-m">
            {#if a.pinned}<span class="dtag pin">{t('置顶')}</span>{/if}
            {#if tg}<span class={['dtag', tg.cls]}>{tg.name}</span>{/if}
            <b>{at.title}</b>
            {#if at.html}<small>{summarize(at.html, 60)}</small>{/if}
          </span>
          <span class="drow-go" aria-hidden="true">→</span>
        </button>
      {/each}
    </div>
  {/if}
</section>
