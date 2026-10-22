<script lang="ts">
  import Fingerprint from '@lucide/svelte/icons/fingerprint';
  import TextField from '../TextField.svelte';
  import { t } from '$lib/i18n.svelte';
  import type { Holder } from '$lib/holder.svelte';

  /*
   * 确认是本人的输入（与 React 门户 components/holder-confirm.tsx 相同）：密码框，或「提交时用通行密钥验证」（lib/holder）。
   * 登录方式还没取到时显示占位；取不到时说明并给「重试」——不能默认给一个密码框：只用通行密钥的账户会看到一个永远通不过的密码框。
   * error：服务端说密码不对时由调用方给，画在密码框下面并聚焦它（id 由调用方给）。
   */
  let { h, id, label, error, oninput }: { h: Holder; id: string; label?: string; error?: string; oninput?: () => void } = $props();
</script>

{#if h.unknown === 'loading'}
  <div class="lines" aria-busy="true" aria-label={t('加载中')}><i></i><i></i></div>
{:else if h.unknown === 'error'}
  <div class="box" role="alert">
    <span>{t('无法确定验证方式，请重试。')}</span>
    <button type="button" class="btn sm" onclick={h.retry}>{t('重试')}</button>
  </div>
{:else if h.stuck}
  <p class="bad" role="alert">{t('这个账户只能用通行密钥确认，但当前浏览器或站点用不了通行密钥。请换用支持通行密钥的浏览器。')}</p>
{:else if h.mode === 'passkey'}
  <div class="box pk">
    <Fingerprint size={16} strokeWidth={1.75} aria-hidden="true" />
    <div>
      <p>{t('提交时用通行密钥验证身份（Face ID、指纹或锁屏密码）。')}</p>
      {#if h.switchable}
        <button type="button" class="field-link sw" onclick={() => (h.chosen = 'password')}>{t('改用密码验证')}</button>
      {/if}
      {#if error}<p class="bad" role="alert">{error}</p>{/if}
    </div>
  </div>
{:else}
  <TextField
    {id} type="password" autocomplete="current-password" label={label ?? t('当前密码')} {error}
    value={h.password} oninput={(e) => { h.password = e.currentTarget.value; oninput?.(); }}
  >
    {#snippet hint()}
      {#if h.switchable}
        <button type="button" class="field-link sw" onclick={() => (h.chosen = 'passkey')}>{t('改用通行密钥验证')}</button>
      {/if}
    {/snippet}
  </TextField>
{/if}

<style>
  .box { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 12px; padding: 12px 14px; border-radius: 8px; background: var(--secondary); font-size: 13px; line-height: 1.7; color: var(--body); }
  .box.pk { flex-wrap: nowrap; align-items: flex-start; justify-content: flex-start; }
  .box.pk :global(svg) { flex: none; margin-top: 3px; color: var(--brand); }
  .sw { border: 0; background: none; padding: 0; font: inherit; font-size: 12.5px; cursor: pointer; }
  .bad { margin-top: 4px; font-size: 12.5px; line-height: 1.7; color: var(--danger); }
</style>
