import { Badge } from '@/components/ui/badge';
import { useT } from '@/i18n';
import type { StatusTone } from '@/lib/format';
import { cn } from '@/lib/utils';

/** 领域状态保留各自的文案映射，视觉色调由 Badge 统一。 */
export default function StatusTag({
  text, tone, className,
}: { text: string; tone: StatusTone; className?: string }) {
  const tr = useT();
  return (
    <Badge variant={tone} className={cn('rounded-full', className)}>
      {tr(text)}
    </Badge>
  );
}
