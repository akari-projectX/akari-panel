<script lang="ts">
  import Lock from '@lucide/svelte/icons/lock';
  import { meApi, passkeyApi } from '@/api';
  import { isUserCancel } from '@/api/webauthn';
  import TextField from '../TextField.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { errorText } from '$lib/errors';
  import { FieldErrors, Pending, fieldOf } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';
  import { toast } from '$lib/toast.svelte';

  /*
   * 修改密码 / 设置第一个密码（用通行密钥注册、还没有密码的账户：先用通行密钥确认是本人）。与 React 门户 settings/password-dialog.tsx 相同：
   * 「至少 8 位」是常驻的帮助文字，确认框离开时就比对；错误画在字段下面并聚焦，不弹浏览器气泡。改密码后面板结束其它会话，当前这个保留。
   */
  let { open = $bindable(false), first, ondone }: { open?: boolean; first: boolean; ondone: () => void } = $props();

  const MIN = 8;
  let current = $state('');
  let next = $state('');
  let again = $state('');
  const busy = new Pending();
  const f = new FieldErrors(['current', 'next', 'again'] as const);

  function clear() {
    current = '';
    next = '';
    again = '';
    f.check({});
  }

  function change(o: boolean) {
    if (busy.busy) return;
    if (!o) clear();
    open = o;
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!f.check({
      current: !first && !current && t('请输入当前密码'),
      next: !next ? t('请输入新密码') : next.length < MIN ? t('新密码至少 8 位') : undefined,
      again: !again ? t('请再次输入新密码') : again !== next ? t('两次输入的新密码不一致') : undefined,
    })) return;
    void busy.run(async () => {
      try {
        if (first) {
          await meApi.setFirstPassword(next, await passkeyApi.confirm());
          toast.success(t('密码已设置'), { description: t('以后可以用邮箱和密码登录') });
        } else {
          await meApi.changePassword(current, next);
          toast.success(t('密码已更新'), { description: t('其他设备上的登录已经结束') });
        }
        ondone();
        clear();
        open = false;
      } catch (err) {
        if (isUserCancel(err)) return;
        const k = fieldOf(err, {
          'account.invalid_password': 'current', 'account.password_required': 'current',
          'account.password_too_short': 'next', 'account.password_too_long': 'next',
        } as const);
        if (k) f.set(first && k === 'current' ? 'next' : k, errorText(err));
        else toast.error(errorText(err));
      }
    });
  }
</script>

<Dialog
  bind:open onOpenChange={change}
  title={first ? t('设置密码') : t('修改密码')}
  description={first ? t('这个账号还没有密码，只能用通行密钥登录。设置密码需要先用通行密钥确认是你本人。') : t('密码更新后，其他设备需要重新登录')}
>
  {#snippet icon()}<Lock class="dlg-icon" size={20} strokeWidth={1.5} aria-hidden="true" />{/snippet}
  <form id="password-form" novalidate onsubmit={submit} class="form">
    {#if !first}
      <TextField {...f.field('current', 'current-password')} label={t('当前密码')} type="password" autocomplete="current-password" bind:value={current} />
    {/if}
    <TextField {...f.field('next', 'new-password')} label={t('新密码')} type="password" autocomplete="new-password" help={t('至少 8 位')} bind:value={next} />
    <TextField
      {...f.field('again', 'confirm-password')} label={t('确认新密码')} type="password" autocomplete="new-password" bind:value={again}
      onblur={() => { if (again.length > 0 && again !== next) f.set('again', t('两次输入的新密码不一致'), false); }}
    />
  </form>
  {#snippet footer()}
    <button type="button" class="btn" disabled={busy.busy} onclick={() => change(false)}>{t('取消')}</button>
    <button type="submit" form="password-form" class="btn pri" disabled={busy.busy}>
      {busy.busy ? t('提交中') : first ? t('用通行密钥确认并设置') : t('更新密码')}
    </button>
  {/snippet}
</Dialog>

<style>
  .form { display: flex; flex-direction: column; gap: 16px; }
</style>
