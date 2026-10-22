<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import { authApi } from '@/api';
  import { solvePow } from '@/api/pow';
  import { isUserCancel, webauthnSupported } from '@/api/webauthn';
  import AuthShell from '../components/auth/AuthShell.svelte';
  import AuthTabs from '../components/auth/AuthTabs.svelte';
  import AuthTitle from '../components/auth/AuthTitle.svelte';
  import CodeField from '../components/auth/CodeField.svelte';
  import GuardFields from '../components/GuardFields.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TextField from '../components/TextField.svelte';
  import { signIn, site } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { FormGuard } from '$lib/form-guard.svelte';
  import { FieldErrors, fieldOf, isCode, isEmail } from '$lib/forms.svelte';
  import { i18n, t } from '$lib/i18n.svelte';
  import { navigate, param } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { domainsLine, mailLocale, siteFlags } from '$lib/site';
  import { toast } from '$lib/toast.svelte';

  /*
   * 注册（样稿 login.html#register）：邮箱 → 邮箱验证码（站点要求验证时）→ 密码（下方三条规则）→ 邀请码 → 创建账号；
   * 行为与 React 门户 pages/auth.tsx 的 Register 相同：
   *   · 不发验证码时浏览器替用户做一小份工作量证明（几秒），挡住批量注册；
   *   · 邀请链接 /register?invite=XXXX 预填；后台关了「允许用户邀请」时不显示也不提交邀请码；
   *   · 面板的错误码对应到字段的画在字段下面，其余用提示条；
   *   · 用通行密钥注册：不填邮箱和密码，账号建好后在弹窗里绑定邮箱（DashLayout 的 BindEmailDialog）；
   *   · 后台关了注册：一进来就说「网站已暂停注册新用户」，邀请链接也一样。
   */
  type Phase = 'idle' | 'pow' | 'submit';

  const s = $derived(siteFlags(site.options));
  const guard = new FormGuard('register');
  const f = new FieldErrors(['email', 'password', 'invite', 'code'] as const);
  let email = $state('');
  let pwd = $state('');
  let code = $state('');
  let invite = $state(param('invite')?.trim() ?? '');
  let phase = $state<Phase>('idle');
  const busy = $derived(phase !== 'idle');

  const FIELD_CODES = {
    'signup.invalid_email': 'email', 'signup.domain_not_allowed': 'email', 'signup.unavailable': 'email',
    'account.password_too_short': 'password', 'account.password_too_long': 'password',
    'signup.invalid_invite': 'invite', 'signup.invite_required': 'invite',
    'signup.invalid_code': 'code',
  } as const;
  const emailError = () => (!email.trim() ? t('请输入邮箱') : !isEmail(email) ? t('请输入有效的邮箱地址') : undefined);
  /* 后台关了「允许用户邀请」：不显示也不提交邀请码（邀请链接带进来的也不带上，否则注册会被拒） */
  const inviteCode = () => (s.invites ? invite.trim() : '');
  const inviteError = () => (s.inviteRequired && !invite.trim() ? t('请填写邀请码') : undefined);
  const showServerError = (err: unknown) => {
    const k = fieldOf(err, FIELD_CODES);
    if (k) f.set(k, errorText(err));
    else toast.error(errorText(err));
  };

  const rules = $derived([
    { label: '至少 8 位', ok: pwd.length >= 8 },
    { label: '含字母', ok: /[a-zA-Z]/.test(pwd) },
    { label: '含数字', ok: /\d/.test(pwd) },
  ]);

  /* 发码：面板对任何地址都答 ok（地址已注册的话收到的是一封「已注册」的邮件） */
  async function sendCode(): Promise<boolean> {
    const ee = emailError();
    if (ee) { f.set('email', ee); return false; }
    try {
      const ic = inviteCode();
      await authApi.registerCode({
        email: email.trim(),
        ...(ic ? { invite_code: ic } : {}),
        locale: mailLocale(i18n.locale),
        guard: await guard.build(),
      });
      toast.success(t('如果这个邮箱可以注册，验证码已经发出'), { description: t('请查收邮件，也看看垃圾邮件箱') });
      return true;
    } catch (e) {
      showServerError(e);
      return false;
    } finally {
      guard.after();
    }
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (phase !== 'idle') return;
    if (!f.check({
      email: emailError(),
      password: !pwd ? t('请设置密码') : pwd.length < 8 ? t('密码至少 8 位') : undefined,
      invite: inviteError(),
      code: s.emailVerify && !isCode(code) && t('请输入 6 位数字验证码'),
    })) return;
    try {
      let pow: { challenge: string; nonce: string } | undefined;
      if (!s.emailVerify) {
        /* 不发验证码时，浏览器替用户做一小份工作量证明（几秒钟），挡住批量注册 */
        phase = 'pow';
        const ch = await authApi.registerChallenge();
        pow = { challenge: ch.challenge, nonce: await solvePow(ch.challenge, ch.bits) };
      }
      phase = 'submit';
      const ic = inviteCode();
      const result = await authApi.register({
        email: email.trim(),
        password: pwd,
        ...(s.emailVerify ? { code: code.trim() } : { pow }),
        ...(ic ? { invite_code: ic } : {}),
        locale: mailLocale(i18n.locale),
        guard: await guard.build(),
      });
      await signIn(result);
      toast.success(t('注册成功'), result.trial ? { description: t('已赠送试用套餐，现在就可以使用') } : undefined);
      navigate(R.dashboard, { replace: true });
    } catch (err) {
      showServerError(err);
    } finally {
      guard.after();
      phase = 'idle';
    }
  }

  /* 用通行密钥注册：不填邮箱和密码，账号建好后在弹窗里绑定邮箱（面板：待绑定邮箱状态） */
  async function passkeySignup() {
    if (phase !== 'idle') return;
    if (!f.check({ invite: inviteError() })) return;
    try {
      phase = 'pow';
      const ch = await authApi.registerChallenge();
      const pow = { challenge: ch.challenge, nonce: await solvePow(ch.challenge, ch.bits) };
      phase = 'submit';
      const ic = inviteCode();
      const result = await authApi.registerPasskey({
        pow,
        ...(ic ? { invite_code: ic } : {}),
        locale: mailLocale(i18n.locale),
        guard: await guard.build(),
      });
      await signIn(result);
      toast.success(t('账号已创建'), { description: t('接下来请绑定一个邮箱') });
      navigate(R.dashboard, { replace: true });
    } catch (err) {
      /* 用户在系统弹窗里点了取消，不算错误 */
      if (isUserCancel(err)) return;
      /* 这条路没有邮箱：signup.unavailable 等不对应任何字段，邀请码的错误除外 */
      const k = fieldOf(err, { 'signup.invalid_invite': 'invite', 'signup.invite_required': 'invite' } as const);
      if (k) f.set(k, errorText(err));
      else toast.error(errorText(err));
    } finally {
      guard.after();
      phase = 'idle';
    }
  }
</script>

{#snippet legal(url: string | null, fallback: string, label: string)}
  {#if url}
    <a href={url} target="_blank" rel="noopener noreferrer">{label}</a>
  {:else}
    <a href={fallback}>{label}</a>
  {/if}
{/snippet}

<AuthShell>
  {#if s.loading}
    <div class="loading" aria-busy="true"><Spinner size={18} /></div>
  {:else if !s.registerOpen}
    <AuthTitle title={t('暂停注册')} lead={t('网站已暂停注册新用户。')} />
    <p class="quiet-box">{t('目前不接受新账号注册，恢复开放后这里会重新出现注册表单。已有账号的用户不受影响，可以正常登录使用。')}</p>
    <a class="btn pri btn-block btn-gap" href={R.login}>{t('登录已有账号')}</a>
  {:else}
    <AuthTabs current="register" />

    <form novalidate onsubmit={submit} class="form">
      <TextField
        {...f.field('email', 'register-email')}
        label={t('邮箱')} type="email" autocomplete="email" placeholder="name@example.com"
        bind:value={email}
      >
        {#snippet hint()}
          {#if s.emailDomains.length > 0}<em>{t('仅限')} {domainsLine(s.emailDomains)}</em>{/if}
        {/snippet}
      </TextField>

      {#if s.emailVerify}
        <CodeField
          id={f.field('code', 'register-code').id} error={f.errors.code}
          bind:value={code} oninput={() => f.dismiss('code')} onsend={sendCode} disabled={!guard.ready || guard.unavailable}
        />
      {/if}

      <div>
        <TextField
          {...f.field('password', 'register-password')}
          label={t('密码')} type="password" autocomplete="new-password" placeholder={t('设置一个安全的密码')}
          bind:value={pwd}
        />
        <ul class="rules" aria-label={t('密码要求')}>
          {#each rules as r (r.label)}
            <li class:ok={r.ok}><Check size={12} strokeWidth={2} aria-hidden="true" />{t(r.label)}</li>
          {/each}
        </ul>
      </div>

      <!-- 没强制要求时邀请码也留着：从邀请链接进来的人得有地方填；关了用户邀请就不显示 -->
      {#if s.invites}
        <TextField
          {...f.field('invite', 'register-invite')}
          label={t('邀请码')} placeholder={t('填写邀请码')}
          bind:value={invite}
        >
          {#snippet hint()}
            {#if !s.inviteRequired}<em>{t('选填')}</em>{/if}
          {/snippet}
        </TextField>
      {/if}

      <GuardFields {guard} />

      <button type="submit" class="btn pri btn-block" disabled={busy || !guard.ready || guard.unavailable}>
        {#if busy}<Spinner size={16} />{/if}
        {phase === 'pow' ? t('正在进行安全校验…') : phase === 'submit' ? t('创建中') : t('创建账号')}
      </button>
      {#if phase === 'pow'}
        <p class="fine" role="status">{t('浏览器正在做一次计算来证明你不是机器人，通常只要几秒。')}</p>
      {/if}
    </form>

    {#if s.passkeyRegister && webauthnSupported()}
      <div class="or">{t('或')}</div>
      <button type="button" class="btn btn-block" disabled={busy || !guard.ready || guard.unavailable} onclick={() => void passkeySignup()}>
        <KeyRound class="i" size={16} strokeWidth={1.75} aria-hidden="true" />{t('用通行密钥注册')}
      </button>
      <p class="fine">{t('不用设置密码；创建后需要绑定一个邮箱才能使用。')}</p>
    {/if}

    <p class="fine">
      {t('注册即表示同意')}
      {@render legal(s.tosUrl, R.terms, t('服务条款'))}
      {t('与')}
      {@render legal(s.privacyUrl, R.privacy, t('隐私政策'))}
    </p>
  {/if}
</AuthShell>
