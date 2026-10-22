/**
 * 订阅地址的格式与一键导入链接（纯函数，有单测）。
 * 订阅地址本身来自 GET /me 的 sub_url；哪些格式开着（sub_formats）、显示哪些导入按钮（sub_import_clients）
 * 由面板的系统设置决定（akari-panel `sub::IMPORT_CLIENTS`），这里只负责按各客户端的 scheme 拼链接。
 */
import type { Me, SubFormat } from '@/api';

export const SUB_FORMATS: SubFormat[] = ['auto', 'clash', 'sing-box', 'links'];

/** 面板开着的格式（auto = 按客户端的 User-Agent 在开着的格式里选，总是可选） */
export function enabledFormats(me: Pick<Me, 'sub_formats'> | undefined): SubFormat[] {
  const on = new Set(me?.sub_formats ?? []);
  return SUB_FORMATS.filter((f) => f === 'auto' || on.has(f));
}

/** 指定格式的订阅地址（auto = 按客户端的 User-Agent，不加参数） */
export function withFormat(url: string, format: SubFormat): string {
  if (format === 'auto') return url;
  return `${url}${url.includes('?') ? '&' : '?'}format=${format}`;
}

/**
 * UTF-8 字符串的 URL 安全 base64（无填充）：Shadowrocket 的 `sub://` 写法。
 * 标准 base64 的 `+`、`/`、`=` 会被深链接当成 URL 语法（面板 W30 实测）。
 */
function base64Url(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type ImportLink = { id: string; name: string; platforms: string; href: string };

/**
 * 一键导入的深链接，按面板给的客户端 id 与顺序（`me.sub_import_clients`，已按开着的格式筛过）。
 * 每个客户端用它自己认得的格式：Clash Verge / mihomo 与 Stash 用 Clash（带分流规则），sing-box 用 sing-box，
 * Shadowrocket 用通用链接；Hiddify 拿原始地址（它的 import 链接不保证保留查询串，面板按 User-Agent 认它）。
 * name 是导入后配置的名字（站点名）。
 */
export function importLinks(url: string, name: string, ids: readonly string[]): ImportLink[] {
  const enc = encodeURIComponent;
  const clash = withFormat(url, 'clash');
  const all: Record<string, ImportLink> = {
    clash: { id: 'clash', name: 'Clash Verge / mihomo', platforms: 'Windows · macOS · Linux · Android', href: `clash://install-config?url=${enc(clash)}&name=${enc(name)}` },
    stash: { id: 'stash', name: 'Stash', platforms: 'iOS · macOS', href: `stash://install-config?url=${enc(clash)}&name=${enc(name)}` },
    shadowrocket: { id: 'shadowrocket', name: 'Shadowrocket', platforms: 'iOS', href: `shadowrocket://add/sub://${base64Url(withFormat(url, 'links'))}?remark=${enc(name)}` },
    'sing-box': { id: 'sing-box', name: 'sing-box', platforms: 'iOS · Android · macOS', href: `sing-box://import-remote-profile?url=${enc(withFormat(url, 'sing-box'))}#${enc(name)}` },
    hiddify: { id: 'hiddify', name: 'Hiddify', platforms: 'Android · Windows · macOS', href: `hiddify://import/${url}#${enc(name)}` },
  };
  return ids.flatMap((id) => (all[id] ? [all[id]] : []));
}

/**
 * 账户的订阅地址；没有可显示的（管理员、续费范围、旧格式链接）为 null。
 * 没配订阅域名 / 主域名时面板给的是相对地址（`/<订阅路径>/<令牌>`），补上本站的 origin。
 * 订阅路径是随机的（D11），前端从不自己拼。
 */
export function mySubUrl(me: Pick<Me, 'sub_url'> | undefined, origin?: string): string | null {
  const u = me?.sub_url;
  if (!u) return null;
  return u.startsWith('/') ? `${origin ?? location.origin}${u}` : u;
}
