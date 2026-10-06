import type { AnchorHTMLAttributes, MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * 页内锚点。
 *
 * 主题走 hash 路由，地址栏的 # 已经被路由占用了：写 <a href="#faq"> 会把地址改成 /#faq，
 * 路由把 faq 当成一个页面路径，直接落到 404。页内锚点得写成「当前路由 + 第二个 #」，
 * 即 #/terms#s1——React Router 能把后半截认作 location.hash。
 *
 * 点击时自己滚动：锚点没变（连点两次同一个目录项）时路由不会触发任何事，
 * 靠 App 里的 ScrollTop 就滚不动了。按住 Ctrl / ⌘ 时交还给浏览器，照常新标签页打开。
 */
export default function HashLink({
  id, onClick, ...rest
}: { id: string } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  const { pathname } = useLocation();
  const nav = useNavigate();

  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    nav({ pathname, hash: `#${id}` }, { replace: true });
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
  };

  return <a href={`#${pathname}#${id}`} onClick={handle} {...rest} />;
}
