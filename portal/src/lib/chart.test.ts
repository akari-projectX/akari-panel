import { describe, expect, it } from 'vitest';
import { chartAxis, inUnit, labelled, smoothPath } from './chart';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

describe('chartAxis', () => {
  it('picks the unit by the largest day and a tidy half step', () => {
    expect(chartAxis(10 * GB)).toEqual({ unit: 'GB', size: GB, ticks: [0, 5, 10], top: 10 });
    expect(chartAxis(10.2 * GB).ticks).toEqual([0, 6, 12]);
    expect(chartAxis(12.1 * GB).ticks).toEqual([0, 7.5, 15]);
    expect(chartAxis(3.4 * GB).ticks).toEqual([0, 2, 4]);
    expect(chartAxis(512 * MB)).toMatchObject({ unit: 'MB', ticks: [0, 300, 600] });
    expect(chartAxis(300).unit).toBe('KB');
  });

  it('the top line is never below the largest day', () => {
    for (const v of [1.01, 2.6, 4.9, 7.3, 12, 99, 101, 640]) {
      expect(chartAxis(v * GB).top).toBeGreaterThanOrEqual(v);
    }
  });

  it('gives an empty axis for no traffic', () => {
    expect(chartAxis(0)).toMatchObject({ unit: 'KB', ticks: [0, 0.5, 1] });
  });
});

describe('inUnit', () => {
  it('one decimal below 100, whole numbers above', () => {
    expect(inUnit(1.94 * GB, GB)).toBe('1.9');
    expect(inUnit(2 * GB, GB)).toBe('2');
    expect(inUnit(123.4 * GB, GB)).toBe('123');
    expect(inUnit(0, GB)).toBe('0');
  });
});

describe('smoothPath', () => {
  it('draws one cubic per segment with flat tangents', () => {
    expect(smoothPath([[0, 10], [10, 0], [20, 5]])).toBe('M0,10 C5,10 5,0 10,0 C15,0 15,5 20,5');
    expect(smoothPath([[1, 2]])).toBe('M1,2');
    expect(smoothPath([])).toBe('');
  });
});

describe('labelled', () => {
  it('counts back from today', () => {
    expect(labelled(7, 1)).toEqual([true, true, true, true, true, true, true]);
    expect(labelled(8, 3)).toEqual([false, true, false, false, true, false, false, true]);
  });
});
