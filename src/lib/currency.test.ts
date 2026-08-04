import { describe, expect, it } from "vitest";
import {
  convertHoldingsToUsd,
  convertPointsToUsd,
  currenciesInHoldings,
  holdingCurrency,
  latestRate,
  rateAt,
  toUsdNow,
} from "./currency";
import { aggregateHoldings } from "./portfolio";
import { Holding } from "./types";

const GBPUSD = [
  { date: "2026-01-05", close: 1.2 },
  { date: "2026-03-02", close: 1.3 },
  { date: "2026-08-03", close: 1.35 },
];
const EURUSD = [
  { date: "2026-01-05", close: 1.0 },
  { date: "2026-08-03", close: 1.1 },
];
const FX = { GBP: GBPUSD, EUR: EURUSD };

function h(over: Partial<Holding> & { id: string }): Holding {
  return {
    symbol: "X",
    shares: 1,
    purchasePrice: 100,
    purchaseDate: "2026-03-10",
    ...over,
  } as Holding;
}

describe("holdingCurrency", () => {
  it("treats GBX as a naming variant of GBP, not a minor unit", () => {
    // The T212 adapter already divided GBX prices by 100 at import.
    // Applying a divisor again here would make every LSE cost basis
    // 100x too small.
    expect(holdingCurrency("GBX")).toBe("GBP");
    expect(holdingCurrency("GBP")).toBe("GBP");
  });

  it("normalizes case and whitespace", () => {
    expect(holdingCurrency(" eur ")).toBe("EUR");
  });

  it("returns empty for absent currency", () => {
    expect(holdingCurrency(undefined)).toBe("");
    expect(holdingCurrency("")).toBe("");
  });
});

describe("rateAt", () => {
  it("uses the rate on or before the date", () => {
    expect(rateAt(GBPUSD, "2026-06-01")).toBe(1.3);
    expect(rateAt(GBPUSD, "2026-03-02")).toBe(1.3);
  });

  it("falls back to the earliest rate for dates before the series", () => {
    expect(rateAt(GBPUSD, "2020-01-01")).toBe(1.2);
  });

  it("returns null with no series so callers can leave amounts alone", () => {
    expect(rateAt(undefined, "2026-06-01")).toBeNull();
    expect(rateAt([], "2026-06-01")).toBeNull();
  });
});

describe("latestRate", () => {
  it("takes the last point", () => {
    expect(latestRate(GBPUSD)).toBe(1.35);
  });
  it("is null when there is no series", () => {
    expect(latestRate([])).toBeNull();
  });
});

describe("convertHoldingsToUsd", () => {
  it("converts each lot at the rate on its own purchase date", () => {
    const out = convertHoldingsToUsd(
      [
        h({ id: "a", currency: "GBP", purchaseDate: "2026-01-06", purchasePrice: 100 }),
        h({ id: "b", currency: "GBP", purchaseDate: "2026-06-01", purchasePrice: 100 }),
      ],
      FX,
    );
    // Not both at today's rate — a lot bought when sterling was cheaper
    // cost fewer dollars, and that difference is real return.
    expect(out[0].purchasePrice).toBeCloseTo(120, 10);
    expect(out[1].purchasePrice).toBeCloseTo(130, 10);
  });

  it("accepts GBX holdings without re-dividing by 100", () => {
    const out = convertHoldingsToUsd(
      [h({ id: "a", currency: "GBX", purchaseDate: "2026-06-01", purchasePrice: 108.68 })],
      FX,
    );
    expect(out[0].purchasePrice).toBeCloseTo(108.68 * 1.3, 10);
  });

  it("leaves USD and currency-less holdings untouched by identity", () => {
    const input = [
      h({ id: "a", currency: "USD" }),
      h({ id: "b" }),
    ];
    // Same array reference: an all-USD portfolio must take exactly the
    // code path it had before multi-currency support existed.
    expect(convertHoldingsToUsd(input, FX)).toBe(input);
  });

  it("leaves a holding alone when its currency has no FX series", () => {
    const input = [h({ id: "a", currency: "JPY", purchasePrice: 1000 })];
    expect(convertHoldingsToUsd(input, FX)[0].purchasePrice).toBe(1000);
  });

  it("feeds aggregateHoldings a USD cost basis", () => {
    const positions = aggregateHoldings(
      convertHoldingsToUsd(
        [
          h({ id: "a", symbol: "VUAA", currency: "GBP", purchaseDate: "2026-06-01", shares: 2, purchasePrice: 100 }),
          h({ id: "b", symbol: "VNGA80", currency: "EUR", purchaseDate: "2026-06-01", shares: 10, purchasePrice: 40 }),
        ],
        FX,
      ),
    );
    const byS = Object.fromEntries(positions.map((p) => [p.symbol, p]));
    expect(byS.VUAA.cost).toBeCloseTo(2 * 100 * 1.3, 6);
    expect(byS.VNGA80.cost).toBeCloseTo(10 * 40 * 1.0, 6);
    // The whole point: these two are now addable.
    expect(byS.VUAA.cost + byS.VNGA80.cost).toBeCloseTo(660, 6);
  });
});

describe("convertPointsToUsd", () => {
  it("converts day by day, not at a single rate", () => {
    const out = convertPointsToUsd(
      [
        { date: "2026-01-06", close: 100 },
        { date: "2026-06-01", close: 100 },
      ],
      "GBP",
      FX,
    );
    expect(out[0].close).toBeCloseTo(120, 10);
    expect(out[1].close).toBeCloseTo(130, 10);
  });

  it("passes USD series through untouched", () => {
    const pts = [{ date: "2026-06-01", close: 100 }];
    expect(convertPointsToUsd(pts, "USD", FX)).toBe(pts);
  });

  it("passes through when the currency has no series", () => {
    const pts = [{ date: "2026-06-01", close: 100 }];
    expect(convertPointsToUsd(pts, "JPY", FX)).toBe(pts);
  });
});

describe("toUsdNow", () => {
  it("uses the most recent rate for live values", () => {
    expect(toUsdNow(110.6, "GBP", FX)).toBeCloseTo(110.6 * 1.35, 10);
  });
  it("handles Yahoo's GBp normalization having already happened", () => {
    expect(toUsdNow(100, "GBX", FX)).toBeCloseTo(135, 10);
  });
  it("leaves the amount alone with no rate available", () => {
    expect(toUsdNow(100, "JPY", FX)).toBe(100);
    expect(toUsdNow(100, "", FX)).toBe(100);
  });
});

describe("currenciesInHoldings", () => {
  it("lists non-USD currencies, deduped and sorted", () => {
    expect(
      currenciesInHoldings([
        h({ id: "a", currency: "GBX" }),
        h({ id: "b", currency: "EUR" }),
        h({ id: "c", currency: "GBP" }),
        h({ id: "d", currency: "USD" }),
        h({ id: "e" }),
      ]),
    ).toEqual(["EUR", "GBP"]);
  });

  it("is empty for an all-USD portfolio", () => {
    expect(currenciesInHoldings([h({ id: "a" })])).toEqual([]);
  });
});
