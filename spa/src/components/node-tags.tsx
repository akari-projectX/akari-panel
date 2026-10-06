import { cn } from '@/lib/utils';
import { sortTags } from '@/lib/node';

/**
 * 节点的线路标签（CN2 GIA、IPLC、流媒体解锁……），画成一排小描边标签。
 * 节点页的「线路」列和仪表盘的节点行共用。没有标签时什么都不画，由调用方决定要不要放占位。
 */
export default function NodeTags({ tags, className }: { tags?: string[] | null; className?: string }) {
  const list = sortTags(tags);
  if (!list.length) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1.5', className)}>
      {list.map((t) => (
        <span
          key={t}
          className="inline-flex h-[18px] items-center rounded-[5px] border border-border px-1.5 text-[11px] font-medium tracking-[.01em] whitespace-nowrap text-muted-foreground"
        >
          {t}
        </span>
      ))}
    </span>
  );
}
