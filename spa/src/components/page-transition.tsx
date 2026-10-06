import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DUR } from '@/lib/motion';

/** 带锚点的地址（#/#pricing、#/terms#s3）由 App 里的 ScrollTop 滚到对应区块，这里不能先把它拉回页首 */
function hasAnchor() {
  return window.location.hash.slice(1).includes('#');
}

/**
 * 切页外壳，站点页与用户中心共用一份，两边的切页手感因此一致：
 * 旧页面淡出（EXIT）→ 回到页首 → 新页面上浮淡入（FAST）。动画本身在 index.css（.page-out / .page-in）。
 *
 *   · 里面要放 FrozenOutlet：地址变了之后，旧页面这一份实例（key 还是旧的 id）继续留在原地淡出，
 *     它里面的 FrozenOutlet 定格的仍是旧页面；否则会变成「新页面闪两次」；
 *   · 回到页首放在旧页面退完之后，而不是一点就跳——先跳到顶、旧页面在顶部位置淡出，看上去整页抖一下；
 *   · 位移只给 NUDGE：页面里的标题、统计条、列表各自还有入场，外层再大幅移动就成了两层动画叠在一起发飘；
 *   · 刷新后的第一页不播外壳动画，由启动画面的淡出和页面自己的入场接手。
 *
 * 退场期间又切了一次地址：旧页面照常退完，退完时直接换成最新的那一页。
 *
 * instant：这一页不做淡入，直接出现。落地页首屏是深色的，从浅色底淡入会先闪一下亮。
 */
export default function PageTransition({
  id, instant, children,
}: { id: string; instant?: boolean; children: ReactNode }) {
  /* 正在显示的那一页；和 id 不同就说明旧页面正在退场 */
  const [shown, setShown] = useState(id);
  /* 是不是切页切过来的：刷新后的第一页为 false，不播入场 */
  const [navigated, setNavigated] = useState(false);
  const latest = useRef(id);
  useEffect(() => { latest.current = id; }, [id]);

  const leaving = id !== shown;
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => {
      if (!hasAnchor()) window.scrollTo({ top: 0 });
      setShown(latest.current);
      setNavigated(true);
    }, DUR.exit * 1000);
    return () => clearTimeout(t);
  }, [leaving]);

  return (
    <div key={shown} className={leaving ? 'page-out' : navigated && !instant ? 'page-in' : undefined}>
      {children}
    </div>
  );
}
