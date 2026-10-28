<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round';
  import { ApiError, authApi, type LoginResult } from '@/api';
  import { isUserCancel, webauthnSupported } from '@/api/webauthn';
  import AuthShell from '../components/auth/AuthShell.svelte';
  import AuthTitle from '../components/auth/AuthTitle.svelte';
  import GuardFields from '../components/GuardFields.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TextField from '../components/TextField.svelte';
  import { signIn, site } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { FormGuard } from '$lib/form-guard.svelte';
  import { FieldErrors, Pending, digits, isCode, isEmail } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';
  import { navigate, param } from '$lib/router.svelte';
  import { R, safeRedirect } from '$lib/routes';
  import { siteFlags } from '$lib/site';
  import { toast } from '$lib/toast.svelte';

  /*
   * 登录（样稿 login.html）：Logo → 登录 / 注册 → 邮箱、密码（「忘记密码」在密码标签右侧）→ 登录；「或」之后是通行密钥（次按钮）。
   * 行为：表单令牌 + 蜜罐 + 最短提交时间（+ 站长开了的 Turnstile）；
   * 面板对所有登录失败都答同一个 401（画在密码下面）；仅通行密钥的账户用密码登录 → 403 auth.passkey_required，把通行密钥按钮提到最前。
   */

  const s = $derived(siteFlags(site.options));
  const guard = new FormGuard('login');
  const f = new FieldErrors(['email', 'password', 'code'] as const);
  const sending = new Pending();
  const passkeyBusy = new Pending();
  let email = $state('');
  let password = $state('');
  let needPasskey = $state(false);
  /* 浏览器拒绝了本站的通行密钥（不支持跨域名通行密钥，或通行密钥域名连不上）：邮箱验证码回退成为主操作 */
  let broken = $state(false);
  let fallbackOpen = $state(false);
  let codeSent = $state(false);
  let code = $state('');

  const canPasskey = $derived(s.passkey && webauthnSupported());
  const passkeyUsable = $derived(canPasskey && !broken);
  const to = safeRedirect(param('redirect'));

  /** 拿到登录答复之后：取账户数据、提示、跳走 */
  async function finish(result: LoginResult) {
    await signIn(result);
    toast.success(t('登录成功'));
    navigate(to, { replace: true });
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!f.check({
      email: !email.trim() ? t('请输入邮箱') : !isEmail(email) ? t('请输入有效的邮箱地址') : undefined,
      password: !password && t('请输入密码'),
    })) return;
    if (codeSent && !isCode(code)) { f.set('code', t('请输入 6 位验证码')); return; }
    void sending.run(async () => {
      try {
        await finish(await authApi.login(email.trim(), password, await guard.build(), codeSent ? code.trim() : undefined));
      } catch (err) {
        if (codeSent && err instanceof ApiError && err.status === 401) {
          code = '';
          f.set('code', t('验证码不正确或已失效，请重新获取'));
          return;
        }
        if (err instanceof ApiError && err.code === 'auth.passkey_required') { needPasskey = true; return; }
        /* 面板对所有登录失败都答同一个 401，不区分邮箱不存在还是密码错：画在密码下面 */
        if (err instanceof ApiError && err.status === 401) f.set('password', t('邮箱或密码错误'));
        else toast.error(errorText(err));
      } finally {
        guard.after();
      }
    });
  }

  /** 回退：密码正确时把验证码发到账户已验证的邮箱（密码不对 = 统一 401） */
  function sendCode() {
    if (!f.check({
      email: !email.trim() ? t('请输入邮箱') : !isEmail(email) ? t('请输入有效的邮箱地址') : undefined,
      password: !password && t('请输入密码'),
    })) return;
    void sending.run(async () => {
      try {
        await authApi.loginFallbackCode(email.trim(), password, await guard.build());
        codeSent = true;
        code = '';
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) f.set('password', t('邮箱或密码错误'));
        else toast.error(errorText(err));
      } finally {
        guard.after();
      }
    });
  }

  /** 通行密钥登录：可发现凭据，不用输邮箱，设备会列出本站的通行密钥让用户选 */
  const passkeyLogin = () => passkeyBusy.run(async () => {
    try {
      await finish(await authApi.passkeyLogin());
    } catch (e) {
      /* 用户在系统弹窗里点了取消，不算错误 */
      if (isUserCancel(e)) return;
      /* 浏览器认为这个域名不能用该通行密钥（不支持跨域名通行密钥（ROR）的浏览器） */
      if (e instanceof DOMException && e.name === 'SecurityError') {
        broken = true;
        needPasskey = true;
        fallbackOpen = true;
        toast.error(t('这个浏览器无法使用本站的通行密钥，请改用密码 + 邮箱验证码登录。'));
        return;
      }
      toast.error(e instanceof ApiError && e.status === 401 ? t('通行密钥登录失败，请重试或改用密码登录') : errorText(e));
    }
  });
</script>

{#snippet passkeyButton(primary: boolean)}
  <button type="button" class={['btn', 'btn-block', primary && 'pri']} disabled={sending.busy || passkeyBusy.busy} onclick={passkeyLogin}>
    {#if passkeyBusy.busy}<Spinner size={16} />{:else}<KeyRound class="i" size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
    {passkeyBusy.busy ? t('等待设备验证…') : t('使用通行密钥登录')}
  </button>
{/snippet}

<AuthShell>
  <AuthTitle title={t('登录')} lead={t('继续使用你的订阅')} />

  {#if needPasskey}
    <div class="callout" data-testid="passkey-fallback">
      <p>{t('这个账户只能用通行密钥登录。')}</p>
      {#if passkeyUsable}
        {@render passkeyButton(true)}
      {:else}
        <p>{t('这个浏览器无法使用本站的通行密钥，请改用密码 + 邮箱验证码登录。')}</p>
      {/if}
      {#if passkeyUsable && !fallbackOpen}
        <button type="button" class="field-link" onclick={() => (fallbackOpen = true)}>{t('通行密钥用不了？改用密码 + 邮箱验证码')}</button>
      {:else if !codeSent}
        <button type="button" class={['btn', 'btn-block', !passkeyUsable && 'pri']} disabled={sending.busy} onclick={sendCode}>
          {#if sending.busy}<Spinner size={16} />{/if}
          {t('发送邮箱验证码')}
        </button>
      {:else}
        <p role="status">{t('验证码已发送到账户的已验证邮箱，10 分钟内有效。')}</p>
        <button type="button" class="field-link" disabled={sending.busy} onclick={sendCode}>{t('重新发送验证码')}</button>
      {/if}
    </div>
  {/if}

  <form novalidate onsubmit={submit} class="form">
    <TextField
      {...f.field('email', 'login-email')}
      label={t('邮箱')} type="email" autocomplete="username webauthn" placeholder="you@example.com"
      bind:value={email}
    />
    <TextField
      {...f.field('password', 'login-password')}
      label={t('密码')} type="password" autocomplete="current-password" placeholder={t('输入密码')}
      bind:value={password}
    >
      {#snippet hint()}
        {#if s.resetOpen}<a class="field-link" href={R.forgot}>{t('忘记密码')}</a>{/if}
      {/snippet}
    </TextField>
    {#if needPasskey && codeSent}
      <TextField
        {...f.field('code', 'login-fallback-code')}
        label={t('邮箱验证码')} inputmode="numeric" autocomplete="one-time-code" placeholder="000000"
        bind:value={code} oninput={() => (code = digits(code))}
      />
    {/if}
    <GuardFields {guard} />
    <button type="submit" class="btn pri btn-block" disabled={sending.busy || passkeyBusy.busy || !guard.ready || guard.unavailable}>
      {#if sending.busy}<Spinner size={16} />{/if}
      {sending.busy ? t('登录中') : t('登录')}
    </button>
  </form>

  {#if !needPasskey && canPasskey}
    <div class="or">{t('或')}</div>
    {@render passkeyButton(false)}
  {/if}

  {#if s.registerOpen}
    <p class="au-foot">{t('还没有账号？')}<a href={R.register}>{t('注册')}</a></p>
  {/if}
</AuthShell>
