<script lang="ts">
  import { accountItems, accountLine, attentionDot, linesLabel, navItems } from '$lib/account';
  import { loadSheetFacts } from '$lib/attention.svelte';
  import { scope, signOut } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { Pop } from '$lib/pop.svelte';

  /*
   * 窄屏（< 1024px）的页头菜单（外观 A）：头像 + 三道线的按钮，一张卡片（AccountCard，带页面导航）。
   * 有事等你（工单新回复、待支付订单）时头像右上一个小圆点；打开时三道线旋成 ×。
   */
  /* 卡片（含十来个图标）按需加载：不进首屏；指针移上来 / 聚焦时就预取，点开时通常已经到了 */
  let Card = $state<typeof import('./AccountCard.svelte').default | undefined>();
  const loadCard = () => import('./AccountCard.svelte').then((m) => { Card = m.default; });
  const pop = new Pop(() => {
    loadSheetFacts(scope());
    return loadCard();
  });
  const a = $derived(accountLine());
</script>

<div class="menu-host lines-host">
  <button
    bind:this={pop.button}
    type="button"
    class="menu-me"
    aria-label={linesLabel(t)}
    aria-haspopup="menu"
    aria-expanded={pop.state === 'open'}
    aria-controls="mobile-menu"
    data-state={pop.state}
    onpointerenter={loadCard}
    onfocus={loadCard}
    onclick={pop.toggle}
    onkeydown={pop.onButtonKey}
  >
    <span class="av" aria-hidden="true">{a.initial}{#if attentionDot()}<i class="av-dot"></i>{/if}</span>
    <span class="burger" aria-hidden="true"><i></i><i></i><i></i></span>
  </button>
  {#if pop.open}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      bind:this={pop.menu}
      id="mobile-menu"
      class="menu-card"
      data-state={pop.state}
      role="menu"
      tabindex="-1"
      aria-label={t('菜单')}
      onkeydown={pop.onMenuKey}
    >
      {#if Card}
        <Card nav={navItems()} links={accountItems()} onsignout={() => { pop.close(); void signOut(); }} />
      {/if}
    </div>
  {/if}
</div>
