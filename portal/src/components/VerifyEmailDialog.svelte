<script lang="ts">
  import { meApi } from '@/api';
  import TextField from './TextField.svelte';
  import Dialog from './ui/Dialog.svelte';
  import { auth, refresh } from '$lib/auth.svelte';
  import { errorText } from '$lib/errors';
  import { Countdown, FieldErrors, Pending, digits, fieldOf, isCode } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { toast } from '$lib/toast.svelte';

  /*
   * 验证当前邮箱（仪表盘提醒「去验证」；之后设置页的「验证」也用它）：
   * 第一步只有一个主按钮「发送验证码」；发出后切到填码（带重发倒计时）。面板不要求密码；验证通过后 /me 刷新，提醒随之消失。
   * 关掉再打开：从头来（倒计时保留，防止连点重发）。
   */
  let { open = $bindable(false) }: { open?: boolean } = $props();

  const f = new FieldErrors(['code'] as const);
  const busy = new Pending();
  const resend = new Countdown();
  $effect(() => () => resend.stop());
  let sent = $state(false);
  let code = $state('');
  const email = $derived(auth.me?.email ?? '');

  function change(o: boolean) {
    if (!o) {
      sent = false;
      code = '';
      f.check({});
    }
    open = o;
  }

  function send() {
    void busy.run(async () => {
      try {
        await meApi.emailCode(email);
        sent = true;
        resend.start(60);
      } catch (err) {
        toast.error(errorText(err));
      }
    });
  }

  function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!f.check({ code: !isCode(code) && t('请输入 6 位数字验证码') })) return;
    void busy.run(async () => {
      try {
        await meApi.emailVerify(code.trim());
        await refresh();
        change(false);
        toast.success(t('邮箱已验证'), { description: t('到期提醒、收据和找回密码都会发到这个地址。') });
      } catch (err) {
        if (fieldOf(err, { 'signup.invalid_code': 'code' } as const)) f.set('code', errorText(err));
        else toast.error(errorText(err));
      }
    });
  }
</script>

<Dialog bind:open onOpenChange={change} title={t('验证邮箱')}>
  <div class="to">
    <span>{sent ? t('验证码已发到') : t('验证码会发到')}</span>
    <b>{email}</b>
  </div>
  {#if sent}
    <form id="verify-email" novalidate onsubmit={submit} class="form">
      <TextField
        {...f.field('code', 'verify-email-code')}
        label={t('邮箱验证码')} inputmode="numeric" autocomplete="one-time-code" maxlength={6} placeholder={t('六位数字')}
        class="num" bind:value={code} help={t('10 分钟内有效。没收到？看看垃圾邮件，或稍后重新发送。')}
        oninput={(e) => { code = digits(e.currentTarget.value); f.dismiss('code'); }}
      >
        {#snippet hint()}
          <button type="button" class="resend" disabled={busy.busy || resend.left > 0} onclick={send}>
            {resend.left > 0 ? tp('{n} 秒后重发', { n: resend.left }) : t('重新发送')}
          </button>
        {/snippet}
      </TextField>
    </form>
  {/if}
  {#snippet footer()}
    <button type="button" class="btn" onclick={() => change(false)}>{t('取消')}</button>
    {#if sent}
      <button type="submit" form="verify-email" class="btn pri" disabled={busy.busy}>{busy.busy ? t('提交中') : t('完成验证')}</button>
    {:else}
      <button type="button" class="btn pri" disabled={busy.busy || resend.left > 0} onclick={send}>
        {resend.left > 0 ? tp('{n} 秒后重发', { n: resend.left }) : t('发送验证码')}
      </button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .to { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: 8px; background: var(--secondary); font-size: 13px; line-height: 1.7; }
  .to span { color: var(--muted); }
  .to b { color: var(--fg); font-weight: var(--fw-strong); overflow-wrap: anywhere; }
  .form { margin-top: 16px; }
  .resend { border: 0; background: none; padding: 0; font: inherit; font-size: 12.5px; color: var(--brand); cursor: pointer; }
  .resend:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
  .resend:disabled { color: var(--muted); cursor: default; }
</style>
