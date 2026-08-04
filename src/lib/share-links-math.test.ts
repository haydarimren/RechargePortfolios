import { describe, expect, it } from "vitest";
import {
  buildSnapshotV1,
  headlineFromSnapshot,
  liveRowsFromSnapshot,
  extendSeries,
  type SnapshotV1,
} from "./share-links-math";
import { aggregateHoldings } from "./portfolio";
import type { Holding } from "./types";
import type { HistoricalPoint } from "./yahoo";

const h = (over: Partial<Holding>): Holding => ({
  id: Math.random().toString(36).slice(2),
  symbol: "AAPL",
  shares: 1,
  purchasePrice: 100,
  purchaseDate: "2026-01-05",
  createdAt: 1,
  ...over,
});

const HOLDINGS: Holding[] = [
  h({ symbol: "AAPL", shares: 10, purchasePrice: 100, importSource: "trading212", brokerOrderId: "o1", isin: "US0378331005" }),
  h({ symbol: "AAPL", shares: 10, purchasePrice: 200, purchaseDate: "2026-02-05" }),
  h({ symbol: "MSFT", shares: 5, purchasePrice: 400, yahooSymbol: "MSFT" }),
  h({ symbol: "VUAA", shares: 3, purchasePrice: 80, yahooSymbol: "VUAA.L" }),
];

const QUOTES = {
  AAPL: { c: 180, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, currency: "USD" },
  MSFT: { c: 500, d: 0, dp: 0, h: 0, l: 0, o: 0, pc: 0, currency: "USD" },
  // VUAA deliberately has no quote — must render as null like the friend view.
};

function snap(): SnapshotV1 {
  return buildSnapshotV1({
    name: "My Portfolio",
    ownerName: "Haydar",
    holdings: HOLDINGS,
    normalizedSeries: [
      { date: "2026-01-05", portfolio: 0, SPY: 0, QQQ: 0 },
      { date: "2026-03-02", portfolio: 12, SPY: 5, QQQ: 8 },
    ],
    asOf: 1764000000000,
  });
}

describe("buildSnapshotV1 — redaction leak test", () => {
  it("contains only whitelisted keys, recursively", () => {
    const allowed = new Set([
      "schemaVersion", "name", "ownerName", "asOf", "positions", "series",
      "symbol", "yahooSymbol", "weightPct", "avgCost",
      "date", "portfolio", "SPY", "QQQ",
    ]);
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v !== null && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          expect(allowed.has(k), `forbidden key in snapshot: ${k}`).toBe(true);
          walk(val);
        }
      }
    };
    walk(snap());
  });

  it("never carries shares, lot dates, broker fields, or dollar totals", () => {
    const json = JSON.stringify(snap());
    for (const needle of [
      "\"shares\"", "\"purchasePrice\"", "\"purchaseDate\"", "\"side\"",
      "\"importSource\"", "\"brokerOrderId\"", "\"isin\"",
      "\"snaptradeAccountId\"", "\"currency\"", "\"cost\"",
    ]) {
      expect(json.includes(needle), `leaked field ${needle}`).toBe(false);
    }
  });

  it("weights sum to ~100 and avgCost matches the Section-104 pool", () => {
    const s = snap();
    const total = s.positions.reduce((a, p) => a + p.weightPct, 0);
    expect(total).toBeCloseTo(100, 6);
    const aapl = s.positions.find((p) => p.symbol === "AAPL")!;
    expect(aapl.avgCost).toBeCloseTo(150, 6); // (10×100 + 10×200) / 20
  });
});

describe("liveRowsFromSnapshot — parity with the friend view", () => {
  it("matches allocation% and gain% computed from full holdings", () => {
    const rows = liveRowsFromSnapshot(snap(), QUOTES);

    // Reference numbers via the friend-view math (market-value shares).
    const positions = aggregateHoldings(HOLDINGS);
    const totalMarket = positions.reduce((sum, p) => {
      const q = QUOTES[p.symbol as keyof typeof QUOTES];
      return q ? sum + p.shares * q.c : sum;
    }, 0);
    for (const p of positions) {
      const q = QUOTES[p.symbol as keyof typeof QUOTES];
      const row = rows.find((r) => r.symbol === p.symbol)!;
      if (!q) {
        expect(row.allocationPct).toBeNull();
        expect(row.gainPct).toBeNull();
        continue;
      }
      expect(row.gainPct).toBeCloseTo(((q.c - p.avgPrice) / p.avgPrice) * 100, 6);
      expect(row.allocationPct).toBeCloseTo(((p.shares * q.c) / totalMarket) * 100, 6);
    }
  });

  it("sorts by allocation desc with null-quote rows last", () => {
    const rows = liveRowsFromSnapshot(snap(), QUOTES);
    expect(rows[rows.length - 1].symbol).toBe("VUAA");
  });
});

describe("headlineFromSnapshot — parity with the viewer hero", () => {
  it("replicates totals.gainPct (cost over all positions, market over quoted)", () => {
    const positions = aggregateHoldings(HOLDINGS);
    let cost = 0, market = 0;
    for (const p of positions) {
      cost += p.cost;
      const q = QUOTES[p.symbol as keyof typeof QUOTES];
      if (q) market += p.shares * q.c;
    }
    const expected = cost > 0 ? ((market - cost) / cost) * 100 : 0;
    expect(headlineFromSnapshot(snap(), QUOTES).gainPct).toBeCloseTo(expected, 6);
  });
});

describe("extendSeries", () => {
  const SPY: HistoricalPoint[] = [
    { date: "2026-03-02", close: 500 },
    { date: "2026-03-03", close: 510 },
  ];
  const QQQ: HistoricalPoint[] = [
    { date: "2026-03-02", close: 400 },
    { date: "2026-03-03", close: 408 },
  ];
  const PRICES: Record<string, HistoricalPoint[]> = {
    AAPL: [{ date: "2026-03-02", close: 170 }, { date: "2026-03-03", close: 187 }],
    MSFT: [{ date: "2026-03-02", close: 480 }, { date: "2026-03-03", close: 480 }],
    "VUAA.L": [{ date: "2026-03-02", close: 90 }, { date: "2026-03-03", close: 90 }],
  };

  it("is continuous at asOf and chains benchmark returns", () => {
    const s = snap(); // last point 2026-03-02: portfolio 12, SPY 5, QQQ 8
    const out = extendSeries(s, PRICES, { SPY, QQQ });
    // First emitted point re-states the last snapshot point.
    expect(out[0]).toMatchObject({ date: "2026-03-02", portfolio: 12, SPY: 5, QQQ: 8 });
    const next = out[1];
    expect(next.date).toBe("2026-03-03");
    expect(next.SPY).toBeCloseTo(((1 + 0.05) * (510 / 500) - 1) * 100, 6);
    expect(next.QQQ).toBeCloseTo(((1 + 0.08) * (408 / 400) - 1) * 100, 6);
    // Portfolio: index(t) = Σ wᵢ·Pᵢ(t)/avgCostᵢ, chained at asOf.
    const idx = (closes: Record<string, number>) =>
      s.positions.reduce((a, p) => {
        const c = closes[p.yahooSymbol ?? p.symbol];
        return c ? a + p.weightPct * (c / p.avgCost) : a;
      }, 0);
    const i0 = idx({ AAPL: 170, MSFT: 480, "VUAA.L": 90 });
    const i1 = idx({ AAPL: 187, MSFT: 480, "VUAA.L": 90 });
    expect(next.portfolio).toBeCloseTo(((1 + 0.12) * (i1 / i0) - 1) * 100, 6);
  });

  it("returns [] when the snapshot series is empty", () => {
    const s = { ...snap(), series: [] };
    expect(extendSeries(s, PRICES, { SPY, QQQ })).toEqual([]);
  });
});
