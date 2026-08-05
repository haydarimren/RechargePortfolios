"use server";

/**
 * Live quote fetcher backed by Yahoo Finance's v8 chart endpoint.
 *
 * History: we used Yahoo's v7 batch quote endpoint for a while (one call,
 * N symbols). In April 2026 Yahoo locked v7 behind a cookie/crumb handshake
 * and now returns 401 "Unauthorized" to anonymous clients. v8 (chart) still
 * serves quote data unauthenticated, so we fetch per-symbol.
 *
 * To avoid tripping Yahoo's rate limiter on large portfolios we cap in-flight
 * requests via a small semaphore; 30s Next server cache absorbs repeat hits.
 *
 * Unofficial endpoint — if it breaks too, Twelve Data is the documented
 * fallback.
 */

import { normalizeQuoteCurrency } from "./symbol-candidates";
import { repairYahooSymbol } from "./symbol-resolve";
import { derivePreviousClose, type DailyBar } from "./previous-close";

/** Max concurrent Yahoo requests. Empirically 6+ starts hitting 429s. */
const CONCURRENCY = 5;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    worker,
  );
  await Promise.all(workers);
  return out;
}

export interface StockQuote {
  c: number; // Current price
  d: number; // Change
  dp: number; // Percent change
  h: number; // High price of the day
  l: number; // Low price of the day
  o: number; // Open price of the day
  pc: number; // Previous close
  /**
   * Major-unit currency the prices above are quoted in (`GBP`, `EUR`,
   * `USD`, …). Empty when Yahoo didn't say. Callers MUST convert before
   * summing across positions — a portfolio holding one LSE and one Milan
   * listing was previously adding pounds to euros.
   *
   * Prices are already normalized out of Yahoo's minor units, so a `GBp`
   * (pence) quote arrives here as GBP with `c` divided by 100.
   */
  currency: string;
}

async function fetchV8Single(symbol: string): Promise<StockQuote | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=5d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 30 },
    });
    if (!res.ok) {
      console.warn(`Yahoo quote ${symbol}: HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      console.warn(`Yahoo quote ${symbol}: no result in response`);
      return null;
    }
    const meta = result.meta ?? {};
    // Yahoo quotes some venues in minor units (LSE pence come back as
    // `GBp`). Divide those out here so every consumer sees major units
    // and can compare against a broker-reported cost basis.
    const { currency, divisor } = normalizeQuoteCurrency(meta.currency);
    const c: number = (meta.regularMarketPrice ?? 0) / divisor;
    // Previous close comes from the daily bars, NOT `chartPreviousClose` —
    // that field is the close before the whole 5d range, which turned every
    // "today's move" in the UI into a week's move. See previous-close.ts.
    const stamps: unknown = result.timestamp;
    const closes: unknown = result.indicators?.quote?.[0]?.close;
    const bars: DailyBar[] = [];
    if (Array.isArray(stamps) && Array.isArray(closes)) {
      for (let i = 0; i < stamps.length; i++) {
        const ts = stamps[i];
        const close = closes[i];
        if (typeof ts === "number" && typeof close === "number" && isFinite(close)) {
          bars.push({ ts, close: close / divisor });
        }
      }
    }
    const pcFromBars = derivePreviousClose(
      bars,
      typeof meta.regularMarketTime === "number" ? meta.regularMarketTime : 0,
      typeof meta.gmtoffset === "number" ? meta.gmtoffset : 0,
    );
    const pc: number =
      pcFromBars ??
      ((meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPrice ?? 0) /
        divisor || c);
    return {
      c,
      d: c - pc,
      dp: pc > 0 ? ((c - pc) / pc) * 100 : 0,
      h: (meta.regularMarketDayHigh ?? 0) / divisor || c,
      l: (meta.regularMarketDayLow ?? 0) / divisor || c,
      o: c,
      pc,
      currency,
    };
  } catch (err) {
    console.warn(`Yahoo quote ${symbol}: ${(err as Error).message}`);
    return null;
  }
}

export async function getQuotes(
  symbols: string[]
): Promise<Record<string, StockQuote | null>> {
  if (symbols.length === 0) return {};
  const uniq = Array.from(new Set(symbols));
  const results = await mapWithConcurrency(uniq, CONCURRENCY, fetchV8Single);
  const out: Record<string, StockQuote | null> = {};
  const dead: string[] = [];
  uniq.forEach((s, i) => {
    out[s] = results[i];
    if (!results[i]) dead.push(s);
  });

  // Second pass: a symbol that returns nothing is usually not a delisting
  // but a venue mismatch — the broker's ticker heuristic picked a venue
  // Yahoo files under a different symbol (`VNGA80.DE` doesn't exist;
  // `VNGA80.MI` does). Resolve and refetch so the position gets a price
  // without waiting for a re-sync to correct the stored symbol.
  if (dead.length > 0) {
    await mapWithConcurrency(dead, CONCURRENCY, async (s) => {
      const repaired = await repairYahooSymbol(s);
      if (!repaired) return;
      const q = await fetchV8Single(repaired.symbol);
      if (q) out[s] = q;
    });
  }
  return out;
}

export async function getQuote(symbol: string): Promise<StockQuote | null> {
  const all = await getQuotes([symbol]);
  return all[symbol] ?? null;
}
