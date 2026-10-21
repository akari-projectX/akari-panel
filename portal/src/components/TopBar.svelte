<script lang="ts">
  import { isCurrent, navGroups } from '$lib/account';
  import { t } from '$lib/i18n.svelte';
  import { loc } from '$lib/router.svelte';
  import LangButton from './LangButton.svelte';
  import Logo from './Logo.svelte';
  import MobileMenu from './MobileMenu.svelte';
  import ThemeButton from './ThemeButton.svelte';
  import UserMenu from './UserMenu.svelte';

  /*
   * 顶栏（样稿 dashboard.html）：Logo，56px 后是纯文字导航 `仪表盘 商店 线路 用量 | 公告 文档 工单`
   * （当前项 600 字重 + 2px 品牌蓝下划线，公告有未读点、工单有新回复点）；右侧主题、语言、邮箱下拉。
   * 窄屏只剩 Logo 与「菜单」。
   */
  const groups = $derived(navGroups());
</script>

<header class="top">
  <div class="wrap">
    <Logo />
    <nav class="nav" aria-label={t('主导航')}>
      {#each groups as group, gi (gi)}
        {#if gi > 0}<span class="sep" aria-hidden="true"></span>{/if}
        {#each group as it (it.to)}
          <a href={it.to} aria-current={isCurrent(it.to, loc.path) ? 'page' : undefined}>
            {it.label}{#if it.dot}<span class="dot" aria-hidden="true"></span><span class="sr">{it.dot}</span>{/if}
          </a>
        {/each}
      {/each}
    </nav>
    <div class="tools">
      <ThemeButton class="hide-m" />
      <LangButton class="hide-m" />
      <UserMenu />
      <MobileMenu />
    </div>
  </div>
</header>
