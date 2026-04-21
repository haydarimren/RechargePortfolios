"use server";

/**
 * Yahoo Finance chart endpoint — free, no API key, but unofficial.
 * If this starts failing, swap in Twelve Data with minimal changes.
 */

export interface HistoricalPoint {
  date: string; // YYYY-MM-DD
  close: number;
}

export async function getHistoricalCloses(
  symbol: string,
  fromMs: number,
  toMs: number
): Promise<HistoricalPoint[]> {
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
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp ?? [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
    const out: HistoricalPoint[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i];
      if (c == null) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      out.push({ date, close: c });
    }
    return out;
  } catch (err) {
    console.warn("Yahoo fetch failed for", symbol, err);
    return [];
  }
}
