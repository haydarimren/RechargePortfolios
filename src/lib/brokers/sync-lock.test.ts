import { describe, it, expect } from "vitest";
import { deriveLockedBroker, snaptradeAccountIdsFromHoldings } from "./sync-lock";
import type { Holding } from "@/lib/types";

function h(over: Partial<Holding>): Holding {
  return {
    id: "h", symbol: "AAPL", shares: 1, purchasePrice: 1,
    purchaseDate: "2024-01-01", createdAt: 0, side: "BUY", ...over,
  };
}

describe("deriveLockedBroker", () => {
  it("returns null for manual-only holdings", () => {
    expect(deriveLockedBroker([h({})])).toBeNull();
  });
  it("returns the broker from the first holding whose importSource is a known broker", () => {
    expect(deriveLockedBroker([h({}), h({ importSource: "trading212" })])).toBe("trading212");
  });
  it("ignores unknown importSource values", () => {
    expect(deriveLockedBroker([h({ importSource: "wealthfront" })])).toBeNull();
  });
});

describe("snaptradeAccountIdsFromHoldings", () => {
  it("collects the distinct snaptrade account ids", () => {
    const got = snaptradeAccountIdsFromHoldings([
      h({ importSource: "snaptrade", snaptradeAccountId: "A" }),
      h({ importSource: "snaptrade", snaptradeAccountId: "B" }),
      h({ importSource: "snaptrade", snaptradeAccountId: "A" }),
      h({ importSource: "snaptrade" }), // no account id — ignored
      h({ importSource: "trading212", snaptradeAccountId: "X" }), // wrong broker — ignored
    ]);
    expect([...got].sort()).toEqual(["A", "B"]);
  });
});
