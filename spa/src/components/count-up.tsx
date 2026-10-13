import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useBootOut } from '@/lib/boot';
import { DUR, useInViewOnce, useReducedMotion } from '@/lib/motion';

type Props = {
  to: number;
  /** 第一次（从 0 滚到值）的时长，秒 */
  duration?: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
  /**
   * 自定义写法：拿到的是滚动中的数值（已按 integer 取整），返回要显示的文本。
   * 金额传 `formatMoney`（值是分，integer 默认为 true，不会出现半分）。给了它就不看 decimals / prefix / suffix。
   */
  format?: (v: number) => string;
  /** 滚动中的数值取整（金额 = 分）。默认：给了 format 时为 true */
  integer?: boolean;
  /** 第一次不滚，直接写终值（页面的最大内容块，见 flat 的 StatRow still）；之后值变了照常滚动 */
  instant?: boolean;
};

/**
 * 数字滚动：进入视口后从 0 滚到值；之后值再变（余额到账、流量刷新）就从旧值滚到新值（DUR.roll，更短）。
 *
 * 动画期间**直接写 DOM**，不走 setState。
 * 原来每帧一次 setVal，一行统计条有四个数字就是每秒 240 次组件渲染，
 * 而这中间除了一段文本什么都没变。现在 React 只渲染一次，剩下的交给 rAF 改 textContent。
 *
 * 因此这个 span 的**子节点必须留空**：以前它既由 JSX 渲染 `{prefix}{to}{suffix}`，
 * 又被 effect 用 textContent 覆盖，两边抢同一块文本。textContent 会把 React 建的
 * 文本节点整个换掉，React 之后再更新时改的是已经脱离文档的节点，屏幕上什么都不会变；
 * 而调用方传的 suffix 是翻译过的（tr(' 台') / tr(' 元') / tr(' 张')），
 * 切一次语言要是重启动画，整页数字全部归零重新滚。现在 DOM 完全归这个组件所有。
 */
export default function CountUp({ to, duration = 1.6, decimals = 0, suffix = '', prefix = '', format, integer, instant = false }: Props) {
  /* instant：一挂载就算「已经滚完」，首帧写终值（见下面的 layout effect） */
  const started = useRef(instant);
  const first = useRef(instant);
  /* 屏幕上此刻的数值：值变化时从这里滚到新值 */
  const shown = useRef(0);
  /* 刷新时等启动画面开始淡出再滚，否则数字在遮罩底下就滚完了，露出来已经是终值 */
  const ready = useBootOut();
  const [ref, seen] = useInViewOnce<HTMLSpanElement>('-60px');
  const inView = seen && ready;
  const still = useReducedMotion();

  /* 格式只影响怎么写，不影响写什么，所以放 ref：换语言不该重启动画。
     赋值在下面的 layout effect 里做，渲染期间不碰 ref */
  const fmt = useRef({ decimals, suffix, prefix, format, integer: integer ?? !!format });

  const write = useCallback((v: number) => {
    const el = ref.current;
    if (!el) return;
    const { decimals: d, prefix: p, suffix: s, format: f, integer: int } = fmt.current;
    const n = int ? Math.round(v) : v;
    shown.current = n;
    el.textContent = f ? f(n) : `${p}${n.toFixed(d)}${s}`;
  }, [ref]);

  /* 从 shown 滚到 target；返回取消函数 */
  const roll = useCallback((target: number, seconds: number) => {
    const from = shown.current;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / (seconds * 1000), 1);
      write(from + (target - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else write(target);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [write]);

  /*
   * 每次渲染后校正一次文本，代价是一句 textContent。
   * 用 layout effect 而不是 effect：effect 在绘制之后才跑，首帧会先闪一下空白。
   *   · instant 的第一次 → 直接写终值
   *   · 还没开始动画 → 写 0（reduced motion 时直接写终值，不做动画）
   *   · 已经停在终值 → 重写一遍（切语言换掉 suffix 时走的就是这一支，只改文本不重播）
   *   · 动画进行中 → 不插手，交给 rAF，新格式下一帧自然生效
   */
  useLayoutEffect(() => {
    fmt.current = { decimals, suffix, prefix, format, integer: integer ?? !!format };
    if (first.current) { first.current = false; write(to); }
    else if (!started.current) write(still ? to : 0);
    else if (shown.current === to) write(to);
  });

  /*
   * 第一次：进入视口后从 0 滚上去；之后值变了：从屏幕上的值滚到新值。
   * 滚到一半值又变了，清理函数停掉旧的一段，再从停下的地方滚向最新的值。
   */
  useEffect(() => {
    if (!started.current) {
      if (!inView) return;
      started.current = true;
      if (still) { write(to); return; }
      return roll(to, duration);
    }
    if (shown.current === to) return;
    if (still) { write(to); return; }
    return roll(to, DUR.roll);
  }, [inView, to, duration, still, write, roll]);

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
        write(to);
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [to, write, ready, ref]);

  /* 子节点留空——文本完全由上面的 write() 负责，不和 React 抢 */
  return <span ref={ref} />;
}
