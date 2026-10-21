<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { tick } from 'svelte';
  import { accountItems, menuLine } from '$lib/account';
  import { loadMenuFacts } from '$lib/attention.svelte';
  import { auth, scope, signOut } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { loc } from '$lib/router.svelte';

  /*
   * 邮箱下拉（WAI-ARIA menu button）：Enter / 空格 / ↓ 打开并聚焦第一项，↑ 打开并聚焦最后一项；
   * 菜单里 ↑ ↓ Home End 移动，Esc 关闭并把焦点还给按钮，Tab 关闭（焦点照常往下走），点外面关闭。
   */
  let open = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let menu: HTMLDivElement | undefined = $state();
  const items = $derived(scope() === 'banned' ? [] : accountItems());

  const entries = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  async function show(focus: 'first' | 'last' | null) {
    open = true;
    loadMenuFacts(scope());
    await tick();
    const list = entries();
    if (focus === 'first') list[0]?.focus();
    else if (focus === 'last') list.at(-1)?.focus();
  }

  function hide(returnFocus = true) {
    if (!open) return;
    open = false;
    if (returnFocus) button?.focus();
  }

  function onButtonKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void show('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      void show('last');
    }
  }

  function onMenuKey(e: KeyboardEvent) {
    const list = entries();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); hide(); }
    else if (e.key === 'Tab') hide(false);
  }

  /* 点菜单外面关闭（按钮自己的点击由 onclick 切换） */
  function onDocDown(e: PointerEvent) {
    const target = e.target as Node;
    if (open && !menu?.contains(target) && !button?.contains(target)) hide(false);
  }

  /* 切了页（点了菜单里的链接）就收起 */
  $effect(() => {
    void loc.path;
    void loc.search;
    open = false;
  });
</script>

<svelte:document onpointerdown={onDocDown} />

<div class="user">
  <button
    bind:this={button}
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="user-menu"
    onclick={() => (open ? hide(false) : show(null))}
    onkeydown={onButtonKey}
  >
    <span>{auth.me?.email}</span><ChevronDown class="i" size={16} strokeWidth={1.75} aria-hidden="true" />
  </button>
  {#if open}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div bind:this={menu} id="user-menu" class="pop" role="menu" aria-label={t('账户菜单')} onkeydown={onMenuKey}>
      <div class="who" role="none">
        <b>{auth.me?.email}</b><span class="num">{menuLine()}</span>
      </div>
      {#each items as it (it.to)}
        <a role="menuitem" tabindex="-1" href={it.to}>{it.label}{#if it.meta}<em class="num">{it.meta}</em>{/if}</a>
      {/each}
      {#if items.length}<hr role="none" />{/if}
      <button role="menuitem" tabindex="-1" type="button" onclick={() => { open = false; void signOut(); }}>{t('退出登录')}</button>
    </div>
  {/if}
</div>
