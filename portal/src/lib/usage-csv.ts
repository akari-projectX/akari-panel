import type { TrafficDay } from '@/lib/traffic';

/*
 * 用量页「导出 CSV」：把这段时间的每日明细（与页面同一份 /me/traffic，全站时区的日）在浏览器里拼成 CSV 下载，
 * 不经面板另开接口。字节数原样给（表格软件自己换算），另附 GB 两位小数方便直接看。
 * 带 UTF-8 BOM（Excel 才认得中文表头）；文本格若以 = + - @ 制表或回车开头就加 ' 并加引号（同面板 csvx 的防公式注入）。
 */
const RISKY = /^[=+\-@\t\r]/;

function cell(v: string | number): string {
  if (typeof v === 'number') return String(v);
  const s = RISKY.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) || s !== v ? `"${s.replace(/"/g, '""')}"` : s;
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);

export function usageCsv(days: TrafficDay[], header: string[]): string {
  const rows = days.map((d) => [d.day, d.downBytes, d.upBytes, d.downBytes + d.upBytes, d.billedBytes, gb(d.downBytes + d.upBytes), gb(d.billedBytes)]);
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

/** 浏览器下载：Blob 地址只在点击期间存在 */
export function downloadCsv(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
