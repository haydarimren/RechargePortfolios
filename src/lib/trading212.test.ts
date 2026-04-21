import { describe, it, expect } from "vitest";
import { stripT212Suffix } from "./trading212-utils";

describe("stripT212Suffix", () => {
  it("strips single exchange suffix", () => {
    expect(stripT212Suffix("AAPL_US_EQ")).toBe("AAPL");
  });

  it("loops the regex so multi-segment suffixes are fully stripped", () => {
    expect(stripT212Suffix("XYZ_ABC_EQ")).toBe("XYZ");
  });

  it("returns unchanged ticker with no suffix", () => {
    expect(stripT212Suffix("AAPL")).toBe("AAPL");
  });

  it("handles 2-letter exchange code", () => {
    expect(stripT212Suffix("TSLA_UK")).toBe("TSLA");
  });

  it("does not strip lowercase segments", () => {
    expect(stripT212Suffix("AAPL_us_eq")).toBe("AAPL_us_eq");
  });
});
