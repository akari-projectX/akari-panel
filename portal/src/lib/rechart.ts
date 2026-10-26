/*
 * 用量页三张图（面积 / 柱 / 环）的几何：复刻 v1.4.0 里 recharts 的取整刻度、monotone 曲线与「首尾保留」的横轴标签间隔。
 * 画图在 components/charts/*.svelte（手写 SVG，不用图表库）。
 */

/** 纵轴刻度（recharts 的 getNiceTickValues，tickCount = 5）：0 起、等步长、顶 ≥ 最大值 */
export function niceTicks(max: number, count = 5): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / (count - 1);
  const digits = Math.floor(Math.log10(rough)) + 1;
  const unit = 10 ** digits;
  const scale = digits !== 1 ? 0.05 : 0.1;
  const step = +(Math.ceil(rough / unit / scale - 1e-9) * scale * unit).toPrecision(12);
  const out = [0];
  while (out.length < count || out[out.length - 1] < max - 1e-9) out.push(+(out[out.length - 1] + step).toPrecision(12));
  return out;
}

const sign = (v: number) => (v < 0 ? -1 : 1);

/** d3 的 curveMonotoneX：穿过各点、不过冲的平滑曲线（SVG path d） */
export function monotonePath(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length;
  const f = (v: number) => +v.toFixed(2);
  if (n === 0) return '';
  if (n === 1) return `M${f(pts[0][0])},${f(pts[0][1])}`;
  const x = pts.map((p) => p[0]);
  const y = pts.map((p) => p[1]);
  const slope3 = (i: number) => {
    const h0 = x[i] - x[i - 1];
    const h1 = x[i + 1] - x[i];
    const s0 = (y[i] - y[i - 1]) / h0;
    const s1 = (y[i + 1] - y[i]) / h1;
    const p = (s0 * h1 + s1 * h0) / (h0 + h1);
    return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  };
  const slope2 = (i: number, t: number) => {
    const h = x[i] - x[i - 1];
    return h ? ((3 * (y[i] - y[i - 1])) / h - t) / 2 : t;
  };
  const t: number[] = Array.from({ length: n }, () => 0);
  for (let i = 1; i < n - 1; i++) t[i] = slope3(i);
  if (n === 2) { t[0] = t[1] = (y[1] - y[0]) / (x[1] - x[0] || 1); } else {
    t[0] = slope2(1, t[1]);
    t[n - 1] = slope2(n - 1, t[n - 2]);
  }
  let d = `M${f(x[0])},${f(y[0])}`;
  for (let i = 1; i < n; i++) {
    const dx = (x[i] - x[i - 1]) / 3;
    d += ` C${f(x[i - 1] + dx)},${f(y[i - 1] + dx * t[i - 1])} ${f(x[i] - dx)},${f(y[i] - dx * t[i])} ${f(x[i])},${f(y[i])}`;
  }
  return d;
}

/** 横轴标签：preserveEnd，从最后一个往前每隔 step 个写一个；step 取让相邻标签留出 minGap 的最小值 */
export function tickMask(count: number, spacing: number, labelW: number, minGap = 18): boolean[] {
  const step = spacing > 0 ? Math.max(1, Math.ceil((labelW + minGap) / spacing)) : count;
  return Array.from({ length: count }, (_, i) => (count - 1 - i) % step === 0);
}

/** 环形的一段：角度从 12 点钟起顺时针（度），内外半径；返回 path d */
export function sector(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => {
    const rad = ((90 - a) * Math.PI) / 180;
    return [+(cx + r * Math.cos(rad)).toFixed(2), +(cy - r * Math.sin(rad)).toFixed(2)] as const;
  };
  const big = a1 - a0 > 180 ? 1 : 0;
  const [x0, y0] = p(r1, a0);
  const [x1, y1] = p(r1, a1);
  const [x2, y2] = p(r0, a1);
  const [x3, y3] = p(r0, a0);
  return `M${x0},${y0} A${r1},${r1} 0 ${big} 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 ${big} 0 ${x3},${y3} Z`;
}
