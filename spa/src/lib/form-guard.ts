import { useCallback, useEffect, useState } from 'react';
import { authApi, type FormGuard } from '@/api';
import { buildGuard, guardStale } from '@/api/guard';
import { useSiteOptions } from '@/lib/auth';

export type GuardedForm = 'login' | 'register' | 'reset';

/**
 * 一张公开表单的防护状态（蜜罐、Turnstile、表单令牌），配合 components/form-guard 的 <GuardFields> 用：
 *
 *   const g = useFormGuard('login');
 *   <GuardFields guard={g} />          // 隐藏的蜜罐 + 需要时的 Turnstile
 *   await authApi.login(email, pwd, await g.build());
 *   g.after();                          // 每次提交后换一个新的 Turnstile 令牌（令牌一次性），并重新取防护设置
 *
 * 防护设置（最短提交时间、哪些表单要 Turnstile）站长随时会改，而被拦下的提交面板只答「普通失败」：
 * 拿着页面打开时的旧设置，每次提交都会失败，直到刷新页面。所以表单挂着时：进来时、每 GUARD_POLL_MS、
 * 窗口回到前台时、每次提交之后，都重新取一遍 /auth/options（SiteProvider.refresh）。
 */

/** 表单挂着时多久重新取一次防护设置 */
export const GUARD_POLL_MS = 30_000;

export function useFormGuard(form: GuardedForm) {
  const { options, refresh, turnstileAllowed } = useSiteOptions();
  const g = options?.guard;
  /* 这一页的 CSP 不放行 Turnstile 时不挂组件（挂了也加载不出来，还会触发 CSP 拒绝）：下面会重新加载页面 */
  const wanted = g?.turnstile?.[form] ? g.turnstile.site_key : null;
  const siteKey = turnstileAllowed === false ? null : wanted;
  const [website, setWebsite] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const again = () => void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') again(); };
    again();
    const timer = window.setInterval(() => void refresh(), GUARD_POLL_MS);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  /*
   * 页面打开之后站长才给表单开了 Turnstile：这一页的 CSP 不放行 Cloudflare 的脚本，组件加载不出来。
   * 重新加载一次页面（面板这时给的 CSP 就放行了），否则用户只能对着一个永远不可用的按钮。
   */
  useEffect(() => {
    if (wanted && turnstileAllowed === false) window.location.reload();
  }, [wanted, turnstileAllowed]);

  const build = useCallback(async (): Promise<FormGuard> => {
    /* 页面开了太久，表单令牌快过期了：先换一个 */
    if (guardStale()) await authApi.options().catch(() => undefined);
    return buildGuard(website, token);
  }, [website, token]);

  const after = useCallback(() => {
    if (siteKey) setResetKey((k) => k + 1);
    void refresh();
  }, [siteKey, refresh]);

  return {
    honeypot: !!g?.honeypot,
    website, setWebsite,
    siteKey, token, setToken, resetKey, failed, setFailed,
    /** 设置读不出来（guard: null）：面板会拒绝这张表单，干脆不让提交 */
    unavailable: !!options && g === null,
    /** 需要 Turnstile 时，拿到令牌才能提交 */
    ready: !wanted || (!!siteKey && !!token),
    build, after,
  };
}

export type FormGuardState = ReturnType<typeof useFormGuard>;
