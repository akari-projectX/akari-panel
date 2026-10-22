<script lang="ts">
  import { site } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';
  import { siteFlags } from '$lib/site';

  /*
   * 样稿 login.html 的「登录 / 注册」文字标签：两个地址之间的导航（不是同一页里的分页），当前一项 600 字重 + 2px 品牌蓝下划线。
   * 站点关了注册时只剩「登录」。页面标题（h1）给读屏，看得见的标题就是这一行。
   */
  let { current }: { current: 'login' | 'register' } = $props();
  const s = $derived(siteFlags(site.options));
  const title = $derived(current === 'login' ? t('登录') : t('创建账号'));
</script>

<h1 class="sr">{title}</h1>
<nav class="tabs" aria-label={t('登录或注册')}>
  <a href={R.login} aria-current={current === 'login' ? 'page' : undefined}>{t('登录')}</a>
  {#if s.registerOpen || current === 'register'}
    <a href={R.register} aria-current={current === 'register' ? 'page' : undefined}>{t('注册')}</a>
  {/if}
</nav>
