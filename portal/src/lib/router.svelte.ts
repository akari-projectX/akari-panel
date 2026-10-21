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

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const url = new URL(to, location.href);
  if (url.origin !== location.origin) {
    location.assign(url.href);
    return;
  }
  const next = url.pathname + url.search + url.hash;
  const same = next === location.pathname + location.search + location.hash;
  if (opts.replace || same) history.replaceState(history.state, '', next);
  else history.pushState({}, '', next);
  sync();
  if (!same && !url.hash) window.scrollTo(0, 0);
}

/** 查询串里的一个参数 */
export function param(name: string): string | null {
  return new URLSearchParams(loc.search).get(name);
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
  navigate(url.pathname + url.search + url.hash);
}

let started = false;
export function startRouter() {
  if (started) return;
  started = true;
  addEventListener('popstate', sync);
  document.addEventListener('click', onClick);
}
