<script lang="ts">
  import { onMount } from 'svelte';
  import ErrorScreen from './components/ErrorScreen.svelte';
  import PageView from './components/PageView.svelte';
  import DashLayout from './layouts/DashLayout.svelte';
  import GuestLayout from './layouts/GuestLayout.svelte';
  import { loadAttention } from '$lib/attention.svelte';
  import { auth, refresh, scope, siteName } from '$lib/auth.svelte';
  import { boot, startBoot } from '$lib/boot.svelte';
  import { t } from '$lib/i18n.svelte';
  import { REDIRECTS, match } from '$lib/pages';
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

  const dash = $derived(found ? found.page.layout === 'dash' : !!auth.me);

  onMount(startBoot);
</script>

{#snippet content()}
  {#if view.kind === 'page' && found}
    {#key loc.path}
      <PageView page={found.page} params={found.params} />
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
  <GuestLayout wide={!!found?.page.wide}>{@render content()}</GuestLayout>
{/if}
