import { useCallback, useState } from 'react';
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
 *   g.after();                          // 每次提交后换一个新的 Turnstile 令牌（令牌一次性）
 */
export function useFormGuard(form: GuardedForm) {
  const { options } = useSiteOptions();
  const g = options?.guard;
  const siteKey = g?.turnstile?.[form] ? g.turnstile.site_key : null;
  const [website, setWebsite] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [failed, setFailed] = useState(false);

  const build = useCallback(async (): Promise<FormGuard> => {
    /* 页面开了太久，表单令牌快过期了：先换一个 */
    if (guardStale()) await authApi.options().catch(() => undefined);
    return buildGuard(website, token);
  }, [website, token]);

  const after = useCallback(() => {
    if (siteKey) setResetKey((k) => k + 1);
  }, [siteKey]);

  return {
    honeypot: !!g?.honeypot,
    website, setWebsite,
    siteKey, token, setToken, resetKey, failed, setFailed,
    /** 设置读不出来（guard: null）：面板会拒绝这张表单，干脆不让提交 */
    unavailable: !!options && g === null,
    /** 需要 Turnstile 时，拿到令牌才能提交 */
    ready: !siteKey || !!token,
    build, after,
  };
}

export type FormGuardState = ReturnType<typeof useFormGuard>;
