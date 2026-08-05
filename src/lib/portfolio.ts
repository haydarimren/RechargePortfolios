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

/**
 * Chronological order for pool replay. `purchaseDate` is stored date-only
 * (broker sync drops the intraday time), so a same-day BUY and SELL collapse
 * to one date. Within a date we apply BUYs before SELLs: a sale can only
 * dispose of shares held on that day, including the day's own purchases, and
 * the createdAt fallback reflects sync *write* order — not execution order —
 * so it can't be trusted to put the buy first. Without this, a same-day
 * round-trip whose sell doc was written first would hit the empty pool, get
 * ignored, and leave the buy as a phantom open position. (This only orders
 * the day's buys ahead of its sells within the single average-cost pool — it
 * is NOT HMRC same-day *lot* matching; the pool stays blended.) createdAt
 * only breaks ties within a side.
 */
function sortForPool(holdings: Holding[]): Holding[] {
  const sideRank = (h: Holding) => ((h.side ?? "BUY") === "SELL" ? 1 : 0);
  return holdings.slice().sort((a, b) => {
    if (a.purchaseDate !== b.purchaseDate) {
      return a.purchaseDate.localeCompare(b.purchaseDate);
    }
    if (sideRank(a) !== sideRank(b)) {
      return sideRank(a) - sideRank(b);
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
 * The broker's position snapshot is the authoritative answer to "how
 * many shares does he hold right now" — it already reflects every sale.
 * The order history we import from SnapTrade is only a partial,
 * sometimes mis-dated window, so the Section-104 pool over the stored
 * lots can disagree with the truth: a real sale may have been dropped
 * during import, mis-sided, or (as a synthesized position) stamped with
 * the sync date so it sorts after — and thus erases — an earlier real
 * sell.
 *
 * Rather than trust the derived lot math for the *current* count, this
 * returns a single adjustment lot that, appended to the symbol's
 * holdings, forces `poolPositions` to land exactly on the broker's
 * units — independent of which upstream step lost the sale. It sorts
 * strictly last so it corrects the FINAL pool and can never be
 * pre-empted by a mis-dated lot. Returns null when the stored holdings
 * already pool to the target (no adjustment needed).
 */
export function reconcileToPositionUnits(
  holdings: Holding[],
  symbol: string,
  targetUnits: number,
  opts: { price: number; date: string; id: string },
): Holding | null {
  const current =
    poolPositions(holdings).find((p) => p.symbol === symbol)?.shares ?? 0;
  const delta = targetUnits - current;
  if (Math.abs(delta) <= 1e-6) return null;
  return {
    id: opts.id,
    symbol,
    shares: Math.abs(delta),
    purchasePrice: opts.price,
    purchaseDate: opts.date,
    side: delta > 0 ? "BUY" : "SELL",
    createdAt: Number.MAX_SAFE_INTEGER,
  };
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
  /**
   * Deployed cost basis of the lots open on this day (Σ remainingShares
   * × purchasePrice). The denominator for `normalizeSeries`'s
   * return-on-invested-capital math. Present on the absolute series from
   * `buildComparisonSeries`; stripped from the normalized output.
   */
  cost?: number;
  [benchKey: string]: number | string | undefined;
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
    let cost = 0;
    const benchValues: Record<string, number> = {};
    for (const key of benchKeys) benchValues[key] = 0;

    for (const lot of openLots) {
      const prices = pricesBySymbol[lot.symbol];
      const c =
        prices && prices.length > 0 ? closeOnOrBefore(prices, bp.date) : null;
      // Skip any holding we can't price (e.g. an option contract
      // SnapTrade reports but Yahoo has no equity quote for). It must be
      // excluded from ALL three sums — portfolio value, deployed cost,
      // and the benchmark "hypothetical" — to keep them consistent.
      // Counting an un-priceable lot's cost in the benchmark sum while
      // the portfolio value (which needs a price) skipped it made the
      // benchmark line spike by that lot's full cost whenever such a
      // position was briefly held (see the regression test). Excluding it
      // everywhere keeps the comparison equities-only and consistent.
      if (c == null) continue;
      port += lot.remainingShares * c;
      const lotCostStillOpen = lot.remainingShares * lot.purchasePrice;
      // Deployed capital this day — the denominator for the
      // return-on-invested-capital normalization. Over the same priced
      // lots as `port` so the two stay consistent.
      cost += lotCostStillOpen;
      for (const key of benchKeys) {
        const basis = closeOnOrBefore(benchmarks[key], lot.purchaseDate);
        if (!basis || basis <= 0) continue;
        const bClose = closeOnOrBefore(benchmarks[key], bp.date);
        if (bClose == null) continue;
        benchValues[key] += lotCostStillOpen * (bClose / basis);
      }
    }
    out.push({ date: bp.date, portfolio: port, cost, ...benchValues });
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

  const sorted = sortForPool(holdings);

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
 * Convert an absolute-value comparison series into %-return form, as
 * **return on deployed capital**: each day's portfolio market value (and
 * each benchmark's same-cost-deployed value) is divided by that day's
 * cost basis, minus one.
 *
 *   portfolio%(t) = (marketValue(t) / costDeployed(t) − 1) × 100
 *   benchmark%(t) = (sameCostInBenchmark(t) / costDeployed(t) − 1) × 100
 *
 * Why per-day cost and not a fixed first-day base: a portfolio is built
 * up over the charted window (deposits, staggered buys), so its market
 * value grows from *capital inflows*, not just returns. Dividing by the
 * value on a single early day — when maybe one small lot or a cash
 * position was all that was held — turns those inflows into nonsense
 * thousand-percent "returns" (the share-link chart bug). Normalizing
 * against deployed capital makes every line start at 0%, immune to
 * deposits, and apples-to-apples with the benchmark's "same dollars into
 * SPY" framing — the same basis as the "vs cost" headline.
 *
 * Used by the shared-viewer chart (owner's friend view) and stored into
 * the share-link snapshot, so both inherit identical behavior.
 */
export function normalizeSeries(series: SeriesPoint[]): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let started = false;
  for (const p of series) {
    const cost = typeof p.cost === "number" ? p.cost : 0;
    // Skip leading days before any capital is both deployed AND priced
    // (e.g. a cash-only or not-yet-priced opening stretch) so the line
    // doesn't begin with a spurious −100% dip.
    if (!started) {
      if (cost <= EPS || p.portfolio <= EPS) continue;
      started = true;
    }
    if (cost <= EPS) continue;
    const point: SeriesPoint = {
      date: p.date,
      portfolio: (p.portfolio / cost - 1) * 100,
    };
    const spy = typeof p.SPY === "number" ? p.SPY : null;
    const qqq = typeof p.QQQ === "number" ? p.QQQ : null;
    if (spy !== null) point.SPY = (spy / cost - 1) * 100;
    if (qqq !== null) point.QQQ = (qqq / cost - 1) * 100;
    out.push(point);
  }
  return out;
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

/** Newest-first slice for the logbook preview card. `buildTradeLog` already
 *  returns newest-first, but this sorts unconditionally so the preview never
 *  depends on the caller's ordering contract. Stable sort keeps same-day
 *  entries in their existing relative order. */
export function pickRecentTrades(
  log: TradeLogEntry[],
  n: number,
): TradeLogEntry[] {
  return log.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, n);
}
