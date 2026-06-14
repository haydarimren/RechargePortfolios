import { afterEach, describe, it, expect, vi } from "vitest";
import { alpacaPageFullyImported, fetchAlpacaOrders, mapAlpacaOrder } from "./sync";

// Hoisted mock — vi.mock must be top-level so it runs before any imports.
// `proxy-fetch` calls `auth.currentUser?.getIdToken()`; in tests we never
// have a real signed-in user, so we stub the firebase module to provide
// a fake token.
vi.mock("../../firebase", () => ({
  auth: { currentUser: { getIdToken: async () => "fake-id-token" } },
}));

function rawOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    symbol: "AAPL",
    asset_class: "us_equity",
    side: "buy" as const,
    filled_qty: "10",
    filled_avg_price: "150.50",
    filled_at: "2024-06-15T14:30:00Z",
    submitted_at: "2024-06-15T14:29:00Z",
    status: "filled",
    ...overrides,
  };
}

describe("mapAlpacaOrder", () => {
  it("keeps a filled US-equity buy", () => {
    const result = mapAlpacaOrder(rawOrder());
    expect(result.kind).toBe("keep");
    if (result.kind !== "keep") return;
    expect(result.order).toEqual({
      id: "ord-1",
      symbol: "AAPL",
      shares: 10,
      purchasePrice: 150.5,
      purchaseDate: "2024-06-15",
      currency: "USD",
      yahooSymbol: "AAPL",
      side: "BUY",
    });
  });

  it("maps a SELL", () => {
    const result = mapAlpacaOrder(rawOrder({ side: "sell" }));
    if (result.kind !== "keep") throw new Error("expected keep");
    expect(result.order.side).toBe("SELL");
  });

  it("normalizes class-share dot to dash", () => {
    const result = mapAlpacaOrder(rawOrder({ symbol: "BRK.B" }));
    if (result.kind !== "keep") throw new Error("expected keep");
    expect(result.order.symbol).toBe("BRK-B");
    expect(result.order.yahooSymbol).toBe("BRK-B");
  });

  it("skips non-filled, non-cancelled statuses", () => {
    expect(mapAlpacaOrder(rawOrder({ status: "new" })).kind).toBe("skip");
    expect(mapAlpacaOrder(rawOrder({ status: "partially_filled" })).kind).toBe("skip");
  });

  it("flags partial-fill-then-cancelled separately from generic skip", () => {
    // Cancelled but with shares already filled before cancellation —
    // user owns those shares; we can't represent them as a lot in v1
    // but we count them so the UI can warn.
    const result = mapAlpacaOrder(
      rawOrder({ status: "canceled", filled_qty: "3" }),
    );
    expect(result.kind).toBe("partial-fill-skipped");
  });

  it("treats cancelled with zero fill as plain skip", () => {
    const result = mapAlpacaOrder(
      rawOrder({ status: "canceled", filled_qty: "0" }),
    );
    expect(result.kind).toBe("skip");
  });

  it("skips non-US-equity asset classes", () => {
    expect(mapAlpacaOrder(rawOrder({ asset_class: "crypto", symbol: "BTC/USD" })).kind).toBe("skip");
    expect(mapAlpacaOrder(rawOrder({ asset_class: "us_option" })).kind).toBe("skip");
  });

  it("skips orders missing fill data", () => {
    expect(mapAlpacaOrder(rawOrder({ filled_at: null })).kind).toBe("skip");
    expect(mapAlpacaOrder(rawOrder({ filled_avg_price: null })).kind).toBe("skip");
  });

  it("skips orders with non-positive shares or price", () => {
    expect(mapAlpacaOrder(rawOrder({ filled_qty: "0" })).kind).toBe("skip");
    expect(mapAlpacaOrder(rawOrder({ filled_qty: "-5" })).kind).toBe("skip");
    expect(mapAlpacaOrder(rawOrder({ filled_avg_price: "0" })).kind).toBe("skip");
    expect(mapAlpacaOrder(rawOrder({ filled_avg_price: "-1.5" })).kind).toBe("skip");
  });

  it("skips orders with non-numeric values (Number, not parseFloat)", () => {
    // parseFloat("10abc") = 10, Number("10abc") = NaN. We use Number.
    expect(mapAlpacaOrder(rawOrder({ filled_qty: "abc" })).kind).toBe("skip");
    expect(mapAlpacaOrder(rawOrder({ filled_qty: "10abc" })).kind).toBe("skip");
    expect(mapAlpacaOrder(rawOrder({ filled_avg_price: "NaN" })).kind).toBe("skip");
  });
});

// --- fetchAlpacaOrders integration tests (mock fetch) ---

describe("fetchAlpacaOrders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects malformed credentials before issuing any request", async () => {
    await expect(fetchAlpacaOrders("nocolon")).rejects.toThrow(/required/);
    await expect(fetchAlpacaOrders(":nokey")).rejects.toThrow(/required/);
    await expect(fetchAlpacaOrders("nosecret:")).rejects.toThrow(/required/);
  });

  it("returns an empty result when the first page is empty", async () => {
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchAlpacaOrders("PKABC:SECRET");
    expect(result).toEqual({
      orders: [],
      sellsImported: 0,
      sellsSkipped: 0,
      partialFillsSkipped: 0,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("counts partial fills skipped", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify([
          rawOrder({ id: "a", status: "filled" }),
          rawOrder({ id: "b", status: "canceled", filled_qty: "2" }),
          rawOrder({ id: "c", status: "canceled", filled_qty: "5" }),
        ]),
        { status: 200 },
      )
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchAlpacaOrders("PKABC:SECRET");
    expect(result.orders).toHaveLength(1);
    expect(result.orders[0].id).toBe("a");
    expect(result.partialFillsSkipped).toBe(2);
  });

  it("propagates non-OK responses as errors", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response("forbidden", { status: 403 })
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchAlpacaOrders("PKABC:SECRET")).rejects.toThrow(/403/);
  });
});

describe("alpacaPageFullyImported", () => {
  const knownAll = () => true;
  const knownNone = () => false;
  it("returns false without a predicate", () => {
    expect(alpacaPageFullyImported([rawOrder()] as never, undefined)).toBe(false);
  });
  it("STOPS on [cancelled, known-filled] — the bug fix", () => {
    const page = [
      rawOrder({ id: "a", status: "canceled", filled_qty: "0", filled_at: null }),
      rawOrder({ id: "b", status: "filled" }),
    ];
    expect(alpacaPageFullyImported(page as never, knownAll)).toBe(true);
  });
  it("STOPS despite a partial-fill-cancelled order (filled_at present but not importable)", () => {
    const page = [
      rawOrder({ id: "a", status: "canceled", filled_qty: "3" }),
      rawOrder({ id: "b", status: "filled" }),
    ];
    expect(alpacaPageFullyImported(page as never, knownAll)).toBe(true);
  });
  it("keeps paginating when an importable order is new", () => {
    const page = [rawOrder({ id: "b", status: "filled" })];
    expect(alpacaPageFullyImported(page as never, knownNone)).toBe(false);
  });
  it("does NOT stop on an all-non-importable page", () => {
    const page = [rawOrder({ id: "a", status: "canceled", filled_qty: "0", filled_at: null })];
    expect(alpacaPageFullyImported(page as never, knownAll)).toBe(false);
  });
});
