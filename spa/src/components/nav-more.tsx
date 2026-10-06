import { useLayoutEffect, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

export type MoreItem = { to: string; label: string; desc: string; meta?: string };

/**
 * 顶部导航当前项下面那道蓝线。整条导航只有这一根，量出当前项（data-active）的位置挪过去，
 * 切页时它从旧的一项滑到新的一项，而不是这边消失、那边出现。
 * 第一次量到位之前不加过渡，免得刷新时从最左边滑进来。
 */
export function NavIndicator({ nav, active }: { nav: RefObject<HTMLElement | null>; active: string }) {
  const [pos, setPos] = useState<{ x: number; y: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const el = nav.current;
    if (!el) return;
    const measure = () => {
      const a = el.querySelector<HTMLElement>('.topnav-link[data-active="true"]');
      /* 窄屏下整条导航是 display:none，量出来是 0：藏起来，等它出现时再量 */
      setPos(a && a.offsetWidth ? { x: a.offsetLeft, y: a.offsetTop + a.offsetHeight - 2, w: a.offsetWidth } : null);
    };
    measure();
    /* 导航本身显隐、字体到货后文字变宽，都要重新量 */
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.querySelectorAll('.topnav-link').forEach((a) => ro.observe(a));
    return () => ro.disconnect();
  }, [nav, active]);

  useLayoutEffect(() => {
    if (!pos || ready) return;
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, [pos, ready]);

  if (!pos) return null;
  return (
    <span
      aria-hidden
      className="nav-indicator"
      data-ready={ready}
      style={{ width: pos.w, translate: `${pos.x}px ${pos.y}px` }}
    />
  );
}

/** 折起来的这几项是目录的后半段，编号从主导航之后接着数 */
const START = 5;

/**
 * 「更多」不是一列光秃秃的链接。
 *
 * 这个站从落地页正文到法务页，用的都是同一套语言：**带编号的目录 + 一道品牌色刻度**。
 * 顶部导航一共十个去处，露出四个、折起六个——折起来的那部分本来就是「目录的后半段」，
 * 所以直接按目录来做：编号从 05 接着数，每项一句说明，右侧挂当前的实时数字。
 * 悬停／选中时编号变蓝、左侧伸出一道刻度，和正文每章标题旁边那道是同一个记号。
 *
 * 它既不是通用下拉，也不只是好看——「1247 台在线」「3 张工单」是点进去之前就该知道的事。
 */
export default function NavMore({
  items, active, className,
}: { items: MoreItem[]; active: string; className?: string }) {
  const nav = useNavigate();
  const tr = useT();
  const inside = items.some((m) => m.to === active);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={cn('topnav-link cursor-pointer gap-1', className)} data-active={inside}>
          {tr('更多')}
          <ChevronDown className="size-3.5 transition-transform duration-(--dur-fast)" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" sideOffset={12} className="w-[340px] rounded-2xl p-0">
        <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
          <span className="text-[11px] tracking-[.2em] text-muted-foreground">{tr('导航')}</span>
          <span className="tnum text-[11px] tracking-[.1em] text-muted-foreground">
            {String(START).padStart(2, '0')} – {String(START + items.length - 1).padStart(2, '0')}
          </span>
        </div>

        <div className="p-1.5">
          {items.map((m, i) => {
            const on = active === m.to;
            return (
              <DropdownMenuItem
                key={m.to}
                onClick={() => nav(m.to)}
                data-on={on}
                className="group relative cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 focus:bg-muted/70 data-[on=true]:bg-muted/50"
              >
                {/* 与正文每章标题旁边同一个记号：一道品牌色刻度 */}
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-1/2 left-0 h-px -translate-y-1/2 bg-brand transition-[width] duration-(--dur-fast)',
                    on ? 'w-2.5' : 'w-0 group-focus:w-2.5',
                  )}
                />
                <span
                  className={cn(
                    'tnum mt-0.5 shrink-0 text-[11.5px] font-medium transition-colors',
                    on ? 'text-brand' : 'text-faint group-focus:text-brand',
                  )}
                >
                  {String(START + i).padStart(2, '0')}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex items-baseline justify-between gap-3">
                    <span className={cn('text-[14.5px] font-medium', on && 'text-brand')}>
                      {tr(m.label)}
                    </span>
                    {m.meta && (
                      <span className="tnum shrink-0 text-[11.5px] whitespace-nowrap text-muted-foreground">
                        {m.meta}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-[12px] leading-[1.5] text-muted-foreground">
                    {tr(m.desc)}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
