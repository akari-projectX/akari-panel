import { useEffect, useMemo, useState } from 'react';
import { orderApi, ticketApi } from '@/api';
import { useApi } from '@/hooks/use-api';
import { useAuth } from '@/lib/auth';
import { useBootOut } from '@/lib/boot';
import { K } from '@/lib/cache';
import { daysLeft, trafficUsage } from '@/lib/format';
import { useT, useTp } from '@/i18n';

/** 页头卡片的外壳（DropdownMenuContent 的类名），见 components/account-card */
export const CARD = 'w-[292px] rounded-2xl p-0 shadow-[0_24px_48px_-20px_rgba(13,21,38,.35)]';

/** 账号的「那根线」：剩余流量占总量的比例（不限流量、没有套餐时不画） */
export function useAccountLine() {
  const { me, plan } = useAuth();
  const usage = trafficUsage(plan?.traffic_used_bytes ?? me?.traffic_used_bytes, plan?.traffic_limit_bytes ?? me?.traffic_limit_bytes ?? null);
  const has = !!plan?.plan && !usage.unlimited && usage.total > 0;
  return {
    email: me?.email ?? '',
    plan: plan?.plan?.name,
    days: daysLeft(plan?.expires_at ?? me?.expires_at),
    usage,
    has,
    value: has ? Math.round(usage.leftPct) : 0,
    tone: has && usage.leftPct < 10 ? ('warn' as const) : undefined,
  };
}

/**
 * 「有事等你」：工单有客服的新回复（面板记的未读）、或者有待支付的订单。
 * 页头那两根线的末尾会多一个小圆点，卡片里对应的那一行也标出来。
 *
 * 两个列表都要等启动画面收起之后才取：它们不是首屏内容，不该拖住启动画面（见 lib/boot 的 soft hold）。
 * 被封禁的账户看不了订单（面板答 403），只取工单。
 */
export function useAttention(enabled: boolean) {
  const out = useBootOut();
  const { scope } = useAuth();
  const canOrders = enabled && (scope === 'full' || scope === 'renewal');
  const canTickets = enabled && !!scope;
  const orders = useApi(() => orderApi.list(), [], { key: K.orders, enabled: canOrders && out });
  const tickets = useApi(() => ticketApi.list(), [], { key: K.tickets, enabled: canTickets && out });
  return useMemo(() => {
    const pending = canOrders ? (orders.data ?? []).filter((o) => o.status === 'pending').length : 0;
    const list = canTickets ? tickets.data ?? [] : [];
    const replied = list.filter((t) => t.unread && t.status !== 'closed').length;
    const openTickets = list.filter((t) => t.status !== 'closed').length;
    return { orders: pending, openTickets, replied, dot: replied > 0 || pending > 0 };
  }, [canOrders, canTickets, orders.data, tickets.data]);
}
export type Attention = ReturnType<typeof useAttention>;

/** 按钮的读屏名字：说出那根线、那个圆点是什么意思 */
export function useLinesLabel(att: Attention | null) {
  const tr = useT();
  const tp = useTp();
  const a = useAccountLine();
  if (!att) return tr('打开菜单');
  if (att.replied > 0) return tp('菜单，{n} 张工单有新回复', { n: att.replied });
  if (att.orders > 0) return tr('菜单，有待支付的订单');
  return a.has ? tp('菜单，剩余流量 {n}%', { n: a.value }) : tr('打开菜单');
}

/**
 * 下面那根线「进来时画一次」：登录后第一次看到页头，从 0 画到当前值，
 * 同一次访问只画一次——动这一下，是告诉你它不是装饰。等启动画面收起再画，不然画在启动画面底下白画。
 */
export function useIntroOnce(enabled: boolean) {
  const out = useBootOut();
  const [pending] = useState(() => {
    try { return !sessionStorage.getItem('akari.line-drawn'); } catch { return false; }
  });
  const intro = pending && enabled && out;
  useEffect(() => {
    if (intro) try { sessionStorage.setItem('akari.line-drawn', '1'); } catch { /* 隐私模式 */ }
  }, [intro]);
  return intro;
}

