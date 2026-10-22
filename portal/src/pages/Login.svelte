<script lang="ts">
  import KeyRound from '@lucide/svelte/icons/key-round';
  import { ApiError, authApi, type LoginResult } from '@/api';
  import { isUserCancel, webauthnSupported } from '@/api/webauthn';
  import AuthShell from '../components/auth/AuthShell.svelte';
  import AuthTabs from '../components/auth/AuthTabs.svelte';
  import GuardFields from '../components/GuardFields.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TextField from '../components/TextField.svelte';
  import { signIn, site } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { FormGuard } from '$lib/form-guard.svelte';
  import { FieldErrors, Pending, isEmail } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';
  import { navigate, param } from '$lib/router.svelte';
  import { R, safeRedirect } from '$lib/routes';
  import { siteFlags } from '$lib/site';
  import { toast } from '$lib/toast.svelte';

  /*
   * 登录（样稿 login.html）：Logo → 登录 / 注册 → 邮箱、密码（「忘记密码」在密码标签右侧）→ 登录；「或」之后是通行密钥（次按钮）。
   * 行为与 React 门户 pages/auth.tsx 的 Login 相同：表单令牌 + 蜜罐 + 最短提交时间（+ 站长开了的 Turnstile）；
   * 面板对所有登录失败都答同一个 401（画在密码下面）；仅通行密钥的账户用密码登录 → 403 auth.passkey_required，把通行密钥按钮提到最前。
   */

  const s = $derived(siteFlags(site.options));
  const guard = new FormGuard('login');
  const f = new FieldErrors(['email', 'password'] as const);
  const sending = new Pending();
  const passkeyBusy = new Pending();
  let email = $state('');
  let password = $state('');
  let needPasskey = $state(false);

  const canPasskey = $derived(s.passkey && webauthnSupported());
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
    void sending.run(async () => {
      try {
        await finish(await authApi.login(email.trim(), password, await guard.build()));
      } catch (err) {
        if (err instanceof ApiError && err.code === 'auth.passkey_required') { needPasskey = true; return; }
        /* 面板对所有登录失败都答同一个 401，不区分邮箱不存在还是密码错：画在密码下面 */
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
        toast.error(t('当前浏览器不支持在这个域名上使用该通行密钥，请改用密码登录'));
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
  <AuthTabs current="login" />

  {#if needPasskey && canPasskey}
    <div class="callout">
      <p>{t('这个账户只能用通行密钥登录。')}</p>
      {@render passkeyButton(true)}
    </div>
  {/if}

  <form novalidate onsubmit={submit} class="form">
    <TextField
      {...f.field('email', 'login-email')}
      label={t('邮箱')} type="email" autocomplete="username webauthn" placeholder="name@example.com"
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
</AuthShell>
