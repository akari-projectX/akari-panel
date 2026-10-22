<script lang="ts">
  import MailCheck from '@lucide/svelte/icons/mail-check';
  import { meApi } from '@/api';
  import TextField from './TextField.svelte';
  import Dialog from './ui/Dialog.svelte';
  import { refresh, signOut, site } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Countdown, FieldErrors, Pending, digits, fieldOf, isCode, isEmail } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { domainsLine, siteFlags } from '$lib/site';
  import { toast } from '$lib/toast.svelte';

  /*
   * 用通行密钥注册之后的第一步：绑定邮箱（与 React 门户 bind-email-dialog.tsx 相同）。账户在这之前除了这里什么接口都用不了
   * （面板答 403 account.email_required），所以这个对话框**不可关闭**（没有关闭按钮，遮罩和 Esc 都不起作用）。
   * 站点要求验证邮箱就发验证码，否则直接绑定；密码选填，可以跳过，以后在设置页设置。24 小时内没完成，账户会被自动清理。
   */
  const s = $derived(siteFlags(site.options));
  const f = new FieldErrors(['email', 'code', 'pwd'] as const);
  const busy = new Pending();
  const resend = new Countdown();
  $effect(() => () => resend.stop());
  let email = $state('');
  let code = $state('');
  let pwd = $state('');
  let sent = $state(false);

  const FIELD_CODES = {
    'signup.invalid_email': 'email', 'signup.domain_not_allowed': 'email', 'signup.unavailable': 'email',
    'signup.invalid_code': 'code', 'account.bind_no_code': 'code',
    'account.password_too_short': 'pwd', 'account.password_too_long': 'pwd',
  } as const;
  const showError = (err: unknown) => {
    const k = fieldOf(err, FIELD_CODES);
    if (k) f.set(k, errorText(err));
    else toast.error(errorText(err));
  };
  const emailError = () => (!email.trim() ? t('请输入邮箱') : !isEmail(email) ? t('请输入有效的邮箱地址') : undefined);

  function send() {
    if (!f.check({ email: emailError() })) return;
    void busy.run(async () => {
      try {
        await meApi.emailBindCode(email.trim());
        sent = true;
        resend.start(60);
        toast.success(t('如果这个邮箱可以使用，验证码已经发出'), { description: t('请查收邮件，也看看垃圾邮件箱') });
      } catch (err) {
        showError(err);
      }
    });
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    const verify = s.emailVerify;
    if (!f.check({
      email: !verify ? emailError() : undefined,
      code: verify && (!sent ? t('请先发送验证码') : !isCode(code) ? t('请输入 6 位数字验证码') : undefined),
      pwd: pwd && pwd.length < 8 && t('密码至少 8 位'),
    })) return;
    void busy.run(async () => {
      try {
        await meApi.emailBind({
          ...(verify ? { code: code.trim() } : { email: email.trim() }),
          ...(pwd ? { password: pwd } : {}),
        });
        await refresh();
        toast.success(t('邮箱已绑定'), { description: t('以后用这个邮箱登录，到期提醒和收据也会发到这里。') });
      } catch (err) {
        showError(err);
      }
    });
  }
</script>

<Dialog
  open
  dismissible={false}
  title={t('绑定邮箱')}
  description={t('账号已创建。请先绑定一个邮箱：它是你的登录名，用来接收提醒和找回账号。完成之前其他功能都不能使用。')}
>
  {#snippet icon()}<MailCheck class="dlg-icon" size={20} strokeWidth={1.5} aria-hidden="true" />{/snippet}
  <form id="bind-email" novalidate onsubmit={submit} class="form">
    <TextField
      {...f.field('email', 'bind-email-addr')}
      label={t('邮箱')} type="email" autocomplete="email" placeholder="name@example.com"
      bind:value={email} disabled={s.emailVerify && sent}
      help={s.emailDomains.length > 0 ? `${t('仅限')} ${domainsLine(s.emailDomains)}` : undefined}
    />
    {#if s.emailVerify}
      <TextField
        {...f.field('code', 'bind-email-code')}
        label={t('邮箱验证码')} inputmode="numeric" autocomplete="one-time-code" maxlength={6} placeholder={t('六位数字')}
        class="num" bind:value={code}
        oninput={(e) => { code = digits(e.currentTarget.value); f.dismiss('code'); }}
      >
        {#snippet after()}
          <button type="button" class="btn side" disabled={busy.busy || resend.left > 0} onclick={send}>
            {resend.left > 0 ? tp('{n} 秒后重发', { n: resend.left }) : sent ? t('重新发送') : t('发送验证码')}
          </button>
        {/snippet}
      </TextField>
    {/if}
    <TextField
      {...f.field('pwd', 'bind-email-pwd')}
      label={`${t('密码')}（${t('选填')}）`} type="password" autocomplete="new-password"
      placeholder={t('可以先跳过，以后在设置页设置')} help={t('至少 8 位')}
      bind:value={pwd}
    />
  </form>
  {#snippet footer()}
    <button type="button" class="btn" disabled={busy.busy} onclick={() => void signOut()}>{t('退出登录')}</button>
    <button type="submit" form="bind-email" class="btn pri" disabled={busy.busy}>{busy.busy ? t('提交中') : t('完成绑定')}</button>
  {/snippet}
</Dialog>
