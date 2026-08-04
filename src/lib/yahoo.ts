"use server";

/**
 * Yahoo Finance chart endpoint — free, no API key, but unofficial.
 * If this starts failing, swap in Twelve Data with minimal changes.
 */

import { normalizeQuoteCurrency } from "./symbol-candidates";
import { repairYahooSymbol } from "./symbol-resolve";

export interface HistoricalPoint {
  date: string; // YYYY-MM-DD
  close: number;
}

export interface HistoricalSeries {
  /**
   * Major-unit currency the closes are quoted in (`GBP`, `EUR`, …).
   * Empty when Yahoo didn't report one. Closes are already divided out
   * of Yahoo's minor units, so a `GBp` (pence) series arrives here in
   * pounds — matching how broker cost bases are stored.
   */
  currency: string;
  points: HistoricalPoint[];
}

const EMPTY: HistoricalSeries = { currency: "", points: [] };

async function fetchSeries(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<HistoricalSeries> {
  const p1 = Math.floor(fromMs / 1000);
  const p2 = Math.floor(toMs / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${p1}&period2=${p2}&interval=1d`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return EMPTY;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return EMPTY;

    const { currency, divisor } = normalizeQuoteCurrency(result.meta?.currency);
    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const points: HistoricalPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      points.push({ date, close: c / divisor });
    }
    return { currency, points };
  } catch (err) {
    console.warn("Yahoo fetch failed for", symbol, err);
    return EMPTY;
  }
}

/**
 * Daily closes for one symbol, plus the currency they're quoted in.
 *
 * An empty result is more often a venue mismatch than a delisting — the
 * broker's ticker heuristic picked a venue Yahoo files under a different
 * symbol — so resolve and retry once before giving up. Same self-heal as
 * `getQuotes`, so the chart and the positions table agree on which
 * symbols are priceable.
 */
export async function getHistoricalSeries(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<HistoricalSeries> {
  const direct = await fetchSeries(symbol, fromMs, toMs);
  if (direct.points.length > 0) return direct;
  const repaired = await repairYahooSymbol(symbol);
  if (!repaired) return direct;
  return fetchSeries(repaired.symbol, fromMs, toMs);
}

/** Closes only — for callers that don't need the quote currency. */
export async function getHistoricalCloses(
  symbol: string,
  fromMs: number,
  toMs: number
): Promise<HistoricalPoint[]> {
  return (await getHistoricalSeries(symbol, fromMs, toMs)).points;
}
