<script lang="ts">
  import type { Snippet } from 'svelte';
  import LangButton from '../components/LangButton.svelte';
  import Logo from '../components/Logo.svelte';
  import SiteFooter from '../components/SiteFooter.svelte';
  import ThemeButton from '../components/ThemeButton.svelte';

  /* 访客页（样稿 login.html）：右上角主题与语言，居中的一栏，居中的页脚 */
  let { children }: { children: Snippet } = $props();
</script>

<div class="auth">
  <div class="auth-top">
    <ThemeButton />
    <LangButton />
  </div>
  <main id="main" class="auth-main" tabindex="-1">
    <div class="auth-col">
      <Logo />
      {@render children()}
    </div>
  </main>
  <SiteFooter />
</div>
