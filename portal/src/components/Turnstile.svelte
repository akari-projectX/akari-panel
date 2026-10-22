<script lang="ts" module>
  /**
   * Cloudflare Turnstile 人机验证组件。
   *
   * 只有站长在后台为这张表单打开了 Turnstile 时才会挂上；这时才去 challenges.cloudflare.com 动态加载它的脚本——不开就一个外部请求都没有。
   * 面板的 CSP 也只在开启 Turnstile 时放行这个来源（script-src、frame-src）。
   *
   * 令牌一次性：每次提交之后（不论成败）resetKey 变，组件先丢掉手里的令牌再重置、拿一个新令牌；令牌过期、出错、交互超时也都丢掉，
   * 出错、超时、脚本加载失败都经 onerror 告诉表单（GuardFields 显示「人机验证加载失败」与重试）。
   * 外观：interaction-only（只有要人工确认时才出现）、flexible（与输入框同宽）、明暗跟随站点、语言跟随界面；明暗或语言变了重新渲染。
   */
  import type { TurnstileFailure } from '$lib/form-guard.svelte';

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

  export type { TurnstileFailure };
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { i18n } from '$lib/i18n.svelte';
  import { theme } from '$lib/theme.svelte';

  let { siteKey, resetKey, ontoken, onerror }: {
    siteKey: string;
    /** 变了就重置组件（换一个新令牌） */
    resetKey: number;
    /** 拿到令牌、令牌过期（null）时调用 */
    ontoken: (token: string | null) => void;
    /** 加载不出来：脚本被拦 / 断网（script），或组件自己出错、交互超时（widget） */
    onerror: (kind: TurnstileFailure) => void;
  } = $props();

  let box: HTMLDivElement | undefined = $state();
  let widget: { api: TurnstileApi; id: string } | null = null;

  $effect(() => {
    const key = siteKey;
    const dark = theme.dark;
    const lang = i18n.locale;
    const el = box;
    if (!el) return;
    let alive = true;
    loadTurnstile()
      .then((api) => {
        if (!alive) return;
        const id = api.render(el, {
          sitekey: key,
          appearance: 'interaction-only',
          size: 'flexible',
          theme: dark ? 'dark' : 'light',
          language: lang === 'en' ? 'en' : 'zh-cn',
          callback: (t: string) => ontoken(t),
          'expired-callback': () => ontoken(null),
          'error-callback': () => { ontoken(null); onerror('widget'); },
          'timeout-callback': () => { ontoken(null); onerror('widget'); },
        });
        widget = { api, id };
      })
      .catch(() => { if (alive) onerror('script'); });
    return () => {
      alive = false;
      if (widget) widget.api.remove(widget.id);
      widget = null;
      untrack(() => ontoken(null));
    };
  });

  $effect(() => {
    if (resetKey === 0) return;
    untrack(() => {
      if (!widget) return;
      ontoken(null);
      widget.api.reset(widget.id);
    });
  });
</script>

<div bind:this={box} data-testid="turnstile" class="turnstile"></div>
