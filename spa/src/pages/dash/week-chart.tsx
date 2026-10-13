import { useMemo, useState } from 'react';
import { formatBytes } from '@/lib/format';
import { weekAxis, type TrafficDay } from '@/lib/traffic';
import { useLocale, useT, useTp } from '@/i18n';
import { cn } from '@/lib/utils';

/*
 * 仪表盘「近 7 日流量趋势」（2026-10-13 改版）：每天一根柱子，下行在下、上行叠在上面，柱顶写当天合计。
 *
 *   · 纵轴有刻度和单位：按最大一天自动选 GB / MB / KB（lib/traffic 的 weekAxis），刻度是整齐的步长。
 *   · 横轴每天两行：星期 + 月-日；最后一天是今天（全站时区的日历日，面板已经按它切好），写「今天」。
 *   · 悬停（鼠标）或点按（手机）一天出提示：日期、下行、上行、合计、计费。键盘可以 Tab 到每一天。
 *   · 纯 HTML/CSS 画，不用图表库：以前的 recharts 分包 gzip 后约 109 kB，仪表盘要单独等它；现在随仪表盘一起到，没有动画。
 */

type Props = { week: TrafficDay[] };

/** 只用于显示：轴单位下的数值，最多一位小数 */
const inUnit = (bytes: number, size: number) => {
  const v = bytes / size;
  return v >= 100 || v === 0 ? Math.round(v).toString() : (+v.toFixed(1)).toString();
};

export default function WeekChart({ week }: Props) {
  const tr = useT();
  const tp = useTp();
  const { locale } = useLocale();
  const [active, setActive] = useState<number | null>(null);

  const max = Math.max(0, ...week.map((d) => d.upBytes + d.downBytes));
  const axis = useMemo(() => weekAxis(max), [max]);
  const top = axis.top * axis.size;
  const pct = (b: number) => (top > 0 ? (b / top) * 100 : 0);

  /* 日子是 YYYY-MM-DD 的日历日：按 UTC 取星期，不再换算时区 */
  const weekday = useMemo(
    () => new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', { weekday: 'short', timeZone: 'UTC' }),
    [locale],
  );
  const dayName = (d: TrafficDay, i: number) =>
    i === week.length - 1 ? tr('今天') : weekday.format(new Date(`${d.day}T00:00:00Z`));

  const tip = active !== null ? week[active] : null;
  const n = week.length;

  return (
    <div className="wk" onPointerLeave={(e) => { if (e.pointerType === 'mouse') setActive(null); }}>
      <div className="wk-legend" aria-hidden>
        <span><i className="wk-key is-down" />{tr('下行')}</span>
        <span><i className="wk-key is-up" />{tr('上行')}</span>
        <span className="wk-unit">{tp('单位 {u}', { u: axis.unit })}</span>
      </div>

      <div className="wk-body">
        {/* 纵轴刻度（只给视觉；读屏读每一天的说明） */}
        <div className="wk-y" aria-hidden>
          {axis.ticks.map((t) => (
            <span key={t} style={{ bottom: `${(t / axis.top) * 100}%` }}>{t}</span>
          ))}
        </div>

        <div className="wk-plot">
          {axis.ticks.map((t) => (
            <i key={t} className={cn('wk-grid', t === 0 && 'is-base')} style={{ bottom: `${(t / axis.top) * 100}%` }} />
          ))}

          <div className="wk-cols" role="group" aria-label={tr('近 7 日流量，每天一项')}>
            {week.map((d, i) => {
              const total = d.upBytes + d.downBytes;
              const on = active === i;
              return (
                <button
                  key={d.day} type="button"
                  className="wk-col" data-active={on || undefined}
                  aria-label={tp('{d}：下行 {down}，上行 {up}，合计 {total}', {
                    d: `${dayName(d, i)} ${d.date}`, down: formatBytes(d.downBytes), up: formatBytes(d.upBytes), total: formatBytes(total),
                  })}
                  aria-pressed={on}
                  onPointerEnter={(e) => { if (e.pointerType === 'mouse') setActive(i); }}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive((a) => (a === i ? null : a))}
                  onClick={() => setActive(i)}
                >
                  <span className="wk-stack" style={{ height: `${pct(total)}%` }}>
                    {total > 0 && <small className="wk-total">{inUnit(total, axis.size)}</small>}
                    {d.upBytes > 0 && <span className="wk-bar is-up" style={{ flexGrow: d.upBytes }} />}
                    {d.downBytes > 0 && <span className="wk-bar is-down" style={{ flexGrow: d.downBytes }} />}
                  </span>
                </button>
              );
            })}
          </div>

          {tip && active !== null && (
            <div
              className="wk-tip" role="status"
              data-edge={active === 0 ? 'start' : active === n - 1 ? 'end' : undefined}
              style={{ left: `${((active + 0.5) / n) * 100}%` }}
            >
              <div className="wk-tip-h">{dayName(tip, active)} · {tip.date}</div>
              <dl>
                <div><dt><i className="wk-key is-down" />{tr('下行')}</dt><dd>{formatBytes(tip.downBytes)}</dd></div>
                <div><dt><i className="wk-key is-up" />{tr('上行')}</dt><dd>{formatBytes(tip.upBytes)}</dd></div>
                <div className="is-sum"><dt>{tr('合计')}</dt><dd>{formatBytes(tip.upBytes + tip.downBytes)}</dd></div>
                <div><dt>{tr('计费')}</dt><dd>{formatBytes(tip.billedBytes)}</dd></div>
              </dl>
            </div>
          )}
        </div>
      </div>

      <div className="wk-x" aria-hidden>
        {week.map((d, i) => (
          <span key={d.day} className={cn(i === n - 1 && 'is-today', active === i && 'is-active')}>
            <b>{dayName(d, i)}</b>
            <span>{d.date}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
