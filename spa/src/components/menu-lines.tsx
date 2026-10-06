import type { ComponentProps, CSSProperties, Ref } from 'react';
import { cn } from '@/lib/utils';

/**
 * 页头的菜单按钮：两根线。
 *
 * 上面那根就是菜单。下面那根是「和你最相关的那个进度」：
 *   · 登录的用户——灰轨加一截蓝，蓝色的长度是剩余流量，不足一成换成琥珀色；
 *   · 落地页上的访客——这一页读到了哪（首屏上两根都是实心白线，就是个普通菜单图标）。
 * 头像因此不需要了：账号没有头像，原来那个人人一样的小人什么也没说。
 * 打开时两根线旋成 ×，卡片顶边那根细线接着把这个值画出来，见 account-card 的 CardLine。
 *
 * 样式在 index.css 的 .lines 里：状态全挂在 data-* 上，Radix 的 data-state=open 直接驱动 ×。
 * Radix 的 Trigger 用 asChild 把 ref、aria-expanded、onClick 塞进来，这里原样交给 <button>。
 */
export default function MenuLines({
  value = 0, solid = false, tone, dot = false, dark = false, intro = false, fillRef, className, style, ...rest
}: ComponentProps<'button'> & {
  /** 下面那根线蓝色部分的长度，0–100 */
  value?: number;
  /** 下面那根也画成实线（访客在首屏、或不在落地页时：就是个普通的菜单图标） */
  solid?: boolean;
  tone?: 'warn';
  /** 上面那根线末尾的小圆点：工单有新回复、有待支付订单 */
  dot?: boolean;
  /** 落地页深色首屏上：线换成白色 */
  dark?: boolean;
  /** 本次访问第一次出现：下面那根从 0 画到当前值 */
  intro?: boolean;
  /** 阅读进度每帧都在变，不走 React 渲染，直接改这根线的宽度 */
  fillRef?: Ref<HTMLElement>;
}) {
  return (
    <button
      type="button"
      className={cn('lines', className)}
      data-solid={solid || undefined}
      data-tone={tone}
      data-dark={dark || undefined}
      data-intro={intro || undefined}
      style={{ '--v': `${Math.max(0, Math.min(100, value))}%`, ...style } as CSSProperties}
      {...rest}
    >
      <i aria-hidden />
      <i aria-hidden><b ref={fillRef} /></i>
      {dot && <s aria-hidden />}
    </button>
  );
}
