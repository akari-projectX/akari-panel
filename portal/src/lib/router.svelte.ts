/**
 * 一个很小的客户端路由（History API）。不用 SvelteKit：它的静态 SPA 产物靠内联 <script> 启动，
 * 面板的 CSP 是固定的 'self'（不带 hash / nonce），见 portal/CLAUDE.md。
 *
 *   · loc：当前地址（$state，模板里读它就会跟着变）；
 *   · navigate(to, {replace})：pushState / replaceState，切页后回到顶部；
 *   · 站内 <a href="/…"> 的点击在 document 上统一接管（新标签、修饰键、download、target、外链照常交给浏览器）；
 *   · popstate（后退 / 前进，以及测速脚本的 pushState + popstate）同样更新 loc。
 */

export const loc = $state({ path: location.pathname, search: location.search, hash: location.hash });

function sync() {
  loc.path = location.pathname;
  loc.search = location.search;
  loc.hash = location.hash;
}

/**
 * state：随这一条历史记录存下的数据（注销结果页读 `history.state.anonymized`）；
 * keepScroll：不回到顶部（页内分页 `?tab=` 换的是同一页的一块）
 */
export function navigate(to: string, opts: { replace?: boolean; state?: Record<string, unknown>; keepScroll?: boolean } = {}) {
  const url = new URL(to, location.href);
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return;
  }
  const next = url.pathname + url.search + url.hash;
  const same = next === location.pathname + location.search + location.hash;
  const samePath = url.pathname === location.pathname;
  if (opts.replace || same) history.replaceState(opts.state ?? history.state, '', next);
  else history.pushState(opts.state ?? {}, '', next);
  sync();
  /* 换了页：回到页首放在旧页面淡出之后（App 的切页外壳）；同一页内的查询串变化立刻回到页首 */
  if (!same && samePath && !url.hash && !opts.keepScroll) window.scrollTo(0, 0);
}

/** 查询串里的一个参数 */
export function param(name: string): string | null {
  return new URLSearchParams(loc.search).get(name);
}

/** 换掉整个查询串（同一页内：文档的分类 / 搜索 / 文章、工单的 ?id=）；值为空的参数不写 */
export function setParams(next: Record<string, string | null | undefined>, opts: { replace?: boolean; keepScroll?: boolean } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) if (v) q.set(k, v);
  const s = q.toString();
  navigate(`${loc.path}${s ? `?${s}` : ''}`, opts);
}

function onClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as Element | null)?.closest?.('a');
  if (!a || !a.hasAttribute('href') || a.hasAttribute('download') || a.dataset.external !== undefined) return;
  if (a.target && a.target !== '_self') return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  /* 只接管门户自己的页面；/api、/auth、/brand、/assets 等交给浏览器 */
  if (/^\/(api|auth|brand|assets)(\/|$)/.test(url.pathname)) return;
  /* 同一页内的锚点（「跳到主要内容」）交给浏览器：它会滚动并移动焦点 */
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
  e.preventDefault();
  /* <a data-replace>：替换当前这条历史记录（注销结果页「返回登录页」，后退不再回到结果页） */
  navigate(url.pathname + url.search + url.hash, { replace: a.dataset.replace !== undefined });
}

let started = false;
export function startRouter() {
  if (started) return;
  started = true;
  addEventListener('popstate', sync);
  document.addEventListener('click', onClick);
}
