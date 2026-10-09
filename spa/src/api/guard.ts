import type { AuthOptions, FormGuard, FormGuardOptions } from './types';

/**
 * 公开表单（登录、注册、找回密码）的机器人防护：表单令牌 + 蜜罐 + 最短提交时间（面板 src/botguard.rs）。
 *
 *   · 每次 GET /auth/options 都带一个新的 form_token（签名的签发时间），表单要在 form_min_secs 之后才能交；
 *     太快交上去面板按「普通失败」答复，前端分不出来——所以这里替用户等够时间再发；
 *   · 蜜罐是一个人看不见的 website 输入框，必须原样（空）交回；
 *   · 令牌在服务端活 24 小时，页面开太久了就先换一个新的；
 *   · 站长随时可能在后台改这些设置（打开最短提交时间、给表单开 Turnstile）。被拦下的提交面板只答「普通失败」，
 *     前端分不出来，所以拿着旧设置会一直失败（「邮箱或密码错误」「人机验证未通过」）直到刷新页面——
 *     lib/form-guard 在表单挂着时定期、窗口回到前台时、每次提交之后都重新取 /auth/options。
 */

let seen: { guard: FormGuardOptions; at: number } | null = null;
const REFRESH_MS = 6 * 3600_000;

/** 两份 guard 除了表单令牌本身以外是否一样（最短时间、蜜罐、Turnstile、有没有令牌） */
function sameGuard(a: FormGuardOptions, b: FormGuardOptions): boolean {
  const strip = (g: FormGuardOptions) => JSON.stringify({ ...g, form_token: g.form_token ? 1 : null });
  return strip(a) === strip(b);
}

/**
 * 每次拿到 /auth/options 时记下 guard。表单令牌不是一次性的（面板只看它的年龄：最短时间到 24 小时之间），
 * 所以手上的令牌还新鲜、设置也没变时**留着它**：后台定期重新取设置不会让最短提交时间重新计时。
 * 设置变了（比如最短时间从 0 改成 2 秒，旧的是 null）或令牌快过期了才换新的。
 */
export function rememberGuard(o: Pick<AuthOptions, 'guard'>, now = Date.now()) {
  if (!o.guard) return;
  if (seen?.guard.form_token && now - seen.at <= REFRESH_MS && sameGuard(seen.guard, o.guard)) return;
  seen = { guard: o.guard, at: now };
}

/** 两份 /auth/options 除了表单令牌以外是否一样（一样就不必让页面重渲染） */
export function sameSiteOptions(a: AuthOptions, b: AuthOptions): boolean {
  const strip = (o: AuthOptions) =>
    JSON.stringify({ ...o, guard: o.guard && { ...o.guard, form_token: o.guard.form_token ? 1 : null } });
  return strip(a) === strip(b);
}

/** 有没有表单开了 Turnstile（= 面板给门户页面的 CSP 放行 challenges.cloudflare.com，web::CSP_TURNSTILE） */
export function turnstileOn(o: Pick<AuthOptions, 'guard'>): boolean {
  const t = o.guard?.turnstile;
  return !!t && (t.login || t.register || t.reset);
}

/** 现在需不需要重新取 /auth/options */
export function guardStale(now = Date.now()): boolean {
  return !seen || now - seen.at > REFRESH_MS;
}

/** 距离可以提交还要等多少毫秒（多留 250ms 余量） */
export function guardWait(now = Date.now()): number {
  if (!seen || !seen.guard.form_token || seen.guard.form_min_secs <= 0) return 0;
  return Math.max(0, seen.at + seen.guard.form_min_secs * 1000 + 250 - now);
}

/**
 * 表单的 guard 段。website 是蜜罐输入框里的值（正常人永远是空串），turnstile 是 Turnstile 组件给的令牌。
 * 需要等最短提交时间的话在这里等。
 */
export async function buildGuard(website: string, turnstile?: string | null): Promise<FormGuard> {
  const wait = guardWait();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const token = seen?.guard.form_token;
  return {
    ...(token ? { form_token: token } : {}),
    website,
    ...(turnstile ? { turnstile } : {}),
  };
}

