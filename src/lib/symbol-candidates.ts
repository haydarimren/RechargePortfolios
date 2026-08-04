/**
 * Ordered Yahoo-symbol candidates for a listing we only know by its bare
 * ticker + trading currency.
 *
 * Why this exists: broker tickers are *venue-native*, Yahoo symbols are
 * *Yahoo-native*, and the two disagree more often than you'd hope. The
 * Vanguard LifeStrategy 80% ETF trades as `VNGA80` on both Euronext
 * Amsterdam and Borsa Italiana, but Yahoo lists the Amsterdam line as
 * `V80A.AS` and only the Milan line as `VNGA80.MI`. Any single-guess
 * mapping (currency → suffix, or broker exchange-letter → suffix) gets
 * this wrong and the position silently loses its price.
 *
 * So instead of one guess we produce an ordered list of plausible
 * symbols; `symbol-resolve.ts` probes them against Yahoo and keeps the
 * first that actually returns data. This module is pure so the ordering
 * is testable without network.
 */

/**
 * Venue suffixes worth trying for a given trading currency, most-liquid
 * first. Not exhaustive — it covers the venues a European retail broker
 * actually routes to, plus the majors.
 */
const CURRENCY_CANDIDATE_SUFFIXES: Record<string, string[]> = {
  // LSE quotes both pence (GBX/GBp) and pound lines under `.L`.
  GBX: [".L"],
  GBP: [".L"],
  // EUR is the ambiguous one: half a dozen venues share the currency and
  // brokers rarely tell you which. Ordered by how often a European ETF
  // listing turns up on each.
  EUR: [".DE", ".AS", ".MI", ".PA", ".F", ".MC", ".BR", ".LS", ".VI", ".IR"],
  CHF: [".SW"],
  SEK: [".ST"],
  DKK: [".CO"],
  NOK: [".OL"],
  PLN: [".WA"],
  CAD: [".TO", ".V"],
  AUD: [".AX"],
  JPY: [".T"],
  HKD: [".HK"],
  // USD is usually a bare US listing, but LSE also runs USD-denominated
  // lines of UCITS ETFs (`VUAA.L` is quoted in USD), so keep `.L` around.
  USD: [".L"],
};

/**
 * Reverse of the table above: which currency does a Yahoo venue suffix
 * imply? Used to recover a currency hint when all we have is a symbol
 * that failed to resolve — a dead `VNGA80.DE` still tells us "this is a
 * EUR listing", which is enough to generate the right sibling venues.
 */
const SUFFIX_TO_CURRENCY: Record<string, string> = {
  ".L": "GBP",
  ".DE": "EUR",
  ".AS": "EUR",
  ".MI": "EUR",
  ".PA": "EUR",
  ".F": "EUR",
  ".MC": "EUR",
  ".BR": "EUR",
  ".LS": "EUR",
  ".VI": "EUR",
  ".IR": "EUR",
  ".SW": "CHF",
  ".ST": "SEK",
  ".CO": "DKK",
  ".OL": "NOK",
  ".WA": "PLN",
  ".TO": "CAD",
  ".V": "CAD",
  ".AX": "AUD",
  ".T": "JPY",
  ".HK": "HKD",
};

/** Split `VNGA80.DE` into `{ bare: "VNGA80", suffix: ".DE" }`. */
export function splitYahooSymbol(symbol: string): {
  bare: string;
  suffix: string;
} {
  const s = symbol.trim().toUpperCase();
  const dot = s.lastIndexOf(".");
  if (dot <= 0) return { bare: s, suffix: "" };
  return { bare: s.slice(0, dot), suffix: s.slice(dot) };
}

/**
 * Best-effort currency for a Yahoo symbol, derived from its venue
 * suffix. Empty string when the symbol is bare or the suffix is unknown.
 */
export function inferCurrencyFromSymbol(symbol: string): string {
  const { suffix } = splitYahooSymbol(symbol);
  return SUFFIX_TO_CURRENCY[suffix] ?? "";
}

export interface CandidateOpts {
  /**
   * The caller's existing best guess (e.g. what the broker's
   * exchange-letter heuristic produced). Tried first — it's right most
   * of the time, and trying it first keeps the common path to one probe.
   */
  candidate?: string | null;
  /** Trading currency as reported by the broker (`GBX`, `EUR`, `USD`, …). */
  currency?: string | null;
}

/**
 * Build the ordered candidate list for `bare` (a suffix-free ticker such
 * as `VNGA80`). Deduplicated, order-preserving.
 *
 * A bare (US-style) symbol is included for every currency — some UCITS
 * tickers do resolve bare on Yahoo — but it is only tried *first* when
 * the currency says US listing, so a European ticker that happens to
 * collide with an unrelated US symbol doesn't win by default.
 */
export function yahooSymbolCandidates(
  bare: string,
  opts: CandidateOpts = {},
): string[] {
  const clean = bare.trim().toUpperCase();
  if (!clean) return [];

  const currency = opts.currency?.trim().toUpperCase() ?? "";
  const isUsLike = currency === "USD" || currency === "";

  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    if (!s) return;
    const v = s.trim().toUpperCase();
    if (v && !out.includes(v)) out.push(v);
  };

  push(opts.candidate);
  if (isUsLike) push(clean);
  for (const suffix of CURRENCY_CANDIDATE_SUFFIXES[currency] ?? []) {
    push(`${clean}${suffix}`);
  }
  // Last resort for non-US currencies: the bare ticker. Cheap to try and
  // occasionally correct (ADRs, dual listings).
  push(clean);

  return out;
}

/**
 * Yahoo quotes some venues in a minor unit — LSE pence come back as
 * `GBp` (note the lowercase `p`), not `GBP`. Callers that mix a Yahoo
 * price with a broker-reported cost basis must normalize both to the
 * major unit or the position reads 100× too big.
 *
 * Returns the major-unit currency code and the divisor to apply to any
 * price quoted in `raw`.
 */
export function normalizeQuoteCurrency(raw: string | null | undefined): {
  currency: string;
  divisor: number;
} {
  const code = (raw ?? "").trim();
  if (!code) return { currency: "", divisor: 1 };
  // Yahoo's minor-unit codes: GBp (UK pence), ZAc (SA cents), ILA (Israeli
  // agorot). All share the shape "major unit code, minor unit marker".
  if (code === "GBp" || code === "GBX") return { currency: "GBP", divisor: 100 };
  if (code === "ZAc" || code === "ZAX") return { currency: "ZAR", divisor: 100 };
  if (code === "ILA") return { currency: "ILS", divisor: 100 };
  return { currency: code.toUpperCase(), divisor: 1 };
}
