import {
  ApiError, authApi, brandUrl, meApi, onSessionEvent, type AuthOptions, type Me, type MyPlan,
} from '@/api';
import { K, clearCache, readCache, writeCache } from '@/lib/cache';
import { setSiteTimeZone } from '@/lib/format';
import { holdBoot } from './boot.svelte';
import { navigate } from './router.svelte';
import { R, scopeOf, type Scope } from './routes';

/**
 * 登录态与站点公开配置（与 React 门户 spa/src/lib/auth-provider.tsx 同一套行为）。
 *
 * 会话是面板发的 httpOnly cookie，前端不存令牌；登录状态以 GET /me 为准（401 = 没登录；
 * 404 = 统一的拒绝，同一浏览器里的管理员会话在门户上就是它——都按没登录处理）。
 * sessionStorage 缓存（akari.cache:*，与 React 门户同键）里有 /me 时先用它把页面画出来，后台再取最新的；
 * 存进去的那份去掉订阅令牌。
 */

type State = {
  me?: Me;
  plan?: MyPlan;
  /** 还不知道登没登录（第一次 /me 没回来、也没有缓存） */
  booting: boolean;
  /** 第一次取 /me 出了网络 / 服务器错误、又没有缓存：登录状态未知（门禁显示重试，不送去登录页） */
  failed: boolean;
};

const cached = readCache<Me>(K.me);
export const auth = $state<State>({
  me: cached,
  plan: readCache<MyPlan>(K.plan),
  booting: cached === undefined,
  failed: false,
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
}

/** 取账户与套餐；401 / 404 = 没登录，返回 null */
async function fetchAccount(): Promise<{ me: Me; plan?: MyPlan } | null> {
  try {
    const m = await meApi.get();
    const s = scopeOf(m);
    /* 套餐：banned 拿不到（面板答 403）；待绑定邮箱的账户只能到 /me */
    const p = (s === 'full' || s === 'renewal') && !m.email_pending ? await meApi.plan() : undefined;
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

/** 退出（面板结束这个账户的所有会话），回登录页 */
export async function signOut() {
  try {
    await authApi.logout();
  } finally {
    drop();
    navigate(R.login, { replace: true });
  }
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

export const site = $state<{ options?: AuthOptions; error: boolean }>({ error: false });

/** 站点名（没取到之前是 Akari） */
export function siteName(): string {
  return site.options?.site_name?.trim() || 'Akari';
}

function loadOptions() {
  authApi.options().then(
    (o) => {
      site.options = o;
      site.error = false;
      setSiteTimeZone(o.timezone);
      /* 站长配的 favicon：换掉 index.html 里的默认图标 */
      const fav = o.branding?.favicon_url;
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (fav && link) {
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
  fetchAccount()
    .then(apply)
    .catch(() => {
      /* 网络错误：有缓存就保留缓存里的账户；没有缓存时门禁显示「重试」，不当成没登录 */
      if (readCache<Me>(K.me) === undefined) auth.failed = true;
    })
    .finally(() => {
      auth.booting = false;
      release();
    });
  loadOptions();
  /* 会话中途失效（任何接口 401）→ 丢掉会话（门禁送去登录页）；被封禁（403 account.banned）→ 重新取 /me，换成封禁范围 */
  onSessionEvent((err) => {
    if (err.status === 401) drop();
    else void refresh();
  });
}
