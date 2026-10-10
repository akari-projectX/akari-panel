import { useEffect, useRef } from 'react';

/**
 * 每隔 ms 调一次 reload（页面在后台时不调，回到前台立即补一次）。
 * 给线路状态这类会自己变的数据用；enabled 为假时什么都不做。
 */
export function useAutoReload(reload: () => void, ms: number, enabled = true) {
  const ref = useRef(reload);
  useEffect(() => { ref.current = reload; }, [reload]);
  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState === 'visible') ref.current(); };
    const id = window.setInterval(tick, ms);
    const onVisible = () => { if (document.visibilityState === 'visible') ref.current(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [ms, enabled]);
}
