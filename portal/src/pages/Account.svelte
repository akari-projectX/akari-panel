<script lang="ts">
  import '../styles/pages/account.css';
  import PageTitle from '../components/flat/PageTitle.svelte';
  import Monitor from '@lucide/svelte/icons/monitor';
  import Moon from '@lucide/svelte/icons/moon';
  import Sun from '@lucide/svelte/icons/sun';
  import { formatDate } from '@/lib/format';
  import { mySubUrl } from '@/lib/sub-links';
  import ResetSubscription from '../components/ResetSubscription.svelte';
  import Security from '../components/settings/Security.svelte';
  import { auth, scope, site } from '$lib/auth.svelte';
  import { i18n, preloadEN, t, tp, type Locale } from '$lib/i18n.svelte';
  import { changeLocale } from '$lib/prefs';
  import { loc, navigate } from '$lib/router.svelte';
  import { R } from '$lib/routes';
  import { siteFlags } from '$lib/site';
  import { setTheme, theme, type ThemeMode } from '$lib/theme.svelte';

  /*
   * 设置：
   *   #account       账户：邮箱（验证 / 更换）、套餐一行摘要
   *   #security      登录与安全：密码、通行密钥、只用通行密钥、退出所有设备（components/settings/Security）
   *   #subscription  订阅链接：状态 + 重置（读不出来的链接也能重置；续费范围说明续费后可用）
   *   #preferences   偏好：界面语言（= 邮件语言，主动切换时才同步）、明暗（含跟随系统）
   *   #danger        危险操作：注销账户
   * 旧链接 /account?tab=security 换成 #security。分区导航：宽屏左侧吸顶竖排，窄屏页头下吸顶横排（可横滑）；滚动时高亮当前分区。
   * 版式：每个分区一个小标题 + 细线分隔的设置行（左：名称 + 说明，右：当前值 + 操作），不套卡片。对话框第一次打开时才下载。
   */
  const PARTS = [
    { id: 'account', label: '账户' },
    { id: 'security', label: '登录与安全' },
    { id: 'subscription', label: '订阅链接' },
    { id: 'preferences', label: '偏好' },
    { id: 'danger', label: '危险操作' },
  ];

  const s = $derived(siteFlags(site.options));
  const me = $derived(auth.me);
  const p = $derived(auth.plan?.plan);
  const sc = $derived(scope());

  /* ── 订阅链接的状态 ── */
  const subState = $derived(
    sc !== 'full' ? 'paused' : me?.sub_own_client ? 'own' : mySubUrl(me) ? 'ok' : me?.sub_unreadable ? 'unreadable' : 'none',
  );

  /* ── 对话框（第一次打开时才下载） ── */
  let verifying = $state(false);
  let verifyLoaded = $state(false);
  let changing = $state(false);
  let changeLoaded = $state(false);
  let deleting = $state(false);
  let deleteLoaded = $state(false);

  /* ── 锚点：带 # 打开时滚到那个分区 ── */
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function scrollTo(id: string, smooth = true) {
    document.getElementById(id)?.scrollIntoView({ behavior: smooth && !still() ? 'smooth' : 'auto', block: 'start' });
  }
  $effect(() => {
    const id = decodeURIComponent(loc.hash.slice(1));
    if (!id) return;
    const timer = setTimeout(() => scrollTo(id), 80);
    return () => clearTimeout(timer);
  });

  function jump(e: MouseEvent, id: string) {
    e.preventDefault();
    navigate(`${loc.path}#${id}`, { replace: true });
    active = id;
    scrollTo(id);
  }

  /* ── 滚动时高亮当前分区（视口上部 1/3 处的那一个） ── */
  let active = $state(PARTS[0].id);
  $effect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = PARTS.find((x) => seen.get(x.id));
      if (first) active = first.id;
    }, { rootMargin: '-72px 0px -62% 0px' });
    PARTS.forEach((x) => { const el = document.getElementById(x.id); if (el) io.observe(el); });
    return () => io.disconnect();
  });

  /* ── 偏好 ── */
  const LOCALES: { id: Locale; short: string; label: string }[] = [
    { id: 'zh-CN', short: '中', label: '简体中文' },
    { id: 'en', short: 'EN', label: 'English' },
  ];
  const THEMES: { id: ThemeMode; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: '浅色', icon: Sun },
    { id: 'dark', label: '深色', icon: Moon },
    { id: 'system', label: '跟随系统', icon: Monitor },
  ];
</script>

<PageTitle title={t('设置')} sub={t('账户、登录与安全、订阅链接、语言与明暗。')} />

<div class="settings-page">
  <nav aria-label={t('设置分区')} class="settings-nav">
    <ul>
      {#each PARTS as x (x.id)}
        <li><a class="settings-nav-link" href="#{x.id}" aria-current={active === x.id ? 'location' : undefined} onclick={(e) => jump(e, x.id)}>{t(x.label)}</a></li>
      {/each}
    </ul>
  </nav>

  <div class="parts">
    <section id="account" class="sec" aria-labelledby="h-account">
      <div class="sec-head"><div><h2 id="h-account" class="sec-title">{t('账户')}</h2></div></div>
      <div class="set-row">
        <div class="set-l">
          <div class="set-t">{t('邮箱')}</div>
          <p class="set-d">{s.mail ? t('登录名，也是到期提醒、收据和找回密码的收件地址。') : t('站点没有开启邮件发送，暂时不能验证或更换邮箱。')}</p>
        </div>
        <div class="set-r">
          <span class="val email">
            {me?.email}
            {#if me?.email_verified}<span class="bdg ok12">{t('已验证')}</span>{:else}<span class="bdg warn12">{t('未验证')}</span>{/if}
          </span>
          {#if s.mail}
            <span class="btns">
              {#if !me?.email_verified}<button type="button" class="btn pri" onclick={() => { verifyLoaded = true; verifying = true; }}>{t('验证')}</button>{/if}
              <button type="button" class="btn" onclick={() => { changeLoaded = true; changing = true; }}>{t('更换')}</button>
            </span>
          {/if}
        </div>
      </div>
      <div class="set-row">
        <div class="set-l">
          <div class="set-t">{t('套餐')}</div>
          <p class="set-d">{t('流量、速率与订阅导入都在仪表盘。')}</p>
        </div>
        <div class="set-r">
          {#if p}
            <span class="val" title={p.name}>
              {auth.plan?.expires_at ? tp('{p} · {d} 到期', { p: p.name, d: formatDate(auth.plan.expires_at) }) : tp('{p} · 长期有效', { p: p.name })}
            </span>
          {:else}
            <span class="val muted">{t('未订阅')}</span>
          {/if}
          <span class="btns">
            {#if p && sc === 'full'}<a class="btn" href={R.dashboard}>{t('查看')}</a>{/if}
            <a class={p ? 'btn' : 'btn pri'} href={R.shop}>{p ? t('续费') : t('去商店')}</a>
          </span>
        </div>
      </div>
    </section>

    <Security />

    <section id="subscription" class="sec" aria-labelledby="h-subscription">
      <div class="sec-head"><div><h2 id="h-subscription" class="sec-title">{t('订阅链接')}</h2></div></div>
      <div class="set-row">
        <div class="set-l">
          <div class="set-t">{t('订阅链接')}</div>
          <p class="set-d">{t('等同于账号凭证：拿到它的人能用你的流量。一旦外泄就重置，旧链接与所有设备上的连接立即失效。')}</p>
        </div>
        <div class="set-r">
          <span class="val" class:muted={subState === 'paused' || subState === 'none'}>
            {subState === 'ok' ? t('正常')
              : subState === 'own' ? t('仅限 Akari 客户端（登录账户获取）')
              : subState === 'unreadable' ? t('无法显示，重置后可查看')
              : subState === 'paused' ? t('续费后可用')
              : t('购买套餐后可用')}
          </span>
          <span class="btns">
            {#if subState === 'ok' || subState === 'unreadable' || subState === 'own'}<ResetSubscription look="button" />{/if}
            {#if subState === 'ok' || subState === 'own'}
              <a class="btn" href="{R.dashboard}#subscribe">{subState === 'own' ? t('下载客户端') : t('去导入')}</a>
            {/if}
            {#if subState === 'paused' || subState === 'none'}<a class="btn pri" href={R.shop}>{t('去商店')}</a>{/if}
          </span>
        </div>
      </div>
    </section>

    <section id="preferences" class="sec" aria-labelledby="h-preferences">
      <div class="sec-head"><div><h2 id="h-preferences" class="sec-title">{t('偏好')}</h2></div></div>
      <div class="set-row">
        <div class="set-l">
          <div class="set-t">{t('界面语言')}</div>
          <p class="set-d">{t('邮件也用这门语言：在这里或页头切换时一起改。')}</p>
        </div>
        <div class="set-r">
          <div class="seg" role="group" aria-label={t('切换语言')} onpointerenter={preloadEN} onfocusin={preloadEN}>
            {#each LOCALES as l (l.id)}
              <button type="button" lang={l.id} title={l.label} aria-pressed={i18n.locale === l.id} onclick={() => { if (i18n.locale !== l.id) void changeLocale(l.id); }}>{l.short}</button>
            {/each}
          </div>
        </div>
      </div>
      <div class="set-row">
        <div class="set-l">
          <div class="set-t">{t('明暗')}</div>
          <p class="set-d">{t('浅色、深色，或跟随系统（默认）。')}</p>
        </div>
        <div class="set-r">
          <div class="seg" role="group" aria-label={t('切换明暗模式')}>
            {#each THEMES as x (x.id)}
              {@const Icon = x.icon}
              <button type="button" class="ic" aria-pressed={theme.mode === x.id} aria-label={t(x.label)} title={t(x.label)} onclick={() => setTheme(x.id)}>
                <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            {/each}
          </div>
        </div>
      </div>
    </section>

    <section id="danger" class="sec settings-danger" aria-labelledby="h-danger">
      <div class="sec-head"><div><h2 id="h-danger" class="sec-title">{t('危险操作')}</h2></div></div>
      <div class="set-row">
        <div class="set-l">
          <div class="set-t">{t('注销账户')}</div>
          <p class="set-d">{t('删除你的个人数据。付款与退款记录按法规匿名保留。注销后不能恢复。')}</p>
        </div>
        <div class="set-r">
          <button type="button" class="btn bad" onclick={() => { deleteLoaded = true; deleting = true; }}>{t('注销账户…')}</button>
        </div>
      </div>
    </section>
  </div>
</div>

{#if verifyLoaded}
  {#await import('../components/VerifyEmailDialog.svelte') then V}<V.default bind:open={verifying} />{/await}
{/if}
{#if changeLoaded}
  {#await import('../components/settings/ChangeEmailDialog.svelte') then C}<C.default bind:open={changing} />{/await}
{/if}
{#if deleteLoaded}
  {#await import('../components/settings/DeleteAccountDialog.svelte') then D}<D.default bind:open={deleting} />{/await}
{/if}

<style>
  .email { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px; overflow-wrap: anywhere; }
  .seg { display: inline-flex; align-items: center; padding: 3px; border: 1px solid var(--line); border-radius: 9999px; }
  .seg button {
    height: 24px; padding: 0 8px; border: 0; border-radius: 9999px; background: none; color: var(--muted);
    font: inherit; font-size: 12px; font-weight: var(--fw-strong); cursor: pointer;
  }
  .seg button.ic { display: inline-grid; place-items: center; padding: 0; width: 32px; }
  .seg button:hover { color: var(--fg); }
  .seg button[aria-pressed='true'] { background: var(--fg); color: var(--bg); }
  .bad { color: var(--danger); }
  .bad:hover { border-color: var(--danger); }
</style>
