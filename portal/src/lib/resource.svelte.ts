import { untrack } from 'svelte';
import { isFresh, load, readCache, writeCache } from '@/lib/cache';
import { holdBoot } from './boot.svelte';

/**
 * 页面取数（与 React 门户 hooks/use-api.ts 的带缓存用法相同）：先用 sessionStorage 缓存（同一个键）把区块画出来，
 * 同时在后台取最新的，回来后原地替换；请求不随页面卸载而取消，结果照样写进缓存。没有缓存时拖住启动画面（soft），
 * 页面一次画全。键变了（7 天 / 30 天）改读新键的缓存，不把上一个键的数据当成这一个的。
 *
 * 只能在组件初始化时调用（里面有 $effect）。`spec` 里读到的 $state 变了就重取。
 *
 *   const nodes = resource(() => ({ key: K.nodes, fetch: () => meApi.nodes(), enabled: full }));
 *   nodes.data / nodes.error / nodes.loading / nodes.reload() / nodes.set(v)
 */
export type Spec<T> = {
  key: string;
  fetch: () => Promise<T>;
  enabled?: boolean;
  /** 键变了而新键没有缓存时先留着上一个键的数据（= React useApi 的 keepPrevious：商店换优惠码 / 余额抵扣重新报价时不闪空） */
  keep?: boolean;
};

export type Resource<T> = {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  reload: () => void;
  /** 本地改了（标记已读之类）：原地换掉，并写进缓存 */
  set: (v: T) => void;
};

export function resource<T>(spec: () => Spec<T>): Resource<T> {
  const first = untrack(spec);
  const s = $state({
    key: first.key,
    data: readCache<T>(first.key),
    error: undefined as unknown,
    loading: false,
  });
  s.loading = (first.enabled ?? true) && s.data === undefined;
  let tick = $state(0);
  let seenTick = 0;

  $effect(() => {
    const o = spec();
    const forced = tick !== seenTick;
    seenTick = tick;
    return untrack(() => run(o, forced));
  });

  function run(o: Spec<T>, forced: boolean): (() => void) | undefined {
    if (o.key !== s.key) {
      s.key = o.key;
      const cached = readCache<T>(o.key);
      if (cached !== undefined || !o.keep) s.data = cached;
      s.error = undefined;
    }
    if (!(o.enabled ?? true)) {
      s.loading = false;
      return undefined;
    }
    const key = o.key;
    /* 预取刚把这份数据取回来（页面是在预取完成之后才挂载的）：就是最新的，不再请求一遍；reload() 一律重取 */
    if (!forced && s.data !== undefined && isFresh(key)) {
      s.loading = false;
      return undefined;
    }
    const release = s.data === undefined ? holdBoot('soft') : () => {};
    s.loading = true;
    s.error = undefined;
    load(key, o.fetch)
      .then(
        (v) => {
          /* undefined 只来自 304（节点列表带 ETag）：保留现有数据 */
          if (s.key === key && v !== undefined) s.data = v;
        },
        (e: unknown) => {
          if (s.key === key) s.error = e;
        },
      )
      .finally(() => {
        release();
        if (s.key === key) s.loading = false;
      });
    return release;
  }

  return {
    get data() { return s.data; },
    get error() { return s.error; },
    get loading() { return s.loading; },
    reload: () => { tick++; },
    set: (v: T) => {
      writeCache(s.key, v);
      s.data = v;
    },
  };
}

/**
 * 每隔 ms 调一次 reload（标签页在后台时不调，回到前台立即补一次），线路状态这类会自己变的数据用。
 * 只能在组件初始化时调用；enabled() 为假时什么都不做。
 */
export function autoReload(reload: () => void, ms: number, enabled: () => boolean) {
  $effect(() => {
    if (!enabled()) return;
    const tickIfVisible = () => { if (document.visibilityState === 'visible') reload(); };
    const id = setInterval(tickIfVisible, ms);
    document.addEventListener('visibilitychange', tickIfVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tickIfVisible);
    };
  });
}
