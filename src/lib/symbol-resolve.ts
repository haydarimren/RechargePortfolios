"use server";

/**
 * Turn a broker's venue-native ticker into a Yahoo symbol that actually
 * resolves — by probing, not by guessing.
 *
 * The old path derived a Yahoo symbol from Trading 212's exchange-letter
 * hint (`VNGA80i_EQ` → `.MI`) or, failing that, from the trading currency
 * (`EUR` → `.DE`). Nothing verified the result. When the guess was wrong
 * the position simply had no quote: blank price, blank market value, and
 * — worse — it dropped out of the allocation denominator, so the
 * remaining positions silently added up to 100%.
 *
 * Resolution order:
 *   1. Probe each candidate from `yahooSymbolCandidates` in order.
 *   2. Prefer a hit whose currency matches what the broker reported;
 *      fall back to the first hit of any currency.
 *   3. If every candidate is dead, ask Yahoo's search endpoint for the
 *      bare ticker and probe what it suggests.
 *
 * Both caches are in-process and per-server-instance. Positives are
 * effectively permanent (an ETF does not change venue); negatives expire
 * quickly so a transient Yahoo outage doesn't pin a symbol as dead.
 *
 * Privacy note: this sends the same tickers to the same upstream that
 * `finnhub.ts`/`yahoo.ts` already send for every quote and chart fetch —
 * no new leak surface, and deliberately no ISIN (Yahoo's ISIN search
 * returns wrong instruments often enough to be a liability: querying
 * VNGA80's ISIN returns a leveraged energy note).
 */

import {
  inferCurrencyFromSymbol,
  normalizeQuoteCurrency,
  splitYahooSymbol,
  yahooSymbolCandidates,
} from "./symbol-candidates";

export interface ResolvedSymbol {
  /** A Yahoo symbol confirmed to return chart data. */
  symbol: string;
  /** Major-unit currency Yahoo quotes it in (`GBP`, not `GBp`). */
  currency: string;
}

interface CacheEntry {
  value: ResolvedSymbol | null;
  expiresAt: number;
}

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 60 * 60 * 1000;
/** Hard cap on probes per resolution so a bad ticker can't fan out. */
const MAX_PROBES = 12;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ResolvedSymbol | null>>();

function cacheKey(bare: string, currency: string, candidate: string): string {
  return `${bare}|${currency}|${candidate}`;
}

/** Does this Yahoo symbol return chart data, and in what currency? */
async function probe(symbol: string): Promise<ResolvedSymbol | null> {
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=5d`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    if (typeof meta.regularMarketPrice !== "number") return null;
    return {
      symbol: typeof meta.symbol === "string" ? meta.symbol : symbol,
      currency: normalizeQuoteCurrency(meta.currency).currency,
    };
  } catch {
    return null;
  }
}

/** Symbols Yahoo's own search associates with this bare ticker. */
async function searchSuggestions(bare: string): Promise<string[]> {
  const url =
    `https://query1.finance.yahoo.com/v1/finance/search` +
    `?q=${encodeURIComponent(bare)}&quotesCount=10&newsCount=0`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 86400 },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const quotes: Array<{ symbol?: string; quoteType?: string }> =
      data?.quotes ?? [];
    return quotes
      .filter(
        (q) =>
          typeof q.symbol === "string" &&
          (q.quoteType === "ETF" ||
            q.quoteType === "EQUITY" ||
            q.quoteType === "MUTUALFUND"),
      )
      .map((q) => q.symbol as string);
  } catch {
    return [];
  }
}

async function resolveUncached(
  bare: string,
  currency: string,
  candidate: string,
): Promise<ResolvedSymbol | null> {
  const wanted = normalizeQuoteCurrency(currency).currency;
  const candidates = yahooSymbolCandidates(bare, {
    candidate: candidate || null,
    currency: currency || null,
  }).slice(0, MAX_PROBES);

  // Probe in order. A currency match ends the search immediately; a hit
  // in the "wrong" currency is held as a fallback in case nothing better
  // turns up (a dual-listed ETF priced in EUR still beats no price).
  let fallback: ResolvedSymbol | null = null;
  for (const sym of candidates) {
    const hit = await probe(sym);
    if (!hit) continue;
    if (!wanted || hit.currency === wanted) return hit;
    fallback ??= hit;
  }
  if (fallback) return fallback;

  // Every venue guess was dead — let Yahoo tell us where it lives. This
  // is the VNGA80 case: Amsterdam and Milan both call it VNGA80, Yahoo
  // calls the Amsterdam line V80A.AS and only Milan keeps the ticker.
  const suggestions = (await searchSuggestions(bare))
    .filter((s) => !candidates.includes(s.toUpperCase()))
    .slice(0, 4);
  for (const sym of suggestions) {
    const hit = await probe(sym);
    if (!hit) continue;
    if (!wanted || hit.currency === wanted) return hit;
    fallback ??= hit;
  }
  return fallback;
}

/**
 * Resolve a bare ticker + trading currency to a live Yahoo symbol.
 * Returns null when nothing resolves (delisted, or an instrument class
 * Yahoo doesn't carry, e.g. an option contract).
 */
export async function resolveYahooSymbol(
  bare: string,
  currency?: string,
  candidate?: string,
): Promise<ResolvedSymbol | null> {
  const cleanBare = bare.trim().toUpperCase();
  if (!cleanBare) return null;
  const cleanCurrency = (currency ?? "").trim().toUpperCase();
  const cleanCandidate = (candidate ?? "").trim().toUpperCase();

  const key = cacheKey(cleanBare, cleanCurrency, cleanCandidate);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = resolveUncached(cleanBare, cleanCurrency, cleanCandidate)
    .then((value) => {
      cache.set(key, {
        value,
        expiresAt:
          Date.now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
      });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p;
}

export interface SymbolResolveRequest {
  /** Suffix-free ticker, e.g. `VNGA80`. */
  bare: string;
  /** Broker-reported trading currency, e.g. `EUR` or `GBX`. */
  currency?: string;
  /** The caller's existing guess, tried first. */
  candidate?: string;
}

/**
 * Batch form for sync, which has a whole order book to map at once.
 * One server round-trip instead of one per symbol; the per-symbol cache
 * underneath means a repeat sync costs nothing.
 *
 * Keyed by `bare|currency` in the returned record. A null value means
 * nothing resolved — callers should keep whatever guess they had rather
 * than storing a symbol they know is wrong-but-different.
 */
export async function resolveYahooSymbols(
  requests: SymbolResolveRequest[],
): Promise<Record<string, ResolvedSymbol | null>> {
  const out: Record<string, ResolvedSymbol | null> = {};
  const seen = new Set<string>();
  const unique = requests.filter((r) => {
    const k = `${r.bare.toUpperCase()}|${(r.currency ?? "").toUpperCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Bounded fan-out: Yahoo starts 429ing past a handful of parallel
  // requests, and each resolution may itself issue several probes.
  const CONCURRENCY = 4;
  let cursor = 0;
  const worker = async () => {
    while (cursor < unique.length) {
      const r = unique[cursor++];
      const key = `${r.bare.toUpperCase()}|${(r.currency ?? "").toUpperCase()}`;
      out[key] = await resolveYahooSymbol(r.bare, r.currency, r.candidate);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker),
  );
  return out;
}

/**
 * Self-healing variant for callers that only hold a (possibly wrong)
 * Yahoo symbol and no broker metadata — the quote and chart fetchers.
 * The dead symbol's own suffix supplies the currency hint: `VNGA80.DE`
 * failing still tells us to look at the other EUR venues.
 *
 * Returns null when `symbol` itself is the answer or nothing resolves,
 * so callers can skip a redundant refetch.
 */
export async function repairYahooSymbol(
  symbol: string,
): Promise<ResolvedSymbol | null> {
  const { bare } = splitYahooSymbol(symbol);
  const currency = inferCurrencyFromSymbol(symbol);
  const resolved = await resolveYahooSymbol(bare, currency, symbol);
  if (!resolved) return null;
  if (resolved.symbol.toUpperCase() === symbol.trim().toUpperCase()) return null;
  return resolved;
}
