<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import QrCode from '@lucide/svelte/icons/qr-code';
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
   * 接入：一个订阅链接导入任意客户端。
   *   · 「复制订阅链接」（正文色实底胶囊）+ 格式（默认自动识别；系统设置里开着的格式才列出）+ 二维码开关（默认收起，本地生成）；
   *   · 一键导入：系统设置里开着的客户端（面板已按开着的格式筛过，顺序即面板的顺序），名字之间一道细竖线，各用自己认得的深链接；
   *   · 还没有客户端：站长配了下载地址就直接给下载，没配就按平台去文档页。
   */
  let format = $state<SubFormat>('auto');
  let copied = $state(false);
  let qr = $state(false);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => () => clearTimeout(copyTimer));

  const FORMAT_LABEL: Record<SubFormat, string> = {
    auto: '自动识别',
    clash: 'Clash / mihomo',
    'sing-box': 'sing-box',
    surge: 'Surge',
    surfboard: 'Surfboard',
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
  <div class="acc-b">
    <div class="acc-row">
      <button type="button" class="btn pri acc-copy" onclick={copy}>
        {#if copied}<Check size={15} strokeWidth={2} aria-hidden="true" />{:else}<Copy size={15} strokeWidth={1.75} aria-hidden="true" />{/if}
        {copied ? t('已复制订阅链接') : t('复制订阅链接')}
      </button>
      <!-- 格式：默认按客户端自动识别；认不出的客户端可以手动指定 -->
      <Menu class="acc-fmt" label={t('订阅格式')} items={formatItems}>
        {t(FORMAT_LABEL[format])}<ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </Menu>
      <!-- 二维码默认收起（2026-10-30 用户：一直显示太挤） -->
      <button type="button" class="acc-fmt" aria-expanded={qr} aria-controls="sub-qr" onclick={() => (qr = !qr)}>
        <QrCode size={14} strokeWidth={1.75} aria-hidden="true" />{t('二维码')}
      </button>
    </div>

    {#if clients.length > 0}
      <div class="acc-k">{t('导入到客户端')}</div>
      <div class="acc-cl">
        {#each primary as c (c.id)}
          <button type="button" class="acc-imp" title={c.platforms} onclick={() => importTo(c)}>{c.name}</button>
        {/each}
        {#if more.length > 0}
          <Menu class="acc-more" label={t('更多')} items={moreItems}>{t('更多')}<ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" /></Menu>
        {/if}
      </div>
    {/if}

    <div id="sub-qr" class="acc-qr" data-open={qr || undefined}>
      <div>
        {#if qr}
          <div class="acc-qf"><Qr value={url} mark /></div>
          <p><b>{t('用手机扫码导入')}</b>{t('在手机客户端里扫一扫，订阅会自动添加。')}</p>
        {/if}
      </div>
    </div>

    <!-- 退路：站长在后台配了下载地址的平台直接给下载，没配的去文档页 -->
    <p class="acc-fb">
      <Download size={14} strokeWidth={1.75} aria-hidden="true" />{t('还没有客户端？')}
      <Menu class="acc-dl" label={downloads.length ? t('下载客户端') : t('按平台查看教程')} items={dlItems}>
        {downloads.length ? t('下载客户端') : t('按平台查看教程')}<ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </Menu>
    </p>
  </div>
{/if}
