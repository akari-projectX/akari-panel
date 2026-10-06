import type { CSSProperties, ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import CountUp from './count-up';
import { useT, useTp } from '@/i18n';
import { cn } from '@/lib/utils';
import { DUR, NUDGE, stagger, useEnter } from '@/lib/motion';

/** 区块：标题 + 右侧操作 + 顶部细分隔线 */
export function Section({
  title, desc, extra, children, className, style,
}: {
  title?: ReactNode; desc?: ReactNode; extra?: ReactNode;
  children: ReactNode; className?: string; style?: CSSProperties;
}) {
  return (
    <section className={cn('sec', className)} style={style}>
      {(title || extra) && (
        <div className="sec-head">
          <div>
            {title && <h2 className="sec-title">{title}</h2>}
            {desc && <div className="sec-desc">{desc}</div>}
          </div>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}

export type Stat = { k: ReactNode; v: number | string; suffix?: string; decimals?: number; x?: ReactNode };

/** 统计条：竖线分隔的指标行 */
export function StatRow({ items }: { items: Stat[] }) {
  const enter = useEnter();
  return (
    <div className="statrow">
      {items.map((s, i) => (
        <div key={i} {...enter({ delay: stagger(i, 0.06) })}>
          <div className="stat-v">
            {typeof s.v === 'number' ? <CountUp to={s.v} decimals={s.decimals ?? 0} /> : s.v}
            {s.suffix?.trim() && <span className="stat-unit">{s.suffix.trim()}</span>}
          </div>
          <div className="stat-k">{s.k}</div>
          <div className="stat-x">{s.x}</div>
        </div>
      ))}
    </div>
  );
}

/** 行式列表项 */
export function Row({
  avatar, title, desc, extra, onClick, index = 0, className,
}: {
  avatar?: ReactNode; title: ReactNode; desc?: ReactNode; extra?: ReactNode;
  onClick?: () => void; index?: number; className?: string;
}) {
  const enter = useEnter();
  const classes = cn(
    'rowline group',
    index === 0 && !onClick && 'pt-0',
    onClick && 'rowline-hover w-full cursor-pointer border-x-0 border-t-0 bg-transparent text-left',
    className,
  );
  const content = (
    <>
      {avatar}
      <div className="rowline-main">
        <div className="rowline-t">{title}</div>
        {desc && <div className="rowline-d">{desc}</div>}
      </div>
      {extra && <div className="rowline-x">{extra}</div>}
    </>
  );
  const animate = enter({ delay: stagger(index), y: NUDGE, duration: DUR.fast });

  if (onClick) {
    return <button type="button" className={classes} onClick={onClick} {...animate}>{content}</button>;
  }
  return <div className={classes} {...animate}>{content}</div>;
}

/** 两栏分区（中间竖细线） */
export function Split({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="split2">
      <div className="pane">{left}</div>
      <div className="vline" />
      <div className="pane">{right}</div>
    </div>
  );
}

/** 页面大标题（编辑式排版，shadcn 版专有） */
export function PageTitle({ title, sub, extra }: { title: string; sub?: ReactNode; extra?: ReactNode }) {
  const enter = useEnter();
  return (
    <div className="flex flex-wrap items-end justify-between gap-6 pt-12 pb-2" {...enter()}>
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {extra}
    </div>
  );
}

/** 分栏标题：结构固定为「微标签 + 说明 + 右侧操作」，保证 Split 左右两栏内容起始线对齐 */
export function PaneHead({
  title, desc, extra,
}: { title: ReactNode; desc: ReactNode; extra?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="sec-title">{title}</h3>
        <div className="pane-desc">{desc}</div>
      </div>
      {/* 右侧操作放进和标题同高（20px）的一行里垂直居中：按钮比标题行高，顶对齐时文字会比标题低半截 */}
      {extra && <div className="flex h-5 shrink-0 items-center">{extra}</div>}
    </div>
  );
}

/**
 * 翻页条：「第 2 / 5 页」+ 上一页 / 下一页。公告与返佣明细共用。
 * 只有一页时不渲染。
 */
export function Pager({
  page, pages, onChange, disabled, meta,
}: { page: number; pages: number; onChange: (p: number) => void; disabled?: boolean; meta?: ReactNode }) {
  const tr = useT();
  const tp = useTp();
  if (pages <= 1) return null;
  return (
    <div className="mt-6 flex items-center justify-between">
      <span className="text-[12.5px] text-muted-foreground">
        {meta ?? tp('第 {a} / {b} 页', { a: page, b: pages })}
      </span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={disabled || page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft className="size-3.5" />{tr('上一页')}
        </Button>
        <Button variant="outline" size="sm" disabled={disabled || page >= pages} onClick={() => onChange(page + 1)}>
          {tr('下一页')}<ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
