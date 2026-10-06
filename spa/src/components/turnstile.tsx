import { useEffect, useRef } from 'react';
import { useLocale } from '@/i18n';

/**
 * Cloudflare Turnstile 人机验证组件。
 *
 * 只有站长在后台为这张表单打开了 Turnstile（/auth/options 的 guard.turnstile）时才会挂上；
 * 这时才去 challenges.cloudflare.com 动态加载它的脚本——不开就一个外部请求都没有。
 * 面板的 CSP 也只在开启 Turnstile 时放行这个来源（script-src、frame-src），见 README「CSP」。
 *
 * 令牌一次性：每次提交之后（不论成败）父组件改 resetKey，组件会重置、拿一个新令牌。
 */

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit`;

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  const w = window as unknown as { turnstile?: TurnstileApi };
  if (w.turnstile) return Promise.resolve(w.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error('turnstile')));
    s.onerror = () => { loading = null; s.remove(); reject(new Error('turnstile')); };
    document.head.appendChild(s);
  });
  return loading;
}

export default function Turnstile({
  siteKey, onToken, resetKey, onError,
}: {
  siteKey: string;
  /** 拿到令牌、令牌过期（null）时调用 */
  onToken: (token: string | null) => void;
  /** 变了就重置组件（换一个新令牌） */
  resetKey: number;
  /** 脚本加载失败（被拦、断网） */
  onError?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: TurnstileApi; id: string } | null>(null);
  const cb = useRef({ onToken, onError });
  useEffect(() => { cb.current = { onToken, onError }; });
  const { locale } = useLocale();

  useEffect(() => {
    let alive = true;
    loadTurnstile()
      .then((api) => {
        if (!alive || !box.current) return;
        const id = api.render(box.current, {
          sitekey: siteKey,
          language: locale === 'en' ? 'en' : 'zh-cn',
          callback: (t: string) => cb.current.onToken(t),
          'expired-callback': () => cb.current.onToken(null),
          'error-callback': () => cb.current.onToken(null),
        });
        widget.current = { api, id };
      })
      .catch(() => { if (alive) cb.current.onError?.(); });
    return () => {
      alive = false;
      if (widget.current) widget.current.api.remove(widget.current.id);
      widget.current = null;
    };
  }, [siteKey, locale]);

  useEffect(() => {
    if (resetKey === 0 || !widget.current) return;
    cb.current.onToken(null);
    widget.current.api.reset(widget.current.id);
  }, [resetKey]);

  return <div ref={box} className="min-h-[65px]" />;
}
