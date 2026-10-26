<script lang="ts">
  import LogOut from '@lucide/svelte/icons/log-out';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import { accountLine, isCurrent, type NavLink } from '$lib/account';
  import { scope } from '$lib/auth.svelte';
  import { i18n, preloadEN, t, tp } from '$lib/i18n.svelte';
  import { changeLocale } from '$lib/prefs';
  import { R } from '$lib/routes';
  import { loc } from '$lib/router.svelte';
  import { setTheme, theme, type ThemeMode } from '$lib/theme.svelte';
  import { ICONS } from './menu-icons';
  import MenuRow from './MenuRow.svelte';

  /*
   * 页头弹出的那张卡片（v1.4.0 components/account-card）：手机上的菜单、桌面上点名字弹出的账号菜单是同一个东西，宽 292px。
   * 顶边一根细线（剩余流量，打开时从左画到对应的值）、账号那一行（剩余流量 · 剩余天数，右边「续费」）、
   * 若干组带图标的行、（窄屏）语言与明暗两枚小开关、最底下的「退出登录」。
   * 桌面的卡片只有「我的订单 / 设置」一组，没有偏好开关：宽屏上它们在顶栏。
   */
  let { groups, prefs = false, onsignout }: { groups: NavLink[][]; prefs?: boolean; onsignout: () => void } = $props();

  const a = $derived(accountLine());
  /* 邮箱单独一行：和套餐名挤在一行时，长邮箱把套餐名截成「标…」 */
  const sub = $derived([a.has ? a.plan : null, a.has ? tp('共 {n} GB', { n: Math.round(a.usage.total) }) : null].filter(Boolean).join(' · '));

  const THEMES: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: '浅色', icon: Sun },
    { id: 'dark', label: '深色', icon: Moon },
    { id: 'system', label: '跟随系统', icon: Monitor },
  ];
</script>

<div class="card-line" aria-hidden="true" data-tone={a.tone} style:--v="{a.value}%"><b></b></div>

<div class="acc-head">
  <div class="acc-main">
    <div class="acc-l1">
      {#if a.has}
        <b class="tnum acc-left" class:warn={a.tone}>{a.usage.left.toFixed(1)}</b>{t('GB 剩余')}{#if a.days !== null}<span class="acc-dot">·</span>{tp('还有 {n} 天', { n: a.days })}{/if}
      {:else}
        <b class="acc-none">{a.plan ?? t('还没有套餐')}</b>
      {/if}
    </div>
    {#if sub}<div class="acc-l2">{sub}</div>{/if}
    {#if a.email}<div class="acc-l2" title={a.email}>{a.email}</div>{/if}
  </div>
  {#if scope() !== 'banned'}
    <a role="menuitem" tabindex="-1" class="acc-renew" href={R.shop}>{a.plan ? t('续费') : t('购买')}</a>
  {/if}
</div>
<hr class="card-sep top" role="none" />

{#each groups as g, gi (gi)}
  <div class="card-group" role="none">
    {#each g as l (l.to)}
      <MenuRow icon={ICONS[l.icon]} label={t(l.label)} meta={l.meta} attention={l.attention} active={isCurrent(l.to, loc.path)} href={l.to} />
    {/each}
  </div>
  <hr class="card-sep" class:last={!prefs && gi === groups.length - 1} role="none" />
{/each}

{#if prefs}
  <div class="prefs-row" role="none">
    <div class="seg" role="group" aria-label={t('切换语言')} onpointerenter={preloadEN} onfocusin={preloadEN}>
      <button type="button" data-nav lang="zh-CN" class="seg-b" aria-label={'中文'} title={'中文'} aria-pressed={i18n.locale === 'zh-CN'} onclick={() => changeLocale('zh-CN')}>{'中'}</button>
      <button type="button" data-nav lang="en" class="seg-b" aria-label="English" title="English" aria-pressed={i18n.locale === 'en'} onclick={() => changeLocale('en')}>EN</button>
    </div>
    <div class="seg" role="group" aria-label={t('切换明暗模式')}>
      {#each THEMES as o (o.id)}
        {@const Icon = o.icon}
        <button type="button" data-nav class="seg-b icon" aria-pressed={theme.mode === o.id} aria-label={t(o.label)} title={t(o.label)} onclick={() => setTheme(o.id)}>
          <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      {/each}
    </div>
  </div>
  <hr class="card-sep last" role="none" />
{/if}

<div class="card-group" role="none">
  <MenuRow icon={LogOut} label={t('退出登录')} destructive onselect={onsignout}>
    {#snippet meta()}<span class="soft">{t('所有设备')}</span>{/snippet}
  </MenuRow>
</div>

<style>
.card-line { position: relative; height: 2px; background: var(--card-track); }
.card-line > b { position: absolute; inset: 0 auto 0 0; width: var(--v, 0%); background: var(--brand); animation: line-draw var(--dur-slow) var(--ease-out) both; }
.card-line[data-tone='warn'] > b { background: var(--amber); }
.card-sep { height: 1px; margin: 4px 0; border: 0; background: var(--line); }
.card-sep.top { margin-top: 0; }
.card-sep.last { margin-bottom: 0; }
.card-group { padding: 6px; }

.acc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 12px 14px 10px; }
.acc-main { min-width: 0; }
.acc-l1 { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--muted); }
.acc-left { margin-right: 3px; font-size: 18px; font-weight: var(--fw-strong); letter-spacing: -.02em; color: var(--fg); font-variant-numeric: tabular-nums; }
.acc-left.warn { color: var(--amber); }
.acc-dot { margin-inline: 6px; opacity: .6; }
.acc-none { font-size: 14.5px; font-weight: var(--fw-strong); color: var(--fg); }
.acc-l2 { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--muted); }
.acc-renew {
  flex: none; margin-top: 2px; padding: 2px 6px; border-radius: calc(var(--radius) * .8); font-size: 13px; font-weight: var(--fw-strong); color: var(--brand);
  outline: none; cursor: pointer;
}
.acc-renew:hover, .acc-renew:focus { background: var(--brand-soft); }

/* 窄屏卡片里的语言与明暗：两枚小开关放在一行 */
.prefs-row { display: flex; align-items: center; gap: 8px; padding: 8px 14px; }
.seg { display: flex; align-items: center; padding: 3px; border: 1px solid var(--line); border-radius: 9999px; }
.seg-b {
  display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 0 8px; border: 0; border-radius: 9999px;
  background: none; color: var(--muted); font: inherit; font-size: 12px; font-weight: var(--fw-strong); transition: color var(--dur-hover), background-color var(--dur-hover);
}
.seg-b.icon { width: 32px; padding: 0; }
.seg-b:hover { color: var(--fg); }
.seg-b[aria-pressed='true'] { background: var(--fg); color: var(--bg); }

.soft { font-weight: var(--fw-regular); color: var(--muted); }
@media (prefers-reduced-motion: reduce) { .card-line > b { animation: none; } }
</style>
