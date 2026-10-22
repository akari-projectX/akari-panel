<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import type { InviteCodes, MyInvite } from '@/api';
  import LoadError from '../LoadError.svelte';
  import Loading from '../Loading.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import type { Resource } from '$lib/resource.svelte';
  import { toast } from '$lib/toast.svelte';
  import { inviteLink, spent, terms } from '$lib/wallet';

  /*
   * 钱包页概览的右栏（只有 full）：邀请链接 + 复制、返佣条款一行（同 React 门户 wallet-invite.tsx 的 InviteLinkPane）。
   * 后台关了「允许用户邀请」/ 站点关了注册时说明原因；单次使用的站点上码用过了给一行琥珀色提示。
   */
  let { codes, invite }: { codes: Resource<InviteCodes>; invite: Resource<MyInvite> } = $props();

  const copied = new Copied<'link'>(2000);
  const c = $derived(codes.data);
  const link = $derived(c?.code ? inviteLink(c.code.code, c.link_base) : '');

  async function copy() {
    await copied.copy(link, 'link');
    if (copied.which === 'link') toast.success(tp('{what}已复制', { what: t('邀请链接') }));
  }
</script>

<section class="sec" aria-labelledby="h-link">
  <div class="sh">
    <div>
      <h2 id="h-link">{t('你的邀请链接')}</h2>
      <p>{t('通过链接注册的人会记在你名下')}</p>
    </div>
  </div>

  {#if codes.loading && !c}
    <Loading rows={1} />
  {:else if codes.error && !c}
    <LoadError error={codes.error} onretry={codes.reload} />
  {:else if c && !c.user_invites}
    <p class="why" data-testid="invites-closed">{t('本站已关闭用户邀请，暂时不能邀请新用户。已邀请的用户与返佣不受影响。')}</p>
  {:else if c && !c.register_enabled}
    <p class="why">{t('站点现在关闭了注册，邀请链接暂时用不了。重新开放注册后这里会恢复。')}</p>
  {:else if c?.code}
    <div class="copy-row">
      <input class="input" readonly value={link} aria-label={t('邀请链接')} onfocus={(e) => e.currentTarget.select()} />
      <button type="button" class="btn" onclick={copy}>
        {#if copied.which === 'link'}<Check size={15} strokeWidth={2} aria-hidden="true" />{:else}<Copy size={15} strokeWidth={1.75} aria-hidden="true" />{/if}
        {copied.which === 'link' ? t('已复制') : t('复制链接')}
      </button>
    </div>
    {#if spent(c)}<p class="spent">{t('你的邀请码已经被使用过，不能再邀请新用户。')}</p>{/if}
  {/if}
  {#if invite.data}<p class="terms">{terms(invite.data, t, tp)}</p>{/if}
</section>

<style>
  .why { font-size: 13.5px; line-height: 1.8; color: var(--muted); }
  .spent { margin-top: 8px; font-size: 12.5px; color: var(--warn); }
  .terms { margin-top: 12px; font-size: 12.5px; line-height: 1.7; color: var(--muted); }
  .copy-row .btn { gap: 6px; }
</style>
