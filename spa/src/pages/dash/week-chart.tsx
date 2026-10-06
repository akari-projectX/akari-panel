import { useMemo } from 'react';
import { Area, AreaChart, ReferenceDot, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import type { TrafficDay } from '@/lib/traffic';
import { useT, useTp } from '@/i18n';

/*
 * 仪表盘「近 7 日流量趋势」那张面积图。
 *
 * 单独成一个按需加载的分包：图表库（recharts 及其依赖）gzip 后 109 kB，
 * 放在仪表盘里静态引用，账户、订阅、节点这些卡片都得等它下完才出来。
 * 现在仪表盘先画别的，图表随后到，占位和图表一样高，页面不跳。
 */

/* 提示框读的是这里的 label，得跟着语言走 */
const CHART_CFG = (tr: (s: string) => string) => ({
  down: { label: tr('下行'), color: 'var(--chart-1)' },
  up: { label: tr('上行'), color: 'var(--chart-2)' },
}) satisfies ChartConfig;

export default function WeekChart({ week }: { week: TrafficDay[] }) {
  const tr = useT();
  const tp = useTp();
  const chartConfig = useMemo(() => CHART_CFG(tr), [tr]);
  const peak = week.length ? week.reduce((a, d) => (d.down > a.down ? d : a), week[0]) : null;
  const last = week.length ? week[week.length - 1] : null;

  return (
    <ChartContainer config={chartConfig} className="h-64 w-full">
      <AreaChart data={week} margin={{ left: 10, right: 12, top: 34, bottom: 0 }}>
        <defs>
          <linearGradient id="gDown" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.28} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.24} />
            <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* 只保留 X 轴刻度，去掉网格与 Y 轴 —— 量级交给峰值标注与悬停 */}
        <XAxis
          dataKey="date" tickLine={false} axisLine={false} dy={8}
          tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
          interval="preserveStartEnd"
        />
        <YAxis hide domain={[0, (max: number) => max * 1.18]} />

        <ChartTooltip
          cursor={{ stroke: 'var(--chart-1)', strokeWidth: 1, strokeDasharray: '4 4', strokeOpacity: 0.45 }}
          content={
            <ChartTooltipContent
              indicator="dot"
              formatter={(value, name) => (
                <div className="flex w-full items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-[2px]"
                    style={{ background: name === 'down' ? 'var(--chart-1)' : 'var(--chart-2)' }}
                  />
                  <span className="text-muted-foreground">{tr(name === 'down' ? '下行' : '上行')}</span>
                  <span className="tnum ml-auto font-medium text-foreground">{value} GB</span>
                </div>
              )}
            />
          }
        />

        <Area
          type="natural" dataKey="down" stroke="var(--chart-1)" strokeWidth={2.2} fill="url(#gDown)"
          animationDuration={1000}
          activeDot={{ r: 4.5, fill: 'var(--chart-1)', stroke: 'var(--background)', strokeWidth: 2 }}
        />
        <Area
          type="natural" dataKey="up" stroke="var(--chart-2)" strokeWidth={1.8} fill="url(#gUp)"
          animationDuration={1200}
          activeDot={{ r: 4, fill: 'var(--chart-2)', stroke: 'var(--background)', strokeWidth: 2 }}
        />

        {/* 峰值标注：让图表说出结论，而不只是画个形状 */}
        {peak && (
          <ReferenceDot
            x={peak.date} y={peak.down} r={4}
            fill="var(--chart-1)" stroke="var(--background)" strokeWidth={2}
            label={{
              value: tp('峰值 {v} GB', { v: peak.down }),
              position: 'top', offset: 12,
              fill: 'var(--foreground)', fontSize: 12, fontWeight: 500,
            }}
          />
        )}
        {last && (
          <ReferenceDot
            x={last.date} y={last.down} r={3}
            fill="var(--background)" stroke="var(--chart-1)" strokeWidth={2}
          />
        )}
      </AreaChart>
    </ChartContainer>
  );
}
