<script lang="ts">
  import type { Snippet } from 'svelte';
  import LangButton from '../components/LangButton.svelte';
  import Logo from '../components/Logo.svelte';
  import SiteFooter from '../components/SiteFooter.svelte';
  import ThemeButton from '../components/ThemeButton.svelte';
  import { site } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { loc } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { siteFlags } from '$lib/site';

  /*
   * 访客页（v1.4.0 layouts/site-layout 的 GuestHeader）：与用户中心页头同高同样式（64px、sticky、下边一道线），
   * 左 Logo，右侧主题、语言、「登录」（登录页上不显示）、「创建账号」（注册页上不显示；手机上页头只放得下一个按钮：
   * 「登录」也在时收起；站点关了注册显示「暂停注册」）。页脚照常。
   * 登录、注册、找回密码、重设密码、注销结果、条款、隐私、找不到页面（没登录时）都用它。
   */
  let { children }: { children: Snippet } = $props();
  const s = $derived(siteFlags(site.options));
</script>

<div class="shell">
  <a class="skip" href="#main">{t('跳到主要内容')}</a>
  <header class="topbar">
    <div class="wrap au-bar">
      <Logo />
      <div class="tools">
        <ThemeButton />
        <LangButton />
        {#if loc.path !== R.login}<a class="btn sm ghost" href={R.login}>{t('登录')}</a>{/if}
        {#if loc.path !== R.register && !s.loading}
          {#if !s.registerOpen}
            <span class="au-paused">{t('暂停注册')}</span>
          {:else}
            <a class={['btn sm pri', loc.path !== R.login && 'au-hide']} href={R.register}>{t('创建账号')}</a>
          {/if}
        {/if}
      </div>
    </div>
  </header>
  <main id="main" tabindex="-1">
    {@render children()}
  </main>
  <SiteFooter />
</div>
