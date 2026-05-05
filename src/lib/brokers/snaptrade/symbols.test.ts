import { describe, it, expect } from "vitest";
import { snaptradeSymbolToYahoo } from "./symbols";

describe("snaptradeSymbolToYahoo", () => {
  it("passes plain US tickers through", () => {
    expect(snaptradeSymbolToYahoo("AAPL")).toBe("AAPL");
    expect(snaptradeSymbolToYahoo("MSFT")).toBe("MSFT");
  });

  it("converts class-share dot to dash", () => {
    expect(snaptradeSymbolToYahoo("BRK.B")).toBe("BRK-B");
    expect(snaptradeSymbolToYahoo("BF.B")).toBe("BF-B");
  });

  it("converts every dot, not just one", () => {
    expect(snaptradeSymbolToYahoo("A.B.C")).toBe("A-B-C");
  });

  it("leaves the empty string alone", () => {
    expect(snaptradeSymbolToYahoo("")).toBe("");
  });
});
