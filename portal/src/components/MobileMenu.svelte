<script lang="ts">
  import { accountLine, attentionDot, linesLabel, menuGroups } from '$lib/account';
  import { loadSheetFacts } from '$lib/attention.svelte';
  import { scope, signOut } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { Pop } from '$lib/pop.svelte';
  
  /*
   * 窄屏（< 1024px）的页头菜单（v1.4.0）：一个按钮（两根线），一张卡片（AccountCard）。
   * 两根线：上面那根就是菜单；下面那根是剩余流量（灰轨加一截蓝，不足一成换成琥珀色）；末尾的小圆点 = 有事等你
   * （工单有新回复、有待支付的订单）。打开时两根线旋成 ×，卡片顶边那根细线接着把这个值画出来。
   * 卡片挂在按钮右下方：按钮 44px 高、居中在 64px 的页头里，所以离页头底边 8px。
   */
  /* 卡片（含十来个图标）按需加载：不进首屏；指针移上来 / 聚焦时就预取，点开时通常已经到了 */
  let Card = $state<typeof import('./AccountCard.svelte').default | undefined>();
  const loadCard = () => import('./AccountCard.svelte').then((m) => { Card = m.default; });
  const pop = new Pop(() => {
    loadSheetFacts(scope());
    return loadCard();
  });
  const a = $derived(accountLine());
  const dot = $derived(attentionDot());

  /* 本次访问第一次出现：下面那根从 0 画到当前值（同一次访问只画一次） */
  let intro = $state(false);
  $effect(() => {
    if (intro || a.value <= 0) return;
    try {
      if (sessionStorage.getItem('akari.line-drawn')) return;
      sessionStorage.setItem('akari.line-drawn', '1');
    } catch { return; }
    intro = true;
  });
</script>

<div class="menu-host lines-host">
  <button
    bind:this={pop.button}
    type="button"
    class="menu-lines"
    aria-label={linesLabel(t)}
    aria-haspopup="menu"
    aria-expanded={pop.state === 'open'}
    aria-controls="mobile-menu"
    data-state={pop.state}
    data-tone={a.tone}
    data-intro={intro || undefined}
    style:--v="{a.value}%"
    onpointerenter={loadCard}
    onfocus={loadCard}
    onclick={pop.toggle}
    onkeydown={pop.onButtonKey}
  >
    <i aria-hidden="true"></i>
    <i aria-hidden="true"><b></b></i>
    {#if dot}<s aria-hidden="true"></s>{/if}
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
        <Card groups={menuGroups()} prefs onsignout={() => { pop.close(); void signOut(); }} />
      {/if}
    </div>
  {/if}
</div>
