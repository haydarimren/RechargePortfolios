/**
 * Strip Trading212's exchange/suffix segments from a ticker.
 * Loops the regex so multi-segment suffixes like `_US_EQ` or `_ABC_EQ` are
 * fully stripped: `AAPL_US_EQ` -> `AAPL`, `XYZ_ABC_EQ` -> `XYZ`.
 */
export function stripT212Suffix(ticker: string): string {
  let out = ticker;
  const re = /_[A-Z]{2,4}$/;
  while (re.test(out)) {
    out = out.replace(re, "");
  }
  return out;
}

// Currency → Yahoo suffix for non-US listings. The key assumption: if T212
// gave us a non-USD currency, the stock isn't on a US exchange, so we need
// to pick the dominant European venue for that currency. Falls back to the
// most liquid venue when the currency alone is ambiguous.
const CURRENCY_TO_YAHOO_SUFFIX: Record<string, string> = {
  GBX: ".L",
  GBP: ".L",
  EUR: ".DE", // fallback; overridden by ticker-letter heuristic below
  CHF: ".SW",
  SEK: ".ST",
  DKK: ".CO",
  NOK: ".OL",
  PLN: ".WA",
};

// Trading212 tickers embed a lowercase exchange letter before `_EQ` for
// non-US venues: `VUAAl_EQ` (London), `VUAGd_EQ` (Xetra), `MCp_EQ` (Paris).
// Not authoritative — T212 doesn't document this — but consistent enough
// in observed data to drive exchange resolution for EUR listings where
// currency alone is ambiguous.
const SUFFIX_LETTER_TO_YAHOO: Record<string, string> = {
  l: ".L", // London
  d: ".DE", // Deutsche Börse / Xetra
  p: ".PA", // Paris
  a: ".AS", // Amsterdam
  s: ".SW", // SIX Swiss
  i: ".MI", // Borsa Italiana
  m: ".MC", // Madrid
};

/**
 * Derive a Yahoo Finance-compatible symbol from a Trading212 ticker + the
 * instrument's currency. Strategy:
 *
 *   1. Ticker already stripped to bare form (`AAPL`, `VUAA`).
 *   2. If the raw T212 ticker ends with `_US_EQ` or currency is USD and the
 *      raw ticker has no exchange-letter hint, treat as a US listing →
 *      return the bare symbol.
 *   3. Otherwise combine the lowercase exchange letter (if present) with
 *      currency to pick a Yahoo suffix: `.L`, `.DE`, `.PA`, etc.
 *
 * Returns `null` when we can't confidently derive a suffix. Callers fall
 * back to the bare symbol — works for US-listed tickers by default.
 */
export function toYahooSymbol(rawTicker: string, currency?: string): string | null {
  const bare = stripT212Suffix(rawTicker);

  // Explicit US listing — `AAPL_US_EQ` style.
  if (/_US_EQ$/.test(rawTicker)) return bare;

  // Try the lowercase exchange letter hint: `VUAAl_EQ` → `l` → `.L`.
  const letterMatch = rawTicker.match(/([a-z])_EQ$/);
  if (letterMatch) {
    const suffix = SUFFIX_LETTER_TO_YAHOO[letterMatch[1]];
    if (suffix) return `${bare}${suffix}`;
  }

  // Currency-based fallback for non-USD.
  if (currency && currency !== "USD") {
    const suffix = CURRENCY_TO_YAHOO_SUFFIX[currency];
    if (suffix) return `${bare}${suffix}`;
  }

  // USD with no exchange hint → assume US listing.
  if (currency === "USD" || !currency) return bare;

  return null;
}
