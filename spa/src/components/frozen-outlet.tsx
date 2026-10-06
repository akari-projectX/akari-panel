import { Suspense, useState, type ReactNode } from 'react';
import { useOutlet } from 'react-router-dom';

/**
 * 「定格」的 Outlet：挂载那一刻渲染的是哪一页，之后就一直是那一页。
 *
 * 切页动画要让旧页面淡出、新页面淡入。可 <Outlet /> 永远渲染「当前」路由——
 * 旧容器在淡出的那 0.14 秒里，里面其实已经换成了新页面：用户看到的是
 * 「新页面淡出 → 一帧空白 → 新页面再淡入」，同一页闪了两次。
 * 用 useOutlet 在挂载时取一次元素存起来，旧容器里就一直是旧页面。
 *
 * 页面分包的 Suspense 必须在这里面、定格之后：放在外面的话，页面分包还没下完（骨架屏还亮着）时，
 * 定格的这一份从来没有真正挂上，React 会丢掉它的状态；这时切页，分包下完重试时它按「当前」地址
 * 重新定格——新页面先在淡出的旧容器里渲染一遍，退场结束再在新容器里重建一遍，
 * 头 0.14 秒里填进表单的内容随旧容器一起丢掉（e2e：support.spec.ts「page transition」）。
 */
export default function FrozenOutlet({ fallback }: { fallback: ReactNode }) {
  const outlet = useOutlet();
  const [frozen] = useState(outlet);
  return <Suspense fallback={fallback}>{frozen}</Suspense>;
}
