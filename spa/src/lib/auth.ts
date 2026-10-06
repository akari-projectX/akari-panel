import { createContext, useContext } from 'react';
import type { AuthOptions, LoginResult, Me, MyPlan } from '@/api';

/**
 * 登录态与「当前账户」的唯一来源。
 *
 * 会话是面板发的 httpOnly cookie，前端不存令牌；登录状态以 GET /me 为准（401 = 没登录）。
 * 账户分四种范围，导航、页面、区块都按它收放（面板 README 的 Renewal scope / Portal scope）：
 *   · full    —— 正常账户，全部功能；
 *   · renewal —— 已过期或流量用完（R21）：只剩商店、订单、钱包、工单、帮助、账户，订阅与节点被面板拒绝；
 *   · banned  —— 被封禁（W28-c）：只看封禁说明和工单，其余接口一律 403 account.banned；
 *   · admin   —— 管理员：门户里没有他的东西，只提示去后台地址（D4：前台不出现后台地址，不给链接）。
 */

export type Scope = 'full' | 'renewal' | 'banned' | 'admin';

export function scopeOf(me: Pick<Me, 'role' | 'banned' | 'expired' | 'quota_exhausted'>): Scope {
  if (me.role === 'admin') return 'admin';
  if (me.banned) return 'banned';
  if (me.expired || me.quota_exhausted) return 'renewal';
  return 'full';
}

export type AuthCtxValue = {
  authed: boolean;
  /** 还不知道登没登录（第一次 /me 没回来）——此时用户中心先显示加载态 */
  booting: boolean;
  me?: Me;
  scope?: Scope;
  /** 当前套餐（banned / admin 没有；没有套餐是 plan: null） */
  plan?: MyPlan;
  /** 登录答复里带了 passkey_prompt：进用户中心后引导绑定通行密钥（一次） */
  passkeyPrompt: boolean;
  dismissPasskeyPrompt: () => void;
  /** 登录、注册成功后调用：取一遍账户数据 */
  signIn: (result: LoginResult) => Promise<void>;
  /** 退出（结束这个账户的所有会话） */
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

export const AuthCtx = createContext<AuthCtxValue | null>(null);

export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return c;
}

/** 站点公开配置（/auth/options）：注册开关、邀请码、Turnstile、品牌……由 SiteProvider 取一次 */
export type SiteCtxValue = { options?: AuthOptions; error?: Error; reload: () => void };
export const SiteCtx = createContext<SiteCtxValue | null>(null);

export function useSiteOptions() {
  const c = useContext(SiteCtx);
  if (!c) throw new Error('useSiteOptions 必须在 <SiteProvider> 内使用');
  return c;
}

/**
 * 登录后该去哪：拦截前想去的那一页，没有就进仪表盘。只接受站内路径——
 * `//evil.example` 会被浏览器当成协议相对的外链。登录页与 GuestOnly 用同一套规则。
 */
export function safeRedirect(redirect: string | null): string {
  if (!redirect || !redirect.startsWith('/') || redirect.startsWith('//') || redirect.includes('\\')) return '/';
  return redirect;
}
