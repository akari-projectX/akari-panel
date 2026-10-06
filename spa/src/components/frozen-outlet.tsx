import { useState } from 'react';
import { useOutlet } from 'react-router-dom';

/**
 * 「定格」的 Outlet：挂载那一刻渲染的是哪一页，之后就一直是那一页。
 *
 * 切页动画要让旧页面淡出、新页面淡入。可 <Outlet /> 永远渲染「当前」路由——
 * 旧容器在淡出的那 0.14 秒里，里面其实已经换成了新页面：用户看到的是
 * 「新页面淡出 → 一帧空白 → 新页面再淡入」，同一页闪了两次。
 * 用 useOutlet 在挂载时取一次元素存起来，旧容器里就一直是旧页面。
 */
export default function FrozenOutlet() {
  const outlet = useOutlet();
  const [frozen] = useState(outlet);
  return frozen;
}
