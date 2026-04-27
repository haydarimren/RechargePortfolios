export interface Portfolio {
  id: string;
  ownerId: string;
  ownerEmail: string;
  name: string;
  sharedWith: string[];
  createdAt: number;
  brokerKeys?: Record<string, string>;
  /**
   * `true` once the owner has run the one-shot Phase 2 migration. Holdings
   * under this portfolio are stored as `{ payload, iv, createdAt, ... }`
   * ciphertext envelopes and require K_portfolio (read from
   * `wrappedKeys/{uid}`) to decode. Pre-migration portfolios omit this
   * field entirely; the read path treats absence as plaintext mode.
   */
  encrypted?: boolean;
}

export interface Holding {
  id: string;
  symbol: string;
  shares: number;
  purchasePrice: number;
  purchaseDate: string;
  createdAt: number;
  importSource?: string;
  currency?: string;
  t212OrderId?: string;
  /**
   * Transaction side. `undefined` is treated as "BUY" so pre-existing
   * Firestore docs (which predate sell support) keep working without migration.
   */
  side?: "BUY" | "SELL";
  /**
   * ISIN as provided by the broker (e.g. Trading212's instrument metadata).
   * Used to resolve a `yahooSymbol` via OpenFIGI for non-US tickers.
   */
  isin?: string;
  /**
   * Yahoo Finance-compatible symbol (e.g. `VUAA.L` for the London-listed
   * Vanguard S&P 500 UCITS ETF). Falls back to `symbol` when absent.
   */
  yahooSymbol?: string;
}

/**
 * A single trade row for the portfolio-wide logbook. One entry per buy/sell
 * event, ordered newest first. Computed by `buildTradeLog` by replaying all
 * holding docs chronologically through a Section 104 pool per symbol.
 */
export interface TradeLogEntry {
  id: string;
  date: string;               // YYYY-MM-DD
  symbol: string;
  yahooSymbol?: string;
  side: "BUY" | "SELL";
  shares: number;
  price: number;
  value: number;              // shares * price — cost for BUY, proceeds for SELL
  /** Realized P&L in account currency. SELL only. */
  realizedGain?: number;
  /** Realized return vs. pool avg cost at moment of sale. SELL only. */
  realizedPct?: number;
  /**
   * The symbol's cost-basis share of the whole portfolio *after* this event.
   * `pool[symbol].cost / totalPoolCost`. 0 when fully sold or portfolio empty.
   */
  symbolWeightAfter: number;
}
