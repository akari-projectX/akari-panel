import { useMemo } from 'react';
import { orderApi } from '@/api';
import { useApi } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { K } from '@/lib/cache';

/**
 * 当前用户待支付的订单。有这样一笔订单时面板会拒绝再下新单（order.in_progress），
 * 所以仪表盘、商店都要把它亮出来，下单弹窗也要先认出它。订单列表和订单页共用同一个缓存键。
 */
export function useOpenOrder() {
  const { scope } = useAuth();
  const enabled = scope === 'full' || scope === 'renewal';
  const orders = useApi(() => orderApi.list(), [], { key: K.orders, enabled });
  const open = useMemo(() => (orders.data ?? []).find((o) => o.status === 'pending') ?? null, [orders.data]);
  return { order: enabled ? open : null, reload: orders.reload };
}
