<script lang="ts">
  import { isCurrent, primaryItems } from '$lib/account';
  import { repliedTickets } from '$lib/attention.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { loc } from '$lib/router.svelte';
  import LangButton from './LangButton.svelte';
  import Logo from './Logo.svelte';
  import MobileMenu from './MobileMenu.svelte';
  import NavMore from './NavMore.svelte';
  import ThemeButton from './ThemeButton.svelte';
  import UserMenu from './UserMenu.svelte';

  /*
   * 顶栏（v1.4.0 dash-layout）：Logo，纯文字导航 `仪表盘 商店 文档 邀请 工单 更多▾`（当前项品牌蓝 + 一道蓝线，
   * 切页时那道线从旧的一项滑到新的一项；工单有新回复时标签右上一个小圆点），右侧主题、语言、账号名（名字下面一根线）。
   * 窄屏（< 1024px）只剩 Logo 与一个两根线的菜单按钮。
   */
  const items = $derived(primaryItems());

  let nav: HTMLElement | undefined = $state();
  let pos = $state<{ x: number; y: number; w: number } | null>(null);
  let ready = $state(false);

  /* 当前项下面那道线：整条导航只有这一根，量出当前项（data-active）的位置挪过去。第一次量到位之前不加过渡，免得刷新时从最左边滑进来 */
  $effect(() => {
    void loc.path;
    void items;
    const el = nav;
    if (!el) return;
    const measure = () => {
      const a = el.querySelector<HTMLElement>('.topnav-link[data-active="true"]');
      /* 窄屏下整条导航是 display:none，量出来是 0：藏起来，等它出现时再量 */
      /* 「更多」包在一个定位的外壳里（卡片相对它定位），offsetLeft 不是相对导航的：用包围盒算 */
      const n = el.getBoundingClientRect();
      const r = a?.getBoundingClientRect();
      pos = r && r.width ? { x: r.left - n.left, y: r.bottom - n.top - 2, w: r.width } : null;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.querySelectorAll('.topnav-link').forEach((a) => ro.observe(a));
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!pos || ready) return;
    const raf = requestAnimationFrame(() => { ready = true; });
    return () => cancelAnimationFrame(raf);
  });
</script>

<header class="topbar">
  <div class="wrap">
    <Logo />
    <nav bind:this={nav} class="topnav" aria-label={t('主导航')}>
      {#each items as it (it.to)}
        {@const on = isCurrent(it.to, loc.path)}
        <a class="topnav-link" href={it.to} data-active={on} aria-current={on ? 'page' : undefined}>
          {t(it.label)}{#if it.attention}<span class="nav-dot" role="status" aria-label={tp('{n} 张工单有新回复', { n: repliedTickets() })}></span>{/if}
        </a>
      {/each}
      <NavMore />
      {#if pos}<span class="nav-indicator" aria-hidden="true" data-ready={ready} style:width="{pos.w}px" style:translate="{pos.x}px {pos.y}px"></span>{/if}
    </nav>
    <div class="tools">
      <ThemeButton class="hide-m" />
      <LangButton class="hide-m" />
      <UserMenu />
      <MobileMenu />
    </div>
  </div>
</header>
