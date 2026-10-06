import type { ReactNode } from 'react';
import { AlertCircle, Inbox, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sk } from '@/components/loading';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * 区块级的三种状态：在加载、加载失败、没有数据。
 *
 * 和 ErrorScreen 的分工：那个是**整页**塌掉时的样子，
 * 这三个只占一个区块，页面其余部分照常可用——
 * 节点列表拉不到不该让仪表盘上的流量图也跟着消失。
 */

/**
 * 区块加载中：画几行和列表行同样高的骨架，而不是转一个菊花。
 * 菊花只占一小块高度，数据一到区块猛地撑开，整页跟着往下跳；
 * 骨架和真实内容差不多高，数据到了只是「填进去」。
 * block 用在图表这类整块区域上，height 给和真实图表一样的高度。
 */
export function Loading({
  className, label, rows = 3, block,
}: { className?: string; label?: string; rows?: number; block?: number }) {
  const tr = useT();
  return (
    <div aria-busy className={cn('load-in py-1', className)}>
      <span className="sr-only">{tr(label ?? '加载中')}</span>
      {block ? (
        <Sk className="block w-full rounded-xl" style={{ height: block }} />
      ) : (
        Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border py-4 last:border-b-0">
            <Sk className="size-7 shrink-0 rounded-full" d={i * 0.05} />
            <div className="flex min-w-0 grow flex-col gap-2">
              <Sk className="h-[13px]" style={{ width: `${58 - i * 9}%` }} d={0.02 + i * 0.05} />
              <Sk className="h-[11px]" style={{ width: `${36 - i * 5}%` }} d={0.04 + i * 0.05} />
            </div>
            <Sk className="hidden h-[13px] w-[64px] shrink-0 sm:block" d={0.06 + i * 0.05} />
          </div>
        ))
      )}
    </div>
  );
}

export function LoadError({
  error, onRetry, className,
}: { error?: Error; onRetry?: () => void; className?: string }) {
  const tr = useT();
  return (
    <div className={cn('state-in flex flex-col items-center justify-center gap-4 py-14 text-center', className)}>
      <AlertCircle className="size-6 text-faint" />
      <div>
        <p className="text-sm font-medium">{tr('这一块没能加载出来')}</p>
        {/* 后端的报错信息本身就是给用户看的中文，原样呈现比换成套话有用 */}
        <p className="mt-1.5 max-w-[46ch] text-[12.5px] leading-[1.8] text-muted-foreground">
          {error?.message || tr('请稍后重试。')}
        </p>
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw className="size-3.5" />{tr('重试')}
        </Button>
      )}
    </div>
  );
}

export function Empty({
  title = '这里还没有内容', desc, action, className,
}: { title?: string; desc?: string; action?: ReactNode; className?: string }) {
  const tr = useT();
  return (
    <div className={cn('state-in flex flex-col items-center justify-center gap-3.5 py-16 text-center', className)}>
      <Inbox className="size-6 text-faint" />
      <div>
        <p className="text-sm font-medium">{tr(title)}</p>
        {desc && <p className="mt-1.5 max-w-[44ch] text-[12.5px] leading-[1.8] text-muted-foreground">{tr(desc)}</p>}
      </div>
      {action}
    </div>
  );
}
