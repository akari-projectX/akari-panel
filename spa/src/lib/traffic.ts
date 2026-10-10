import type { MyTraffic, RateRule } from '@/api';
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
 * 按入口汇总（原始流量 GB，从多到少）：线路名 =「入口 · 标签…」（不显示节点、服务器名；同名的加 #2），
 * name 为 null 的是隐藏或已删除的线路，合成一项。
 * rate 是此刻生效的倍率（面板按 D9 时段规则算好），不是计费 ÷ 原始——同一节点的直连与中转倍率不同，混在一起的比值没有意义。
 */
export function trafficByEntrance(t: MyTraffic | undefined, other: string) {
  const seen = new Map<string, number>();
  return (t?.entrances ?? [])
    .map((n) => ({
      name: n.name === null ? other : unique(seen, [n.name, ...n.tags].join(' · ')),
      value: gb(n.up_bytes + n.down_bytes),
      billed: gb(n.billed_bytes),
      rate: n.rate,
      rules: n.rules,
    }))
    .filter((n) => n.value > 0)
    .sort((a, b) => b.value - a.value);
}

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** 一条时段规则的说明：「工作日 20:00–24:00 ×2」；t 是翻译函数（星期名走词典） */
export function ruleText(r: RateRule, t: (s: string) => string): string {
  const d = [...r.weekdays].sort((a, b) => a - b).join(',');
  const days = d === '1,2,3,4,5,6,7' ? t('每天') : d === '1,2,3,4,5' ? t('工作日') : d === '6,7' ? t('周末')
    : r.weekdays.map((w) => t(WEEKDAYS[w - 1])).join(' ');
  const end = r.end === 1440 || r.end === 0 ? '24:00' : hhmm(r.end);
  return `${days} ${hhmm(r.start)}–${end} ×${r.rate}`;
}

/** 线路名在图表与表格里当键用：重名的依次加 #2、#3（与订阅里同名线路的写法一致） */
function unique(seen: Map<string, number>, name: string): string {
  const n = (seen.get(name) ?? 0) + 1;
  seen.set(name, n);
  return n === 1 ? name : `${name} #${n}`;
}
