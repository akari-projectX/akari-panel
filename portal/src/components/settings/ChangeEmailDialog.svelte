<script lang="ts">
  import Mail from '@lucide/svelte/icons/mail';
  import { meApi, passkeyApi } from '@/api';
  import { isUserCancel } from '@/api/webauthn';
  import { K } from '@/lib/cache';
  import HolderConfirm from './HolderConfirm.svelte';
  import TextField from '../TextField.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import { auth, refresh } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Countdown, FieldErrors, Pending, digits, fieldOf, isCode, isEmail } from '$lib/forms.svelte';
  import { Holder } from '$lib/holder.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { resource } from '$lib/resource.svelte';
  import { toast } from '$lib/toast.svelte';

  /*
   * 更换邮箱：① 新地址 + 确认是本人（当前密码，只用通行密钥的账户用通行密钥）→ 发码；
   * ② 填发到新地址的验证码（带重发倒计时，可以退回第一步改地址）。验证通过后新地址就是登录名。
   * 地址已被占用时面板的答复和成功一样（不泄露哪些地址注册过），验证那一步才会失败。站点没开发信时设置页不给这个入口。
   */
  let { open = $bindable(false) }: { open?: boolean } = $props();

  const methods = resource(() => ({ key: K.passkeys, fetch: () => passkeyApi.list(), enabled: open }));
  const holder = new Holder(methods);
  let email = $state('');
  let code = $state('');
  let sentTo = $state<string | null>(null);
  const resend = new Countdown();
  $effect(() => () => resend.stop());
  const busy = new Pending();
  const f = new FieldErrors(['email', 'password', 'code'] as const);
  f.field('password', 'change-email-password');

  function clear() {
    email = '';
    code = '';
    sentTo = null;
    holder.reset();
    f.check({});
  }

  function change(o: boolean) {
    if (busy.busy) return;
    if (!o) clear();
    open = o;
  }

  function send(e?: SubmitEvent) {
    e?.preventDefault();
    const to = (sentTo ?? email).trim();
    if (!f.check({
      email: !to ? t('请输入新邮箱地址') : !isEmail(to) ? t('请输入有效的邮箱地址')
        : to.toLowerCase() === auth.me?.email.toLowerCase() ? t('这就是你现在的邮箱') : undefined,
      password: holder.mode === 'password' && !holder.password && t('请输入当前密码'),
    })) return;
    void busy.run(async () => {
      try {
        await meApi.emailCode(to, await holder.proof());
        sentTo = to;
        code = '';
        resend.start(60);
      } catch (err) {
        if (isUserCancel(err)) return;
        const k = fieldOf(err, {
          'signup.invalid_email': 'email', 'signup.domain_not_allowed': 'email', 'account.email_unchanged': 'email',
          'account.invalid_password': 'password', 'account.password_required': 'password', 'account.passkey_failed': 'password',
        } as const);
        if (k) f.set(sentTo ? 'code' : k, errorText(err));
        else toast.error(errorText(err));
      }
    });
  }

  function verify(e: SubmitEvent) {
    e.preventDefault();
    if (!f.check({ code: !isCode(code) && t('请输入 6 位数字验证码') })) return;
    void busy.run(async () => {
      try {
        const r = await meApi.emailVerify(code.trim());
        await refresh();
        clear();
        open = false;
        toast.success(t('邮箱已更换'), { description: tp('以后用 {e} 登录', { e: r.email }) });
      } catch (err) {
        if (fieldOf(err, { 'signup.invalid_code': 'code' } as const)) f.set('code', errorText(err));
        else toast.error(errorText(err));
      }
    });
  }

  function back() {
    if (sentTo) email = sentTo;
    sentTo = null;
    f.check({});
  }
</script>

<Dialog bind:open onOpenChange={change} title={t('更换邮箱')} description={tp('第 {n} 步，共 2 步', { n: sentTo ? 2 : 1 })}>
  {#snippet icon()}<Mail class="dlg-icon" size={20} strokeWidth={1.5} aria-hidden="true" />{/snippet}
  {#if sentTo}
    <form id="change-email" novalidate onsubmit={verify} class="form">
      <div class="to">
        <span>{t('验证码已发到')}</span>
        <div class="row"><b>{sentTo}</b><button type="button" class="field-link plain" onclick={back}>{t('修改')}</button></div>
      </div>
      <TextField
        {...f.field('code', 'change-email-code')}
        label={t('邮箱验证码')} inputmode="numeric" autocomplete="one-time-code" maxlength={6} placeholder={t('六位数字')}
        class="num" bind:value={code} help={t('10 分钟内有效。没收到？看看垃圾邮件，或稍后重新发送。')}
        oninput={(e) => { code = digits(e.currentTarget.value); f.dismiss('code'); }}
      >
        {#snippet hint()}
          <button type="button" class="field-link plain" disabled={busy.busy || resend.left > 0} onclick={() => send()}>
            {resend.left > 0 ? tp('{n} 秒后重发', { n: resend.left }) : t('重新发送')}
          </button>
        {/snippet}
      </TextField>
    </form>
  {:else}
    <form id="change-email" novalidate onsubmit={send} class="form">
      <TextField
        {...f.field('email', 'change-email-new')}
        label={t('新邮箱地址')} type="email" autocomplete="email" placeholder="you@example.com" bind:value={email}
        help={t('新地址验证通过后就是你的登录名，到期提醒、收据和找回密码也改发到新地址。')}
      />
      <HolderConfirm h={holder} id="change-email-password" error={f.errors.password} oninput={() => f.dismiss('password')} />
    </form>
  {/if}
  {#snippet footer()}
    <button type="button" class="btn" disabled={busy.busy} onclick={() => change(false)}>{t('取消')}</button>
    <button type="submit" form="change-email" class="btn pri" disabled={busy.busy || !holder.usable}>
      {busy.busy ? t('提交中') : sentTo ? t('确认更换') : t('发送验证码')}
    </button>
  {/snippet}
</Dialog>

<style>
  .form { display: flex; flex-direction: column; gap: 16px; }
  .to { padding: 12px 14px; border-radius: 8px; background: var(--secondary); font-size: 13px; line-height: 1.7; }
  .to > span { color: var(--muted); }
  .row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px 12px; }
  .row b { font-weight: var(--fw-strong); color: var(--fg); overflow-wrap: anywhere; }
  .plain { border: 0; background: none; padding: 0; font: inherit; font-size: 12.5px; cursor: pointer; }
  .plain:disabled { color: var(--muted); cursor: default; text-decoration: none; }
</style>
