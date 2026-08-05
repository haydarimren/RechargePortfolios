import { describe, expect, it } from "vitest";
import { derivePreviousClose, type DailyBar } from "./previous-close";

/** US market: 09:30 ET open = 13:30 UTC; gmtoffset −4h in summer. */
const ET = -14400;
const bar = (ts: number, close: number): DailyBar => ({ ts, close });

// Real MU bars pulled from Yahoo v8 on 2026-08-05 — the case that exposed
// the bug (chartPreviousClose 739.0 → +24.90%; true session move +3.40%).
const MU_BARS = [
  bar(1785418200, 874.66), // Jul 30
  bar(1785504600, 823.03), // Jul 31
  bar(1785763800, 829.5), // Aug 3
  bar(1785850200, 892.67), // Aug 4
  bar(1785936600, 922.9998), // Aug 5 — session in progress
];
const MU_MARKET_TIME = 1785948635; // Aug 5, 16:50 UTC

describe("derivePreviousClose", () => {
  it("uses the prior bar while today's session is the last bar", () => {
    expect(derivePreviousClose(MU_BARS, MU_MARKET_TIME, ET)).toBe(892.67);
  });

  it("produces a day change, not a range change, for the real MU case", () => {
    const pc = derivePreviousClose(MU_BARS, MU_MARKET_TIME, ET)!;
    const dp = ((923 - pc) / pc) * 100;
    expect(dp).toBeCloseTo(3.4, 1);
  });

  it("uses the last bar when it is already a completed prior session", () => {
    // Monday pre-open: market time is a day after the newest bar.
    const monday = 1786023000; // Aug 6, 13:30 UTC
    expect(derivePreviousClose(MU_BARS, monday, ET)).toBe(922.9998);
  });

  it("compares days in market-local time, not UTC", () => {
    // A 23:30 UTC market time on Aug 5 is still Aug 5 in ET (19:30).
    const lateUtc = 1785972600;
    expect(derivePreviousClose(MU_BARS, lateUtc, ET)).toBe(892.67);
    // With a +10h venue offset the same instant is Aug 6 locally, so the
    // last bar counts as a completed session.
    expect(derivePreviousClose(MU_BARS, lateUtc, 36000)).toBe(922.9998);
  });

  it("returns null when there is no prior bar to compare against", () => {
    expect(derivePreviousClose([], MU_MARKET_TIME, ET)).toBeNull();
    expect(
      derivePreviousClose([bar(1785936600, 922.9998)], MU_MARKET_TIME, ET),
    ).toBeNull();
  });

  it("falls back to the last bar when the market time is unknown", () => {
    expect(derivePreviousClose(MU_BARS, 0, ET)).toBe(922.9998);
  });
});
