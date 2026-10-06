import type { MyTraffic } from '@/api';
import { fillDays, formatMonthDay, toGB } from '@/lib/format';

/** 图表与明细表用的一天：GB，保留两位小数 */
export type TrafficDay = { date: string; day: string; up: number; down: number; billed: number };

const gb = (b: number) => +toGB(b).toFixed(2);

/**
 * GET /me/traffic 的按天明细 → 图表数据。面板只给有流量的日子，这里补齐 [from, to] 的每一天。
 * 日子是全站时区的日历日（面板已经按它切好），前端不再换算时区。
 */
export function trafficDays(t: MyTraffic | undefined): TrafficDay[] {
  if (!t) return [];
  return fillDays(t.days, t.from, t.to, { up_bytes: 0, down_bytes: 0, billed_bytes: 0 }).map((d) => ({
    day: d.day,
    date: formatMonthDay(d.day),
    up: gb(d.up_bytes),
    down: gb(d.down_bytes),
    billed: gb(d.billed_bytes),
  }));
}

/**
 * 按节点汇总（原始流量 GB，从多到少）。name 为 null 的是隐藏或已删除的节点，合成一项。
 * rate 是这段时间的有效倍率：计费 ÷ 原始（D9 分时段倍率之后同一节点不同时段倍率不同，只能这样算）。
 */
export function trafficByNode(t: MyTraffic | undefined, other: string) {
  return (t?.nodes ?? [])
    .map((n) => {
      const raw = n.up_bytes + n.down_bytes;
      return { name: n.name ?? other, value: gb(raw), billed: gb(n.billed_bytes), rate: raw > 0 ? +(n.billed_bytes / raw).toFixed(2) : null };
    })
    .filter((n) => n.value > 0)
    .sort((a, b) => b.value - a.value);
}
