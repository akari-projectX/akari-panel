import { describe, expect, it } from "vitest";
import { heatmap, overlaps, parseHhmm, rateAt, segments } from "./rates";

describe("D9 rate rules (display mirror of rates.rs)", () => {
  it("crosses midnight and the end of the week", () => {
    expect(segments({ weekdays: [7], start: 22 * 60, end: 2 * 60, rate: 2 })).toEqual([
      [6 * 1440 + 1320, 7 * 1440],
      [0, 120],
    ]);
  });
  it("finds overlaps and takes the highest rate", () => {
    const rules = [
      { weekdays: [5], start: 18 * 60, end: 23 * 60, rate: 2 },
      { weekdays: [5, 6], start: 20 * 60, end: 0, rate: 3.5 },
    ];
    expect(overlaps(rules)).toEqual([{ a: 0, b: 1, at: 4 * 1440 + 20 * 60, rate: 3.5 }]);
    expect(rateAt(1, rules, 4 * 1440 + 21 * 60)).toBe(3.5);
    expect(rateAt(1, rules, 4 * 1440 + 19 * 60)).toBe(2);
    expect(rateAt(1, rules, 0)).toBe(1);
    const grid = heatmap(1, rules);
    expect(grid[4][21]).toBe(3.5);
    expect(grid[0][0]).toBe(1);
  });
  it("parses HH:MM", () => {
    expect(parseHhmm("24:00")).toBe(1440);
    expect(parseHhmm("07:30")).toBe(450);
    expect(parseHhmm("7:30")).toBeNull();
    expect(parseHhmm("12:60")).toBeNull();
  });
});
