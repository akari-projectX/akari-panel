import type { AuthOptions, FormGuard, FormGuardOptions } from './types';

/**
 * 公开表单（登录、注册、找回密码）的机器人防护：表单令牌 + 蜜罐 + 最短提交时间（面板 src/botguard.rs）。
 *
 *   · 每次 GET /auth/options 都带一个新的 form_token（签名的签发时间），表单要在 form_min_secs 之后才能交；
 *     太快交上去面板按「普通失败」答复，前端分不出来——所以这里替用户等够时间再发；
 *   · 蜜罐是一个人看不见的 website 输入框，必须原样（空）交回；
 *   · 令牌在服务端活 24 小时，页面开太久了就先换一个新的。
 */

let seen: { guard: FormGuardOptions; at: number } | null = null;
const REFRESH_MS = 6 * 3600_000;

/** 每次拿到 /auth/options 时记下最新的 guard */
export function rememberGuard(o: Pick<AuthOptions, 'guard'>, now = Date.now()) {
  if (o.guard) seen = { guard: o.guard, at: now };
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

