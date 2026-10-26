<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { Snippet } from 'svelte';
  import { refreshOptions, site } from '$lib/auth.svelte';
  import { Pending } from '$lib/forms.svelte';
  import { t } from '$lib/i18n.svelte';

  /*
   * 登录、注册、找回、重设密码、注销结果页的外壳（v1.4.0 pages/auth 的 Shell）：垂直居中的 360px 一栏，顶上一层极淡的品牌色光晕。
   * /auth/options 没取到：注册、找回、通行密钥的入口都按「关」处理，表单提交也会被拒——得告诉用户，而不是只少几个按钮。
   */
  let { children }: { children: Snippet } = $props();
  const retry = new Pending();
</script>

<section class="au-sec">
  <div class="au-col">
    {#if site.error}
      <div role="alert" class="au-alert">
        <TriangleAlert class="i" size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{t('站点设置没能加载，暂时无法登录或注册。')}</span>
        <button type="button" class="btn sm" disabled={retry.busy} onclick={() => retry.run(refreshOptions)}>{t('重试')}</button>
      </div>
    {/if}
    {@render children()}
  </div>
</section>
