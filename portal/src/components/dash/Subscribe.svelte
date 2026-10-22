<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import LinkIcon from '@lucide/svelte/icons/link';
  import type { SubFormat } from '@/api';
  import { PLATFORMS } from '@/data/platforms';
  import { enabledFormats, importLinks, mySubUrl, withFormat, type ImportLink } from '@/lib/sub-links';
  import Menu, { type MenuItem } from '../ui/Menu.svelte';
  import Qr from './Qr.svelte';
  import { auth, site, siteName } from '$lib/auth.svelte';
  import { t, tp } from '$lib/i18n.svelte';
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

  /** 打码显示：令牌只露头 4 位、尾 6 位 */
  const masked = $derived.by(() => {
    const m = /^(.*\/)([^/?#]+)(.*)$/.exec(url);
    if (!m || m[2].length < 14) return url;
    return `${m[1]}${m[2].slice(0, 4)}•••••••${m[2].slice(-6)}${m[3]}`;
  });

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
  <div class="access">
    <div class="main">
      <div class="row-actions">
        <button type="button" class="btn pri copy" onclick={copy}>
          {#if copied}<Check size={15} strokeWidth={2} aria-hidden="true" />{:else}<Copy size={15} strokeWidth={1.75} aria-hidden="true" />{/if}
          {copied ? t('已复制订阅链接') : t('复制订阅链接')}
        </button>
        <Menu class="select" label={t('订阅格式')} items={formatItems}>
          {t(FORMAT_LABEL[format])}<ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
        </Menu>
      </div>
      <div class="sublink"><LinkIcon size={14} strokeWidth={1.75} aria-hidden="true" /><span class="mono">{masked}</span></div>

      {#if clients.length > 0}
        <p class="k">{t('一键导入')}</p>
        <div class="clients">
          {#each clients as c (c.id)}
            <button type="button" onclick={() => importTo(c)}><b>{c.name}</b><span>{c.platforms}</span><em>{t('导入')}</em></button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="qr">
      <div class="box"><Qr value={url} /></div>
      <p>{t('扫码导入')}</p>
    </div>
  </div>

  <div class="help">
    <span class="lead"><Download size={15} strokeWidth={1.75} aria-hidden="true" />{t('还没有客户端？')}{downloads.length ? t('下载客户端：') : t('按平台查看教程：')}</span>
    {#if downloads.length}
      {#each downloads as d, i (`${d.platform}-${i}`)}
        <a href={d.url} target="_blank" rel="noopener noreferrer">{d.label ?? t(platformName(d.platform))}</a>
      {/each}
    {:else}
      {#each PLATFORMS as p (p.id)}
        <a href="{R.help}?q={encodeURIComponent(p.name)}">{t(p.name)}</a>
      {/each}
    {/if}
  </div>
{/if}

<style>
  .access { display: grid; grid-template-columns: minmax(0, 1fr) 128px; gap: 32px; }
  .main { min-width: 0; }
  .row-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .copy { min-width: 148px; }
  :global(.select) {
    display: inline-flex; align-items: center; gap: 6px; height: 36px; padding: 0 10px 0 12px; border-radius: 8px;
    border: 1px solid var(--line2); background: var(--surface); color: var(--body); font: inherit; font-size: 13.5px; cursor: pointer;
  }
  :global(.select svg) { color: var(--faint); }
  :global(.select[aria-expanded='true']), :global(.select:hover) { border-color: color-mix(in srgb, var(--fg) 28%, transparent); }
  .sublink { display: flex; align-items: center; gap: 8px; margin-top: 12px; color: var(--faint); min-width: 0; }
  .sublink :global(svg) { flex: none; }
  .mono { font-family: var(--font-mono); font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .k { margin: 24px 0 4px; font-size: 12.5px; color: var(--faint); }
  .clients { display: grid; grid-template-columns: 1fr 1fr; column-gap: 24px; }
  .clients button {
    display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 9px 0; border: 0; border-bottom: 1px solid var(--line);
    background: none; font: inherit; text-align: left; cursor: pointer; border-radius: 0;
  }
  .clients b { color: var(--fg); font-weight: 500; white-space: nowrap; }
  .clients span { flex: 1; min-width: 0; color: var(--faint); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .clients em { font-style: normal; color: var(--brand); font-size: 13px; }
  .clients button:hover b { color: var(--brand); }
  .qr { text-align: center; }
  .box { width: 128px; height: 128px; padding: 10px; background: var(--qr-paper); border: 1px solid var(--line); border-radius: 8px; }
  .qr p { margin-top: 8px; font-size: 12.5px; color: var(--faint); }
  .help { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; margin-top: 20px; font-size: 13px; color: var(--muted); }
  .help a { color: var(--body); }
  .help a:hover { color: var(--brand); }
  /* 引导语单独一行、平台链接在下面一行：左栏约 620px 放不下引导语 + 七个平台，同一行里会把最后一个（路由器）单独挤到下一行 */
  .lead { display: inline-flex; align-items: center; gap: 6px; flex-basis: 100%; }

  @media (max-width: 720px) {
    .access { grid-template-columns: 1fr; }
    .qr { display: none; }
    .clients { grid-template-columns: 1fr; }
  }
</style>
