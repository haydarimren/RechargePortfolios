import { describe, it, expect } from "vitest";
import {
  buildIsinSymbolMap,
  isImportableT212Order,
  lookupIsinSymbol,
  pageFullyImported,
  type T212Instrument,
  type T212OrderItem,
} from "./sync";

function t212(overrides: Partial<{
  id: number; ticker: string; status: string; side: string;
  initiatedFrom: string; quantity: number; price: number; filledAt: string | null;
}> = {}): T212OrderItem {
  const o = {
    id: 1, ticker: "AAPL_US_EQ", status: "FILLED", side: "BUY",
    initiatedFrom: "ORDER", quantity: 10, price: 150, filledAt: "2024-06-15T10:00:00Z",
    ...overrides,
  };
  return {
    order: {
      id: o.id, ticker: o.ticker, status: o.status, side: o.side,
      createdAt: "2024-06-15T09:59:00Z", initiatedFrom: o.initiatedFrom,
      instrument: { currency: "USD" },
    },
    fill: o.filledAt === null ? null : { quantity: o.quantity, price: o.price, filledAt: o.filledAt },
  };
}

const knownAll = () => true;
const knownNone = () => false;

describe("isImportableT212Order", () => {
  it("imports a filled BUY/SELL", () => {
    expect(isImportableT212Order(t212(), null)).toBe(true);
    expect(isImportableT212Order(t212({ side: "SELL" }), null)).toBe(true);
  });
  it("skips a cancelled order (no fill)", () => {
    expect(isImportableT212Order(t212({ status: "CANCELLED", filledAt: null }), null)).toBe(false);
  });
  it("skips a non-FILLED status", () => {
    expect(isImportableT212Order(t212({ status: "NEW", filledAt: null }), null)).toBe(false);
  });
  it("skips an AutoInvest buy not in open positions", () => {
    const open = new Set<string>(); // empty: ticker not held
    expect(isImportableT212Order(t212({ initiatedFrom: "AUTOINVEST" }), open)).toBe(false);
  });
  it("keeps an AutoInvest buy that IS in open positions", () => {
    const open = new Set(["AAPL_US_EQ"]);
    expect(isImportableT212Order(t212({ initiatedFrom: "AUTOINVEST" }), open)).toBe(true);
  });
});

describe("pageFullyImported", () => {
  it("returns false without an isOrderKnown predicate", () => {
    expect(pageFullyImported([t212()], null, undefined)).toBe(false);
  });
  it("STOPS on a page of [cancelled, known-filled] — the bug fix", () => {
    const page = [t212({ id: 1, status: "CANCELLED", filledAt: null }), t212({ id: 2 })];
    expect(pageFullyImported(page, null, knownAll)).toBe(true);
  });
  it("keeps paginating when an importable order is new", () => {
    const page = [t212({ id: 1, status: "CANCELLED", filledAt: null }), t212({ id: 2 })];
    expect(pageFullyImported(page, null, knownNone)).toBe(false);
  });
  it("does NOT stop on an all-cancelled page (can't conclude)", () => {
    const page = [t212({ id: 1, status: "CANCELLED", filledAt: null })];
    expect(pageFullyImported(page, null, knownAll)).toBe(false);
  });
});

describe("ISIN → display symbol", () => {
  // The real shape of the collision: one fund, one ISIN, two LSE lines.
  const VANGUARD: T212Instrument[] = [
    { ticker: "VUAGl_EQ", isin: "IE00BFMXXD54", shortName: "VUAG", currencyCode: "GBX" },
    { ticker: "VUAAl_EQ", isin: "IE00BFMXXD54", shortName: "VUAA", currencyCode: "USD" },
  ];

  it("labels a GBP order with the GBP line, not the USD one", () => {
    const map = buildIsinSymbolMap(VANGUARD);
    expect(lookupIsinSymbol(map, "IE00BFMXXD54", "GBX")).toBe("VUAG");
  });

  it("labels a USD order of the same ISIN with the USD line", () => {
    const map = buildIsinSymbolMap(VANGUARD);
    expect(lookupIsinSymbol(map, "IE00BFMXXD54", "USD")).toBe("VUAA");
  });

  it("treats GBX and GBP as the same listing", () => {
    const map = buildIsinSymbolMap(VANGUARD);
    expect(lookupIsinSymbol(map, "IE00BFMXXD54", "GBP")).toBe("VUAG");
  });

  it("is order-independent — a USD listing no longer overwrites the others", () => {
    const reversed = buildIsinSymbolMap([...VANGUARD].reverse());
    expect(lookupIsinSymbol(reversed, "IE00BFMXXD54", "GBX")).toBe("VUAG");
  });

  it("still heals a stale pre-merger ticker (ASTS ← NPA)", () => {
    // T212 keeps reporting orders under the old ticker; the metadata
    // carries the current one against the same ISIN, both in USD.
    const map = buildIsinSymbolMap([
      { ticker: "ASTS_US_EQ", isin: "US00214Q1040", shortName: "ASTS", currencyCode: "USD" },
    ]);
    expect(lookupIsinSymbol(map, "US00214Q1040", "USD")).toBe("ASTS");
  });

  it("falls back to the ISIN-only entry when the currency is unknown", () => {
    const map = buildIsinSymbolMap(VANGUARD);
    expect(lookupIsinSymbol(map, "IE00BFMXXD54", undefined)).toBe("VUAA");
  });

  it("returns undefined without an ISIN, leaving the caller on its own ticker", () => {
    const map = buildIsinSymbolMap(VANGUARD);
    expect(lookupIsinSymbol(map, undefined, "GBX")).toBeUndefined();
    expect(lookupIsinSymbol(map, "NOT_LISTED", "GBX")).toBeUndefined();
  });

  it("skips instruments with no ISIN", () => {
    const map = buildIsinSymbolMap([
      { ticker: "X_EQ", isin: "", shortName: "X", currencyCode: "USD" },
    ]);
    expect(map.size).toBe(0);
  });
});
