import type { AuthOptions } from '@/api';

/**
 * 站点公开配置（/auth/options）里登录、注册页要看的开关。
 * 没取到之前（或取失败）一律按「关」处理：表单不会被提交到一个关着的接口。
 * 组件里：`const s = $derived(siteFlags(site.options))`。
 */
export type SiteFlags = {
  /** 配了外链就跳外链，没配用门户的条款 / 隐私页 */
  tosUrl: string | null;
  privacyUrl: string | null;
  registerOpen: boolean;
  resetOpen: boolean;
  inviteRequired: boolean;
  /** 后台「允许用户邀请」：关着时注册页不显示邀请码（任何码都会被拒），邀请链接里的码也不带上 */
  invites: boolean;
  emailVerify: boolean;
  emailDomains: string[];
  passkey: boolean;
  /** 注册页可以「用通行密钥注册」 */
  passkeyRegister: boolean;
  /** 站点开着发信：关着时设置页不出现「更换邮箱」「验证」 */
  mail: boolean;
  /** 配置还没取到 */
  loading: boolean;
};

export function siteFlags(o: AuthOptions | undefined): SiteFlags {
  const b = o?.branding ?? null;
  return {
    tosUrl: b?.tos_url || null,
    privacyUrl: b?.privacy_url || null,
    registerOpen: !!o?.register,
    resetOpen: !!o?.reset,
    inviteRequired: !!o?.invite_required,
    invites: !!o?.invites,
    emailVerify: !!o?.email_verify,
    emailDomains: o?.email_domains ?? [],
    passkey: !!o?.passkey,
    passkeyRegister: !!o?.passkey_register,
    mail: !!o?.mail,
    loading: !o,
  };
}

/** 「仅限 a / b / c …」：允许注册的邮箱域名（最多列三个） */
export function domainsLine(domains: string[]): string {
  return `${domains.slice(0, 3).join(' / ')}${domains.length > 3 ? ' …' : ''}`;
}

/** 邮件语言：注册时按界面语言定 */
export const mailLocale = (l: string): 'zh' | 'en' => (l === 'en' ? 'en' : 'zh');

/** 面板内容的中英文：英文界面且有英文版本时用英文 */
export function pick<T>(locale: string, zh: T, en: T | null | undefined): T {
  return locale === 'en' && en != null && en !== '' ? en : zh;
}
