import { type MyNode } from '@/api';
import { LOAD_TEXT, NODES_REFRESH_MS, STATUS_TEXT } from '@/lib/node';
import { cn } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

const DOT = {
  online: 'bg-emerald-500',
  offline: 'bg-muted-foreground/60',
  maintenance: 'bg-amber-500',
} as const;

const LOAD_TONE = {
  low: 'text-success',
  medium: 'text-warning',
  high: 'text-danger',
} as const;

/** 状态：圆点 + 在线 / 离线 / 维护中 */
export function NodeState({ n, className }: { n: Pick<MyNode, 'status'>; className?: string }) {
  const tr = useT();
  return (
    <span
      data-node-status={n.status}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap',
        n.status === 'maintenance' && 'text-warning',
        n.status === 'offline' && 'text-muted-foreground',
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full', DOT[n.status])} />
      {tr(STATUS_TEXT[n.status])}
    </span>
  );
}

/** 负载等级（只在在线且已知时有） */
export function NodeLoad({ n }: { n: Pick<MyNode, 'load'> }) {
  const tr = useT();
  if (!n.load) return null;
  return (
    <span data-node-load={n.load} className={cn('text-[12.5px] whitespace-nowrap', LOAD_TONE[n.load])}>
      {tr(LOAD_TEXT[n.load])}
    </span>
  );
}

/** 图例：三种状态的含义、负载与延迟怎么来的、多久刷新一次 */
export function NodeLegend({ className }: { className?: string }) {
  const tr = useT();
  const tp = useTp();
  return (
    <div data-node-legend className={cn('space-y-1.5 text-[12.5px] leading-[1.7] text-muted-foreground', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <NodeState n={{ status: 'online' }} className="text-[12.5px]" />
        <NodeState n={{ status: 'offline' }} className="text-[12.5px]" />
        <span className="inline-flex items-center gap-1">
          <NodeState n={{ status: 'maintenance' }} className="text-[12.5px]" />
          <span>{tr('（暂停使用，订阅里暂时没有它）')}</span>
        </span>
      </div>
      <p>
        {tr('负载按节点的 CPU 与带宽占用分为低 / 中 / 高；延迟是面板到线路的连接测速，仅供参考。')}
        {tp('每 {n} 秒自动刷新。', { n: NODES_REFRESH_MS / 1000 })}
      </p>
    </div>
  );
}
