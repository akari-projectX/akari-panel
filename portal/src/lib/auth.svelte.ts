import {
  ApiError, authApi, brandUrl, meApi, onSessionEvent, type AuthOptions, type LoginResult, type Me, type MyPlan,
} from '@/api';
import { sameSiteOptions, turnstileOn } from '@/api/guard';
import { K, clearCache, readCache, writeCache } from '@/lib/cache';
import { setSiteTimeZone } from '@/lib/format';
import { holdBoot } from './boot.svelte';
import { t } from './i18n.svelte';
import { toast } from './toast.svelte';
import { navigate } from './router.svelte';
import { match } from './pages';
import { prefetchCurrent } from './prefetch';
import { R, scopeOf, type Scope } from './routes';

/**
 * 登录态与站点公开配置。
 *
 * 会话是面板发的 httpOnly cookie，前端不存令牌；登录状态以 GET /me 为准（401 = 没登录；
 * 404 = 统一的拒绝，同一浏览器里的管理员会话在门户上就是它——都按没登录处理）。
 * sessionStorage 缓存里有 /me 时先用它把页面画出来，后台再取最新的；
 * 存进去的那份去掉订阅令牌。
 */

type State = {
  me?: Me;
  plan?: MyPlan;
  /** 还不知道登没登录（第一次 /me 没回来、也没有缓存） */
  booting: boolean;
  /** 第一次取 /me 出了网络 / 服务器错误、又没有缓存：登录状态未知（门禁显示重试，不送去登录页） */
  failed: boolean;
  /**
   * 进用户中心后引导绑定通行密钥（一次）：'login' = 登录答复里带了 passkey_prompt（站点开了引导、账户还没有通行密钥）；
   * 'signup' = 刚用密码注册成功、站点能用通行密钥。false = 不引导
   */
  passkeyPrompt: false | 'login' | 'signup';
};

const cached = readCache<Me>(K.me);
export const auth = $state<State>({
  me: cached,
  plan: readCache<MyPlan>(K.plan),
  booting: cached === undefined,
  failed: false,
  passkeyPrompt: false,
});

/** 当前账户范围（没登录为 undefined） */
export function scope(): Scope | undefined {
  return auth.me ? scopeOf(auth.me) : undefined;
}

const sanitize = (me: Me): Me => ({ ...me, sub_token: null, sub_url: null });

function drop() {
  clearCache();
  auth.me = undefined;
  auth.plan = undefined;
  auth.passkeyPrompt = false;
}

/**
 * 取账户与套餐；401 / 404 = 没登录，返回 null。
 * speculative：多半已登录（刷新用户中心的页面、刚登录成功）时 /me 与 /me/plan 同时发出，省一个往返（限速的手机网络上约一个 RTT 加上排队）；
 * /me 说这个账户拿不到套餐（banned、待绑定邮箱）时丢掉套餐那份的结果与错误。访客页（/login 等）不投机：多发一个必然 401 的请求没有意义。
 */
async function fetchAccount(speculative = false): Promise<{ me: Me; plan?: MyPlan } | null> {
  try {
    const early = speculative ? meApi.plan() : undefined;
    early?.catch(() => {});
    const m = await meApi.get();
    const s = scopeOf(m);
    /* 套餐：banned 拿不到（面板答 403）；待绑定邮箱的账户只能到 /me */
    const p = (s === 'full' || s === 'renewal') && !m.email_pending ? await (early ?? meApi.plan()) : undefined;
    return { me: m, plan: p };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 401 || e.status === 404)) return null;
    throw e;
  }
}

function apply(r: { me: Me; plan?: MyPlan } | null) {
  if (!r) { drop(); return; }
  setSiteTimeZone(r.me.timezone);
  auth.me = r.me;
  writeCache(K.me, sanitize(r.me));
  auth.plan = r.plan;
  if (r.plan) writeCache(K.plan, r.plan);
}

/** 重新取一遍账户（失败保留旧数据） */
export async function refresh() {
  await fetchAccount().then(
    (r) => { apply(r); auth.failed = false; },
    () => {},
  );
}

/** 登录、注册成功后调用（拿到登录答复之后）：丢掉旧缓存，取一遍账户数据 */
export async function signIn(result: LoginResult) {
  clearCache();
  auth.passkeyPrompt = result.passkey_prompt ? 'login' : false;
  apply(await fetchAccount(true));
  auth.failed = false;
}

/** 密码注册成功之后：第一次进仪表盘请用户加一个通行密钥（站点的通行密钥可用时） */
export function promptPasskeyAfterSignup() {
  if (site.options?.passkey) auth.passkeyPrompt = 'signup';
}

export function dismissPasskeyPrompt() {
  auth.passkeyPrompt = false;
}

/** 退出（面板结束这个账户的所有会话），回登录页 */
export async function signOut() {
  try {
    await authApi.logout();
    toast.success(t('已退出'), { description: t('所有设备上的登录都已结束') });
  } catch (e) {
    void import('./error-toast').then((m) => m.toastError(e));
  } finally {
    drop();
    navigate(R.login, { replace: true });
  }
}

/** 面板已经结束了会话（注销账户之后）：只收掉本地登录态，不再请求、不跳转（调用方已经去了结果页） */
export function forget() {
  drop();
}

/**
 * 用户主动切换界面语言时，把账户的邮件语言改成同一门（面板按账户的 locale 发邮件）。
 * 只在主动切换时同步：打开页面时不同步，免得另一台设备上的语言偏好悄悄改掉邮件语言。
 */
export function setMailLocale(l: 'zh' | 'en') {
  const me = auth.me;
  if (!me || me.role !== 'user' || me.email_pending || me.locale === l) return;
  meApi.setLocale(l).then(
    () => { if (auth.me) auth.me = { ...auth.me, locale: l }; },
    () => { /* 尽力而为：下次切换再试 */ },
  );
}

/* ───────────── 站点公开配置（/auth/options） ───────────── */

/**
 * error：第一次就没取到（之后再失败保留旧的）。turnstileAllowed：这一页的 CSP 是否放行 Turnstile——面板在打开页面那一刻
 * 有表单开了 Turnstile 才放行（web::CSP_TURNSTILE），所以按第一次取到的设置定下来，之后不变（见 form-guard）。
 */
export const site = $state<{ options?: AuthOptions; error: boolean; turnstileAllowed?: boolean }>({ error: false });

/** 站点名（没取到之前是 Akari） */
export function siteName(): string {
  return site.options?.site_name?.trim() || 'Akari';
}

/**
 * 取一遍 /auth/options（每次都带新的表单令牌，记在 api/guard 里）。站长随时可能在后台改防护设置：公开表单挂着、
 * 提交之后、窗口回到前台时都会再取（lib/form-guard）。只有表单令牌以外的内容变了才换 options，免得整页重渲染。
 */
export function refreshOptions(): Promise<void> {
  return authApi.options().then(
    (o) => {
      site.turnstileAllowed ??= turnstileOn(o);
      if (!site.options || !sameSiteOptions(site.options, o)) site.options = o;
      site.error = false;
      setSiteTimeZone(o.timezone);
      /* 站长配的 favicon：换掉 index.html 里的默认图标 */
      const fav = o.branding?.favicon_url;
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (fav && link && link.getAttribute('href') !== brandUrl(fav)) {
        link.href = brandUrl(fav);
        link.removeAttribute('type');
      }
    },
    () => { if (!site.options) site.error = true; },
  );
}

/** 启动：取 /me（没有缓存时拖住启动画面）、取站点配置、订阅全站会话事件 */
export function startAuth() {
  const release = auth.booting ? holdBoot() : () => {};
  const found = match(location.pathname);
  fetchAccount(cached !== undefined || found?.page.layout === 'dash')
    .then((r) => {
      apply(r);
      /* 这一页的首屏数据在渲染之前就发出去（App 的同名预取是换页用的，请求在途表里同一个键只有一个请求）：渲染外壳要花几十毫秒，请求不必等它 */
      if (r && !r.me.email_pending) {
        const s = scopeOf(r.me);
        if (s) prefetchCurrent(location.pathname, s);
      }
    })
    .catch(() => {
      /* 网络错误：有缓存就保留缓存里的账户；没有缓存时门禁显示「重试」，不当成没登录 */
      if (readCache<Me>(K.me) === undefined) auth.failed = true;
    })
    .finally(() => {
      auth.booting = false;
      release();
    });
  void refreshOptions();
  /* 会话中途失效（任何接口 401）→ 丢掉会话（门禁送去登录页）；被封禁（403 account.banned）→ 重新取 /me，换成封禁范围 */
  onSessionEvent((err) => {
    if (err.status === 401) drop();
    else void refresh();
  });
}
