<script lang="ts">
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import type { FormGuard } from '$lib/form-guard.svelte';
  import { t } from '$lib/i18n.svelte';
  import Spinner from './Spinner.svelte';
  import Turnstile from './Turnstile.svelte';

  /*
   * 公开表单里的防护字段：
   *   · 蜜罐：一个叫 website 的输入框，人看不见、读屏跳过、浏览器不自动填；机器人填了就会被面板按普通失败拒掉；
   *   · Turnstile：站长为这张表单开了才出现；加载失败（脚本被拦、组件出错、交互超时）时显示原因和「重试」。
   */
  let { guard }: { guard: FormGuard } = $props();
</script>

{#if guard.honeypot}
  <div aria-hidden="true" class="trap">
    <label>
      Website
      <input type="text" name="website" tabindex="-1" autocomplete="off" bind:value={guard.website} />
    </label>
  </div>
{/if}
{#if guard.siteKey}
  <div class="guard">
    <Turnstile siteKey={guard.siteKey} resetKey={guard.resetKey} ontoken={guard.onToken} onerror={guard.onError} />
    {#if !guard.token && !guard.failed}
      <p role="status" class="guard-note"><Spinner size={12} />{t('正在进行人机验证…')}</p>
    {/if}
    {#if guard.failed}
      <div role="alert" class="guard-note bad">
        <span>{t('人机验证加载失败，请刷新重试')}</span>
        <button type="button" class="textbtn" onclick={guard.retry}>
          <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />{t('重试')}
        </button>
      </div>
    {/if}
  </div>
{/if}
{#if guard.unavailable}
  <p class="quiet-box">{t('站点设置暂时读不出来，请稍后刷新再试。')}</p>
{/if}
