<script lang="ts">
  import Menu from '@lucide/svelte/icons/menu';
  import X from '@lucide/svelte/icons/x';
  import { tick } from 'svelte';
  import { accountItems, isCurrent, navGroups, sheetLine } from '$lib/account';
  import { loadSheetFacts } from '$lib/attention.svelte';
  import { auth, scope, signOut } from '$lib/auth.svelte';
  import { i18n, preloadEN, t } from '$lib/i18n.svelte';
  import { changeLocale } from '$lib/prefs';
  import { loc } from '$lib/router.svelte';
  import { setTheme, theme, type ThemeMode } from '$lib/theme.svelte';

  /*
   * 窄屏（< 960px）菜单：顶栏下方铺满全屏的文字列表（样稿 dashboard.html#menu）。
   * 模态对话框：打开时锁住页面滚动、焦点进入列表并困在「列表 + 顶栏的关闭按钮」里，Esc 或再点按钮关闭并把焦点还给按钮；
   * 切页、窗口变宽到桌面布局时自动收起。
   */
  let open = $state(false);
  let button: HTMLButtonElement | undefined = $state();
  let sheet: HTMLDivElement | undefined = $state();

  const THEMES: { id: ThemeMode; label: string }[] = [
    { id: 'light', label: '浅色' },
    { id: 'dark', label: '深色' },
    { id: 'system', label: '跟随系统' },
  ];
  const services = $derived(navGroups().flat());
  const account = $derived(scope() === 'banned' ? [] : accountItems());

  async function show() {
    open = true;
    loadSheetFacts(scope());
    await tick();
    sheet?.querySelector<HTMLElement>('a, button')?.focus();
  }

  function hide(returnFocus = true) {
    if (!open) return;
    open = false;
    if (returnFocus) button?.focus();
  }

  /* 焦点困在「顶栏的关闭按钮 + 菜单」里 */
  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
    if (e.key !== 'Tab' || !sheet || !button) return;
    const list = [button, ...sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === -1 || i === list.length - 1 ? 0 : i + 1);
    e.preventDefault();
    list[next]?.focus();
  }

  $effect(() => {
    document.documentElement.classList.toggle('menu-open', open);
    return () => document.documentElement.classList.remove('menu-open');
  });

  $effect(() => {
    void loc.path;
    void loc.search;
    open = false;
  });

  $effect(() => {
    const wide = matchMedia('(min-width: 961px)');
    const close = () => { if (wide.matches) open = false; };
    wide.addEventListener('change', close);
    return () => wide.removeEventListener('change', close);
  });
</script>

<svelte:document onkeydown={onKey} />

<button
  bind:this={button}
  type="button"
  class="iconbtn menu-btn"
  aria-haspopup="dialog"
  aria-expanded={open}
  aria-controls="sheet"
  onclick={() => (open ? hide() : show())}
>
  {#if open}<X class="i" size={16} strokeWidth={1.75} aria-hidden="true" /><span>{t('关闭')}</span>
  {:else}<Menu class="i" size={16} strokeWidth={1.75} aria-hidden="true" /><span>{t('菜单')}</span>{/if}
</button>

{#if open}
  <div bind:this={sheet} id="sheet" class="sheet" role="dialog" aria-modal="true" aria-label={t('菜单')}>
    <div class="who"><b>{auth.me?.email}</b><span class="num">{sheetLine()}</span></div>

    <h2>{t('服务')}</h2>
    {#each services as it (it.to)}
      <a class="it" href={it.to} aria-current={isCurrent(it.to, loc.path, loc.search) ? 'page' : undefined}>{it.label}{#if it.meta}<em class="num">{it.meta}</em>{/if}</a>
    {/each}

    {#if account.length}
      <h2>{t('账户')}</h2>
      {#each account as it (it.to)}
        <a class="it" href={it.to} aria-current={isCurrent(it.to, loc.path, loc.search) ? 'page' : undefined}>{it.label}{#if it.meta}<em class="num">{it.meta}</em>{/if}</a>
      {/each}
    {/if}

    <h2>{t('偏好')}</h2>
    <div class="prefs" role="group" aria-label={t('主题')}>
      <span aria-hidden="true">{t('主题')}</span>
      <div>
        {#each THEMES as o (o.id)}
          <button type="button" aria-pressed={theme.mode === o.id} onclick={() => setTheme(o.id)}>{t(o.label)}</button>
        {/each}
      </div>
    </div>
    <div class="prefs" role="group" aria-label={t('语言')}>
      <span aria-hidden="true">{t('语言')}</span>
      <div>
        <button type="button" lang="zh-CN" aria-pressed={i18n.locale === 'zh-CN'} onclick={() => changeLocale('zh-CN')}>{'中文'}</button>
        <button type="button" lang="en" aria-pressed={i18n.locale === 'en'} onpointerenter={preloadEN} onfocus={preloadEN} onclick={() => changeLocale('en')}>English</button>
      </div>
    </div>

    <button type="button" class="out" onclick={() => { open = false; void signOut(); }}>{t('退出登录')}</button>
  </div>
{/if}
