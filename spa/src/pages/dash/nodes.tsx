import { useMemo, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { DUR, NUDGE, stagger, useEnter } from '@/lib/motion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageTitle, Row, Section, StatRow } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import Flag from '@/components/flag';
import NodeTags from '@/components/node-tags';
import { NodeLegend, NodeLoad, NodeState } from '@/components/node-status';
import { meApi, type MyNode } from '@/api';
import { useApi } from '@/hooks/use-api';
import { useAutoReload } from '@/hooks/use-auto-reload';
import { useAuth } from '@/lib/auth';
import { K } from '@/lib/cache';
import { NODES_REFRESH_MS, nodeCC, nodeKey, nodeLatency, nodeUp, rateTone, sortTags, stripFlag } from '@/lib/node';
import { formatRate, fromNow } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useT, useTp } from '@/i18n';

/**
 * 可用线路：/me/nodes 每行是「节点 + 入口」（直连或中转），只有名字、入口、地区、标签、倍率、
 * 状态（在线 / 离线 / 维护中）、负载等级、延迟——面板不给 id、地址、协议或机器指标的数字。倍率按入口计（W28-a）；D9 合并后显示此刻的倍率和时段规则（rates 开关）。
 */
export default function Nodes() {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const { me } = useAuth();
  const [kw, setKw] = useState('');
  const [sortAsc, setSortAsc] = useState(true);

  const nodes = useApi(() => meApi.nodes(), [], { key: K.nodes });
  useAutoReload(nodes.reload, NODES_REFRESH_MS);
  const all = useMemo(() => nodes.data ?? [], [nodes.data]);

  const data = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return all
      .filter((n) => !k
        || stripFlag(n.name).toLowerCase().includes(k)
        || n.entrance.toLowerCase().includes(k)
        || (n.region ?? '').toLowerCase().includes(k)
        || n.tags.some((t) => t.toLowerCase().includes(k)))
      /* 默认按倍率升序：对用户来说「哪条最省流量」比「哪条排在前面」有用得多 */
      .sort((a, b) => (sortAsc ? 1 : -1) * (a.rate - b.rate));
  }, [all, kw, sortAsc]);

  const up = all.filter(nodeUp);
  const down = all.length - up.length;
  const cheapest = all.length ? Math.min(...all.map((n) => n.rate)) : 0;
  const lastProbe = all.reduce<string | null>(
    (max, n) => (n.latency_measured_at && (!max || n.latency_measured_at > max) ? n.latency_measured_at : max), null,
  );
  const probeMinutes = me ? Math.max(1, Math.round(me.probe_interval_secs / 60)) : null;

  return (
    <>
      <PageTitle
        title={tr('节点状态')}
        sub={tr('订阅内所有线路的实时状态。倍率越低，同样的流量能用得越久。')}
        extra={
          <Button variant="outline" className="h-9" disabled={nodes.loading} onClick={nodes.reload}>
            <RefreshCw className={cn('size-3.5', nodes.loading && 'animate-spin')} />{tr('刷新')}
          </Button>
        }
      />

      <Section>
        <StatRow
          items={[
            { k: tr('可用线路'), v: up.length, suffix: tr(' 条'), x: tr('可以直接连接') },
            {
              k: tr('不可用'), v: down, suffix: tr(' 条'),
              x: down > 0 ? tr('客户端会自动跳过') : tr('全部线路正常'),
            },
            {
              k: tr('最低倍率'), v: formatRate(cheapest), suffix: '×',
              x: tr('按此刻生效的倍率'),
            },
            {
              k: tr('延迟测速'), v: probeMinutes ?? '—', suffix: probeMinutes ? tr(' 分钟一次') : '',
              x: lastProbe ? tp('最近一次 {t}', { t: fromNow(lastProbe, tp) }) : tr('暂无测速记录'),
            },
          ]}
        />
      </Section>

      <Section
        title={tr('全部线路')}
        desc={data.length ? tp('共 {n} 条线路，点击「倍率」列可切换排序', { n: data.length }) : undefined}
      >
        <NodeLegend className="mb-4" />
        <div className="mb-4.5 md:max-w-[480px]">
          <div className="relative">
            <Search aria-hidden className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input
              aria-label={tr('搜索节点、入口、地区或线路')}
              className="h-9 pl-9" placeholder={tr('搜索节点、入口、地区或线路')}
              value={kw} onChange={(e) => setKw(e.target.value)}
            />
          </div>
        </div>

        {nodes.loading && !nodes.data ? <Loading />
          : nodes.error && !nodes.data ? <LoadError error={nodes.error} onRetry={nodes.reload} />
          : all.length === 0 ? <Empty title="订阅里还没有线路" desc="套餐生效后线路会自动出现。" />
          : data.length === 0 ? <Empty title="没有匹配的线路" desc="换个关键词试试。" />
          : (
            <>
            {/* 窄屏：一行一条线路，左边国旗 + 名称 + 入口，右边倍率 */}
            <div className="md:hidden">
              {data.map((n, i) => {
                const cc = nodeCC(n);
                const ok = nodeUp(n);
                return (
                  <Row
                    key={nodeKey(n)} index={i} className={cn(!ok && 'is-off')}
                    avatar={cc
                      ? <Flag cc={cc} className="h-[15px] w-[22px]" />
                      : <span className="inline-block h-[15px] w-[22px] shrink-0 rounded-[3px] bg-muted" />}
                    title={stripFlag(n.name)}
                    desc={
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate">{[n.entrance, ...sortTags(n.tags)].join(' · ')}</span>
                        <NodeState n={n} />
                        {ok && <NodeLoad n={n} />}
                      </span>
                    }
                    extra={<RateBadge n={n} />}
                  />
                );
              })}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow className="flat-head hover:bg-transparent">
                    <TableHead className="min-w-[200px] pl-0">{tr('节点')}</TableHead>
                    <TableHead className="w-40">{tr('入口')}</TableHead>
                    <TableHead className="w-52">{tr('线路')}</TableHead>
                    <TableHead className="w-28">{tr('延迟')}</TableHead>
                    <TableHead className="w-28" aria-sort={sortAsc ? 'ascending' : 'descending'}>
                      <button type="button" className="inline-flex cursor-pointer items-center gap-1 rounded-sm" onClick={() => setSortAsc((v) => !v)}>
                        {tr('流量倍率')} <span aria-hidden>{sortAsc ? '↑' : '↓'}</span>
                      </button>
                    </TableHead>
                    <TableHead className="w-24 pr-0">{tr('状态')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((n, i) => {
                    const cc = nodeCC(n);
                    return (
                      <tr
                        key={nodeKey(n)}
                        {...enter({ delay: stagger(i), y: NUDGE, duration: DUR.fast })}
                        className={cn('border-b transition-colors hover:bg-brand/[.03]', !nodeUp(n) && 'opacity-55')}
                      >
                        <TableCell className="pl-0">
                          <div className="flex items-center gap-3">
                            {cc
                              ? <Flag cc={cc} className="h-4 w-6" />
                              : <span className="inline-block h-4 w-6 shrink-0 rounded-[3px] bg-muted" />}
                            <div className="min-w-0">
                              <div className="truncate font-medium">{stripFlag(n.name)}</div>
                              {n.region && <div className="text-[12.5px] text-muted-foreground">{n.region}</div>}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-sm">{n.entrance}</TableCell>
                        <TableCell>
                          {n.tags.length ? <NodeTags tags={n.tags} /> : <span className="text-[13px] text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="tnum text-sm">
                          {nodeUp(n) && nodeLatency(n) != null
                            ? `${nodeLatency(n)} ms`
                            : <span className="text-muted-foreground">{tr(n.latency_status === 'timeout' ? '超时' : '—')}</span>}
                        </TableCell>
                        <TableCell><RateBadge n={n} /></TableCell>
                        <TableCell className="pr-0">
                          <span className="flex flex-col gap-0.5">
                            <NodeState n={n} />
                            {nodeUp(n) && <NodeLoad n={n} />}
                          </span>
                        </TableCell>
                      </tr>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            </>
          )}
      </Section>
    </>
  );
}

/** 倍率徽标：此刻生效的倍率（D9 时段倍率由面板按站点时区算好） */
function RateBadge({ n }: { n: MyNode }) {
  return <Badge variant="secondary" className={cn('rounded-full', rateTone(n.rate))}>×{formatRate(n.rate)}</Badge>;
}
