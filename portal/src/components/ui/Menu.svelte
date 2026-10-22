<script lang="ts" module>
  export type MenuItem = { id: string; label: string; selected?: boolean; onselect: () => void };
</script>

<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import { tick, type Snippet } from 'svelte';

  /*
   * 小下拉菜单（WAI-ARIA menu button，与顶栏的邮箱下拉同一套键盘规则；手写，不为它引入 bits-ui 的浮层）：
   * 点击、Enter / 空格 / ↓ 打开并聚焦当前项（没有就第一项），↑ 打开并聚焦最后一项；菜单里 ↑ ↓ Home End 移动，
   * Enter / 空格选中，Esc 关闭并把焦点还给按钮，Tab 关闭，点外面关闭。菜单贴在按钮下方左对齐。
   * 选项：label（已翻译）、selected（打勾）、onselect。
   */

  let { label, items, class: cls = '', align = 'start', children }: {
    label: string;
    /** end = 菜单右边与按钮对齐（按钮在行尾时，不伸出屏幕） */
    align?: 'start' | 'end';
    items: MenuItem[];
    class?: string;
    children: Snippet;
  } = $props();

  const uid = $props.id();
  let open = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let menu: HTMLDivElement | undefined = $state();

  const entries = () => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  async function show(focus: 'current' | 'last') {
    open = true;
    await tick();
    const list = entries();
    if (focus === 'last') list.at(-1)?.focus();
    else (list.find((x) => x.dataset.selected !== undefined) ?? list[0])?.focus();
  }

  function hide(returnFocus = true) {
    if (!open) return;
    open = false;
    if (returnFocus) button?.focus();
  }

  function onButtonKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      void show('current');
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

  function choose(item: MenuItem) {
    item.onselect();
    hide();
  }

  function onDocDown(e: PointerEvent) {
    const target = e.target as Node;
    if (open && !menu?.contains(target) && !button?.contains(target)) hide(false);
  }
</script>

<svelte:document onpointerdown={onDocDown} />

<div class="menu-wrap">
  <button
    bind:this={button}
    type="button"
    class={cls}
    aria-label={label}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls="{uid}-menu"
    onclick={() => (open ? hide() : void show('current'))}
    onkeydown={onButtonKey}
  >
    {@render children()}
  </button>
  {#if open}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div bind:this={menu} id="{uid}-menu" class="menu-pop" class:end={align === 'end'} role="menu" aria-label={label} onkeydown={onMenuKey}>
      {#each items as item (item.id)}
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          data-selected={item.selected ? '' : undefined}
          onclick={() => choose(item)}
        >
          <span>{item.label}</span>
          {#if item.selected}<Check size={14} strokeWidth={2} aria-hidden="true" />{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .menu-wrap { position: relative; display: inline-flex; }
  .menu-pop {
    position: absolute; left: 0; top: calc(100% + 6px); z-index: 30; min-width: 200px; padding: 6px 0;
    background: var(--surface); border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--pop-shadow);
    animation: pop-in var(--dur-hover) var(--ease-out);
  }
  .menu-pop.end { left: auto; right: 0; }
  [role='menuitem'] {
    display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; padding: 7px 14px;
    border: 0; border-radius: 0; background: none; color: var(--body); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer;
  }
  [role='menuitem']:hover, [role='menuitem']:focus-visible { background: var(--hover); color: var(--fg); box-shadow: none; }
  [role='menuitem'] :global(svg) { color: var(--brand); }
  @media (prefers-reduced-motion: reduce) {
    .menu-pop { animation: none; }
  }
</style>
