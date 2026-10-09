import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import {
  ApiError, authApi, brandUrl, meApi, onSessionEvent, type AuthOptions, type LoginResult, type Me, type MyPlan,
} from '@/api';
import { K, clearCache, readCache, writeCache } from '@/lib/cache';
import {
  AuthCtx, SiteCtx, safeRedirect, scopeOf, useAuth, type AuthCtxValue, type Scope,
} from '@/lib/auth';
import { setSiteTimeZone } from '@/lib/format';
import { sameSiteOptions, turnstileOn } from '@/api/guard';
import { PageLoading } from '@/components/loading';
import { useLocale } from '@/i18n';

/* ───────────── 站点公开配置 ───────────── */

export function SiteProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<AuthOptions>();
  const [error, setError] = useState<Error>();
  const current = useRef<AuthOptions | undefined>(undefined);
  /* 这一页的 CSP 是否放行了 Turnstile：面板在打开页面那一刻有表单开了 Turnstile 才放行（web::CSP_TURNSTILE） */
  const [turnstileAllowed, setTurnstileAllowed] = useState<boolean>();

  /*
   * 重新取一遍（每次都带新的表单令牌，记在 api/guard 里）。站长随时可能在后台改防护设置（最短提交时间、
   * Turnstile 开关）：公开表单挂着、提交失败、窗口回到前台时都会再取，见 lib/form-guard。
   * 只有表单令牌以外的内容变了才换 options，免得每次都整页重渲染。
   */
  const refresh = useCallback(
    () =>
      authApi.options().then(
        (o) => {
          setTurnstileAllowed((cur) => cur ?? turnstileOn(o));
          if (!current.current || !sameSiteOptions(current.current, o)) {
            current.current = o;
            setOptions(o);
          }
          setError(undefined);
          setSiteTimeZone(o.timezone);
        },
        (e: Error) => {
          if (!current.current) setError(e);
        },
      ),
    [],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* 站长配的 favicon 和站点名：换掉 index.html 里的默认值 */
  useEffect(() => {
    const fav = options?.branding?.favicon_url;
    if (!fav) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    link.href = brandUrl(fav);
    link.removeAttribute('type');
  }, [options?.branding?.favicon_url]);

  const value = useMemo(
    () => ({ options, error, refresh, turnstileAllowed }),
    [options, error, refresh, turnstileAllowed],
  );
  return <SiteCtx.Provider value={value}>{children}</SiteCtx.Provider>;
}

/* ───────────── 账户 ───────────── */

/** 存进 sessionStorage 的 /me 去掉订阅令牌 */
const sanitize = (me: Me): Me => ({ ...me, sub_token: null, sub_url: null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const { locale } = useLocale();
  const [me, setMe] = useState<Me | undefined>(() => readCache<Me>(K.me));
  const [plan, setPlan] = useState<MyPlan | undefined>(() => readCache<MyPlan>(K.plan));
  const [authed, setAuthed] = useState(() => readCache<Me>(K.me) !== undefined);
  const [booting, setBooting] = useState(() => readCache<Me>(K.me) === undefined);
  const [passkeyPrompt, setPasskeyPrompt] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const drop = useCallback(() => {
    clearCache();
    setAuthed(false);
    setMe(undefined);
    setPlan(undefined);
    setPasskeyPrompt(false);
  }, []);

  /** 取账户与套餐（不碰状态）；401 = 没登录，返回 null */
  const fetchAccount = useCallback(async (): Promise<{ me: Me; plan?: MyPlan } | null> => {
    try {
      const m = await meApi.get();
      const scope = scopeOf(m);
      /* 套餐：banned 拿不到（面板答 403） */
      const p = scope === 'full' || scope === 'renewal' ? await meApi.plan() : undefined;
      return { me: m, plan: p };
    } catch (e) {
      /* 401 = 没登录；404 = 统一的拒绝（同一浏览器里的管理员会话在门户上就是这个）：都按没登录处理 */
      if (e instanceof ApiError && (e.status === 401 || e.status === 404)) return null;
      throw e;
    }
  }, []);

  const apply = useCallback((r: { me: Me; plan?: MyPlan } | null) => {
    if (!alive.current) return;
    if (!r) { drop(); return; }
    setSiteTimeZone(r.me.timezone);
    setMe(r.me);
    writeCache(K.me, sanitize(r.me));
    setPlan(r.plan);
    if (r.plan) writeCache(K.plan, r.plan);
    setAuthed(true);
  }, [drop]);

  const load = useCallback(() => fetchAccount().then(apply), [fetchAccount, apply]);

  useEffect(() => {
    fetchAccount()
      .then(apply)
      .catch(() => { /* 网络错误：保留缓存里的账户，页面各区块自己报错 */ })
      .finally(() => { if (alive.current) setBooting(false); });
  }, [fetchAccount, apply]);

  /* 会话中途失效（任何接口 401）→ 退回登录页；被封禁（403 account.banned）→ 重新取 /me，换成封禁视图 */
  useEffect(() => onSessionEvent((err) => {
    if (err.status === 401) drop();
    else void load().catch(() => {});
  }), [drop, load]);

  /* 邮件语言跟着界面语言走（面板按账户的 locale 发邮件） */
  const want = locale === 'en' ? 'en' : 'zh';
  const accountLocale = me?.role === 'user' ? me.locale : undefined;
  useEffect(() => {
    if (!accountLocale || accountLocale === want) return;
    meApi.setLocale(want)
      .then(() => setMe((m) => (m ? { ...m, locale: want } : m)))
      .catch(() => { /* 尽力而为 */ });
  }, [accountLocale, want]);

  const signIn = useCallback(async (result: LoginResult) => {
    clearCache();
    setPasskeyPrompt(!!result.passkey_prompt);
    await load();
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      drop();
    }
  }, [drop]);

  const refresh = useCallback(async () => {
    await load().catch(() => { /* 刷新失败保留旧数据 */ });
  }, [load]);

  const dismissPasskeyPrompt = useCallback(() => setPasskeyPrompt(false), []);

  const value = useMemo<AuthCtxValue>(() => ({
    authed, booting, me, plan, scope: me ? scopeOf(me) : undefined,
    passkeyPrompt, dismissPasskeyPrompt, signIn, signOut, refresh,
  }), [authed, booting, me, plan, passkeyPrompt, dismissPasskeyPrompt, signIn, signOut, refresh]);

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

/* ───────────── 路由门禁 ───────────── */

/** 用户中心的门禁。未登录时把当前地址塞进 redirect，登录后能回到原来那一页 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { authed, booting } = useAuth();
  const loc = useLocation();
  if (booting) return <PageLoading className="min-h-[60vh]" />;
  if (!authed) {
    const from = encodeURIComponent(loc.pathname + loc.search);
    return <Navigate to={`/login?redirect=${from}`} replace />;
  }
  return <>{children}</>;
}

/** 已登录时不该再看到登录 / 注册页 */
export function GuestOnly({ children }: { children: ReactNode }) {
  const { authed, booting } = useAuth();
  const [sp] = useSearchParams();
  if (booting) return <PageLoading className="min-h-[60vh]" />;
  if (authed) return <Navigate to={safeRedirect(sp.get('redirect'))} replace />;
  return <>{children}</>;
}

/** 只给某些账户范围看的页面；范围外的人回仪表盘（仪表盘按范围显示续费 / 封禁说明） */
export function RequireScope({ allow, children }: { allow: Scope[]; children: ReactNode }) {
  const { scope } = useAuth();
  if (scope && !allow.includes(scope)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
