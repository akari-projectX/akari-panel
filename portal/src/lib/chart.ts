/*
 * 流量图（仪表盘的平滑面积图，样稿 design/portal-v2-2026-10/chart.js）的纯函数：纵轴的单位与刻度、平滑曲线的路径。
 * 画图本身在 components/dash/TrafficChart.svelte（手写 SVG，不用图表库）。
 */

const UNITS = [
  { unit: 'GB', size: 1024 ** 3 },
  { unit: 'MB', size: 1024 ** 2 },
  { unit: 'KB', size: 1024 },
] as const;

const STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10];

export type Axis = { unit: string; size: number; ticks: [number, number, number]; top: number };

/**
 * 纵轴：按最大一天选单位（≥ 1 GB 用 GB，否则 MB / KB），三条细线 0 / 一半 / 顶（样稿的 0 / 6 / 12）。
 * 一半取 STEPS × 10ⁿ 里不小于最大值一半的那个整齐数，顶 = 它的两倍，所以顶线不低于最大值，也不会空出太多。
 * 最大值为 0 时给一条 0–1 的空轴（单位 KB）。
 */
export function chartAxis(maxBytes: number): Axis {
  const u = UNITS.find((x) => maxBytes >= x.size) ?? UNITS[UNITS.length - 1];
  const max = maxBytes > 0 ? maxBytes / u.size : 1;
  const raw = max / 2;
  const p = 10 ** Math.floor(Math.log10(raw));
  const half = STEPS.map((m) => +(m * p).toPrecision(6)).find((v) => v >= raw - 1e-9) ?? 10 * p;
  const top = +(half * 2).toPrecision(6);
  return { unit: u.unit, size: u.size, ticks: [0, half, top], top };
}

/** 轴单位下的数值（图上的标签）：≥ 100 取整，否则最多一位小数 */
export function inUnit(bytes: number, size: number): string {
  const v = bytes / size;
  return v >= 100 || v === 0 ? String(Math.round(v)) : String(+v.toFixed(1));
}

/**
 * 穿过各点的平滑曲线（SVG path d）：相邻两点之间一段三次贝塞尔，两个控制点在两点的水平中线上、各自与端点同高。
 * 切线在每个点上是水平的，所以曲线不会冲出相邻两点的高度范围（不会画出负的流量）。
 */
export function smoothPath(points: readonly (readonly [number, number])[]): string {
  if (points.length === 0) return '';
  const f = (n: number) => +n.toFixed(2);
  let d = `M${f(points[0][0])},${f(points[0][1])}`;
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const cx = f((x0 + x1) / 2);
    d += ` C${cx},${f(y0)} ${cx},${f(y1)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

/**
 * 横轴哪些日子写标签：7 天每天都写；更长的范围每隔 step 天写一个，从今天（最后一天）往前数，今天总在。
 */
export function labelled(count: number, step: number): boolean[] {
  return Array.from({ length: count }, (_, i) => (count - 1 - i) % Math.max(1, step) === 0);
}
