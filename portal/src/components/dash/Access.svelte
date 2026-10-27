<script lang="ts">
  import Wifi from '@lucide/svelte/icons/wifi';
  import Download from '@lucide/svelte/icons/download';
  import Info from '@lucide/svelte/icons/info';
  import { PLATFORMS } from '@/data/platforms';
  import { mySubUrl } from '@/lib/sub-links';
  import Empty from '../Empty.svelte';
  import PaneHead from '../flat/PaneHead.svelte';
  import ResetSubscription from '../ResetSubscription.svelte';
  import Subscribe from './Subscribe.svelte';
  import { auth, site } from '$lib/auth.svelte';
  import { t } from '$lib/i18n.svelte';
  import { R } from '$lib/routes';

  /*
   * 接入配置（#subscribe：付款结果的「查看订阅」直达这里），分支：
   *   · 仅自研客户端（me.sub_own_client，有套餐）：不给链接、复制、二维码与一键导入，只给 Akari 客户端的下载
   *     （后台「外观与品牌」的客户端下载链接；站长没配就一句中性的说明）——components/own-client.tsx；
   *   · 有订阅链接：Subscribe；
   *   · 续费范围：订阅已暂停；链接读不出来：重置后才显示；没有套餐：去选套餐。
   * 没有套餐时面板照样给令牌，但链接里没有节点：不显示，引导去商店。
   */
  let { full }: { full: boolean } = $props();

  const me = $derived(auth.me);
  const hasPlan = $derived(!!auth.plan?.plan);
  const subUrl = $derived(hasPlan ? mySubUrl(me) : null);
  const downloads = $derived(site.options?.branding?.client_downloads ?? []);
  const platformName = (id: string) => PLATFORMS.find((p) => p.id === id)?.name ?? id;
</script>

<PaneHead>
  {#snippet title()}<Wifi size={16} strokeWidth={1.75} aria-hidden="true" />{t('接入配置')}{/snippet}
  {#snippet desc()}{me?.sub_own_client ? t('下载 Akari 客户端，登录账户即可使用') : t('一个链接，导入任意客户端')}{/snippet}
  {#snippet extra()}{#if full && hasPlan}<ResetSubscription />{/if}{/snippet}
</PaneHead>

  {#if full && hasPlan && me?.sub_own_client}
    <div class="own" data-testid="own-client">
      <p class="lead">{t('在客户端里登录账户即可自动获取节点')}</p>
      {#if downloads.length > 0}
        <div class="dl">
          {#each downloads as d, i (`${d.platform}-${i}`)}
            <a class={i === 0 ? 'btn pri' : 'btn'} href={d.url} target="_blank" rel="noopener noreferrer">
              <Download size={14} strokeWidth={1.75} aria-hidden="true" />{d.label ?? t(platformName(d.platform))}
            </a>
          {/each}
        </div>
      {:else}
        <p class="none"><Info size={14} strokeWidth={1.75} aria-hidden="true" />{t('客户端下载地址还没有公布，请留意公告或联系客服。')}</p>
      {/if}
    </div>
  {:else if subUrl}
    <Subscribe />
  {:else if !full}
    <Empty title={t('订阅已暂停')} desc={t('续费或购买流量重置包后，订阅链接会恢复。')}>
      {#snippet action()}<a class="btn sm pri" href={R.shop}>{t('去商店')}</a>{/snippet}
    </Empty>
  {:else if me?.sub_unreadable}
    <Empty title={t('订阅链接无法显示')} desc={t('保存的订阅链接读不出来了（站点主密钥已更换）。重置一次就会换成新的链接（旧链接随即失效）。')}>
      {#snippet action()}<ResetSubscription look="button" />{/snippet}
    </Empty>
  {:else}
    <Empty title={t('还没有可用的订阅')} desc={t('购买套餐后，订阅链接会出现在这里。')}>
      {#snippet action()}<a class="btn sm pri" href={R.shop}>{t('去选套餐')}</a>{/snippet}
    </Empty>
  {/if}

<style>
  .own { display: flex; flex-direction: column; gap: 16px; }
  .lead { color: var(--fg); }
  .dl { display: flex; flex-wrap: wrap; gap: 8px; }
  .none { display: flex; align-items: flex-start; gap: 6px; font-size: 13px; color: var(--muted); }
  .none :global(svg) { flex: none; margin-top: 4px; }
</style>
