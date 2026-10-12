import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useReducedMotion } from '@/lib/motion';

/**
 * 地址带 #锚点 时滚到那个区块（设置页的分区导航、付款结果的「查看订阅」→ 仪表盘 #subscribe）。
 * 切页外壳（PageTransition）在旧页面退场后先回到页首，新页面挂载后这里再滚过去；ready = 区块已经渲染出来。
 * 目标元素的 scroll-margin-top 让出吸顶的页头（index.css）。
 */
export function useHashScroll(ready = true) {
  const { hash } = useLocation();
  const still = useReducedMotion();
  useEffect(() => {
    if (!ready || hash.length < 2) return;
    const t = setTimeout(() => {
      document.getElementById(decodeURIComponent(hash.slice(1)))
        ?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    }, 80);
    return () => clearTimeout(t);
  }, [hash, ready, still]);
}
