<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Headphones from '@lucide/svelte/icons/headphones';
  import { formatDateTime } from '@/lib/format';
  import { auth } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';

  /* 封禁账户的仪表盘：管理员写的原因 + 工单入口，别的都看不了（与 React 门户 dashboard.tsx 的 BannedNotice 相同） */
  const me = $derived(auth.me);
</script>

<div class="ph">
  <div>
    <h1>{t('账户已被封禁')}</h1>
    <p>{t('封禁期间不能使用订阅和节点，也不能购买。')}</p>
  </div>
</div>

<section class="sec banned">
  <Ban class="mark" size={20} strokeWidth={1.75} aria-hidden="true" />
  <div class="body">
    {#if me?.banned_at}<p class="when num">{tp('封禁时间 {t}', { t: formatDateTime(me.banned_at) })}</p>{/if}
    <div>
      <div class="k">{t('原因')}</div>
      <p class="reason">{me?.ban_reason || t('管理员没有填写原因。')}</p>
    </div>
    <p class="when">{t('如有异议，可以提交工单联系管理员。')}</p>
    <a class="btn pri" href={R.tickets}><Headphones size={15} strokeWidth={1.75} aria-hidden="true" />{t('提交或查看工单')}</a>
  </div>
</section>

<style>
  .banned { display: flex; align-items: flex-start; gap: 16px; max-width: 66ch; }
  .banned :global(.mark) { flex: none; margin-top: 4px; color: var(--danger); }
  .body { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; min-width: 0; font-size: 14px; line-height: 1.9; }
  .when { color: var(--muted); }
  .k { font-size: 13px; color: var(--muted); }
  .reason { margin-top: 2px; color: var(--fg); white-space: pre-wrap; }
</style>
