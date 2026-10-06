import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DUR, NUDGE, stagger, useEnter } from '@/lib/motion';
import { toast } from '@/lib/toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageTitle, Row, Section, StatRow } from '@/components/flat';
import { Empty, LoadError, Loading } from '@/components/data-state';
import StatusTag from '@/components/status-tag';
import { orderApi, walletApi, type MyOrder } from '@/api';
import { useApi, usePending } from '@/hooks/use-api';
import { K } from '@/lib/cache';
import { useErrorText } from '@/lib/errors';
import { ORDER_ACTION, formatDateTime, formatMoney, orderState, periodText } from '@/lib/format';
import { R } from '@/lib/routes';
import { useT, useTp } from '@/i18n';

/** 分页签：按用户眼里的状态筛（已退款优先于已付款） */
const TABS: { key: string; label: string; test: (o: MyOrder) => boolean }[] = [
  { key: 'all', label: '全部', test: () => true },
  { key: 'pending', label: '待支付', test: (o) => o.status === 'pending' },
  { key: 'paid', label: '已付款', test: (o) => o.status === 'paid' && !o.refunded_at },
  { key: 'refunded', label: '已退款', test: (o) => !!o.refunded_at },
  { key: 'closed', label: '已关闭', test: (o) => o.status === 'expired' || o.status === 'cancelled' },
];

/** 实际付过、没退款的（含余额支付的部分） */
const spent = (o: MyOrder) => (o.status === 'paid' && !o.refunded_at ? o.amount_cents + o.balance_cents : 0);

export default function Orders() {
  const enter = useEnter();
  const tr = useT();
  const tp = useTp();
  const nav = useNavigate();
  const errText = useErrorText();

  const [tab, setTab] = useState('all');
  /* 面板给最近 50 笔，切页签只在前端筛 */
  const orders = useApi(() => orderApi.list(), [], { key: K.orders });
  const balance = useApi(() => walletApi.balance({ limit: 1 }), [], { key: K.balance });
  /* 包一层保持引用稳定，否则下面的 useMemo 每次渲染都要重算 */
  const all = useMemo(() => orders.data ?? [], [orders.data]);
  const [cancelling, runCancel] = usePending();

  const data = useMemo(() => {
    const t = TABS.find((x) => x.key === tab) ?? TABS[0];
    return all.filter(t.test);
  }, [all, tab]);

  const paidTotal = all.reduce((n, o) => n + spent(o), 0);
  const pendingCount = all.filter((o) => o.status === 'pending').length;
  const last = all[0];

  const cancel = (o: MyOrder) => runCancel(async () => {
    try {
      await orderApi.cancel(o.id);
      toast.success(tr('订单已取消'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      orders.reload();
    }
  });
  const typeText = (o: MyOrder) => tr(ORDER_ACTION[o.action]);

  return (
    <>
      <PageTitle title={tr('我的订单')} sub={tr('全部消费记录与支付状态。')} />

      <Section>
        <StatRow
          items={[
            {
              k: tr('累计消费'), v: formatMoney(paidTotal),
              x: tr('已付款、未退款的订单（含余额支付）'),
            },
            {
              k: tr('订单总数'), v: all.length, suffix: tr(' 笔'),
              x: last ? tp('最近一笔 {d}', { d: formatDateTime(last.created_at) }) : tr('还没有下过单'),
            },
            { k: tr('待支付'), v: pendingCount, suffix: tr(' 笔'), x: tr('超时未支付将自动关闭') },
            {
              k: tr('账户余额'), v: balance.data ? formatMoney(balance.data.balance_cents) : '—',
              x: tr('下单时可以选择抵扣'),
            },
          ]}
        />
      </Section>

      <Section title={tr('订单记录')} desc={data.length ? tp('共 {n} 笔订单', { n: data.length }) : undefined}>
        <Tabs value={tab} onValueChange={setTab} className="mb-4.5 inline-flex">
          <TabsList className="h-9">
            {TABS.map((t) => <TabsTrigger key={t.key} value={t.key}>{tr(t.label)}</TabsTrigger>)}
          </TabsList>
        </Tabs>

        {orders.loading && !orders.data ? <Loading />
          : orders.error && !orders.data ? <LoadError error={orders.error} onRetry={orders.reload} />
          : data.length === 0 ? (
            <Empty
              title="这里还没有订单"
              desc="选一个套餐下单后，记录会出现在这里。"
              action={<Button variant="outline" size="sm" onClick={() => nav(R.shop)}>{tr('去选套餐')}</Button>}
            />
          ) : (
            <>
            {/* 窄屏：八列的表放不下，改成一行一笔订单，点整行进详情 */}
            <div className="md:hidden">
              {data.map((o, i) => (
                <Row
                  key={o.id} index={i} onClick={() => nav(R.order(o.id))}
                  title={o.plan_name}
                  desc={[typeText(o), periodText(o.period, o.period_days, tr, tp), formatDateTime(o.created_at)].filter(Boolean).join(' · ')}
                  extra={
                    <span className="flex flex-col items-end gap-1.5">
                      <span className="tnum text-[15px] font-medium">{formatMoney(o.amount_cents)}</span>
                      <StatusTag {...orderState(o)} />
                    </span>
                  }
                />
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow className="flat-head hover:bg-transparent">
                    <TableHead className="min-w-[180px] pl-0">{tr('订单号')}</TableHead>
                    <TableHead className="w-32">{tr('套餐')}</TableHead>
                    <TableHead className="w-28">{tr('类型')}</TableHead>
                    <TableHead className="w-28">{tr('周期')}</TableHead>
                    <TableHead className="w-24">{tr('金额')}</TableHead>
                    <TableHead className="w-24">{tr('状态')}</TableHead>
                    <TableHead className="w-40">{tr('下单时间')}</TableHead>
                    <TableHead className="w-32 pr-0 text-right">{tr('操作')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((o, i) => (
                    <tr
                      key={o.id}
                      {...enter({ delay: stagger(i), y: NUDGE, duration: DUR.fast })}
                      className="border-b transition-colors hover:bg-brand/[.03]"
                    >
                      <TableCell className="pl-0"><code className="text-[12.5px]">{o.out_trade_no}</code></TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="rounded-full bg-brand/10 text-brand-ink">{o.plan_name}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">{typeText(o)}</TableCell>
                      <TableCell className="text-sm">{periodText(o.period, o.period_days, tr, tp)}</TableCell>
                      <TableCell className="tnum font-medium">{formatMoney(o.amount_cents)}</TableCell>
                      <TableCell>
                        <StatusTag {...orderState(o)} />
                      </TableCell>
                      <TableCell className="tnum text-sm text-muted-foreground">{formatDateTime(o.created_at)}</TableCell>
                      <TableCell className="pr-0 text-right">
                        <Button variant="link" size="xs" onClick={() => nav(R.order(o.id))}>
                          {o.status === 'pending' ? tr('去支付') : tr('详情')}
                        </Button>
                        {o.status === 'pending' && (
                          <Button variant="link" size="xs" disabled={cancelling} onClick={() => cancel(o)}>
                            {tr('取消')}
                          </Button>
                        )}
                      </TableCell>
                    </tr>
                  ))}
                </TableBody>
              </Table>
            </div>
            </>
          )}
      </Section>
    </>
  );
}
