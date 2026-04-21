import { describe, it, expect } from "vitest";
import {
  aggregateHoldings,
  closeOnOrBefore,
  fmtShares,
  buildComparisonSeries,
  poolPositions,
} from "./portfolio";
import type { Holding } from "./types";
import type { HistoricalPoint } from "./yahoo";

function h(
  id: string,
  symbol: string,
  shares: number,
  purchasePrice: number,
  purchaseDate: string
): Holding {
  return {
    id,
    symbol,
    shares,
    purchasePrice,
    purchaseDate,
    createdAt: 0,
  };
}

function sell(
  id: string,
  symbol: string,
  shares: number,
  purchaseDate: string,
  purchasePrice = 0,
  createdAt = 0
): Holding {
  return {
    id,
    symbol,
    shares,
    purchasePrice,
    purchaseDate,
    createdAt,
    side: "SELL",
  };
}

describe("aggregateHoldings", () => {
  it("groups same-symbol lots with weighted avg cost and earliest purchase date", () => {
    const holdings: Holding[] = [
      h("1", "AAPL", 10, 100, "2024-03-01"),
      h("2", "AAPL", 20, 130, "2024-01-15"),
      h("3", "MSFT", 5, 400, "2024-02-10"),
    ];
    const result = aggregateHoldings(holdings);
    expect(result).toHaveLength(2);

    const aapl = result.find((r) => r.symbol === "AAPL")!;
    expect(aapl.shares).toBe(30);
    expect(aapl.cost).toBe(10 * 100 + 20 * 130); // 3600
    expect(aapl.avgPrice).toBeCloseTo(3600 / 30, 10); // 120
    expect(aapl.firstDate).toBe("2024-01-15");
    expect(aapl.lots).toHaveLength(2);

    const msft = result.find((r) => r.symbol === "MSFT")!;
    expect(msft.shares).toBe(5);
    expect(msft.avgPrice).toBe(400);
    expect(msft.firstDate).toBe("2024-02-10");
  });

  it("returns empty array for no holdings", () => {
    expect(aggregateHoldings([])).toEqual([]);
  });

  it("sorts output alphabetically by symbol", () => {
    const holdings = [
      h("1", "ZZZ", 1, 1, "2024-01-01"),
      h("2", "AAA", 1, 1, "2024-01-01"),
      h("3", "MMM", 1, 1, "2024-01-01"),
    ];
    expect(aggregateHoldings(holdings).map((r) => r.symbol)).toEqual([
      "AAA",
      "MMM",
      "ZZZ",
    ]);
  });
});

describe("closeOnOrBefore", () => {
  const pts: HistoricalPoint[] = [
    { date: "2024-01-02", close: 100 },
    { date: "2024-01-03", close: 101 },
    { date: "2024-01-05", close: 105 }, // gap over weekend
    { date: "2024-01-08", close: 110 },
  ];

  it("returns exact match when date present", () => {
    expect(closeOnOrBefore(pts, "2024-01-03")).toBe(101);
  });

  it("returns nearest on-or-before when date falls in a gap", () => {
    // weekend - nearest before is 01-05
    expect(closeOnOrBefore(pts, "2024-01-06")).toBe(105);
    expect(closeOnOrBefore(pts, "2024-01-07")).toBe(105);
  });

  it("returns last close when date is after all points", () => {
    expect(closeOnOrBefore(pts, "2024-02-01")).toBe(110);
  });

  it("returns null when date is before the first point", () => {
    expect(closeOnOrBefore(pts, "2023-12-31")).toBeNull();
  });

  it("returns null for empty points", () => {
    expect(closeOnOrBefore([], "2024-01-01")).toBeNull();
  });
});

describe("fmtShares", () => {
  it("integer renders without decimals", () => {
    expect(fmtShares(42)).toBe("42");
  });

  it("tiny fractional uses up to 6 dp", () => {
    expect(fmtShares(0.00004)).toBe("0.00004");
  });

  it("large numbers get commas", () => {
    expect(fmtShares(1234567)).toBe("1,234,567");
  });

  it("trims trailing zeros below 6 dp", () => {
    expect(fmtShares(1.5)).toBe("1.5");
  });

  it("caps at 6 fractional digits", () => {
    // 0.1234567 rounds to 6 dp
    expect(fmtShares(0.1234567)).toBe("0.123457");
  });
});

describe("buildComparisonSeries", () => {
  it("sums lots per day, runs hypothetical-invest benchmark math, excludes future lots", () => {
    // Two lots of AAPL: bought on 01-02 and 01-05
    const holdings: Holding[] = [
      h("L1", "AAPL", 10, 100, "2024-01-02"), // cost 1000
      h("L2", "AAPL", 5, 110, "2024-01-05"), // cost 550
    ];

    const aaplPrices: HistoricalPoint[] = [
      { date: "2024-01-02", close: 100 },
      { date: "2024-01-03", close: 102 },
      { date: "2024-01-04", close: 104 },
      { date: "2024-01-05", close: 110 },
      { date: "2024-01-08", close: 115 },
    ];

    const spyPrices: HistoricalPoint[] = [
      { date: "2024-01-02", close: 400 },
      { date: "2024-01-03", close: 404 },
      { date: "2024-01-04", close: 408 },
      { date: "2024-01-05", close: 410 },
      { date: "2024-01-08", close: 420 },
    ];

    const series = buildComparisonSeries(
      holdings,
      { AAPL: aaplPrices },
      { SPY: spyPrices }
    );

    expect(series.map((s) => s.date)).toEqual([
      "2024-01-02",
      "2024-01-03",
      "2024-01-04",
      "2024-01-05",
      "2024-01-08",
    ]);

    // 01-02: only L1. portfolio = 10 * 100 = 1000
    // SPY: 1000 * (400/400) = 1000
    expect(series[0].portfolio).toBeCloseTo(1000);
    expect(series[0].SPY).toBeCloseTo(1000);

    // 01-03: only L1 (L2 not yet bought). portfolio = 10 * 102 = 1020
    // SPY: 1000 * (404/400) = 1010
    expect(series[1].portfolio).toBeCloseTo(1020);
    expect(series[1].SPY).toBeCloseTo(1010);
    // L2 purchase date (01-05) > 01-03, confirm exclusion via magnitude check
    expect(series[1].portfolio).toBeLessThan(1100);

    // 01-05: both lots active. portfolio = 15 * 110 = 1650
    // SPY L1 basis=400, current=410 -> 1000 * 410/400 = 1025
    // SPY L2 basis=410, current=410 -> 550 * 410/410 = 550. total = 1575
    expect(series[3].portfolio).toBeCloseTo(1650);
    expect(series[3].SPY).toBeCloseTo(1575);

    // 01-08: portfolio = 15 * 115 = 1725
    // SPY: 1000 * 420/400 + 550 * 420/410 = 1050 + 563.4146... = 1613.4146
    expect(series[4].portfolio).toBeCloseTo(1725);
    expect(series[4].SPY).toBeCloseTo(1050 + (550 * 420) / 410);
  });

  it("returns empty series when no holdings", () => {
    expect(
      buildComparisonSeries([], {}, { SPY: [{ date: "2024-01-02", close: 400 }] })
    ).toEqual([]);
  });

  it("returns empty series when no benchmarks", () => {
    const holdings = [h("L1", "AAPL", 1, 1, "2024-01-01")];
    expect(buildComparisonSeries(holdings, { AAPL: [] }, {})).toEqual([]);
  });

  it("reflects a mid-window sell in portfolio and benchmark series", () => {
    // Buy 10 @ $100 on 01-02. Sell 5 on 01-04. Post-sell: 5 shares remaining.
    const holdings: Holding[] = [
      h("L1", "AAPL", 10, 100, "2024-01-02"),
      sell("S1", "AAPL", 5, "2024-01-04"),
    ];

    const aaplPrices: HistoricalPoint[] = [
      { date: "2024-01-02", close: 100 },
      { date: "2024-01-03", close: 110 },
      { date: "2024-01-04", close: 120 },
      { date: "2024-01-05", close: 130 },
    ];
    const spyPrices: HistoricalPoint[] = [
      { date: "2024-01-02", close: 400 },
      { date: "2024-01-03", close: 404 },
      { date: "2024-01-04", close: 408 },
      { date: "2024-01-05", close: 410 },
    ];

    const series = buildComparisonSeries(
      holdings,
      { AAPL: aaplPrices },
      { SPY: spyPrices }
    );

    // 01-02: 10 shares @ 100 = 1000. SPY basis=400. 1000 * 400/400 = 1000
    expect(series[0].portfolio).toBeCloseTo(1000);
    expect(series[0].SPY).toBeCloseTo(1000);

    // 01-03: still 10 shares, price 110 = 1100. SPY: 1000 * 404/400 = 1010
    expect(series[1].portfolio).toBeCloseTo(1100);
    expect(series[1].SPY).toBeCloseTo(1010);

    // 01-04: sell happens this day. 5 shares remain @ 120 = 600.
    // Benchmark: lotCostStillOpen = 5 * 100 = 500, SPY 500 * 408/400 = 510
    expect(series[2].portfolio).toBeCloseTo(600);
    expect(series[2].SPY).toBeCloseTo(510);

    // 01-05: 5 shares @ 130 = 650. SPY: 500 * 410/400 = 512.5
    expect(series[3].portfolio).toBeCloseTo(650);
    expect(series[3].SPY).toBeCloseTo(512.5);
  });
});

describe("poolPositions", () => {
  it("single buy: one position, one full-size remaining lot", () => {
    const res = poolPositions([h("1", "AAPL", 10, 100, "2024-01-01")]);
    expect(res).toHaveLength(1);
    expect(res[0].shares).toBe(10);
    expect(res[0].avgPrice).toBe(100);
    expect(res[0].firstPurchaseDate).toBe("2024-01-01");
    expect(res[0].remainingLots).toHaveLength(1);
    expect(res[0].remainingLots[0].remainingShares).toBe(10);
    expect(res[0].remainingLots[0].originalShares).toBe(10);
  });

  it("two buys same symbol: pooled shares, weighted avg, two untouched lots", () => {
    const res = poolPositions([
      h("1", "AAPL", 10, 100, "2024-01-01"),
      h("2", "AAPL", 20, 130, "2024-02-01"),
    ]);
    expect(res).toHaveLength(1);
    expect(res[0].shares).toBe(30);
    expect(res[0].avgPrice).toBeCloseTo(3600 / 30, 10);
    expect(res[0].remainingLots).toHaveLength(2);
    expect(res[0].remainingLots[0].remainingShares).toBe(10);
    expect(res[0].remainingLots[1].remainingShares).toBe(20);
  });

  it("buy + full sell: symbol dropped", () => {
    const res = poolPositions([
      h("1", "AAPL", 10, 100, "2024-01-01"),
      sell("S", "AAPL", 10, "2024-01-05"),
    ]);
    expect(res).toHaveLength(0);
  });

  it("buy + 50% sell: shares halved, avgPrice preserved, single half-size lot", () => {
    const res = poolPositions([
      h("1", "AAPL", 10, 100, "2024-01-01"),
      sell("S", "AAPL", 5, "2024-01-05"),
    ]);
    expect(res).toHaveLength(1);
    expect(res[0].shares).toBeCloseTo(5);
    expect(res[0].avgPrice).toBeCloseTo(100);
    expect(res[0].remainingLots).toHaveLength(1);
    expect(res[0].remainingLots[0].remainingShares).toBeCloseTo(5);
    expect(res[0].remainingLots[0].originalShares).toBe(10);
  });

  it("buy + buy + sell half the pool: both lots scaled 50%, avg unchanged", () => {
    // 10 @ 100 + 20 @ 130 = 30 shares, avg 120. Sell 15 → 15 remain @ avg 120.
    const res = poolPositions([
      h("1", "AAPL", 10, 100, "2024-01-01"),
      h("2", "AAPL", 20, 130, "2024-02-01"),
      sell("S", "AAPL", 15, "2024-03-01"),
    ]);
    expect(res).toHaveLength(1);
    expect(res[0].shares).toBeCloseTo(15);
    expect(res[0].avgPrice).toBeCloseTo(120);
    expect(res[0].remainingLots).toHaveLength(2);
    expect(res[0].remainingLots[0].remainingShares).toBeCloseTo(5); // 10 * 0.5
    expect(res[0].remainingLots[1].remainingShares).toBeCloseTo(10); // 20 * 0.5
  });

  it("sell before any buy: ignored, empty result", () => {
    const res = poolPositions([sell("S", "AAPL", 5, "2024-01-01")]);
    expect(res).toEqual([]);
  });

  it("oversell clamps to zero and drops the position", () => {
    const res = poolPositions([
      h("1", "AAPL", 10, 100, "2024-01-01"),
      sell("S", "AAPL", 50, "2024-01-05"),
    ]);
    expect(res).toEqual([]);
  });

  it("firstPurchaseDate uses earliest BUY date, not sell date", () => {
    const res = poolPositions([
      h("1", "AAPL", 10, 100, "2024-01-15"),
      h("2", "AAPL", 5, 110, "2024-01-05"), // earlier buy
      sell("S", "AAPL", 3, "2024-01-01"), // earlier date but sell — ignored here
    ]);
    // Sell at date with no pool is ignored, so pool then has 15 shares, avg ...
    // firstPurchaseDate should be the earliest BUY: 2024-01-05
    expect(res).toHaveLength(1);
    expect(res[0].firstPurchaseDate).toBe("2024-01-05");
  });

  it("aggregateHoldings shim preserves TickerPosition shape and drops sold-out symbols", () => {
    const holdings: Holding[] = [
      h("1", "AAPL", 10, 100, "2024-01-01"),
      sell("S", "AAPL", 10, "2024-01-05"),
      h("2", "MSFT", 5, 400, "2024-02-10"),
    ];
    const res = aggregateHoldings(holdings);
    expect(res).toHaveLength(1);
    expect(res[0].symbol).toBe("MSFT");
    expect(res[0].lots).toBeDefined();
    expect(res[0].cost).toBeCloseTo(2000);
    expect(res[0].firstDate).toBe("2024-02-10");
  });
});
