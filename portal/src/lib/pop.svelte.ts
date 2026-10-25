import { tick } from 'svelte';
import { loc } from './router.svelte';

/*
 * 弹出菜单的行为（WAI-ARIA menu button；手写，不为顶栏的三个菜单引入 bits-ui 的浮层）：
 *   · 点击打开：键盘触发（回车 / 空格，click 的 detail 为 0）→ 焦点到第一项（带焦点环）；指针 / 触摸 → 焦点在菜单本身（不画环）；
 *   · 按钮上 ↓ 打开并聚焦第一项，↑ 打开并聚焦最后一项；菜单里 ↑ ↓ Home End 移动，Esc 关闭并把焦点还给按钮，Tab 关闭（焦点照常往下走）；
 *   · 点菜单外面关闭；切页（点了菜单里的链接）立即收起；
 *   · 关闭有一个很短的退场（--dur-exit，data-state="closed" 时播），减少动效时不等。
 * 用法：const pop = new Pop(); 按钮 bind:this={pop.button} onclick={pop.toggle} onkeydown={pop.onButtonKey}，
 * 菜单 {#if pop.open} bind:this={pop.menu} data-state={pop.state} onkeydown={pop.onMenuKey}。
 * 可以聚焦的条目：[role="menuitem"] 与带 data-nav 的按钮（偏好开关：按下不收起菜单）。
 */
const EXIT_MS = 100;
const ITEMS = '[role="menuitem"], [data-nav]';

export class Pop {
  /** 菜单挂在页面上（含退场的那一小段） */
  open = $state(false);
  closing = $state(false);
  button: HTMLButtonElement | undefined = $state();
  menu: HTMLElement | undefined = $state();
  readonly #onshow: (() => unknown) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** onshow：菜单要打开时调用；返回 Promise 的话（按需加载卡片）等它好了再把焦点放进去 */
  constructor(onshow?: () => unknown) {
    this.#onshow = onshow;
    $effect(() => {
      void loc.path;
      void loc.search;
      this.close();
    });
    /* 打开时锁住页面滚动（v1.4.0 的 Radix 菜单是模态的）；html 上留着滚动条的位置（scrollbar-gutter），页面不横跳 */
    $effect(() => {
      document.documentElement.classList.toggle('menu-open', this.open);
      return () => document.documentElement.classList.remove('menu-open');
    });
    $effect(() => {
      if (!this.open) return;
      const down = (e: PointerEvent) => {
        const target = e.target as Node;
        if (!this.menu?.contains(target) && !this.button?.contains(target)) this.hide(false);
      };
      document.addEventListener('pointerdown', down);
      return () => document.removeEventListener('pointerdown', down);
    });
    $effect(() => () => clearTimeout(this.#timer));
  }

  /** data-state：打开 / 退场 */
  get state(): 'open' | 'closed' {
    return this.open && !this.closing ? 'open' : 'closed';
  }

  entries = (): HTMLElement[] => [...(this.menu?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];

  show = async (focus: 'first' | 'last' | 'menu') => {
    clearTimeout(this.#timer);
    this.closing = false;
    let ready: unknown;
    if (!this.open) {
      this.open = true;
      ready = this.#onshow?.();
    }
    await ready;
    await tick();
    if (focus === 'menu') this.menu?.focus();
    else {
      const list = this.entries();
      (focus === 'first' ? list[0] : list.at(-1))?.focus();
    }
  };

  /** 立即收起（切页、选了一项） */
  close = () => {
    clearTimeout(this.#timer);
    this.open = false;
    this.closing = false;
  };

  hide = (returnFocus = true) => {
    if (!this.open || this.closing) return;
    if (returnFocus) this.button?.focus();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { this.close(); return; }
    this.closing = true;
    this.#timer = setTimeout(this.close, EXIT_MS);
  };

  toggle = (e: MouseEvent) => {
    if (this.open && !this.closing) this.hide(false);
    else void this.show(e.detail === 0 ? 'first' : 'menu');
  };

  onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      void this.show('first');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      void this.show('last');
    }
  };

  onMenuKey = (e: KeyboardEvent) => {
    const list = this.entries();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); list[(n + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); this.hide(); }
    else if (e.key === 'Tab') this.hide(false);
  };
}
