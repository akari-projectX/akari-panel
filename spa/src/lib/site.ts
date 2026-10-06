import { useMemo } from 'react';
import { brandUrl, type AuthOptions, type Branding } from '@/api';
import { useSiteOptions } from '@/lib/auth';

/**
 * 站点运行期配置：来自面板的公开配置 GET /auth/options（站点名、品牌、注册与找回密码开关……）。
 * SiteProvider 在启动时取一次；没取到之前（或取失败）按「全关」处理，表单不会被提交到一个关着的接口。
 * 不使用任何注入到 window 上的全局变量（面板的 CSP 不允许内联脚本）。
 */

/**
 * 品牌。页脚版权、服务条款与隐私政策里的「我们」一律用 BRAND.name，不取后台的站点名称：
 * 站点名称是站长随手填的展示名，法务文本里的缔约方必须是固定的品牌。
 */
export const BRAND = { name: 'Akari', zh: '灯塔', domain: 'akari.cc' } as const;

/** 法务页的联系方式：面板没有这两个设置，主题自带页面说「提交工单」 */
export const LEGAL = { email: '', privacyEmail: '' } as const;

export type Site = {
  title: string;
  logo: string;
  favicon: string;
  footerText: string;
  footerLinks: { label: string; url: string }[];
  /** 配了外链就跳外链，没配用主题自带的条款 / 隐私页 */
  tosUrl: string | null;
  privacyUrl: string | null;
  downloads: Branding['client_downloads'];
  registerOpen: boolean;
  resetOpen: boolean;
  inviteRequired: boolean;
  emailVerify: boolean;
  emailDomains: string[];
  passkey: boolean;
  /** 配置还没取到 */
  loading: boolean;
};

export function siteFrom(o: AuthOptions | undefined): Site {
  const b = o?.branding ?? null;
  return {
    title: o?.site_name?.trim() || BRAND.name,
    logo: b?.logo_url ? brandUrl(b.logo_url) : '',
    favicon: b?.favicon_url ? brandUrl(b.favicon_url) : '',
    footerText: b?.footer_text ?? '',
    footerLinks: b?.footer_links ?? [],
    tosUrl: b?.tos_url || null,
    privacyUrl: b?.privacy_url || null,
    downloads: b?.client_downloads ?? [],
    registerOpen: !!o?.register,
    resetOpen: !!o?.reset,
    inviteRequired: !!o?.invite_required,
    emailVerify: !!o?.email_verify,
    emailDomains: o?.email_domains ?? [],
    passkey: !!o?.passkey,
    loading: !o,
  };
}

export function useSite(): Site {
  const { options } = useSiteOptions();
  return useMemo(() => siteFrom(options), [options]);
}
