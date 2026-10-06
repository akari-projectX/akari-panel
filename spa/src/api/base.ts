/**
 * 门户挂在哪里、面板的接口在哪里。整站只在这里决定一次。
 *
 * 门户在主域名根路径 `/`（D11），接口在 `/api/v1`、`/auth`，品牌图片在 `/brand/…`。
 * 后台在独立的秘密前缀下，是另一个应用：门户代码里不出现后台地址，也不往后台跳（D4）。
 *
 * 要发给别人的深链接从这里拿，页面不拼绝对路径。
 */

export const apiBase = '/api/v1';
export const authBase = '/auth';

/** 面板给的品牌图片地址是相对面板根的（"brand/logo?v=3"） */
export function brandUrl(rel: string): string {
  return `/${rel.replace(/^\//, '')}`;
}

/** 门户里某一页的完整地址（要复制、要发给别人的深链接）。route 以 / 开头 */
export function portalUrl(route: string): string {
  return `${location.origin}${route}`;
}
