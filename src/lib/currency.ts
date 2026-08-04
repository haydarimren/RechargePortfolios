import { closeOnOrBefore } from "./portfolio";
import { Holding } from "./types";
import { HistoricalPoint } from "./yahoo";

/**
 * Multi-currency normalization.
 *
 * A portfolio can hold a London line quoted in GBP and a Milan line
 * quoted in EUR. Summing those two market values produces a number in no
 * currency at all — which is what the totals row used to do, under a `$`
 * sign. Everything is converted to USD here before any cross-position
 * arithmetic, which also makes the SPY/QQQ benchmark comparison
 * meaningful again: the hypothetical is priced in USD, so the portfolio
 * has to be too.
 *
 * Cost basis converts at the FX rate on the *purchase* date — that's
 * what the lot actually cost in USD terms. Market value converts at
 * today's rate. The difference between the two is genuine FX gain/loss
 * and belongs in the return.
 */

/** USD is the display currency; everything converts into it. */
export const DISPLAY_CURRENCY = "USD";

/**
 * Yahoo's FX pair symbol for `currency` → USD. Fetched through the same
 * cached daily-close path as any other symbol, so no separate rates API
 * and no separate cache: the last point of the series is "today's rate"
 * and earlier points date the cost basis.
 */
export function fxSymbol(currency: string): string {
  return `${holdingCurrency(currency)}USD=X`;
}

/**
 * Major-unit currency code for a *broker-reported holding* currency.
 *
 * Note the asymmetry with `normalizeQuoteCurrency` in
 * `symbol-candidates.ts`: that one also returns a divisor, because Yahoo
 * quotes LSE in pence. Broker prices arrive already converted to the
 * major unit (the T212 adapter divides its GBX prices by 100 at import),
 * so here `GBX` is purely a naming variant of `GBP` — applying a divisor
 * would double-count.
 */
export function holdingCurrency(raw: string | null | undefined): string {
  const code = (raw ?? "").trim().toUpperCase();
  if (!code) return "";
  if (code === "GBX" || code === "GBP") return "GBP";
  if (code === "ZAC") return "ZAR";
  if (code === "ILA") return "ILS";
  return code;
}

/** Is this currency already the display currency (or unknown)? */
export function isDisplayCurrency(code: string): boolean {
  return code === "" || code === DISPLAY_CURRENCY;
}

/**
 * USD per 1 unit of `currency` on `date`, from a daily FX series.
 * Falls back to the earliest known rate for dates before the series
 * starts, and to null when there's no series at all — callers treat null
 * as "leave the amount alone" rather than dropping the position.
 */
export function rateAt(
  fx: HistoricalPoint[] | undefined,
  date: string,
): number | null {
  if (!fx || fx.length === 0) return null;
  const at = closeOnOrBefore(fx, date);
  const rate = at ?? fx[0].close;
  return rate > 0 ? rate : null;
}

/** Latest known rate in a series. */
export function latestRate(fx: HistoricalPoint[] | undefined): number | null {
  if (!fx || fx.length === 0) return null;
  const rate = fx[fx.length - 1].close;
  return rate > 0 ? rate : null;
}

/**
 * Restate every lot's purchase price in USD, using the rate on that
 * lot's own purchase date.
 *
 * Converting here — upstream of `aggregateHoldings`, `buildTradeLog`,
 * and `buildComparisonSeries` — is deliberate: one conversion point
 * means cost basis, realized P&L, allocation, and the benchmark chart
 * can't drift into disagreeing about what currency they're in.
 *
 * Holdings with no currency (manually added, or US brokers) pass
 * through untouched, so single-currency portfolios are bit-identical to
 * before.
 */
export function convertHoldingsToUsd(
  holdings: Holding[],
  fxByCurrency: Record<string, HistoricalPoint[]>,
): Holding[] {
  let changed = false;
  const out = holdings.map((h) => {
    const ccy = holdingCurrency(h.currency);
    if (isDisplayCurrency(ccy)) return h;
    const rate = rateAt(fxByCurrency[ccy], h.purchaseDate);
    if (rate === null) return h;
    changed = true;
    return { ...h, purchasePrice: h.purchasePrice * rate };
  });
  return changed ? out : holdings;
}

/** Restate a daily close series in USD, day by day. */
export function convertPointsToUsd(
  points: HistoricalPoint[],
  currency: string,
  fxByCurrency: Record<string, HistoricalPoint[]>,
): HistoricalPoint[] {
  const ccy = holdingCurrency(currency);
  if (isDisplayCurrency(ccy)) return points;
  const fx = fxByCurrency[ccy];
  if (!fx || fx.length === 0) return points;
  return points.map((p) => {
    const rate = rateAt(fx, p.date);
    return rate === null ? p : { date: p.date, close: p.close * rate };
  });
}

/**
 * Convert a present-day amount (a live quote, or a market value derived
 * from one) at the most recent rate. Returns the amount unchanged when
 * no rate is available.
 */
export function toUsdNow(
  amount: number,
  currency: string,
  fxByCurrency: Record<string, HistoricalPoint[]>,
): number {
  const ccy = holdingCurrency(currency);
  if (isDisplayCurrency(ccy)) return amount;
  const rate = latestRate(fxByCurrency[ccy]);
  return rate === null ? amount : amount * rate;
}

/**
 * A position's market value in USD, or null when there's no quote to
 * value it with. The one primitive every "what is this worth" caller
 * should go through — the totals row, the allocation denominator, the
 * home-page cards and the treemap all used to inline
 * `shares * quote.c`, which silently added pounds to euros.
 */
export function quoteValueUsd(
  quote: { c: number; currency: string } | null | undefined,
  shares: number,
  fxByCurrency: Record<string, HistoricalPoint[]>,
): number | null {
  if (!quote) return null;
  return toUsdNow(shares * quote.c, quote.currency, fxByCurrency);
}

/**
 * Every non-USD currency a set of holdings touches. Drives which FX
 * series the page fetches — an all-USD portfolio fetches none and stays
 * on exactly the code path it had before.
 */
export function currenciesInHoldings(holdings: Holding[]): string[] {
  const out = new Set<string>();
  for (const h of holdings) {
    const ccy = holdingCurrency(h.currency);
    if (!isDisplayCurrency(ccy)) out.add(ccy);
  }
  return Array.from(out).sort();
}
