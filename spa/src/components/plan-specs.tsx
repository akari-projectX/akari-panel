import type { ComponentType } from 'react';
import { Gauge, RotateCw, Zap } from 'lucide-react';
import type { ShopPlan } from '@/api';
import { formatBytes, resetPeriodText } from '@/lib/format';
import { useT, useTp } from '@/i18n';
import { cn } from '@/lib/utils';

type Spec = { icon: ComponentType<{ className?: string }>; value: string; unit?: string };

/**
 * 套餐的硬指标：流量、速率，外加流量重置周期。
 * 设备数不显示（低-9）：面板不执行设备限制，席位绑定随 akari-client 做。
 */
export default function PlanSpecs({
  plan, className, showReset = true,
}: {
  plan: Pick<ShopPlan, 'traffic_quota_bytes' | 'speed_limit_mbps' | 'period'>;
  className?: string;
  showReset?: boolean;
}) {
  const tr = useT();
  const tp = useTp();
  const specs: Spec[] = [
    plan.traffic_quota_bytes != null
      ? { icon: Gauge, value: formatBytes(plan.traffic_quota_bytes), unit: tr('流量') }
      : { icon: Gauge, value: tr('不限流量') },
    plan.speed_limit_mbps
      ? { icon: Zap, value: `${plan.speed_limit_mbps} Mbps` }
      : { icon: Zap, value: tr('不限速') },
  ];

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        {specs.map(({ icon: Icon, value, unit }, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Icon className="size-3.5 shrink-0 text-brand" />
            <span className="tnum text-body">{unit ? `${value} ${unit}` : value}</span>
          </span>
        ))}
      </div>
      {showReset && plan.traffic_quota_bytes != null && (
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <RotateCw className="size-3 shrink-0" />{resetPeriodText(plan.period, tr, tp)}
        </div>
      )}
    </div>
  );
}
