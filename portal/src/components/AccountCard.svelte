<script lang="ts">
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import LogOut from '@lucide/svelte/icons/log-out';
  import { mySubUrl } from '@/lib/sub-links';
  import { accountLine, isCurrent, type NavLink } from '$lib/account';
  import { auth, scope } from '$lib/auth.svelte';
  import { Copied } from '$lib/copy.svelte';
  import { i18n, preloadEN, t, tp } from '$lib/i18n.svelte';
  import { changeLocale } from '$lib/prefs';
  import { R } from '$lib/routes';
  import { loc } from '$lib/router.svelte';
  import { setTheme, theme, type ThemeMode } from '$lib/theme.svelte';
  import { thumb } from '$lib/thumb';
  import { ICONS } from './menu-icons';
  import MenuRow from './MenuRow.svelte';

  /*
   * 头像菜单（外观 A · 纸面简约）：桌面点头像、窄屏点「头像 + 三道线」弹出的是同一张卡片，宽 300px。
   *   · 抬头：头像、名字（邮箱 @ 前）、邮箱；
   *   · 套餐：名字、还剩几天、一根用量条、已用 / 剩余，两个快捷按钮「复制订阅」「续费」（被封禁的账户没有这一块）；
   *   · 页面导航（只在窄屏：宽屏的导航在顶栏）；
   *   · 钱包 / 邀请、设置；外观与语言两枚开关；退出登录。
   */
  let { nav = [], links, onsignout }: { nav?: NavLink[]; links: NavLink[]; onsignout: () => void } = $props();

  const a = $derived(accountLine());
  const name = $derived(a.email.split('@')[0] || t('我的账号'));
  const banned = $derived(scope() === 'banned');
  const subUrl = $derived(a.plan ? mySubUrl(auth.me) : null);
  const copied = new Copied<'sub'>();

  const THEMES: { id: ThemeMode; label: string }[] = [
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '深色' },
    { id: 'system', label: '自动' },
  ];
</script>

<div class="acc-head">
  <span class="av lg" aria-hidden="true">{a.initial}</span>
  <div class="acc-who">
    <div class="acc-name">{name}</div>
    {#if a.email}<div class="acc-email" title={a.email}>{a.email}</div>{/if}
  </div>
</div>

{#if !banned}
  <div class="acc-plan" data-tone={a.tone}>
    <div class="acc-pl1">
      <span class="acc-pn">{a.plan ?? t('还没有套餐')}</span>
      {#if a.plan && a.days !== null}<span class="acc-days tnum">{tp('还有 {n} 天', { n: a.days })}</span>{/if}
    </div>
    {#if a.has}
      <div class="acc-bar" aria-hidden="true"><b style:width="{100 - a.value}%"></b></div>
      <div class="acc-pl2 tnum">
        <span>{tp('已用 {n} GB', { n: a.usage.used.toFixed(1) })}</span>
        <span class:warn={a.tone}>{tp('剩余 {n} GB', { n: a.usage.left.toFixed(1) })}</span>
      </div>
    {/if}
    <div class="acc-qa" role="none">
      {#if subUrl}
        <button role="menuitem" tabindex="-1" type="button" class="qa" onclick={() => copied.copy(subUrl, 'sub')}>
          {#if copied.which === 'sub'}<Check size={14} strokeWidth={2} aria-hidden="true" />{t('已复制')}{:else}<Copy size={14} strokeWidth={1.75} aria-hidden="true" />{t('复制订阅')}{/if}
        </button>
      {/if}
      <a role="menuitem" tabindex="-1" class="qa pri" href={R.shop}>{a.plan ? t('续费') : t('购买')}</a>
    </div>
  </div>
{/if}

{#if nav.length > 0}
  <div class="card-group" role="none">
    {#each nav as l (l.to)}
      <MenuRow icon={ICONS[l.icon]} label={t(l.label)} meta={l.meta} attention={l.attention} active={isCurrent(l.to, loc.path)} href={l.to} />
    {/each}
  </div>
{/if}

{#if links.length > 0}
  <div class="card-group" role="none">
    {#each links as l (l.to)}
      <MenuRow icon={ICONS[l.icon]} label={t(l.label)} meta={l.meta} active={isCurrent(l.to, loc.path)} href={l.to} />
    {/each}
  </div>
{/if}

<div class="prefs" role="none">
  <div class="pref">
    <span>{t('外观')}</span>
    <div class="seg" {@attach thumb} role="group" aria-label={t('切换明暗模式')}>
      {#each THEMES as o (o.id)}
        <button type="button" data-nav class="seg-b" aria-pressed={theme.mode === o.id} onclick={() => setTheme(o.id)}>{t(o.label)}</button>
      {/each}
    </div>
  </div>
  <div class="pref">
    <span>{t('语言')}</span>
    <div class="seg" {@attach thumb} role="group" aria-label={t('切换语言')} onpointerenter={preloadEN} onfocusin={preloadEN}>
      <button type="button" data-nav lang="zh-CN" class="seg-b" aria-pressed={i18n.locale === 'zh-CN'} onclick={() => changeLocale('zh-CN')}>{'中文'}</button>
      <button type="button" data-nav lang="en" class="seg-b" aria-label="English" aria-pressed={i18n.locale === 'en'} onclick={() => changeLocale('en')}>EN</button>
    </div>
  </div>
</div>

<div class="card-group last" role="none">
  <MenuRow icon={LogOut} label={t('退出登录')} destructive onselect={onsignout}>
    {#snippet meta()}<span class="soft">{t('所有设备')}</span>{/snippet}
  </MenuRow>
</div>

<style>
.acc-head { display: flex; align-items: center; gap: 12px; padding: 16px 16px 14px; }
.acc-who { min-width: 0; }
.acc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14.5px; font-weight: var(--fw-strong); color: var(--fg); }
.acc-email { margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; color: var(--muted); }

.acc-plan { margin: 0 12px 4px; padding: 12px; border: 1px solid var(--line); border-radius: calc(var(--radius) * 1.2); }
.acc-pl1 { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.acc-pn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: var(--fw-strong); color: var(--fg); }
.acc-days { flex: none; font-size: 12px; color: var(--muted); }
.acc-bar { position: relative; height: 3px; margin-top: 10px; border-radius: 3px; overflow: hidden; background: var(--line); }
.acc-bar > b { position: absolute; inset: 0 auto 0 0; background: var(--fg); animation: line-draw var(--dur-slow) var(--ease-out) both; }
.acc-plan[data-tone='warn'] .acc-bar > b { background: var(--warn); }
.acc-pl2 { display: flex; justify-content: space-between; gap: 10px; margin-top: 6px; font-size: 12px; color: var(--muted); }
.acc-pl2 .warn { color: var(--warn); }
.acc-qa { display: flex; gap: 8px; margin-top: 12px; }
.qa {
  display: inline-flex; flex: 1; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 10px; border: 1px solid var(--line2);
  border-radius: 9999px; background: none; color: var(--fg); font: inherit; font-size: 13px; font-weight: var(--fw-strong); white-space: nowrap;
  cursor: pointer; outline: none; transition: background-color var(--dur-hover), border-color var(--dur-hover);
}
.qa:hover, .qa:focus { background: var(--hover); }
.qa:focus-visible { box-shadow: var(--focus); }
.qa.pri { border-color: var(--fg); background: var(--fg); color: var(--bg); }
.qa.pri:hover, .qa.pri:focus { background: var(--body); border-color: var(--body); }

.card-group { padding: 6px; border-top: 1px solid var(--line); }
.acc-plan + .card-group, .acc-head + .card-group { margin-top: 8px; }

.prefs { display: flex; flex-direction: column; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--line); }
.pref { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--muted); }
.seg { display: flex; align-items: center; padding: 2px; border: 1px solid var(--line); border-radius: 9999px; }
.seg-b {
  display: inline-flex; align-items: center; justify-content: center; height: 24px; padding: 0 10px; border: 0; border-radius: 9999px;
  background: none; color: var(--muted); font: inherit; font-size: 12px; font-weight: var(--fw-strong); transition: color var(--dur-base) var(--ease-out);
}
.seg-b:hover { color: var(--fg); }
.seg-b[aria-pressed='true'] { color: var(--bg); }
/* 当前项的实底是 .seg 上会滑的那块（lib/thumb.ts、app.css「分段切换的滑块」）；量到之前当前项自己铺底 */
.seg:not([data-thumb]) .seg-b[aria-pressed='true'] { background: var(--fg); }

.soft { font-weight: var(--fw-regular); color: var(--muted); }
@media (prefers-reduced-motion: reduce) { .acc-bar > b { animation: none; } }
</style>
