<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import ErrorScreen from './components/ErrorScreen.svelte';
  import PageView from './components/PageView.svelte';
  import DashLayout from './layouts/DashLayout.svelte';
  import GuestLayout from './layouts/GuestLayout.svelte';
  import { loadAttention } from '$lib/attention.svelte';
  import { auth, refresh, scope, siteName } from '$lib/auth.svelte';
  import { boot, startBoot } from '$lib/boot.svelte';
  import { t } from '$lib/i18n.svelte';
  import { REDIRECTS, match, type Page } from '$lib/pages';
  import { prefetchDash, prefetchSite, whenIdle } from '$lib/prefetch';
  import { loc, navigate } from '$lib/router.svelte';
  import { allowed, R, safeRedirect } from '$lib/routes';

  /*
   * 门禁（与 React 门户 App.tsx / auth-provider.tsx 相同）：
   *   · 访客页（登录、注册、找回密码）：已登录 → ?redirect= 指的站内页面；
   *   · 公开页（重置密码、注销结果、条款、隐私）：谁都能看；
   *   · 其余要登录：还不知道 → 启动画面；连不上面板 → 重试；没登录 → /login?redirect=<原地址>；
   *     账户范围进不了这一页 → 回仪表盘。
   */
  const found = $derived(match(loc.path));

  type View =
    | { kind: 'redirect'; to: string }
    | { kind: 'wait' }
    | { kind: 'failed' }
    | { kind: 'notfound' }
    | { kind: 'page' };

  const view = $derived.by((): View => {
    const legacy = REDIRECTS[loc.path];
    if (legacy) return { kind: 'redirect', to: legacy };
    if (!found) return { kind: 'notfound' };
    const { layout } = found.page;
    if (layout === 'public') return { kind: 'page' };
    if (auth.booting) return { kind: 'wait' };
    if (layout === 'guest') {
      return auth.me ? { kind: 'redirect', to: safeRedirect(new URLSearchParams(loc.search).get('redirect')) } : { kind: 'page' };
    }
    if (!auth.me) {
      if (auth.failed) return { kind: 'failed' };
      return { kind: 'redirect', to: `${R.login}?redirect=${encodeURIComponent(loc.path + loc.search)}` };
    }
    if (!allowed(loc.path, scope())) return { kind: 'redirect', to: R.dashboard };
    return { kind: 'page' };
  });

  $effect(() => {
    if (view.kind === 'redirect') navigate(view.to, { replace: true });
  });

  /* 标题：「页面 · 站点」 */
  $effect(() => {
    const name = found ? t(found.page.title) : t('这片海图上没有这一页');
    document.title = `${name} · ${siteName()}`;
  });

  /* 导航上的提醒数字：启动画面收起之后再取，换了账户（范围）重新取 */
  /* 待绑定邮箱的账户除了 /me 什么都取不到：不取 */
  const who = $derived(auth.me && !auth.me.email_pending ? `${auth.me.id}:${scope()}` : '');
  $effect(() => {
    if (boot.out && who) loadAttention(scope());
  });

  /* 切页预取（lib/prefetch）：启动画面收起后趁空闲把其余页面的分包与首屏数据取好；换了账户（范围）重新来 */
  $effect(() => {
    if (!boot.out || auth.booting) return;
    const s = scope();
    /* 用户中心：启动画面收起时首屏已经画全，最多等 500ms 空闲就开始（切页常在进门后一两秒内） */
    if (who && s) return whenIdle(() => prefetchDash(s), 500);
    if (!auth.me) return whenIdle(prefetchSite);
  });

  /* 公开页（条款、隐私、重设密码……）：登录了就用用户中心的页头（v1.4.0 SiteLayout），没登录用访客页头 */
  const dash = $derived(found ? found.page.layout === 'dash' || !!auth.me : !!auth.me);

  /*
   * 切页外壳（v1.4.0 page-transition）：旧页面淡出（--dur-exit）→ 回到页首 → 新页面淡入（PageView 的 .page）。
   * 旧页面这一份实例留在原地淡出（shown 是它的页面与参数）；退场期间又切了一次：退完时直接换成最新的那一页。
   * 刷新后的第一页不播退场；系统要求减少动效时直接换页。
   */
  type Shown = { path: string; page: Page; params: Record<string, string> };
  let shown = $state<Shown | null>(null);
  let leaving = $state(false);
  let latest: Shown | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  const swap = () => {
    leaveTimer = undefined;
    if (!latest) return;
    if (!location.hash) window.scrollTo(0, 0);
    shown = latest;
    leaving = false;
  };
  $effect(() => {
    const cur: Shown | null = view.kind === 'page' && found ? { path: loc.path, page: found.page, params: found.params } : null;
    untrack(() => {
      latest = cur;
      if (!cur) { clearTimeout(leaveTimer); leaveTimer = undefined; shown = null; leaving = false; if (view.kind !== 'wait') window.scrollTo(0, 0); return; }
      if (!shown || shown.path === cur.path) { shown = cur; return; }
      if (leaveTimer) return;
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { swap(); return; }
      leaving = true;
      leaveTimer = setTimeout(swap, 100);
    });
  });

  onMount(startBoot);
</script>

{#snippet content()}
  {#if view.kind === 'page' && found && shown}
    {#key shown.path}
      <PageView page={shown.page} params={shown.params} {leaving} />
    {/key}
  {:else if view.kind === 'notfound'}
    <ErrorScreen kind="notfound" />
  {:else if view.kind === 'failed'}
    <ErrorScreen kind="failed" onretry={() => void refresh()} />
  {/if}
{/snippet}

{#if view.kind === 'wait' || view.kind === 'redirect'}
  <!-- 门禁还没定（启动画面盖着）或正在跳转 -->
{:else if dash && auth.me}
  <DashLayout>{@render content()}</DashLayout>
{:else}
  <GuestLayout>{@render content()}</GuestLayout>
{/if}
