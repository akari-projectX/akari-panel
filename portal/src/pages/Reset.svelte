<script lang="ts">
  import { authApi } from '@/api';
  import AuthShell from '../components/auth/AuthShell.svelte';
  import AuthTitle from '../components/auth/AuthTitle.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TextField from '../components/TextField.svelte';
  import { errorText } from '$lib/errors';
  import { FieldErrors, Pending, fieldOf } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';
  import { navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 按邮件链接设新密码（与 React 门户 pages/auth.tsx 的 Reset 相同）。
   * 邮件里的链接是 …/reset#token=…：令牌放在 # 后面，不会出现在服务器日志和 Referer 里；读到之后就从地址栏抹掉
   * （免得被截图、被浏览器历史同步走）。设好之后这个账户所有的会话都会结束，需要重新登录。
   */
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ?? '';
  if (location.hash) history.replaceState(history.state, '', location.pathname + location.search);

  const f = new FieldErrors(['pwd', 'confirm'] as const);
  const sending = new Pending();
  let pwd = $state('');
  let confirm = $state('');

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!f.check({
      pwd: !pwd ? t('请输入新密码') : pwd.length < 8 ? t('新密码至少 8 位') : undefined,
      confirm: !confirm ? t('请再次输入新密码') : confirm !== pwd ? t('两次输入的新密码不一致') : undefined,
    })) return;
    void sending.run(async () => {
      try {
        await authApi.reset(token, pwd);
        toast.success(t('密码已重置，请用新密码登录'), { description: t('所有设备上的登录都已结束') });
        navigate(R.login, { replace: true });
      } catch (err) {
        const k = fieldOf(err, { 'account.password_too_short': 'pwd', 'account.password_too_long': 'pwd' } as const);
        if (k) f.set(k, errorText(err));
        else toast.error(errorText(err));
      }
    });
  }
</script>

<AuthShell>
  {#if !token}
    <AuthTitle title={t('链接无效')} lead={t('这个重置链接不完整或已经用过了。')} />
    <a class="btn pri btn-block btn-gap" href={R.forgot}>{t('重新申请重置')}</a>
  {:else}
    <AuthTitle title={t('设置新密码')} lead={t('设好之后，所有设备上的登录都会结束。')} />
    <form novalidate onsubmit={submit} class="form">
      <TextField
        {...f.field('pwd', 'reset-password')}
        label={t('新密码')} type="password" autocomplete="new-password" help={t('至少 8 位')}
        bind:value={pwd}
      />
      <TextField
        {...f.field('confirm', 'reset-confirm')}
        label={t('确认新密码')} type="password" autocomplete="new-password" placeholder={t('再次输入新密码')}
        bind:value={confirm}
        onblur={() => { if (confirm && confirm !== pwd) f.set('confirm', t('两次输入的新密码不一致'), false); }}
      />
      <button type="submit" class="btn pri btn-block" disabled={sending.busy}>
        {#if sending.busy}<Spinner size={16} />{/if}
        {sending.busy ? t('提交中') : t('重置密码')}
      </button>
    </form>
  {/if}
</AuthShell>
