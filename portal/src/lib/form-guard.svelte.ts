import { authApi, type FormGuard as Guard } from '@/api';
import { buildGuard, guardStale } from '@/api/guard';
import { refreshOptions, site } from './auth.svelte';

/**
 * 一张公开表单的防护状态（蜜罐、Turnstile、表单令牌），配合 components/GuardFields.svelte 用：
 *
 *   const g = new FormGuard('login');      // 在组件初始化时创建（构造函数里挂了 $effect）
 *   <GuardFields guard={g} />              // 隐藏的蜜罐 + 需要时的 Turnstile
 *   await authApi.login(email, pwd, await g.build());
 *   g.after();                             // 每次提交后换一个新的 Turnstile 令牌（令牌一次性），并重新取防护设置
 *
 * 防护设置（最短提交时间、哪些表单要 Turnstile）站长随时会改，而被拦下的提交面板只答「普通失败」：拿着页面打开时的旧设置，
 * 每次提交都会失败，直到刷新页面。所以表单挂着时：进来时、每 30 秒、窗口回到前台时、每次提交之后，都重新取一遍 /auth/options。
 */
export type GuardedForm = 'login' | 'register' | 'reset';
/** 人机验证为什么没出来：脚本没加载（要刷新页面）/ 组件出错或超时（重置组件即可） */
export type TurnstileFailure = 'script' | 'widget';

/** 表单挂着时多久重新取一次防护设置 */
const GUARD_POLL_MS = 30_000;

export class FormGuard {
  website = $state('');
  token = $state<string | null>(null);
  resetKey = $state(0);
  failed = $state<TurnstileFailure | null>(null);
  #form: GuardedForm;

  constructor(form: GuardedForm) {
    this.#form = form;

    $effect(() => {
      const again = () => void refreshOptions();
      const onVisible = () => { if (document.visibilityState === 'visible') again(); };
      again();
      const timer = setInterval(again, GUARD_POLL_MS);
      addEventListener('focus', again);
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        clearInterval(timer);
        removeEventListener('focus', again);
        document.removeEventListener('visibilitychange', onVisible);
      };
    });

    /*
     * 页面打开之后站长才给表单开了 Turnstile：这一页的 CSP 不放行 Cloudflare 的脚本，组件加载不出来。
     * 重新加载一次页面（面板这时给的 CSP 就放行了），否则用户只能对着一个永远不可用的按钮。
     */
    $effect(() => {
      if (this.wanted && site.turnstileAllowed === false) location.reload();
    });
  }

  get #g() {
    return site.options?.guard;
  }

  /** 站长为这张表单开了 Turnstile：站点密钥 */
  get wanted(): string | null {
    const g = this.#g;
    return g?.turnstile?.[this.#form] ? g.turnstile.site_key : null;
  }

  /** 这一页的 CSP 不放行 Turnstile 时不挂组件（挂了也加载不出来，还会触发 CSP 拒绝）：上面会重新加载页面 */
  get siteKey(): string | null {
    return site.turnstileAllowed === false ? null : this.wanted;
  }

  get honeypot(): boolean {
    return !!this.#g?.honeypot;
  }

  /** 设置读不出来（guard: null）：面板会拒绝这张表单，干脆不让提交 */
  get unavailable(): boolean {
    return !!site.options && this.#g === null;
  }

  /** 需要 Turnstile 时，拿到令牌才能提交 */
  get ready(): boolean {
    return !this.wanted || (!!this.siteKey && !!this.token);
  }

  async build(): Promise<Guard> {
    /* 页面开了太久，表单令牌快过期了：先换一个 */
    if (guardStale()) await authApi.options().catch(() => undefined);
    return buildGuard(this.website, this.token);
  }

  /** 拿到令牌就说明组件好了 */
  onToken = (t: string | null) => {
    this.token = t;
    if (t) this.failed = null;
  };

  onError = (kind: TurnstileFailure) => {
    this.failed = kind;
  };

  /** 「重试」：脚本没加载出来只能重新加载页面；组件自己出错就重置它 */
  retry = () => {
    if (this.failed === 'script') {
      location.reload();
      return;
    }
    this.failed = null;
    this.resetKey++;
  };

  after() {
    if (this.siteKey) this.resetKey++;
    void refreshOptions();
  }
}
