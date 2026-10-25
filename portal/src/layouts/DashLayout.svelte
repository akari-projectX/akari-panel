<script lang="ts">
  import type { Snippet } from 'svelte';
  import { webauthnSupported } from '@/api/webauthn';
  import DashSkeleton from '../components/DashSkeleton.svelte';
  import SiteFooter from '../components/SiteFooter.svelte';
  import TopBar from '../components/TopBar.svelte';
  import { auth } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';

  /*
   * 用户中心布局：顶栏、页面、页脚。
   *   · 用通行密钥注册、还没绑定邮箱（me.email_pending）：面板对其余接口一律 403，不渲染页面（免得一屏报错），
   *     盖一个不可关闭的「绑定邮箱」对话框；
   *   · 密码登录后（登录答复的 passkey_prompt）引导添加通行密钥。
   * 两个对话框按需加载（含 bits-ui），不进首屏。
   */
  let { children }: { children: Snippet } = $props();
  const pending = $derived(!!auth.me?.email_pending);
</script>

<div class="shell">
  <a class="skip" href="#main">{t('跳到主要内容')}</a>
  <TopBar />
  <main id="main" class="wrap" tabindex="-1">
    {#if pending}
      <DashSkeleton />
    {:else}
      {@render children()}
    {/if}
  </main>
  <SiteFooter />
</div>
{#if pending}
  {#await import('../components/BindEmailDialog.svelte') then m}<m.default />{/await}
{:else if auth.passkeyPrompt && webauthnSupported()}
  {#await import('../components/PasskeyPrompt.svelte') then m}<m.default />{/await}
{/if}
