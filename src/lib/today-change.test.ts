import { describe, expect, it } from "vitest";
import { computeTodayChange } from "./today-change";

describe("computeTodayChange", () => {
  it("returns null when nothing is priced", () => {
    expect(computeTodayChange([])).toBeNull();
    expect(computeTodayChange([{ market: null, dp: 2 }])).toBeNull();
    expect(computeTodayChange([{ market: 100, dp: null }])).toBeNull();
  });

  it("computes usd and pct for a single position", () => {
    // market 102 after a +2% day → prev close basis 100, +2 USD, +2%
    const r = computeTodayChange([{ market: 102, dp: 2 }]);
    expect(r).not.toBeNull();
    expect(r!.usd).toBeCloseTo(2, 6);
    expect(r!.pct).toBeCloseTo(2, 6);
    expect(r!.pricedCount).toBe(1);
  });

  it("aggregates mixed movers against the summed previous basis", () => {
    // A: 102 after +2% (prev 100, +2). B: 98 after -2% (prev 100, -2).
    // Total: prev 200, change 0 → 0%.
    const r = computeTodayChange([
      { market: 102, dp: 2 },
      { market: 98, dp: -2 },
    ]);
    expect(r!.usd).toBeCloseTo(0, 6);
    expect(r!.pct).toBeCloseTo(0, 6);
    expect(r!.pricedCount).toBe(2);
  });

  it("skips unpriced rows but keeps the rest", () => {
    const r = computeTodayChange([
      { market: 102, dp: 2 },
      { market: null, dp: 5 },
    ]);
    expect(r!.usd).toBeCloseTo(2, 6);
    expect(r!.pricedCount).toBe(1);
  });

  it("treats a flat day as zero, not null", () => {
    const r = computeTodayChange([{ market: 100, dp: 0 }]);
    expect(r!.usd).toBe(0);
    expect(r!.pct).toBe(0);
  });

  it("guards degenerate dp ≤ -100 rows by skipping them", () => {
    const r = computeTodayChange([
      { market: 102, dp: 2 },
      { market: 1, dp: -100 },
    ]);
    expect(r!.pricedCount).toBe(1);
    expect(r!.usd).toBeCloseTo(2, 6);
  });

  it("skips NaN/Infinity rows", () => {
    const r = computeTodayChange([
      { market: 102, dp: 2 },
      { market: NaN, dp: 5 },
      { market: Infinity, dp: 5 },
      { market: 100, dp: NaN },
    ]);
    expect(r!.pricedCount).toBe(1);
    expect(r!.usd).toBeCloseTo(2, 6);
  });
});
