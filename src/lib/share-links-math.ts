/**
 * Pure math for share-link snapshots. No Firebase imports — everything
 * here is unit-testable and shared between the snapshot publisher
 * (owner side) and the public /s/ page (viewer side).
 *
 * PRIVACY HARD RULE: SnapshotV1 carries percentages and per-share
 * baselines only. Never shares, lot dates, dollar totals, broker
 * fields, or currency amounts. The leak test in share-links-math.test.ts
 * enforces the whitelist — extend it deliberately or not at all.
 */

import { poolPositions, type SeriesPoint } from "./portfolio";
import type { Holding } from "./types";
import type { StockQuote } from "./finnhub";
import type { HistoricalPoint } from "./yahoo";

export interface SnapshotPosition {
  symbol: string;
  /** Yahoo query symbol when it differs (e.g. VUAA.L). */
  yahooSymbol?: string;
  /** Cost-basis weight, % of total cost. */
  weightPct: number;
  /** Section-104 pool average cost per share — the live-% baseline.
   *  Equivalent information to a published gain % (price/(1+gain%)),
   *  reveals price paid per share, never position size. */
  avgCost: number;
}

export interface SnapshotV1 {
  schemaVersion: 1;
  name: string;
  ownerName: string;
  asOf: number; // Unix ms
  positions: SnapshotPosition[];
  /** Normalized %-return curve (normalizeSeries output) up to asOf. */
  series: SeriesPoint[];
}

export function buildSnapshotV1(input: {
  name: string;
  ownerName: string;
  holdings: Holding[];
  normalizedSeries: SeriesPoint[];
  asOf: number;
}): SnapshotV1 {
  const pooled = poolPositions(input.holdings);
  const totalCost = pooled.reduce((a, p) => a + p.shares * p.avgPrice, 0);
  const yahooBySymbol = new Map<string, string>();
  for (const h of input.holdings) {
    if (h.yahooSymbol && !yahooBySymbol.has(h.symbol)) {
      yahooBySymbol.set(h.symbol, h.yahooSymbol);
    }
  }
  const positions: SnapshotPosition[] = pooled.map((p) => {
    const ys = yahooBySymbol.get(p.symbol);
    return {
      symbol: p.symbol,
      ...(ys && ys !== p.symbol ? { yahooSymbol: ys } : {}),
      weightPct: totalCost > 0 ? ((p.shares * p.avgPrice) / totalCost) * 100 : 0,
      avgCost: p.avgPrice,
    };
  });
  return {
    schemaVersion: 1,
    name: input.name,
    ownerName: input.ownerName,
    asOf: input.asOf,
    positions,
    series: input.normalizedSeries,
  };
}

export interface LiveRow {
  symbol: string;
  allocationPct: number | null;
  gainPct: number | null;
}

/**
 * Live per-position percentages from baselines + quotes. Must produce
 * numbers identical to the friend view's `nonOwnerRows`:
 *   marketᵢ ∝ weightPctᵢ × Pᵢ/avgCostᵢ   (∝ sharesᵢ × Pᵢ)
 *   gain%ᵢ  = (Pᵢ − avgCostᵢ)/avgCostᵢ
 * Quotes are keyed by display symbol (the caller re-keys, mirroring
 * every existing page). Positions without a quote get nulls and are
 * excluded from the allocation denominator.
 */
export function liveRowsFromSnapshot(
  snap: SnapshotV1,
  quotes: Record<string, StockQuote | null>,
): LiveRow[] {
  const markets = snap.positions.map((p) => {
    const q = quotes[p.symbol];
    if (!q || p.avgCost <= 0) return null;
    return p.weightPct * (q.c / p.avgCost);
  });
  const totalMarket = markets.reduce<number>((a, m) => (m !== null ? a + m : a), 0);
  return snap.positions
    .map((p, i) => {
      const q = quotes[p.symbol];
      const m = markets[i];
      return {
        symbol: p.symbol,
        allocationPct:
          m !== null && totalMarket > 0 ? (m / totalMarket) * 100 : null,
        gainPct:
          q && p.avgCost > 0 ? ((q.c - p.avgCost) / p.avgCost) * 100 : null,
      };
    })
    .sort((a, b) => (b.allocationPct ?? -1) - (a.allocationPct ?? -1));
}

/**
 * Headline gain % — parity with the viewer hero's `totals.gainPct`:
 * cost sums ALL positions, market sums only quoted ones (the friend
 * view has always behaved this way).
 */
export function headlineFromSnapshot(
  snap: SnapshotV1,
  quotes: Record<string, StockQuote | null>,
): { gainPct: number } {
  let cost = 0;
  let market = 0;
  for (const p of snap.positions) {
    cost += p.weightPct;
    const q = quotes[p.symbol];
    if (q && p.avgCost > 0) market += p.weightPct * (q.c / p.avgCost);
  }
  return { gainPct: cost > 0 ? ((market - cost) / cost) * 100 : 0 };
}

/**
 * Extend the snapshot's normalized curve from asOf to today using
 * public closes, chained to be continuous at the last snapshot point.
 * For t > asOf:
 *   portfolioIdx(t) = Σ weightPctᵢ × closeᵢ(t)/avgCostᵢ
 *   portfolio%(t)   = ((1 + last%/100) × portfolioIdx(t)/portfolioIdx(asOf) − 1) × 100
 * and the same single-series chaining for SPY/QQQ. Valid because the
 * composition cannot have changed since asOf — every holdings mutation
 * republishes the snapshot. Returns the extension INCLUDING a restated
 * last snapshot point (so callers can concat series.slice(0,-1) + this).
 */
export function extendSeries(
  snap: SnapshotV1,
  pricesBySymbol: Record<string, HistoricalPoint[]>,
  benchmarks: { SPY: HistoricalPoint[]; QQQ: HistoricalPoint[] },
): SeriesPoint[] {
  if (snap.series.length === 0) return [];
  const last = snap.series[snap.series.length - 1];
  const closeOnOrBefore = (pts: HistoricalPoint[], date: string): number | null => {
    let best: number | null = null;
    for (const p of pts) {
      if (p.date <= date) best = p.close;
      else break;
    }
    return best;
  };
  const portfolioIdx = (date: string): number => {
    let idx = 0;
    for (const p of snap.positions) {
      const pts = pricesBySymbol[p.yahooSymbol ?? p.symbol];
      if (!pts || p.avgCost <= 0) continue;
      const c = closeOnOrBefore(pts, date);
      if (c !== null) idx += p.weightPct * (c / p.avgCost);
    }
    return idx;
  };

  const baseIdx = portfolioIdx(last.date);
  const spyBase = closeOnOrBefore(benchmarks.SPY, last.date);
  const qqqBase = closeOnOrBefore(benchmarks.QQQ, last.date);
  const lastSpy = typeof last.SPY === "number" ? last.SPY : null;
  const lastQqq = typeof last.QQQ === "number" ? last.QQQ : null;

  const out: SeriesPoint[] = [{ ...last }];
  for (const bp of benchmarks.SPY) {
    if (bp.date <= last.date) continue;
    const point: SeriesPoint = { date: bp.date, portfolio: last.portfolio };
    if (baseIdx > 0) {
      const idx = portfolioIdx(bp.date);
      point.portfolio = ((1 + last.portfolio / 100) * (idx / baseIdx) - 1) * 100;
    }
    if (lastSpy !== null && spyBase) {
      point.SPY = ((1 + lastSpy / 100) * (bp.close / spyBase) - 1) * 100;
    }
    if (lastQqq !== null && qqqBase) {
      const qc = closeOnOrBefore(benchmarks.QQQ, bp.date);
      if (qc !== null) point.QQQ = ((1 + lastQqq / 100) * (qc / qqqBase) - 1) * 100;
    }
    out.push(point);
  }
  return out;
}
