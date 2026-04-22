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
    const c: number = meta.regularMarketPrice ?? 0;
    const pc: number = meta.chartPreviousClose ?? meta.previousClose ?? c;
    return {
      c,
      d: c - pc,
      dp: pc > 0 ? ((c - pc) / pc) * 100 : 0,
      h: meta.regularMarketDayHigh ?? c,
      l: meta.regularMarketDayLow ?? c,
      o: c,
      pc,
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
  uniq.forEach((s, i) => {
    out[s] = results[i];
  });
  return out;
}

export async function getQuote(symbol: string): Promise<StockQuote | null> {
  const all = await getQuotes([symbol]);
  return all[symbol] ?? null;
}
