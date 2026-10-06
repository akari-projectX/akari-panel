/**
 * 门户挂在哪里、面板的接口在哪里。整站只在这里决定一次。
 *
 * 构建时由 VITE_PORTAL_MODE 选（见 README「部署位置」）：
 *   · root（默认，③ 之后的部署）：门户在主域名根路径 `/`，接口在 `/api/v1`、`/auth`，品牌图片在 `/brand/…`；
 *   · prefixed（过渡期）：门户在面板的秘密前缀下 `/{prefix}/app`，接口在 `/{prefix}/api/v1`……
 *     前缀是服务器上的秘密，构建时不知道，取当前地址的第一段。
 *
 * 路由（BrowserRouter 的 basename）、接口地址、要发给别人的深链接都从这里拿，页面不拼绝对路径。
 */

export type PortalMode = 'root' | 'prefixed';

export const PORTAL_MODE: PortalMode = import.meta.env.VITE_PORTAL_MODE === 'prefixed' ? 'prefixed' : 'root';

function firstSegment(pathname: string): string {
  const seg = pathname.split('/')[1] ?? '';
  return seg ? `/${seg}` : '';
}

/** 面板的根（接口、认证、品牌图片都在它下面）。root 模式是空串 */
export const panelBase: string = PORTAL_MODE === 'prefixed' && typeof location !== 'undefined'
  ? firstSegment(location.pathname)
  : '';

/** 门户路由的根（BrowserRouter 的 basename）。root 模式是空串，即 `/` */
export const routerBase: string = PORTAL_MODE === 'prefixed' ? `${panelBase}/app` : '';

export const apiBase = `${panelBase}/api/v1`;
export const authBase = `${panelBase}/auth`;

/** 面板给的品牌图片地址是相对面板根的（"brand/logo?v=3"） */
export function brandUrl(rel: string): string {
  return `${panelBase}/${rel.replace(/^\//, '')}`;
}

/** 门户里某一页的完整地址（要复制、要发给别人的深链接）。route 以 / 开头 */
export function portalUrl(route: string): string {
  return `${location.origin}${routerBase}${route}`;
}

/**
 * 过渡期（面板 main，③ 之前）没有 sub_url 时，按令牌在本站拼订阅地址（固定的 /sub/ 路径）。
 * ③ 之后订阅路径是随机的、还可能在单独的订阅域名上：只能用面板给的 sub_url（features 的 sub-url-only）。
 */
export function legacySubscriptionUrl(token: string): string {
  return `${location.origin}${panelBase}/sub/${token}`;
}
