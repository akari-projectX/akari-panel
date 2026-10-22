<script lang="ts">
  import { Countdown, Pending, digits } from '$lib/forms.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import Spinner from '../Spinner.svelte';
  import TextField from '../TextField.svelte';

  /*
   * 邮箱验证码那一行（样稿：输入框 + 「发送验证码」同一行）：60 秒冷却按截止时间戳算。
   * 发码是一次带防护的公开表单提交：面板对任何地址都答 ok，不能据此判断邮箱是否已注册。
   */
  let { id, value = $bindable(''), error, disabled = false, onsend, oninput }: {
    id: string;
    value?: string;
    error?: string;
    disabled?: boolean;
    /** 发码；返回 true 才进入冷却 */
    onsend: () => Promise<boolean>;
    oninput?: () => void;
  } = $props();

  const wait = new Countdown();
  const sending = new Pending();
  $effect(() => () => wait.stop());

  const send = () => sending.run(async () => {
    if (await onsend()) wait.start(60);
  });
</script>

<TextField
  {id} label={t('邮箱验证码')} {error} bind:value
  inputmode="numeric" autocomplete="one-time-code" maxlength={6} placeholder={t('六位数字')}
  class="num"
  oninput={(e) => { value = digits(e.currentTarget.value); oninput?.(); }}
>
  {#snippet after()}
    <button type="button" class="btn side" disabled={disabled || sending.busy || wait.left > 0} onclick={send}>
      {#if sending.busy}<Spinner />{/if}
      {wait.left > 0 ? tp('{n} 秒', { n: wait.left }) : t('发送验证码')}
    </button>
  {/snippet}
</TextField>
