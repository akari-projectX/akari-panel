<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  /*
   * 账号卡片 / 窄屏菜单里的一行（v1.4.0 account-card 的 MenuRow）：图标、名字，右边可以挂一个实时数字。
   * href = 去某一页（<a>，路由接管点击）；否则是按钮。
   */
  let {
    icon: Icon, label, meta, attention = false, active = false, strong = false, destructive = false, href, onselect, trailing,
  }: {
    icon: Component<{ class?: string; size?: number; strokeWidth?: number; 'aria-hidden'?: 'true' }>;
    label: string;
    meta?: string | Snippet;
    /** 需要你处理：数字前面加一个品牌色圆点 */
    attention?: boolean;
    /** 当前页：铺浅底，图标和文字变蓝 */
    active?: boolean;
    strong?: boolean;
    destructive?: boolean;
    href?: string;
    onselect?: () => void;
    trailing?: Snippet;
  } = $props();
</script>

{#snippet inner()}
  <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
  <span class="row-t">{label}</span>
  {#if meta}
    <span class="row-m num">
      {#if attention}<i aria-hidden="true"></i>{/if}
      {#if typeof meta === 'string'}{meta}{:else}{@render meta()}{/if}
    </span>
  {/if}
  {@render trailing?.()}
{/snippet}

{#if href}
  <a role="menuitem" tabindex="-1" class="row" class:strong {href} aria-current={active ? 'page' : undefined} data-active={active || undefined}>{@render inner()}</a>
{:else}
  <button role="menuitem" tabindex="-1" type="button" class="row" class:strong class:destructive onclick={onselect}>{@render inner()}</button>
{/if}

<style>
/* 卡片里的一行 */
.row {
  position: relative; display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 0 10px; border: 0; border-radius: 9px;
  background: none; color: var(--fg); font: inherit; font-size: 14px; text-align: left; cursor: pointer; outline: none; user-select: none;
}
.row > :global(svg) { flex: none; color: var(--muted); }
.row:hover, .row:focus { background: var(--hover); }
.row.strong { font-weight: 500; }
.row[data-active] { background: var(--hover); color: var(--brand); }
.row[data-active] > :global(svg) { color: var(--brand); }
.row.destructive, .row.destructive > :global(svg) { color: var(--danger); }
.row.destructive:hover, .row.destructive:focus { background: color-mix(in srgb, var(--danger) 10%, transparent); }
.row-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-m { margin-left: auto; display: flex; flex: none; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--fg); }
.row-m i { width: 5px; height: 5px; border-radius: 9999px; background: var(--brand); }

</style>
