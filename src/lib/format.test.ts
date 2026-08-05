import { describe, expect, it } from "vitest";
import { fmtMoney, fmtPct, formatBig } from "./format";

describe("format", () => {
  it("fmtMoney renders dollars with two decimals and thousands separators", () => {
    expect(fmtMoney(1234.5)).toBe("$1,234.50");
    expect(fmtMoney(0)).toBe("$0.00");
  });

  it("fmtPct signs positives and keeps two decimals", () => {
    expect(fmtPct(3.14159)).toBe("+3.14%");
    expect(fmtPct(-0.5)).toBe("-0.50%");
    expect(fmtPct(0)).toBe("+0.00%");
  });

  it("formatBig keeps at most two decimals with separators", () => {
    expect(formatBig(48652.301)).toBe("48,652.3");
    expect(formatBig(1000000)).toBe("1,000,000");
  });
});
