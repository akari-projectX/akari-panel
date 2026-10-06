import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useBootOut } from '@/lib/boot';
import { useInViewOnce, useReducedMotion } from '@/lib/motion';

type Props = { to: number; duration?: number; decimals?: number; suffix?: string; prefix?: string };

/**
 * 进入视口后数字滚动增长。
 *
 * 动画期间**直接写 DOM**，不走 setState。
 * 原来每帧一次 setVal，一行统计条有四个数字就是每秒 240 次组件渲染，
 * 而这中间除了一段文本什么都没变。现在 React 只渲染一次，剩下的交给 rAF 改 textContent。
 *
 * 因此这个 span 的**子节点必须留空**：以前它既由 JSX 渲染 `{prefix}{to}{suffix}`，
 * 又被 effect 用 textContent 覆盖，两边抢同一块文本。textContent 会把 React 建的
 * 文本节点整个换掉，React 之后再更新时改的是已经脱离文档的节点，屏幕上什么都不会变；
 * 显示之所以还对，全靠 prefix/suffix 在依赖数组里、变一次就重跑一次 effect——
 * 而调用方传的 suffix 是翻译过的（tr(' 台') / tr(' 元') / tr(' 张')），
 * 于是切一次语言，整页数字全部归零重新滚。现在 DOM 完全归这个组件所有。
 */
export default function CountUp({ to, duration = 1.6, decimals = 0, suffix = '', prefix = '' }: Props) {
  const started = useRef(false);
  const done = useRef(false);
  /* 刷新时等启动画面开始淡出再滚，否则数字在遮罩底下就滚完了，露出来已经是终值 */
  const ready = useBootOut();
  const [ref, seen] = useInViewOnce<HTMLSpanElement>('-60px');
  const inView = seen && ready;
  const still = useReducedMotion();

  /* 格式只影响怎么写，不影响写什么，所以放 ref：换语言不该重启动画。
     赋值在下面的 layout effect 里做，渲染期间不碰 ref */
  const fmt = useRef({ decimals, suffix, prefix });

  const write = useCallback((v: number) => {
    const el = ref.current;
    if (!el) return;
    const { decimals: d, prefix: p, suffix: s } = fmt.current;
    el.textContent = `${p}${v.toFixed(d)}${s}`;
  }, [ref]);

  /*
   * 每次渲染后校正一次文本，代价是一句 textContent。
   * 用 layout effect 而不是 effect：effect 在绘制之后才跑，首帧会先闪一下空白。
   *   · 还没开始动画 → 写 0（reduced motion 时直接写终值，不做动画）
   *   · 已经动画完 → 写终值。切语言换掉 suffix 时走的就是这一支，只改文本不重播
   *   · 动画进行中 → 不插手，交给 rAF，新格式下一帧自然生效
   */
  useLayoutEffect(() => {
    fmt.current = { decimals, suffix, prefix };
    if (!started.current) write(still ? to : 0);
    else if (done.current) write(to);
  });

  useEffect(() => {
    if (!inView || started.current) return;
    started.current = true;
    if (still) { write(to); done.current = true; return; }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / (duration * 1000), 1);
      write(to * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else done.current = true;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, to, duration, still, write]);

  /**
   * 安全网：交叉观察器偶尔会漏掉首屏内的元素（移动端复现过——同一行两个数字，
   * 一个触发一个没有），漏掉就会永远停在 0。所以延时复核一次：
   * 元素明明在视口内却没开始动画，直接落到终值，宁可不动也不能显示 0。
   */
  useEffect(() => {
    /* 从启动画面收起时起算；刷新时停在启动画面上的那段不算，否则来不及滚就被这里落成终值 */
    if (!ready) return;
    const t = setTimeout(() => {
      const el = ref.current;
      if (started.current || !el) return;
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.top < window.innerHeight && r.bottom > 0) {
        started.current = true;
        done.current = true;
        write(to);
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [to, write, ready, ref]);

  /* 子节点留空——文本完全由上面的 write() 负责，不和 React 抢 */
  return <span ref={ref} />;
}
