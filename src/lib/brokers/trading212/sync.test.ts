import { describe, it, expect } from "vitest";
import {
  isImportableT212Order,
  pageFullyImported,
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
