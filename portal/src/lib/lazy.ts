/**
 * 按需加载的页面，与「新版本上线后自动重新加载」。
 *
 * 发布新版本后，旧页面里记着的分包地址（带内容哈希）在面板上已经不存在：import() 会失败。
 *   1. 先隔 700ms 重试一次——移动网络切基站、进隧道的那几秒也会让 import() 失败。浏览器会把失败的模块记在
 *      module map 里，原样再 import 连请求都不会发，所以从报错里取出地址、加查询串当成新模块再取；
 *   2. 还不行就整页重新加载一次（拿到新的 index.html 与新的分包），sessionStorage 记一笔防止无限刷新；
 *   3. 重新加载过仍然失败：交给页面显示「这一页没能下载完」（ChunkError）。
 * Vite 预加载失败（vite:preloadError）走同一套。
 */

const RELOAD_KEY = 'akari.chunk-reload';

const CHUNK_ERROR = /Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed|error loading dynamically imported/i;

function isChunkError(e: unknown): boolean {
  return CHUNK_ERROR.test(String(e instanceof Error ? e.message : e));
}

function retry<T>(load: () => Promise<T>): Promise<T> {
  return load().catch((err: unknown) => {
    const url = String(err instanceof Error ? err.message : err).match(/https?:\/\/\S+?\.m?js/)?.[0];
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        const again = url ? (import(/* @vite-ignore */ `${url}?retry=${Date.now()}`) as Promise<T>) : load();
        again.then(resolve, () => reject(err));
      }, 700);
    });
  });
}

/** 新版本上线导致的分包失败：整页重新加载一次。返回 true = 已经在重新加载 */
function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  location.reload();
  return true;
}

/** 页面正常显示了：下一次失败又可以自动重新加载 */
export function chunkLoaded() {
  try { sessionStorage.removeItem(RELOAD_KEY); } catch { /* 隐私模式 */ }
}

const cache = new Map<() => Promise<unknown>, Promise<unknown>>();
const done = new Map<() => Promise<unknown>, unknown>();

/** 已经下载好的页面模块（同步取到，切页不闪加载态）；还没有为 undefined */
export function loadedPage<T>(load: () => Promise<T>): T | undefined {
  return done.get(load) as T | undefined;
}

/** 加载一个页面模块（同一个模块只下一次）；失败按上面的顺序处理，最终失败时 reject（调用方显示 ChunkError） */
export function loadPage<T>(load: () => Promise<T>): Promise<T> {
  let p = cache.get(load) as Promise<T> | undefined;
  if (!p) {
    p = retry(load).then((m) => { done.set(load, m); return m; }, (e: unknown) => {
      cache.delete(load);
      if (isChunkError(e) && reloadOnce()) return new Promise<T>(() => {});
      throw e;
    });
    cache.set(load, p);
  }
  return p;
}

const preloading = new Map<() => Promise<unknown>, Promise<void>>();

/**
 * 预载一个页面模块（lib/prefetch、lib/dialogs 用）：成功后 loadedPage 同步取得到；失败静默——真正进页面时 loadPage 照常重试 / 重新加载。
 * 浏览器对同一个模块地址只发一次请求，预载在途时进页面的 import() 复用它；在途时再预载（指针移上又聚焦）不再调用 load。
 */
export function preloadPage<T>(load: () => Promise<T>): Promise<void> {
  if (done.has(load)) return Promise.resolve();
  let p = preloading.get(load);
  if (!p) {
    p = (cache.get(load) ?? load()).then((m) => { done.set(load, m); }, () => {}).finally(() => preloading.delete(load));
    preloading.set(load, p);
  }
  return p;
}

/** Vite 的模块预加载失败：同样重新加载一次（之后照常抛出，交给页面） */
export function watchPreloadErrors() {
  addEventListener('vite:preloadError', (e) => {
    if (reloadOnce()) e.preventDefault();
  });
}

/*
 * 预载（lib/prefetch 的页面、lib/dialogs 的对话框）共用的两条规则：只在快网络上做、等浏览器空闲再做。
 */

/** effectiveType 只有 slow-2g / 2g / 3g / 4g 四档；拿不到这个值的浏览器（Safari、Firefox）按快网络处理 */
export function fastNetwork(): boolean {
  const net = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (net?.saveData) return false;
  return !net?.effectiveType || net.effectiveType === '4g';
}

/** 等浏览器闲下来再跑，别和当前页面自己的请求抢带宽 */
export function whenIdle(fn: () => void, timeout = 2500): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(fn, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const t = setTimeout(fn, Math.min(timeout, 1200));
  return () => clearTimeout(t);
}
