import { describe, it, expect } from "vitest";
import { alpacaSymbolToYahoo } from "./symbols";

describe("alpacaSymbolToYahoo", () => {
  it("passes plain US tickers through", () => {
    expect(alpacaSymbolToYahoo("AAPL")).toBe("AAPL");
    expect(alpacaSymbolToYahoo("MSFT")).toBe("MSFT");
    expect(alpacaSymbolToYahoo("SPY")).toBe("SPY");
  });

  it("converts class-share dot to dash", () => {
    expect(alpacaSymbolToYahoo("BRK.B")).toBe("BRK-B");
    expect(alpacaSymbolToYahoo("BF.B")).toBe("BF-B");
    expect(alpacaSymbolToYahoo("LEN.B")).toBe("LEN-B");
  });

  it("converts every dot, not just one", () => {
    // Hypothetical multi-dot ticker — doesn't exist in real US listings
    // but the rule should still hold.
    expect(alpacaSymbolToYahoo("A.B.C")).toBe("A-B-C");
  });

  it("leaves the empty string alone", () => {
    expect(alpacaSymbolToYahoo("")).toBe("");
  });
});
