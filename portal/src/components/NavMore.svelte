<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { MORE_START, isCurrent, moreItems } from '$lib/account';
  import { t } from '$lib/i18n.svelte';
  import { Pop } from '$lib/pop.svelte';
  import { loc } from '$lib/router.svelte';

  /*
   * 「更多」（v1.4.0 nav-more）：不是一列光秃秃的链接，而是带编号的目录——编号从 05 接着主导航数，每项一句说明，
   * 右侧挂当前的实时数字（「3 笔待支付」是点进去之前就该知道的事）。悬停 / 选中时编号变蓝、左侧伸出一道品牌色刻度。
   */
  const pop = new Pop();
  const items = $derived(moreItems());
  const inside = $derived(items.some((m) => isCurrent(m.to, loc.path)));
  const pad = (n: number) => String(n).padStart(2, '0');
</script>

{#if items.length > 0}
  <div class="menu-host more">
    <button
      bind:this={pop.button}
      type="button"
      class="topnav-link more-btn"
      data-active={inside}
      data-state={pop.state}
      aria-haspopup="menu"
      aria-expanded={pop.state === 'open'}
      aria-controls="more-menu"
      onclick={pop.toggle}
      onkeydown={pop.onButtonKey}
    >
      {t('更多')}<ChevronDown class="more-chev" size={14} strokeWidth={1.75} aria-hidden="true" />
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
        <div class="more-head" role="none">
          <span>{t('导航')}</span>
          <span class="tnum">{pad(MORE_START)} – {pad(MORE_START + items.length - 1)}</span>
        </div>
        <div class="more-list" role="none">
          {#each items as m, i (m.to)}
            {@const on = isCurrent(m.to, loc.path)}
            <a role="menuitem" tabindex="-1" class="more-item" href={m.to} data-on={on} aria-current={on ? 'page' : undefined}>
              <span class="more-tick" aria-hidden="true"></span>
              <span class="more-no tnum">{pad(MORE_START + i)}</span>
              <span class="more-body">
                <span class="more-l1">
                  <span class="more-t">{t(m.label)}</span>
                  {#if m.meta}<span class="more-m tnum">{m.meta}</span>{/if}
                </span>
                <span class="more-d">{t(m.desc ?? '')}</span>
              </span>
            </a>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}
