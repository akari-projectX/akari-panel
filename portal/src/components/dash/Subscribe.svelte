<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import type { SubFormat } from '@/api';
  import { PLATFORMS } from '@/data/platforms';
  import { enabledFormats, importLinks, mySubUrl, withFormat, type ImportLink } from '@/lib/sub-links';
  import Menu, { type MenuItem } from '../ui/Menu.svelte';
  import Qr from './Qr.svelte';
  import { auth, site, siteName } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
  import { navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { toast } from '$lib/toast.svelte';

  /*
   * 接入：一个订阅链接导入任意客户端（与 React 门户 components/subscribe.tsx 相同的行为，版式按样稿 dashboard.html）。
   *   · 「复制订阅链接」+ 格式（默认自动识别；系统设置里开着的格式才列出）；下面一行打码的链接（链接等同密码）；
   *   · 一键导入：系统设置里开着的客户端（面板已按开着的格式筛过，顺序即面板的顺序），各用自己认得的深链接；
   *   · 二维码（本地生成）；
   *   · 还没有客户端：站长配了下载地址就直接给下载，没配就按平台去文档页。
   */
  let format = $state<SubFormat>('auto');
  let copied = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(copyTimer));

  const FORMAT_LABEL: Record<SubFormat, string> = {
    auto: '自动识别',
    clash: 'Clash / mihomo',
    'sing-box': 'sing-box',
    links: '通用链接',
  };

  const base = $derived(mySubUrl(auth.me));
  const url = $derived(base ? withFormat(base, format) : '');
  const formatItems = $derived<MenuItem[]>(enabledFormats(auth.me).map((f) => ({
    id: f, label: t(FORMAT_LABEL[f]), selected: f === format, onselect: () => { format = f; },
  })));
  const clients = $derived<ImportLink[]>(base ? importLinks(base, siteName(), auth.me?.sub_import_clients ?? []) : []);
  const downloads = $derived(site.options?.branding?.client_downloads ?? []);
  const PRIMARY_COUNT = 3;
  const primary = $derived(clients.slice(0, PRIMARY_COUNT));
  const more = $derived(clients.slice(PRIMARY_COUNT));
  const moreItems = $derived<MenuItem[]>(more.map((c) => ({ id: c.id, label: c.name, sub: c.platforms, onselect: () => importTo(c) })));
  const dlItems = $derived<MenuItem[]>(downloads.length
    ? downloads.map((d, i) => ({
      id: `${d.platform}-${i}`, label: t(platformName(d.platform)), sub: d.label ?? t(PLATFORMS.find((p) => p.id === d.platform)?.client ?? ''),
      tail: t('下载'), onselect: () => { window.open(d.url, '_blank', 'noopener'); },
    }))
    : PLATFORMS.map((p) => ({ id: p.id, label: t(p.name), sub: t(p.client), tail: t('看教程'), onselect: () => navigate(`${R.help}?q=${encodeURIComponent(p.name)}`) })));

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      toast.error(t('复制失败，请手动选中复制'));
      return;
    }
    copied = true;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied = false; }, 2200);
    toast.success(t('订阅地址已复制'), { description: t('在客户端中粘贴即可导入') });
  }

  function importTo(c: ImportLink) {
    window.location.assign(c.href);
    toast.success(tp('正在唤起 {n}', { n: c.name }), { description: t('若未自动打开，请确认已安装该客户端') });
  }

  const platformName = (id: string) => PLATFORMS.find((p) => p.id === id)?.name ?? id;
</script>

{#if url}
  <div class="sub">
    <div class="sub-l">
      <div class="sub-acts">
        <button type="button" class="btn pri sub-copy" onclick={copy}>
          {#if copied}<Check size={16} strokeWidth={2} aria-hidden="true" />{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{/if}
          {copied ? t('已复制订阅链接') : t('复制订阅链接')}
        </button>
        <!-- 格式：默认按客户端自动识别；认不出的客户端可以手动指定 -->
        <Menu class="sub-fmt" label={t('订阅格式')} items={formatItems}>
          {t(FORMAT_LABEL[format])}<ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
        </Menu>
      </div>

      {#if clients.length > 0}
        <div>
          <div class="sub-k">{t('导入到客户端')}</div>
          <div class="sub-cl">
            {#each primary as c, i (c.id)}
              <span>
                {#if i > 0}<i class="sep" aria-hidden="true"></i>{/if}
                <button type="button" class="sub-imp" title={c.platforms} onclick={() => importTo(c)}>{c.name}</button>
              </span>
            {/each}
            {#if more.length > 0}
              <i class="sep" aria-hidden="true"></i>
              <Menu class="sub-more" label={t('更多')} items={moreItems}>{t('更多')}<ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /></Menu>
            {/if}
          </div>
        </div>
      {/if}

      <!-- 退路：站长在后台配了下载地址的平台直接给下载，没配的去文档页 -->
      <div class="sub-fb">
        <p>
          <Download size={14} strokeWidth={1.75} aria-hidden="true" />{t('还没有客户端？')}
          <Menu class="sub-dl" label={downloads.length ? t('下载客户端') : t('按平台查看教程')} items={dlItems}>
            {downloads.length ? t('下载客户端') : t('按平台查看教程')}<ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
          </Menu>
        </p>
      </div>
    </div>

    <div class="sub-qr">
      <div class="sub-box"><i class="c1"></i><i class="c2"></i><i class="c3"></i><i class="c4"></i><Qr value={url} mark defer /></div>
      <div class="sub-qk">{t('扫码导入')}</div>
    </div>
  </div>
{/if}

