<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { isCurrent, moreItems } from '$lib/account';
  import { pendingOrders } from '$lib/attention.svelte';
  import { t } from '$lib/i18n.svelte';
  import { Pop } from '$lib/pop.svelte';
  import { loc } from '$lib/router.svelte';
  import { R } from '$lib/routes';

  /*
   * 顶栏的「更多」（2026-10-31）：不常用的三项（流量明细、账单、动态）收在这里。
   * 按钮和外面的导航项同一个样子（.topnav-link）：当前页在这三项里时它算当前项（那道线滑到它下面）；
   * 有待支付订单时按钮上挂一个小圆点。下拉是纯文字的一张小卡片，每项一行说明。窄屏不用它：窄屏菜单里八项平铺。
   */
  const NOTES: Record<string, string> = {
    [R.traffic]: '每天的用量与节点分布',
    [R.orders]: '订单、付款与退款记录',
    [R.announcements]: '公告与服务更新',
  };
  const items = $derived(moreItems());
  const on = $derived(items.some((it) => isCurrent(it.to, loc.path)));
  const dot = $derived(items.some((it) => it.attention));
  const pop = new Pop();
</script>

{#if items.length > 0}
  <div class="menu-host more-host">
    <button
      bind:this={pop.button}
      type="button"
      class="topnav-link more-btn"
      data-active={on}
      data-state={pop.state}
      aria-haspopup="menu"
      aria-expanded={pop.state === 'open'}
      aria-controls="more-menu"
      onclick={pop.toggle}
      onkeydown={pop.onButtonKey}
    >
      {t('更多')}{#if dot}<span class="nav-dot" role="status" aria-label={t('有待支付的订单')}></span>{/if}
      <ChevronDown class="more-chev" size={14} strokeWidth={1.75} aria-hidden="true" />
    </button>
    {#if pop.open}
      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <div
        bind:this={pop.menu}
        id="more-menu"
        class="menu-card more-card"
        data-state={pop.state}
        role="menu"
        tabindex="-1"
        aria-label={t('更多')}
        onkeydown={pop.onMenuKey}
      >
        {#each items as it (it.to)}
          {@const cur = isCurrent(it.to, loc.path)}
          <a role="menuitem" tabindex="-1" class="more-row" href={it.to} aria-current={cur ? 'page' : undefined} data-active={cur || undefined}>
            <span class="more-t">{t(it.label)}{#if it.to === R.orders && pendingOrders() > 0}<i class="more-dot" aria-hidden="true"></i>{/if}</span>
            <span class="more-d">{t(NOTES[it.to] ?? '')}</span>
          </a>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
.more-host { display: flex; }
.more-btn { gap: 2px; cursor: pointer; }
.more-btn :global(.more-chev) { flex: none; margin-left: 2px; color: var(--faint); transition: rotate var(--dur-fast) var(--ease-out); }
.more-btn[data-state='open'] { color: var(--fg); }
.more-btn[data-state='open'] :global(.more-chev) { rotate: 180deg; }
.more-btn:focus-visible { outline: none; box-shadow: var(--focus); border-radius: 4px; }
.more-card { top: calc(100% + 12px); right: auto; left: -14px; width: 248px; padding: 6px; transform-origin: top left; }
.more-row {
  display: block; padding: 9px 10px; border-radius: calc(var(--radius) * .9); color: var(--fg); outline: none;
  transition: background-color var(--dur-hover);
}
.more-row:hover, .more-row:focus { background: var(--hover); }
.more-row:focus-visible { box-shadow: var(--focus); }
.more-t { display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: var(--fw-nav); }
.more-row[data-active] .more-t { color: var(--brand); }
.more-d { display: block; margin-top: 2px; font-size: 12.5px; color: var(--muted); }
.more-dot { width: 6px; height: 6px; border-radius: 9999px; background: var(--brand); }
</style>
