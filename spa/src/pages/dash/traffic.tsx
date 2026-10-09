import { useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis,
} from 'recharts';
import { ArrowDown, ArrowUp, CloudDownload, PieChart as PieIcon } from 'lucide-react';
import { DUR, useEnter } from '@/lib/motion';
import { Badge } from '@/components/ui/badge';
import {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageTitle, PaneHead, Section, Split, StatRow } from '@/components/flat';
import { Empty, LoadError } from '@/components/data-state';
import { DashSkeleton } from '@/components/loading';
import { meApi } from '@/api';
import { useApi } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { useAuth } from '@/lib/auth';
import { addDays, daysLeft, formatDate, monthStart, siteToday, toGB, trafficUsage } from '@/lib/format';
import { ruleText, trafficByEntrance, trafficDays } from '@/lib/traffic';
import { useT, useTp } from '@/i18n';

const COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

/* 图例与提示框读的是这里的 label，得跟着语言走，所以在组件里按当前语言组装 */
const CFG = (tr: (s: string) => string) => ({
  down: { label: tr('下行流量'), color: 'var(--chart-1)' },
  up: { label: tr('上行流量'), color: 'var(--chart-2)' },
}) satisfies ChartConfig;

const BILLED_CFG = (tr: (s: string) => string) =>
  ({ billed: { label: tr('计费流量'), color: 'var(--chart-1)' } }) satisfies ChartConfig;

/** 范围：本月（默认，全站时区的自然月）、近 7 天、近 30 天 */
type Range = 'month' | '7' | '30';
function rangeOf(r: Range): { from: string; to: string } {
  const to = siteToday();
  if (r === 'month') return { from: monthStart(), to };
  return { from: addDays(to, -(Number(r) - 1)), to };
}

export default function Traffic() {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const { me, plan } = useAuth();
  const [range, setRange] = useState<Range>('month');
  const { from, to } = rangeOf(range);

  /* 日界按全站时区（面板 Q3），接口返回的 timezone 就是它 */
  const logs = useApi(() => meApi.traffic(from, to), [from, to], { key: K.traffic(from, to), keepPrevious: true });
  const data = useMemo(() => trafficDays(logs.data), [logs.data]);
  const rates = useMemo(() => trafficByEntrance(logs.data, tr('其他（已隐藏或删除的线路）')), [logs.data, tr]);

  const cfg = useMemo(() => CFG(tr), [tr]);
  const billedCfg = useMemo(() => BILLED_CFG(tr), [tr]);
  const pieCfg = useMemo(
    () => Object.fromEntries(rates.map((n, i) => [n.name, { label: n.name, color: COLORS[i % COLORS.length] }])) as ChartConfig,
    [rates],
  );

  const { totalDown, totalUp, maxDay } = useMemo(() => ({
    totalDown: data.reduce((n, d) => n + d.down, 0),
    totalUp: data.reduce((n, d) => n + d.up, 0),
    maxDay: Math.max(1, ...data.map((d) => d.down + d.up)),
  }), [data]);

  const usage = trafficUsage(plan?.traffic_used_bytes ?? me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? null);
  const nextReset = plan?.plan?.next_reset_at ?? null;
  const resetIn = daysLeft(nextReset);
  const days = data.length;
  const sum = totalDown + totalUp;
  const billed = toGB(logs.data?.total.billed_bytes);
  const any = sum > 0;

  if (logs.loading && !logs.data) return <DashSkeleton hold={false} />;
  if (logs.error && !logs.data) return <LoadError error={logs.error} onRetry={logs.reload} className="py-32" />;

  return (
    <>
      <PageTitle
        title={tr('使用明细')}
        sub={logs.data ? tp('上下行流量走势、线路分布与每日用量。日期按 {tz} 计算。', { tz: logs.data.timezone }) : tr('上下行流量走势、线路分布与每日用量。')}
      />

      <Section>
        <StatRow
          items={[
            {
              k: tr('套餐已用流量'), v: usage.used, decimals: 1,
              suffix: !usage.unlimited ? ` / ${Math.round(usage.total)} GB` : ' GB',
              x: !usage.unlimited ? <Progress value={usage.usedPct} className="h-1" /> : tr('套餐不限流量'),
            },
            {
              k: tr('下行'), v: totalDown, decimals: 1, suffix: ' GB',
              x: (
                <span className="flex items-center gap-1">
                  <ArrowDown className="size-3 text-brand" />
                  {tr('占总流量')} {sum > 0 ? ((totalDown / sum) * 100).toFixed(0) : 0}%
                </span>
              ),
            },
            {
              k: tr('上行'), v: totalUp, decimals: 1, suffix: ' GB',
              x: (
                <span className="flex items-center gap-1">
                  <ArrowUp className="size-3 text-brand-light" />
                  {tr('日均')} {(totalUp / Math.max(1, data.length)).toFixed(1)} GB
                </span>
              ),
            },
            resetIn !== null
              ? {
                  k: tr('距离重置'), v: resetIn, suffix: tr(' 天'),
                  x: tp('{d} 重置，计费 {b} GB', { d: formatDate(nextReset), b: billed.toFixed(1) }),
                }
              : {
                  k: tr('计费流量'), v: billed, decimals: 1, suffix: ' GB',
                  x: tr('（上行 + 下行）× 倍率'),
                },
          ]}
        />
      </Section>

      {logs.data?.daily_since && logs.data.daily_since > from && (
        <p className="mt-4 text-[12.5px] text-muted-foreground">
          {tp('按天的明细只保留到 {d}，更早的日子显示为 0。', { d: logs.data.daily_since })}
        </p>
      )}

      {!any ? (
        <Section title={tr('流量走势')}>
          <Empty title="这段时间还没有流量记录" desc="连接节点并产生流量后，这里会按天统计出来。" />
        </Section>
      ) : (
        <>
          <Section
            title={<><CloudDownload className="size-4 text-brand" />{tr('流量走势')}</>}
            desc={tp('{a} 至 {b}，按天统计', { a: from, b: to })}
            extra={
              <Tabs value={range} onValueChange={(v) => setRange(v as Range)}>
                <TabsList className="h-9">
                  <TabsTrigger value="month">{tr('本月')}</TabsTrigger>
                  <TabsTrigger value="7">{tr('近 7 天')}</TabsTrigger>
                  <TabsTrigger value="30">{tr('近 30 天')}</TabsTrigger>
                </TabsList>
              </Tabs>
            }
          >
            <div key={range} {...enter({ y: 0, duration: DUR.fast })}>
              <ChartContainer config={cfg} className="-mx-2 h-75 w-[calc(100%+16px)]">
                <AreaChart data={data} margin={{ left: -20, right: 10, top: 8 }}>
                  <defs>
                    <linearGradient id="tD" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.38} /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="tU" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.34} /><stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={18} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} />
                  <YAxis tickLine={false} axisLine={false} unit="G" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Area type="monotone" dataKey="down" stroke="var(--chart-1)" strokeWidth={2.2} fill="url(#tD)" animationDuration={900} />
                  <Area type="monotone" dataKey="up" stroke="var(--chart-2)" strokeWidth={2.2} fill="url(#tU)" animationDuration={1200} />
                </AreaChart>
              </ChartContainer>
            </div>
          </Section>

          <Section>
            <Split
              left={
                <>
                  <PaneHead
                    title={<><PieIcon className="size-4 text-brand" />{tr('线路分布')}</>}
                    desc={tr('这段时间的流量落在各条线路上的比例（原始流量）')}
                  />
                  <ChartContainer config={pieCfg} className="h-68 w-full">
                    <PieChart>
                      <Pie data={rates} dataKey="value" nameKey="name" innerRadius={60} outerRadius={94}
                           paddingAngle={3} animationDuration={1000}>
                        {rates.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="none" />)}
                      </Pie>
                      <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                      <ChartLegend content={<ChartLegendContent nameKey="name" />} className="flex-wrap gap-2" />
                    </PieChart>
                  </ChartContainer>
                </>
              }
              right={
                <>
                  <PaneHead
                    title={tr('每日计费流量')}
                    desc={tr('（上行 + 下行）× 倍率，也就是真正扣掉的量')}
                    extra={<span className="text-[12.5px] text-muted-foreground">{tr('单位 GB')}</span>}
                  />
                  <ChartContainer config={billedCfg} className="-mx-2 h-68 w-[calc(100%+16px)]">
                    <BarChart data={data} margin={{ left: -20, top: 8 }}>
                      <CartesianGrid strokeDasharray="4 4" stroke="var(--border)" vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={18} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} />
                      <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} />
                      <ChartTooltip cursor={{ fill: 'rgba(22,119,255,.05)' }} content={<ChartTooltipContent />} />
                      <Bar dataKey="billed" radius={[6, 6, 0, 0]} animationDuration={1000} fill="var(--chart-1)" />
                    </BarChart>
                  </ChartContainer>
                </>
              }
            />
          </Section>

          {rates.length > 0 && (
            <Section title={tr('按线路')} desc={tr('当前倍率是此刻生效的倍率；有时段倍率的线路按全站时区的时段计费')}>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="flat-head hover:bg-transparent">
                      <TableHead className="pl-0">{tr('线路')}</TableHead>
                      <TableHead className="w-32">{tr('原始')}</TableHead>
                      <TableHead className="w-32">{tr('计费')}</TableHead>
                      <TableHead className="w-40 pr-0">{tr('当前倍率')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rates.map((n) => (
                      <TableRow key={n.name} className="hover:bg-brand/[.03]">
                        <TableCell className="pl-0">{n.name}</TableCell>
                        <TableCell className="tnum">{n.value} GB</TableCell>
                        <TableCell className="tnum">{n.billed} GB</TableCell>
                        <TableCell className="tnum pr-0">
                          {n.rate != null ? `×${n.rate}` : '—'}
                          {n.rules.map((x, i) => (
                            <div key={i} className="text-[12px] text-muted-foreground">{ruleText(x, tr)}</div>
                          ))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Section>
          )}

          <Section title={tr('明细记录')} desc={tp('{d} 天的每日上下行流量', { d: days })}>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="flat-head hover:bg-transparent">
                    <TableHead className="w-32 pl-0">{tr('日期')}</TableHead>
                    <TableHead className="w-32">{tr('下行')}</TableHead>
                    <TableHead className="w-32">{tr('上行')}</TableHead>
                    <TableHead className="w-32">{tr('合计')}</TableHead>
                    <TableHead className="w-32">{tr('计费')}</TableHead>
                    <TableHead className="pr-0">{tr('占比')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...data].reverse().map((d) => (
                    <TableRow key={d.day} className="hover:bg-brand/[.03]">
                      <TableCell className="tnum pl-0">{d.day}</TableCell>
                      <TableCell className="tnum">{d.down} GB</TableCell>
                      <TableCell className="tnum">{d.up} GB</TableCell>
                      <TableCell className="tnum font-medium">{(d.down + d.up).toFixed(1)} GB</TableCell>
                      <TableCell className="tnum">{d.billed.toFixed(1)} GB</TableCell>
                      <TableCell className="pr-0">
                        <div className="flex items-center gap-2.5">
                          {/* 条长按当期最大单日归一，与右侧真实占比同向可比 */}
                          <Progress value={((d.down + d.up) / maxDay) * 100} className="h-1.5 max-w-45" />
                          <Badge variant="secondary" className="rounded-full bg-brand/10 text-brand-ink">
                            {sum > 0 ? (((d.down + d.up) / sum) * 100).toFixed(1) : '0.0'}%
                          </Badge>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
