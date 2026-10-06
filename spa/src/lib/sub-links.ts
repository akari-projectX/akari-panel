/**
 * 订阅地址的格式与一键导入链接（移植自面板 spa/src/lib/sub-links.ts，纯函数，有单测）。
 * 订阅地址本身来自 GET /me 的 sub_url。
 */
import { feature, legacySubscriptionUrl, type Me, type SubFormat } from '@/api';

export const SUB_FORMATS: SubFormat[] = ['auto', 'clash', 'sing-box', 'links'];

/** 指定格式的订阅地址（auto = 按客户端的 User-Agent，不加参数） */
export function withFormat(url: string, format: SubFormat): string {
  if (format === 'auto') return url;
  return `${url}${url.includes('?') ? '&' : '?'}format=${format}`;
}

/** UTF-8 字符串的标准 base64（Shadowrocket 的 sub:// 写法） */
function base64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

export type ImportLink = { id: string; name: string; platforms: string; href: string };

/**
 * 一键导入的深链接。每个客户端用它自己认得的格式，不依赖面板认出它的 User-Agent。
 * name 是导入后配置的名字（站点名）。
 */
export function importLinks(url: string, name: string): ImportLink[] {
  const enc = encodeURIComponent;
  const clash = withFormat(url, 'clash');
  return [
    { id: 'clash', name: 'Clash Verge / mihomo', platforms: 'Windows · macOS · Linux · Android', href: `clash://install-config?url=${enc(clash)}&name=${enc(name)}` },
    { id: 'shadowrocket', name: 'Shadowrocket', platforms: 'iOS', href: `shadowrocket://add/sub://${base64(withFormat(url, 'links'))}?remark=${enc(name)}` },
    { id: 'sing-box', name: 'sing-box', platforms: 'iOS · Android · macOS', href: `sing-box://import-remote-profile?url=${enc(withFormat(url, 'sing-box'))}#${enc(name)}` },
    { id: 'stash', name: 'Stash', platforms: 'iOS · macOS', href: `stash://install-config?url=${enc(clash)}&name=${enc(name)}` },
    { id: 'hiddify', name: 'Hiddify', platforms: 'Android · Windows · macOS', href: `hiddify://import/${url}#${enc(name)}` },
  ];
}

/** 账户的订阅地址；没有可显示的（管理员、续费范围、旧格式链接）为 null */
export function mySubUrl(me: Pick<Me, 'sub_url' | 'sub_token'> | undefined): string | null {
  if (!me) return null;
  if (me.sub_url) return me.sub_url;
  return me.sub_token && !feature('sub-url-only') ? legacySubscriptionUrl(me.sub_token) : null;
}
