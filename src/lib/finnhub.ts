"use server";

/**
 * Live quote fetcher backed by Yahoo Finance's batch quote endpoint.
 *
 * Why Yahoo (not Finnhub anymore): one HTTP call returns N symbols, so a
 * portfolio with 20 tickers no longer burns 20 requests. Server-side cached
 * for 30s, so repeat navigations during a burst don't re-hit upstream.
 *
 * The endpoint is unofficial — same caveat as src/lib/yahoo.ts. If this
 * breaks, swap to Twelve Data.
 */

export interface StockQuote {
  c: number; // Current price
  d: number; // Change
  dp: number; // Percent change
  h: number; // High price of the day
  l: number; // Low price of the day
  o: number; // Open price of the day
  pc: number; // Previous close
}

interface YahooQuoteRow {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketOpen?: number;
  regularMarketPreviousClose?: number;
}

function toQuote(row: YahooQuoteRow): StockQuote {
  const c = row.regularMarketPrice ?? 0;
  const pc = row.regularMarketPreviousClose ?? c;
  return {
    c,
    d: row.regularMarketChange ?? c - pc,
    dp:
      row.regularMarketChangePercent ??
      (pc > 0 ? ((c - pc) / pc) * 100 : 0),
    h: row.regularMarketDayHigh ?? c,
    l: row.regularMarketDayLow ?? c,
    o: row.regularMarketOpen ?? c,
    pc,
  };
}

async function fetchV7Batch(
  symbols: string[]
): Promise<Map<string, StockQuote>> {
  if (symbols.length === 0) return new Map();
  const url =
    `https://query1.finance.yahoo.com/v7/finance/quote` +
    `?symbols=${encodeURIComponent(symbols.join(","))}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    next: { revalidate: 30 },
  });
  if (!res.ok) throw new Error(`Yahoo quote ${res.status}`);
  const data = await res.json();
  const rows: YahooQuoteRow[] = data?.quoteResponse?.result ?? [];
  const out = new Map<string, StockQuote>();
  for (const row of rows) out.set(row.symbol, toQuote(row));
  return out;
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
    if (!res.ok) return null;
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return null;
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
  } catch {
    return null;
  }
}

export async function getQuotes(
  symbols: string[]
): Promise<Record<string, StockQuote | null>> {
  if (symbols.length === 0) return {};
  const uniq = Array.from(new Set(symbols));
  const out: Record<string, StockQuote | null> = {};
  try {
    const batch = await fetchV7Batch(uniq);
    for (const s of uniq) out[s] = batch.get(s) ?? null;
  } catch {
    // Fall through to per-symbol fallback
  }
  const missing = uniq.filter((s) => !out[s]);
  if (missing.length > 0) {
    const fallback = await Promise.all(missing.map((s) => fetchV8Single(s)));
    missing.forEach((s, i) => {
      out[s] = fallback[i];
    });
  }
  return out;
}

export async function getQuote(symbol: string): Promise<StockQuote | null> {
  const all = await getQuotes([symbol]);
  return all[symbol] ?? null;
}
