<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import { accountItems, accountLine, attentionDot } from '$lib/account';
  import { loadMenuFacts } from '$lib/attention.svelte';
  import { scope, signOut } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { Pop } from '$lib/pop.svelte';
  
  /*
   * 宽屏右上角的账号入口（v1.4.0）：你的名字，名字下面一根细线——长度是剩余流量，和窄屏页头那两根线里下面那根是同一个意思。
   * 点开的卡片和窄屏菜单是同一个（AccountCard），只是没有导航：宽屏上导航都摆在顶栏。
   * 账号没有昵称，邮箱 @ 前那段就是这里能显示的「名字」。
   */
  /* 卡片（含十来个图标）按需加载：不进首屏；指针移上来 / 聚焦时就预取，点开时通常已经到了 */
  let Card = $state<typeof import('./AccountCard.svelte').default | undefined>();
  const loadCard = () => import('./AccountCard.svelte').then((m) => { Card = m.default; });
  const pop = new Pop(() => {
    loadMenuFacts(scope());
    return loadCard();
  });
  const a = $derived(accountLine());
  const name = $derived(a.email.split('@')[0] || t('我的账号'));
</script>

<div class="menu-host user">
  <button
    bind:this={pop.button}
    type="button"
    class="acct"
    aria-label={t('账户菜单')}
    aria-haspopup="menu"
    aria-expanded={pop.state === 'open'}
    aria-controls="user-menu"
    data-state={pop.state}
    data-tone={a.tone}
    style:--v="{a.value}%"
    onpointerenter={loadCard}
    onfocus={loadCard}
    onclick={pop.toggle}
    onkeydown={pop.onButtonKey}
  >
    <span class="acct-name">{name}</span>
    {#if attentionDot()}<i class="acct-dot" aria-hidden="true"></i>{/if}
    <ChevronDown class="acct-chev" size={14} strokeWidth={1.75} aria-hidden="true" />
  </button>
  {#if pop.open}
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
      bind:this={pop.menu}
      id="user-menu"
      class="menu-card"
      data-state={pop.state}
      role="menu"
      tabindex="-1"
      aria-label={t('账户菜单')}
      onkeydown={pop.onMenuKey}
    >
      {#if Card}
        <Card groups={[scope() === 'banned' ? [] : accountItems()]} onsignout={() => { pop.close(); void signOut(); }} />
      {/if}
    </div>
  {/if}
</div>
