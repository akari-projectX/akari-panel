import { useCallback, useEffect, useRef, useState } from 'react';
import { holdBoot } from '@/lib/boot';
import { load, readCache, writeCache } from '@/lib/cache';

/**
 * 一个够用的取数 hook：加载态、错误态、手动重取，外加可选的缓存。
 *
 * 传了 key 就是「先用缓存、后台刷新」：
 *   · 挂载时若有缓存，第一次渲染就带着数据，页面不经过骨架，入场动画和内容一起播；
 *   · 请求照发，回来后原地替换；
 *   · 请求不随组件卸载而取消——结果写进缓存，下次进来就是新的。
 * 不传 key 就是普通的「进来拉一次」，卸载时 abort。
 *
 * 没有引 react-query：全站的取数模式就这两种，为此多背一个依赖不划算。
 */
export type ApiState<T> = {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
  setData: (v: T | undefined) => void;
};

/* 带缓存的请求不跟组件同生共死，给它一个永远不会 abort 的信号 */
const NEVER = new AbortController().signal;

export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
  options: {
    enabled?: boolean;
    key?: string;
    /**
     * key 变了、新 key 又没有缓存时，先接着显示上一个 key 的数据，而不是退回骨架。
     * 给分页列表用：翻页时旧的一页留在原地、页码条也不消失，新的一页到了再换。
     */
    keepPrevious?: boolean;
  } = {},
): ApiState<T> {
  const { enabled = true, key, keepPrevious = false } = options;

  /*
   * 数据和它所属的 key 存在一起。key 变了（翻页、换一张工单）而新数据还没到时，
   * 不能把上一个 key 的数据当成这一个的——那会闪一下别人的内容——改读新 key 的缓存。
   */
  const [state, setState] = useState<{ key?: string; data?: T }>(() => ({
    key,
    data: key ? readCache<T>(key) : undefined,
  }));
  const switched = !!key && state.key !== key;
  const data = switched ? readCache<T>(key) ?? (keepPrevious ? state.data : undefined) : state.data;

  /*
   * 错误同样记下它属于哪个 key：上一张工单没加载出来，不该让下一张一打开就是报错。
   * loading 则在「key 刚变、effect 还没跑」的那一次渲染里也要是 true——
   * 否则页面会拿到 loading=false、data=undefined，先闪一下「暂无数据」再出骨架。
   */
  const [err, setErr] = useState<{ key?: string; error?: Error }>({});
  const error = err.key === key ? err.error : undefined;
  const [loadingState, setLoading] = useState(enabled && data === undefined);
  const loading = loadingState || (enabled && switched && err.key !== key && data === undefined);
  const [tick, setTick] = useState(0);

  /* fetcher 通常是行内箭头函数，放进依赖数组会导致每次渲染都重取 */
  const ref = useRef(fetcher);
  ref.current = fetcher;

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    let alive = true;
    const ac = new AbortController();
    /* 有缓存就不拖住启动画面：页面已经能完整画出来了，见 lib/boot.ts */
    const cached = key ? readCache<T>(key) !== undefined : false;
    const release = cached ? () => {} : holdBoot('soft');
    setLoading(true);
    setErr({ key });

    const run = key ? load(key, () => ref.current(NEVER)) : ref.current(ac.signal);
    run
      .then((v) => {
        if (!alive) return;
        /* v === undefined 只来自 304（节点列表带 ETag），这时保留现有数据，但同样算这个 key 已就绪 */
        setState((s) => (v !== undefined ? { key, data: v } : { key, data: s.key === key ? s.data : readCache<T>(key!) }));
      })
      .catch((e: Error) => {
        if (!alive || e?.name === 'AbortError') return;
        setErr({ key, error: e instanceof Error ? e : new Error(String(e)) });
      })
      .finally(() => { release(); if (alive) setLoading(false); });

    return () => { alive = false; release(); if (!key) ac.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, key, tick, enabled]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const setData = useCallback((v: T | undefined) => {
    if (key && v !== undefined) writeCache(key, v);
    setState({ key, data: v });
  }, [key]);

  return { data, error, loading, reload, setData };
}

/**
 * 提交类操作的配套：跑一次异步动作，期间把按钮置灰。
 * 只管「在跑没跑」，成功提示与错误提示交给调用处，因为文案各不相同。
 */
export function usePending() {
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  /* 挂载时重新置 true，理由同 AuthProvider 的 alive：StrictMode 下会先卸载再挂载一次 */
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = useCallback(async <T,>(task: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    try {
      return await task();
    } finally {
      if (mounted.current) setPending(false);
    }
  }, []);

  return [pending, run] as const;
}
