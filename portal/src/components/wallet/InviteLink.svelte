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

{#if codes.loading && !c}
  <Loading rows={1} />
{:else if codes.error && !c}
  <LoadError error={codes.error} onretry={codes.reload} />
{:else if c && !c.user_invites}
  <p class="pt-why" data-testid="invites-closed">{t('本站已关闭用户邀请，暂时不能邀请新用户。已邀请的用户与返佣不受影响。')}</p>
{:else if c && !c.register_enabled}
  <p class="pt-why">{t('站点现在关闭了注册，邀请链接暂时用不了。重新开放注册后这里会恢复。')}</p>
{:else if c?.code}
  <div class="cp-row">
    <input class="input" readonly value={link} aria-label={t('邀请链接')} onfocus={(e) => e.currentTarget.select()} />
    <button type="button" class="btn pri" onclick={copy}>
      {#if copied.which === 'link'}<Check size={14} strokeWidth={2} aria-hidden="true" />{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{/if}
      {copied.which === 'link' ? t('已复制') : t('复制链接')}
    </button>
  </div>
  {#if spent(c)}<p class="pt-note warn">{t('你的邀请码已经被使用过，不能再邀请新用户。')}</p>{/if}
{/if}
{#if invite.data}<p class="pt-note" style="margin-top: 12px">{terms(invite.data, t, tp)}</p>{/if}
