"use server";

/**
 * Analyst recommendation spreads from Finnhub `/stock/recommendation`.
 *
 * Complements `yahoo-insights.ts` rather than replacing it: Yahoo has the
 * consensus word, the mean price target and the calendar dates but only a
 * headcount; Finnhub has the per-bucket breakdown but keeps price targets
 * behind its paid tier. Free tier covers US-listed equities at 60 req/min.
 *
 * Degrades the same way its Yahoo counterpart does: no API key, a dead
 * endpoint, or an uncovered symbol all return null and the UI hides the bar.
 * NOTE: this is the *only* Finnhub code path in the app. Live quotes come
 * from Yahoo v8 via the misleadingly-named `finnhub.ts` — don't route them
 * back here.
 *
 * Caching lives in `ttl-cache.ts`, NOT in `next: { revalidate }` — that
 * option does nothing inside a Server Action (see that file's header). The
 * distinction between a cacheable answer and a transient failure is load
 * bearing: a 429 stored as `null` is indistinguishable from "no analyst
 * coverage", which is exactly how throttled symbols used to render as
 * permanently missing bars.
 */

import { parseFinnhubRecommendation, type AnalystSpread } from "./insights";
import { mapWithConcurrency } from "./concurrency";
import { createTtlCache } from "./ttl-cache";
import { retryDelayMs } from "./rate-limit";

const CONCURRENCY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest we'll hold a request open waiting for the rate-limit window. */
const RETRY_CAP_MS = 4000;

/** Symbol → spread. Process-wide and user-agnostic: the value depends only on
 *  the ticker, so nothing user-identifying is retained. */
const spreadCache = createTtlCache<AnalystSpread | null>(DAY_MS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves to a definitive answer (spread, or null for "no coverage") and
 * REJECTS on anything transient, so the cache only ever stores real answers.
 */
async function fetchSpread(symbol: string, token: string): Promise<AnalystSpread | null> {
  const url =
    `https://finnhub.io/api/v1/stock/recommendation` +
    `?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;

  let res = await fetch(url);

  if (res.status === 429) {
    const delay = retryDelayMs(
      res.status, res.headers.get("x-ratelimit-reset"), Date.now(), RETRY_CAP_MS,
    );
    if (delay === null) throw new Error(`finnhub rate limited: ${symbol}`);
    await sleep(delay);
    res = await fetch(url);
    if (res.status === 429) throw new Error(`finnhub rate limited after retry: ${symbol}`);
  }

  // 403 is Finnhub's answer for listings outside the free tier (anything
  // non-US). Permanent, so it's worth caching as "no coverage" rather than
  // re-asking every single view.
  if (res.status === 403) return null;
  if (!res.ok) throw new Error(`finnhub ${res.status}: ${symbol}`);

  return parseFinnhubRecommendation(await res.json());
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
  const results = await mapWithConcurrency(uniq, CONCURRENCY, (s) =>
    // A transient failure renders as a missing bar for this view only — it
    // isn't cached, so the next view retries it.
    spreadCache.getOrCreate(s, () => fetchSpread(s, token)).catch(() => null),
  );
  uniq.forEach((s, i) => { out[s] = results[i]; });
  return out;
}
