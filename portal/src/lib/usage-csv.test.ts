import { describe, expect, it } from 'vitest';
import { usageCsv } from './usage-csv';

const day = (d: string, down: number, up: number, billed: number) => ({
  day: d, date: d.slice(5), down: 0, up: 0, billed: 0, downBytes: down, upBytes: up, billedBytes: billed,
});

describe('usageCsv', () => {
  it('starts with a BOM, one row per day, bytes and GB', () => {
    const csv = usageCsv([day('2026-10-01', 1024 ** 3, 1024 ** 3, 3 * 1024 ** 3)], ['日期', '下行', '上行', '合计', '计费', '合计 GB', '计费 GB']);
    expect(csv.startsWith('﻿日期,下行,上行,合计,计费,合计 GB,计费 GB\r\n')).toBe(true);
    expect(csv).toContain(`2026-10-01,${1024 ** 3},${1024 ** 3},${2 * 1024 ** 3},${3 * 1024 ** 3},2.00,3.00\r\n`);
  });

  it('quotes and defuses text cells that start like a formula', () => {
    const csv = usageCsv([], ['=SUM(A1)', 'a,b', 'plain']);
    expect(csv).toBe('﻿"\'=SUM(A1)","a,b",plain\r\n');
  });
});
