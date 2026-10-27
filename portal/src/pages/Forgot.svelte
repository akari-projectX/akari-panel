<script lang="ts">
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import MailCheck from '@lucide/svelte/icons/mail-check';
  import { authApi } from '@/api';
  import AuthShell from '../components/auth/AuthShell.svelte';
  import AuthTitle from '../components/auth/AuthTitle.svelte';
  import GuardFields from '../components/GuardFields.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TextField from '../components/TextField.svelte';
  import { site } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { FormGuard } from '$lib/form-guard.svelte';
  import { FieldErrors, Pending, fieldOf, isEmail } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';
  import { siteFlags } from '$lib/site';
  import { toast } from '$lib/toast.svelte';

  /*
   * 找回密码：申请重置链接。
   * 面板的流程是「邮件里的一次性链接（30 分钟）→ 设新密码」，不是验证码；只有已验证的邮箱才收得到；
   * 对任何地址都答 ok，页面也就只能说「如果……就会收到」。
   */
  const s = $derived(siteFlags(site.options));
  const guard = new FormGuard('reset');
  const f = new FieldErrors(['email'] as const);
  const sending = new Pending();
  let email = $state('');
  let sent = $state(false);

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!f.check({ email: !email.trim() ? t('请输入邮箱') : !isEmail(email) ? t('请输入有效的邮箱地址') : undefined })) return;
    void sending.run(async () => {
      try {
        await authApi.resetRequest(email.trim(), await guard.build());
        sent = true;
      } catch (err) {
        if (fieldOf(err, { 'signup.invalid_email': 'email' } as const)) f.set('email', errorText(err));
        else toast.error(errorText(err));
      } finally {
        guard.after();
      }
    });
  }
</script>

<AuthShell>
  {#if !s.loading && !s.resetOpen}
    <AuthTitle title={t('找回密码')} lead={t('本站没有开放自助找回密码。')} />
    <p class="quiet-box">{t('请联系站点管理员重置密码。')}</p>
    <a class="btn btn-block btn-gap" href={R.login}>{t('返回登录')}</a>
  {:else if sent}
    <AuthTitle title={t('查收邮件')} lead={t('如果这个邮箱已注册并验证过，重置链接已经发出，30 分钟内有效。')}>
      {#snippet icon()}<MailCheck size={20} strokeWidth={1.75} aria-hidden="true" />{/snippet}
    </AuthTitle>
    <p class="au-note">{t('没收到的话看看垃圾邮件箱。没有验证过的邮箱收不到重置邮件，请联系管理员。')}</p>
    <a class="btn btn-block btn-gap" href={R.login}>{t('返回登录')}</a>
  {:else}
    <AuthTitle title={t('找回密码')} lead={t('填写登录邮箱，我们会把重置链接发给你。')} />
    <form novalidate onsubmit={submit} class="form">
      <TextField
        {...f.field('email', 'forgot-email')}
        label={t('邮箱')} type="email" autocomplete="email" placeholder="you@example.com"
        bind:value={email}
      />
      <GuardFields {guard} />
      <button type="submit" class="btn pri btn-block" disabled={sending.busy || !guard.ready || guard.unavailable}>
        {#if sending.busy}<Spinner size={16} />{/if}
        {sending.busy ? t('提交中') : t('发送重置链接')}
      </button>
    </form>
    <a class="back" href={R.login}><ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />{t('返回登录')}</a>
  {/if}
</AuthShell>
