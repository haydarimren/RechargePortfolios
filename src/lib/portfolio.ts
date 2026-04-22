import { Holding, TradeLogEntry } from "./types";
import { HistoricalPoint } from "./yahoo";

export interface TickerPosition {
  symbol: string;
  lots: Holding[];
  shares: number;
  cost: number;
  avgPrice: number;
  firstDate: string;
}

const EPS = 1e-9;

export interface PooledLot {
  purchaseDate: string;
  purchasePrice: number;
  originalShares: number;
  remainingShares: number;
}

export interface PooledPosition {
  symbol: string;
  shares: number;
  avgPrice: number;
  firstPurchaseDate: string;
  remainingLots: PooledLot[];
}

interface PoolState {
  totalShares: number;
  totalCost: number;
  lots: PooledLot[];
  firstBuyDate: string | null;
}

function emptyPool(): PoolState {
  return { totalShares: 0, totalCost: 0, lots: [], firstBuyDate: null };
}

/**
 * Apply a single holding (buy or sell) to the pool, mutating in place.
 * Sells consume the pool at weighted-avg cost and scale all open lots
 * proportionally. Oversells clamp to zero; sells with no stock are ignored.
 */
function applyToPool(pool: PoolState, h: Holding): void {
  const side = h.side ?? "BUY";
  if (side === "BUY") {
    pool.totalShares += h.shares;
    pool.totalCost += h.shares * h.purchasePrice;
    pool.lots.push({
      purchaseDate: h.purchaseDate,
      purchasePrice: h.purchasePrice,
      originalShares: h.shares,
      remainingShares: h.shares,
    });
    if (pool.firstBuyDate === null || h.purchaseDate < pool.firstBuyDate) {
      pool.firstBuyDate = h.purchaseDate;
    }
    return;
  }

  // SELL
  if (pool.totalShares <= EPS) return; // nothing to sell — ignore
  const sellShares = Math.min(h.shares, pool.totalShares);
  const avgCost = pool.totalCost / pool.totalShares;
  const before = pool.totalShares;
  pool.totalShares = before - sellShares;
  pool.totalCost -= sellShares * avgCost;
  // Guard against negative float drift
  if (pool.totalShares < EPS) {
    pool.totalShares = 0;
    pool.totalCost = 0;
    for (const lot of pool.lots) lot.remainingShares = 0;
    return;
  }
  const scale = pool.totalShares / before;
  for (const lot of pool.lots) {
    lot.remainingShares = lot.remainingShares * scale;
  }
}

function sortForPool(holdings: Holding[]): Holding[] {
  return holdings.slice().sort((a, b) => {
    if (a.purchaseDate !== b.purchaseDate) {
      return a.purchaseDate.localeCompare(b.purchaseDate);
    }
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

/**
 * Section 104 average-cost pooling. Buys add to the pool; sells consume it
 * at the weighted average cost and proportionally scale every open buy lot.
 * Symbols fully sold out are dropped from the result.
 */
export function poolPositions(holdings: Holding[]): PooledPosition[] {
  const bySymbol = new Map<string, Holding[]>();
  for (const h of holdings) {
    const arr = bySymbol.get(h.symbol) ?? [];
    arr.push(h);
    bySymbol.set(h.symbol, arr);
  }

  const out: PooledPosition[] = [];
  for (const [symbol, lots] of bySymbol) {
    const pool = emptyPool();
    for (const h of sortForPool(lots)) applyToPool(pool, h);

    if (pool.totalShares <= EPS || pool.firstBuyDate === null) continue;

    const remainingLots = pool.lots.filter((l) => l.remainingShares > EPS);
    out.push({
      symbol,
      shares: pool.totalShares,
      avgPrice: pool.totalCost / pool.totalShares,
      firstPurchaseDate: pool.firstBuyDate,
      remainingLots,
    });
  }

  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * Legacy shim used by existing UI callers. Preserves the `TickerPosition`
 * interface shape (including `lots`, `cost`, `firstDate`). Symbols fully
 * sold out are dropped.
 */
export function aggregateHoldings(holdings: Holding[]): TickerPosition[] {
  const pooled = poolPositions(holdings);
  const bySymbol = new Map<string, Holding[]>();
  for (const h of holdings) {
    const arr = bySymbol.get(h.symbol) ?? [];
    arr.push(h);
    bySymbol.set(h.symbol, arr);
  }
  return pooled.map((p) => {
    const rawLots = sortForPool(bySymbol.get(p.symbol) ?? []);
    return {
      symbol: p.symbol,
      lots: rawLots,
      shares: p.shares,
      cost: p.shares * p.avgPrice,
      avgPrice: p.avgPrice,
      firstDate: p.firstPurchaseDate,
    };
  });
}

/**
 * Returns the most recent close on-or-before the given YYYY-MM-DD date.
 * Points must be sorted ascending by date.
 */
export function closeOnOrBefore(
  points: HistoricalPoint[],
  date: string
): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let best: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].date <= date) {
      best = points[mid].close;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

export interface SeriesPoint {
  date: string;
  portfolio: number;
  [benchKey: string]: number | string;
}

interface LotWithSymbol extends PooledLot {
  symbol: string;
}

/**
 * Build a daily timeline comparing portfolio market value to one or more
 * hypothetical benchmarks. For each date D we replay the Section 104 pool
 * over transactions with purchaseDate <= D, then:
 *   portfolio(D) = Σ remainingShares × price(symbol, D) across all open lots
 *   bench_k(D)   = Σ (remainingShares × lot.purchasePrice) × bench_k(D)/bench_k(lotDate)
 *
 * This keeps the benchmark comparison apples-to-apples after partial sells:
 * only the still-invested portion of each lot tracks the benchmark.
 */
export function buildComparisonSeries(
  holdings: Holding[],
  pricesBySymbol: Record<string, HistoricalPoint[]>,
  benchmarks: Record<string, HistoricalPoint[]>
): SeriesPoint[] {
  const benchKeys = Object.keys(benchmarks);
  if (holdings.length === 0 || benchKeys.length === 0) return [];

  const primary = benchmarks[benchKeys[0]];
  if (!primary || primary.length === 0) return [];

  const bySymbol = new Map<string, Holding[]>();
  for (const h of holdings) {
    const arr = bySymbol.get(h.symbol) ?? [];
    arr.push(h);
    bySymbol.set(h.symbol, arr);
  }

  // Per-symbol chronologically sorted transaction lists + an index cursor
  // that advances as we walk dates, so we only reapply new transactions.
  const symbols = Array.from(bySymbol.keys());
  const sortedBySymbol = new Map<string, Holding[]>();
  for (const sym of symbols) {
    sortedBySymbol.set(sym, sortForPool(bySymbol.get(sym)!));
  }

  let firstDate: string | null = null;
  for (const h of holdings) {
    if (h.side === "SELL") continue;
    if (firstDate === null || h.purchaseDate < firstDate) {
      firstDate = h.purchaseDate;
    }
  }
  if (firstDate === null) return [];

  const pools = new Map<string, PoolState>();
  const cursors = new Map<string, number>();
  for (const sym of symbols) {
    pools.set(sym, emptyPool());
    cursors.set(sym, 0);
  }

  const out: SeriesPoint[] = [];
  for (const bp of primary) {
    if (bp.date < firstDate) continue;

    // Advance each symbol's pool through all transactions with purchaseDate <= bp.date
    for (const sym of symbols) {
      const txs = sortedBySymbol.get(sym)!;
      let i = cursors.get(sym)!;
      const pool = pools.get(sym)!;
      while (i < txs.length && txs[i].purchaseDate <= bp.date) {
        applyToPool(pool, txs[i]);
        i++;
      }
      cursors.set(sym, i);
    }

    // Snapshot open lots with their symbol for valuation
    const openLots: LotWithSymbol[] = [];
    for (const sym of symbols) {
      const pool = pools.get(sym)!;
      for (const lot of pool.lots) {
        if (lot.remainingShares > EPS) {
          openLots.push({ ...lot, symbol: sym });
        }
      }
    }

    let port = 0;
    const benchValues: Record<string, number> = {};
    for (const key of benchKeys) benchValues[key] = 0;

    for (const lot of openLots) {
      const prices = pricesBySymbol[lot.symbol];
      if (prices && prices.length > 0) {
        const c = closeOnOrBefore(prices, bp.date);
        if (c != null) port += lot.remainingShares * c;
      }
      const lotCostStillOpen = lot.remainingShares * lot.purchasePrice;
      for (const key of benchKeys) {
        const basis = closeOnOrBefore(benchmarks[key], lot.purchaseDate);
        if (!basis || basis <= 0) continue;
        const bClose = closeOnOrBefore(benchmarks[key], bp.date);
        if (bClose == null) continue;
        benchValues[key] += lotCostStillOpen * (bClose / basis);
      }
    }
    out.push({ date: bp.date, portfolio: port, ...benchValues });
  }
  return out;
}

/**
 * Build a chronological trade log from raw holding docs. Each holding doc
 * (BUY or SELL) becomes one entry. Sell rows are annotated with realized
 * P&L computed from the Section 104 pool at the moment of the sale — same
 * pool math as `poolPositions`, just recorded per-event instead of collapsed
 * to a final snapshot.
 *
 * `symbolWeightAfter` on each entry gives the symbol's cost-basis share of
 * the whole portfolio *after* the event, so the shared-viewer UI can show
 * "how big is this position now" without leaking absolute dollar amounts.
 *
 * Returned newest-first.
 */
export function buildTradeLog(holdings: Holding[]): TradeLogEntry[] {
  if (holdings.length === 0) return [];

  const sorted = holdings.slice().sort((a, b) => {
    if (a.purchaseDate !== b.purchaseDate) {
      return a.purchaseDate.localeCompare(b.purchaseDate);
    }
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });

  const pool = new Map<string, { shares: number; cost: number }>();
  let totalCost = 0;
  const out: TradeLogEntry[] = [];

  for (const h of sorted) {
    const side = h.side ?? "BUY";
    const shares = h.shares;
    const price = h.purchasePrice;
    const value = shares * price;

    const entry: TradeLogEntry = {
      id: h.id,
      date: h.purchaseDate,
      symbol: h.symbol,
      yahooSymbol: h.yahooSymbol,
      side,
      shares,
      price,
      value,
      symbolWeightAfter: 0,
    };

    const p = pool.get(h.symbol) ?? { shares: 0, cost: 0 };

    if (side === "BUY") {
      p.shares += shares;
      p.cost += value;
      totalCost += value;
      pool.set(h.symbol, p);
    } else {
      // SELL — draw from the pool at weighted-average cost
      if (p.shares > EPS) {
        const avgCost = p.cost / p.shares;
        const sellShares = Math.min(shares, p.shares);
        entry.realizedGain = (price - avgCost) * sellShares;
        entry.realizedPct = avgCost > 0 ? (price - avgCost) / avgCost : 0;
        const costReduction = avgCost * sellShares;
        p.shares -= sellShares;
        p.cost -= costReduction;
        totalCost -= costReduction;
        if (p.shares < EPS) {
          p.shares = 0;
          p.cost = 0;
        }
        pool.set(h.symbol, p);
      }
      // else: sell against empty pool — realized fields stay undefined
    }

    entry.symbolWeightAfter = totalCost > EPS ? p.cost / totalCost : 0;
    out.push(entry);
  }

  return out.reverse();
}

/**
 * Format a share count with up to 4 significant fractional digits,
 * trimming trailing zeros. Keeps numeric columns aligned.
 */
export function fmtShares(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}
