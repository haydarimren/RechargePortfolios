import { describe, it, expect } from "vitest";
import {
  aggregateHoldings,
  closeOnOrBefore,
  fmtShares,
  buildComparisonSeries,
  normalizeSeries,
  poolPositions,
  reconcileToPositionUnits,
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

  it("excludes un-priceable holdings (e.g. options) from BOTH portfolio and benchmark sums", () => {
    // Regression: a holding whose symbol has no Yahoo price data (an
    // option contract SnapTrade reports, etc.) was skipped from the
    // portfolio value but still counted in the benchmark "hypothetical"
    // cost sum. A large such position held briefly spiked the benchmark
    // line by its full cost (~$900k in the reported chart) while the
    // portfolio line stayed flat, then snapped back when it was sold.
    const day = (d: string, c: number): HistoricalPoint => ({ date: d, close: c });
    const flat = (c: number) =>
      ["2026-04-14", "2026-04-15", "2026-04-16", "2026-04-17", "2026-04-18", "2026-04-19", "2026-04-20", "2026-04-21"].map(
        (d) => day(d, c)
      );
    const holdings: Holding[] = [
      h("EQ", "AAPL", 1000, 100, "2026-04-14"), // priced equity, held throughout
      h("OPT", "AAPL260619C", 1000, 800, "2026-04-18"), // big, NO Yahoo price
      sell("OPTSELL", "AAPL260619C", 1000, "2026-04-20"), // sold two days later
    ];
    const series = buildComparisonSeries(
      holdings,
      { AAPL: flat(100) }, // note: no AAPL260619C price series
      { SPY: flat(700) }
    );
    const at = (d: string) => series.find((s) => s.date === d)!;
    // AAPL alone: 1000 × $100 = $100k, benchmark cost 100k × 1 = $100k.
    // The un-priceable option lot must appear in NEITHER line.
    expect(at("2026-04-17").SPY).toBeCloseTo(100000);
    expect(at("2026-04-18").portfolio).toBeCloseTo(100000);
    expect(at("2026-04-18").SPY).toBeCloseTo(100000); // was $900k before the fix
    expect(at("2026-04-19").SPY).toBeCloseTo(100000);
    expect(at("2026-04-21").SPY).toBeCloseTo(100000);
    // Cost basis denominator likewise excludes the un-priceable lot.
    expect(at("2026-04-18").cost).toBeCloseTo(100000);
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

describe("normalizeSeries — return on deployed capital", () => {
  // Build a flat daily price series so the math is hand-checkable.
  const daily = (
    from: string,
    to: string,
    close: number
  ): HistoricalPoint[] => {
    const out: HistoricalPoint[] = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
      out.push({ date: d.toISOString().slice(0, 10), close });
      d.setDate(d.getDate() + 1);
    }
    return out;
  };

  it("emits per-day deployed cost from buildComparisonSeries", () => {
    const holdings: Holding[] = [
      h("L1", "AAPL", 10, 100, "2024-01-02"), // cost 1000
      h("L2", "MSFT", 5, 200, "2024-01-04"), // cost 1000, opens later
    ];
    const series = buildComparisonSeries(
      holdings,
      {
        AAPL: daily("2024-01-02", "2024-01-05", 100),
        MSFT: daily("2024-01-02", "2024-01-05", 200),
      },
      { SPY: daily("2024-01-02", "2024-01-05", 400) }
    );
    // 01-02: only AAPL deployed → cost 1000. 01-04 on: both → 2000.
    expect(series.find((s) => s.date === "2024-01-02")!.cost).toBeCloseTo(1000);
    expect(series.find((s) => s.date === "2024-01-04")!.cost).toBeCloseTo(2000);
  });

  it("does NOT explode for a portfolio built up over the window (regression)", () => {
    // The reported bug: a tiny cash position funded first, equities bought
    // two weeks later. Normalizing market value against the day-0 value
    // turned capital inflows into thousands-of-percent 'returns'.
    const holdings: Holding[] = [
      h("CASH", "SPAXX", 50, 1, "2026-01-02"), // $50 cash, flat $1
      h("EQ", "AAPL", 10, 100, "2026-01-16"), // $1000 equity, two weeks later
    ];
    const series = buildComparisonSeries(
      holdings,
      {
        SPAXX: daily("2025-12-19", "2026-01-30", 1),
        AAPL: daily("2025-12-19", "2026-01-30", 110), // +10% vs cost
      },
      { SPY: daily("2025-12-19", "2026-01-30", 500) } // flat → 0% benchmark
    );
    const norm = normalizeSeries(series);
    const last = norm[norm.length - 1];

    // Return on deployed capital: cost = 1050, value = 50 + 1100 = 1150.
    expect(last.portfolio).toBeCloseTo(((1150 - 1050) / 1050) * 100, 4); // ≈ +9.52%
    // Flat SPY over the window → 0% benchmark return.
    expect(last.SPY as number).toBeCloseTo(0, 4);
    // The load-bearing guard: nowhere near the old +2000% explosion.
    for (const p of norm) {
      expect(Math.abs(p.portfolio)).toBeLessThan(100);
    }
  });

  it("both lines start at 0% on the first invested day", () => {
    const holdings: Holding[] = [h("L1", "AAPL", 10, 100, "2026-02-02")];
    const series = buildComparisonSeries(
      holdings,
      { AAPL: daily("2026-01-19", "2026-02-10", 100) },
      { SPY: daily("2026-01-19", "2026-02-10", 400) }
    );
    const norm = normalizeSeries(series);
    expect(norm[0].portfolio).toBeCloseTo(0, 6);
    expect(norm[0].SPY as number).toBeCloseTo(0, 6);
  });

  it("returns [] for an empty series", () => {
    expect(normalizeSeries([])).toEqual([]);
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

describe("reconcileToPositionUnits", () => {
  const opts = { price: 50, date: "2026-05-18", id: "pos-recon-ACC-PANW" };

  it("forces the pooled net to the broker units when a sell was lost upstream", () => {
    // The real sale never made it into stored holdings (dropped during
    // import). Only a BUY 100 is on file; the broker says he holds 40.
    const stored = [h("b1", "PANW", 100, 50, "2026-05-10")];
    const adj = reconcileToPositionUnits(stored, "PANW", 40, opts);
    expect(adj).not.toBeNull();
    const net =
      poolPositions([...stored, adj!]).find((p) => p.symbol === "PANW")
        ?.shares ?? 0;
    expect(net).toBeCloseTo(40, 6);
  });

  it("forces the net even when a real sell sorts before a sync-dated buy", () => {
    // The exact reported bug shape: a real SELL dated earlier than a
    // synthesized BUY stamped with the sync day. Section-104 drops the
    // pre-buy sell, so the naive pooled net is wrong (100). The
    // reconciler must still land the displayed net on the broker truth.
    const stored = [
      sell("s1", "PANW", 60, "2026-05-15"),
      h("synth", "PANW", 100, 50, "2026-05-18"),
    ];
    const adj = reconcileToPositionUnits(stored, "PANW", 40, opts);
    const net =
      poolPositions(adj ? [...stored, adj] : stored).find(
        (p) => p.symbol === "PANW",
      )?.shares ?? 0;
    expect(net).toBeCloseTo(40, 6);
  });

  it("returns null when the stored net already equals the broker units", () => {
    const stored = [h("b1", "PANW", 40, 50, "2026-05-10")];
    expect(reconcileToPositionUnits(stored, "PANW", 40, opts)).toBeNull();
  });

  it("emits a BUY adjustment when the broker holds more than is stored", () => {
    const stored = [h("b1", "PANW", 40, 50, "2026-05-10")];
    const adj = reconcileToPositionUnits(stored, "PANW", 70, opts);
    expect(adj?.side).toBe("BUY");
    const net =
      poolPositions([...stored, adj!]).find((p) => p.symbol === "PANW")
        ?.shares ?? 0;
    expect(net).toBeCloseTo(70, 6);
  });
});
