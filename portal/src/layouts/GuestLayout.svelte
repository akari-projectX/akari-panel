<script lang="ts">
  import type { Snippet } from 'svelte';
  import LangButton from '../components/LangButton.svelte';
  import Logo from '../components/Logo.svelte';
  import SiteFooter from '../components/SiteFooter.svelte';
  import ThemeButton from '../components/ThemeButton.svelte';

  /*
   * 访客页（样稿 login.html）：右上角主题与语言，居中的一栏（360px；条款、隐私是 680px 的阅读栏），居中的页脚。
   * 登录、注册、找回密码、重设密码、注销结果、条款、隐私、找不到页面（没登录时）都用它。
   */
  let { children, wide = false }: { children: Snippet; wide?: boolean } = $props();
</script>

<div class="auth">
  <div class="auth-top">
    <ThemeButton />
    <LangButton />
  </div>
  <main id="main" class="auth-main" tabindex="-1">
    <div class={['auth-col', wide && 'wide']}>
      <Logo />
      {@render children()}
    </div>
  </main>
  <SiteFooter />
</div>
