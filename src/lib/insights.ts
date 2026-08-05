/**
 * Pure insights logic — no network, no React. The Yahoo quoteSummary
 * parser plus the three section builders (upcoming dates, analyst ratings,
 * top movers) and the rating label/tone maps. Unit-tested in insights.test.ts.
 */

export interface StockInsight {
  earningsDate?: string;      // YYYY-MM-DD (next reported, may be past)
  exDividendDate?: string;    // YYYY-MM-DD
  dividendDate?: string;      // YYYY-MM-DD (pay date)
  targetMeanPrice?: number;
  recommendationKey?: string; // "strong_buy"|"buy"|"hold"|"sell"|"strong_sell"|"none"
  analystCount?: number;
}

/** Finnhub `/stock/recommendation` — one month's bucket counts. */
export interface AnalystSpread {
  strongBuy: number; buy: number; hold: number; sell: number; strongSell: number;
  period: string;            // YYYY-MM-DD, first of the month
}

export type SpreadKey = "strongBuy" | "buy" | "hold" | "sell" | "strongSell";
export interface SpreadSegment {
  key: SpreadKey;
  count: number;             // always > 0 — empty buckets are dropped
  pct: number;               // share of the fixed-width track; sums to 100
  showLabel: boolean;        // wide enough to hold its own count
}

export type EventKind = "earnings" | "ex-dividend" | "dividend";
export interface UpcomingDate { symbol: string; kind: EventKind; date: string }
export interface AnalystRating {
  symbol: string; ratingKey: string; ratingLabel: string;
  target?: number; upsidePct?: number;
  spread?: AnalystSpread; analystCount?: number;
}
export interface MoverRow { symbol: string; pct: number }
export interface Movers { gainers: MoverRow[]; losers: MoverRow[] }

/** Yahoo returns numbers as `{ raw, fmt }` (or sometimes a bare number). */
function num(v: unknown): number | undefined {
  if (typeof v === "number" && isFinite(v)) return v;
  if (v && typeof v === "object" && typeof (v as { raw?: unknown }).raw === "number") {
    const raw = (v as { raw: number }).raw;
    return isFinite(raw) ? raw : undefined;
  }
  return undefined;
}

function toISO(rawSeconds: number | undefined): string | undefined {
  if (rawSeconds === undefined) return undefined;
  return new Date(rawSeconds * 1000).toISOString().split("T")[0];
}

/** Parse one quoteSummary JSON body into a StockInsight, or null if empty. */
export function parseQuoteSummary(json: unknown): StockInsight | null {
  const r = (json as { quoteSummary?: { result?: unknown[] } })?.quoteSummary?.result?.[0] as
    | { calendarEvents?: Record<string, unknown>; financialData?: Record<string, unknown> }
    | undefined;
  if (!r) return null;
  const cal = (r.calendarEvents ?? {}) as Record<string, unknown>;
  const fin = (r.financialData ?? {}) as Record<string, unknown>;
  const earnings = (cal.earnings as { earningsDate?: unknown[] } | undefined)?.earningsDate?.[0];
  const out: StockInsight = {};
  const earningsDate = toISO(num(earnings));
  const exDividendDate = toISO(num(cal.exDividendDate));
  const dividendDate = toISO(num(cal.dividendDate));
  const targetMeanPrice = num(fin.targetMeanPrice);
  const recommendationKey =
    typeof fin.recommendationKey === "string" ? fin.recommendationKey : undefined;
  const analystCount = num(fin.numberOfAnalystOpinions);
  if (earningsDate) out.earningsDate = earningsDate;
  if (exDividendDate) out.exDividendDate = exDividendDate;
  if (dividendDate) out.dividendDate = dividendDate;
  if (targetMeanPrice !== undefined) out.targetMeanPrice = targetMeanPrice;
  if (recommendationKey) out.recommendationKey = recommendationKey;
  if (analystCount !== undefined) out.analystCount = analystCount;
  return out;
}

const SPREAD_KEYS: SpreadKey[] = ["strongBuy", "buy", "hold", "sell", "strongSell"];
/** Bullish→bearish weights; the mean lands on a Yahoo-style rating key. */
const SPREAD_WEIGHT: Record<SpreadKey, number> = {
  strongBuy: 2, buy: 1, hold: 0, sell: -1, strongSell: -2,
};
/** A segment narrower than this can't hold a legible count, so it goes bare. */
const LABEL_MIN_PCT = 12;

/** Parse a Finnhub recommendation array, keeping the latest period. */
export function parseFinnhubRecommendation(json: unknown): AnalystSpread | null {
  if (!Array.isArray(json) || json.length === 0) return null;
  const rows = json.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === "object",
  );
  let best: Record<string, unknown> | null = null;
  for (const r of rows) {
    if (typeof r.period !== "string") continue;
    if (!best || r.period > (best.period as string)) best = r;
  }
  if (!best) return null;
  const out: AnalystSpread = {
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
    period: best.period as string,
  };
  let sawBucket = false;
  for (const k of SPREAD_KEYS) {
    const v = best[k];
    if (typeof v === "number" && isFinite(v)) { out[k] = v; sawBucket = true; }
  }
  // A row with a period but no bucket at all isn't a recommendation.
  return sawBucket ? out : null;
}

export function spreadTotal(s: AnalystSpread): number {
  return SPREAD_KEYS.reduce((a, k) => a + s[k], 0);
}

/** Bar geometry: proportional widths over a fixed-width track, most
 *  bullish first. Empty buckets are dropped rather than drawn as slivers. */
export function spreadSegments(s: AnalystSpread): SpreadSegment[] {
  const total = spreadTotal(s);
  if (total <= 0) return [];
  return SPREAD_KEYS.filter((k) => s[k] > 0).map((k) => {
    const pct = (s[k] / total) * 100;
    return { key: k, count: s[k], pct, showLabel: pct >= LABEL_MIN_PCT };
  });
}

/** Collapse a spread into a single rating key. Used only when Yahoo has no
 *  `recommendationKey` of its own, so the pill still has a word to show. */
export function deriveRatingKey(s: AnalystSpread): string {
  const total = spreadTotal(s);
  if (total <= 0) return "none";
  const score = SPREAD_KEYS.reduce((a, k) => a + SPREAD_WEIGHT[k] * s[k], 0) / total;
  if (score >= 1.5) return "strong_buy";
  if (score >= 0.5) return "buy";
  if (score > -0.5) return "hold";
  if (score > -1.5) return "sell";
  return "strong_sell";
}

/** Future-dated events across holdings, flattened + sorted ascending. */
export function buildUpcomingDates(
  bySymbol: Record<string, StockInsight | null>,
  todayISO: string,
): UpcomingDate[] {
  const out: UpcomingDate[] = [];
  for (const [symbol, ins] of Object.entries(bySymbol)) {
    if (!ins) continue;
    if (ins.earningsDate && ins.earningsDate >= todayISO) out.push({ symbol, kind: "earnings", date: ins.earningsDate });
    if (ins.exDividendDate && ins.exDividendDate >= todayISO) out.push({ symbol, kind: "ex-dividend", date: ins.exDividendDate });
    if (ins.dividendDate && ins.dividendDate >= todayISO) out.push({ symbol, kind: "dividend", date: ins.dividendDate });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** One row per symbol present in `weightBySymbol`, sorted by weight desc.
 *  Rows with no coverage get ratingKey "none" and no upside. */
export function buildAnalystRatings(
  bySymbol: Record<string, StockInsight | null>,
  priceBySymbol: Record<string, number | undefined>,
  weightBySymbol: Record<string, number>,
  spreadBySymbol: Record<string, AnalystSpread | null> = {},
): AnalystRating[] {
  const rows: AnalystRating[] = Object.keys(weightBySymbol).map((symbol) => {
    const ins = bySymbol[symbol] ?? null;
    const spread = spreadBySymbol[symbol] ?? undefined;
    // Yahoo's own word wins; Finnhub's spread only fills the gap so a symbol
    // Yahoo doesn't cover still gets a pill instead of a grey "None".
    //
    // "No rating" reaches us two different ways: Yahoo omits the field, or
    // Yahoo answers with the literal string "none". The second is the common
    // one and it is a *defined* value, so `??` alone kept it and skipped the
    // Finnhub fallback entirely — the reason well-covered symbols like SNEX
    // and CRDO rendered no pill. Treat both as "Yahoo has nothing".
    const yahooKey =
      ins?.recommendationKey && ins.recommendationKey !== "none"
        ? ins.recommendationKey
        : undefined;
    const ratingKey = yahooKey ?? (spread ? deriveRatingKey(spread) : "none");
    // The count must agree with the bar it sits next to, so it comes from the
    // spread whenever there is one.
    const analystCount = spread ? spreadTotal(spread) : ins?.analystCount;
    const target = ins?.targetMeanPrice;
    const price = priceBySymbol[symbol];
    const upsidePct =
      target !== undefined && price !== undefined && price > 0
        ? ((target - price) / price) * 100
        : undefined;
    return {
      symbol, ratingKey, ratingLabel: ratingLabel(ratingKey),
      target, upsidePct, spread, analystCount,
    };
  });
  return rows.sort((a, b) => (weightBySymbol[b.symbol] ?? 0) - (weightBySymbol[a.symbol] ?? 0));
}

/** Top 3 gainers (pct>0 desc) and losers (pct<0 asc) for each metric. */
export function topMovers(
  rows: Array<{ symbol: string; dailyPct: number; returnPct: number }>,
): { today: Movers; sincePurchase: Movers } {
  const pick = (sel: (r: { dailyPct: number; returnPct: number }) => number): Movers => {
    const mapped = rows.map((r) => ({ symbol: r.symbol, pct: sel(r) }));
    const gainers = mapped.filter((r) => r.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 3);
    const losers = mapped.filter((r) => r.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 3);
    return { gainers, losers };
  };
  return { today: pick((r) => r.dailyPct), sincePurchase: pick((r) => r.returnPct) };
}

export function ratingLabel(key: string | undefined): string {
  switch (key) {
    case "strong_buy": return "Strong Buy";
    case "buy": return "Buy";
    case "hold": return "Hold";
    case "sell": return "Sell";
    case "strong_sell": return "Strong Sell";
    default: return "None";
  }
}

export type RatingTone = "pos" | "neutral" | "neg" | "fade";
export function ratingTone(key: string | undefined): RatingTone {
  switch (key) {
    case "strong_buy":
    case "buy": return "pos";
    case "hold": return "neutral";
    case "sell":
    case "strong_sell": return "neg";
    default: return "fade";
  }
}
