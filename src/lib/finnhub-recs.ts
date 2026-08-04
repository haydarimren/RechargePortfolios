"use server";

/**
 * Analyst recommendation spreads from Finnhub `/stock/recommendation`.
 *
 * Complements `yahoo-insights.ts` rather than replacing it: Yahoo has the
 * consensus word, the mean price target and the calendar dates but only a
 * headcount; Finnhub has the per-bucket breakdown but keeps price targets
 * behind its paid tier. Free tier covers US-listed equities at 60 req/min —
 * one call per symbol per day is nowhere near it.
 *
 * Degrades the same way its Yahoo counterpart does: no API key, a dead
 * endpoint, or an uncovered symbol all return null and the UI hides the bar.
 * NOTE: this is the *only* Finnhub code path in the app. Live quotes come
 * from Yahoo v8 via the misleadingly-named `finnhub.ts` — don't route them
 * back here.
 */

import { parseFinnhubRecommendation, type AnalystSpread } from "./insights";
import { mapWithConcurrency } from "./concurrency";

const CONCURRENCY = 5;
const DAY = 86400;

async function fetchOne(symbol: string, token: string): Promise<AnalystSpread | null> {
  try {
    const url =
      `https://finnhub.io/api/v1/stock/recommendation` +
      `?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { next: { revalidate: DAY } });
    if (!res.ok) return null;
    return parseFinnhubRecommendation(await res.json());
  } catch {
    return null;
  }
}

export async function getAnalystSpreads(
  symbols: string[],
): Promise<Record<string, AnalystSpread | null>> {
  const out: Record<string, AnalystSpread | null> = {};
  if (symbols.length === 0) return out;
  const uniq = Array.from(new Set(symbols));
  const token = process.env.FINNHUB_API_KEY;
  // Unconfigured is a supported state, not an error: the app then behaves
  // exactly as it did before this module existed.
  if (!token) {
    for (const s of uniq) out[s] = null;
    return out;
  }
  const results = await mapWithConcurrency(uniq, CONCURRENCY, (s) => fetchOne(s, token));
  uniq.forEach((s, i) => { out[s] = results[i]; });
  return out;
}
