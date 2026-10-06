import { useCallback, useEffect, useRef } from 'react';

/**
 * setTimeout 的安全版本：组件卸载时自动清理，避免在已卸载组件上 setState。
 * 返回的 run 引用稳定，可直接放进依赖数组。
 */
export function useSafeTimeout() {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const set = timers.current;
    return () => { set.forEach(clearTimeout); set.clear(); };
  }, []);

  return useCallback((fn: () => void, ms: number) => {
    /* 触发之后要把自己从集合里摘掉，否则长驻组件里 id 只进不出 */
    const id = setTimeout(() => { timers.current.delete(id); fn(); }, ms);
    timers.current.add(id);
    return id;
  }, []);
}
