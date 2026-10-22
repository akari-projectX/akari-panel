<script lang="ts">
  import Eye from '@lucide/svelte/icons/eye';
  import EyeOff from '@lucide/svelte/icons/eye-off';
  import type { Snippet } from 'svelte';
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { t } from '$lib/i18n.svelte';

  /*
   * 全站的文本输入字段（样稿 login.html 的 .field）：标签行（右侧可放「忘记密码」「选填」）+ 输入框 + 常驻帮助文字 / 内联错误（二选一，同一个位置）。
   *
   * 校验不用浏览器原生气泡：表单写 novalidate，提交时用 lib/forms 算出每个字段的错误，这里把它画在输入框下方，
   * 输入框红边 + aria-invalid + aria-describedby 指向这行字，读屏能读到；第一个出错的字段被聚焦（与 React 门户 text-field.tsx 相同）。
   * 密码框自带「显示 / 隐藏」按钮。after = 输入框右边的按钮（「发送验证码」）。
   */
  let {
    id, label, value = $bindable(''), type = 'text', error, help, hint, after, class: cls, ...rest
  }: Omit<HTMLInputAttributes, 'value' | 'id'> & {
    id: string;
    label: string;
    value?: string;
    error?: string;
    /** 常驻帮助文字（如「至少 8 位」）；有错误时被错误替换 */
    help?: string;
    /** 标签行右侧：「忘记密码」之类 */
    hint?: Snippet;
    /** 输入框右边（同一行）的按钮 */
    after?: Snippet;
  } = $props();

  let show = $state(false);
  const isPwd = $derived(type === 'password');
  const msg = $derived(`${id}-msg`);
</script>

<div class="field">
  <div class="field-label">
    <label for={id}>{label}</label>
    {@render hint?.()}
  </div>
  <div class="field-row">
    <div class="field-box">
      <input
        {...rest}
        {id}
        class={['input', isPwd && 'pwd', cls]}
        type={isPwd && show ? 'text' : type}
        bind:value
        aria-invalid={error ? true : undefined}
        aria-describedby={error || help ? msg : undefined}
      />
      {#if isPwd}
        <button
          type="button"
          class="reveal"
          aria-controls={id}
          aria-label={show ? t('隐藏密码') : t('显示密码')}
          onclick={() => (show = !show)}
        >
          {#if show}<EyeOff size={16} strokeWidth={1.75} aria-hidden="true" />{:else}<Eye size={16} strokeWidth={1.75} aria-hidden="true" />{/if}
        </button>
      {/if}
    </div>
    {@render after?.()}
  </div>
  {#if error || help}
    <p id={msg} role={error ? 'alert' : undefined} class="field-msg" class:bad={!!error}>{error || help}</p>
  {/if}
</div>
