<script lang="ts">
  import { isCurrent, primaryItems } from '$lib/account';
  import { repliedTickets } from '$lib/attention.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { loc } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import Logo from './Logo.svelte';
  import { ICONS } from './menu-icons';
  import MobileMenu from './MobileMenu.svelte';
  import MoreMenu from './MoreMenu.svelte';
  import ThemeButton from './ThemeButton.svelte';
  import UserMenu from './UserMenu.svelte';

  /*
   * 顶栏（外观 A · N1；2026-10-31 名称方案 ①，用户选「顶栏与下拉都带图标」）：Logo，导航 `总览 套餐 节点 指南 支持 更多⌄`，每项前一个 15px 线性图标（与窄屏菜单同一套），全部中粗（--fw-nav 500），
   * 当前项只换正文色 + 一道同色细线（字重不变，切换时文字不跳；切页时那道线从旧的一项滑到新的一项；「更多」里的页面算「更多」），
   * 工单有新回复、有待支付订单时标签右上一个小圆点；右侧明暗按钮与头像。
   * 窄屏（< 1024px）导航收进头像菜单：只剩 Logo 与「头像 + 三道线」的菜单按钮。
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
      const n = el.getBoundingClientRect();
      const r = a?.getBoundingClientRect();
      pos = r && r.width ? { x: r.left - n.left, y: r.bottom - n.top - 2, w: r.width } : null;
    };
    /* 不在这里同步量：这时量会把整页的第一次排版挤进脚本里（紧挨着页面其余部分的渲染，排版做两遍）。
       ResizeObserver 订阅后会在第一帧排版之后、绘制之前通知一次，那一刻量，首帧就带着这道线 */
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
        {@const Icon = ICONS[it.icon]}
        <a class="topnav-link" href={it.to} data-active={on} aria-current={on ? 'page' : undefined}>
          <Icon class="topnav-ic" size={15} strokeWidth={1.75} aria-hidden="true" />{t(it.label)}{#if it.attention}<span class="nav-dot" role="status" aria-label={it.to === R.tickets ? tp('{n} 张工单有新回复', { n: repliedTickets() }) : t('有待支付的订单')}></span>{/if}
        </a>
      {/each}
      <MoreMenu />
      {#if pos}<span class="nav-indicator" aria-hidden="true" data-ready={ready} style:width="{pos.w}px" style:translate="{pos.x}px {pos.y}px"></span>{/if}
    </nav>
    <div class="tools">
      <ThemeButton class="hide-m" />
      <UserMenu />
      <MobileMenu />
    </div>
  </div>
</header>
