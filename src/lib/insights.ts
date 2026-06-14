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

export type EventKind = "earnings" | "ex-dividend" | "dividend";
export interface UpcomingDate { symbol: string; kind: EventKind; date: string }
export interface AnalystRating {
  symbol: string; ratingKey: string; ratingLabel: string;
  target?: number; upsidePct?: number;
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
): AnalystRating[] {
  const rows: AnalystRating[] = Object.keys(weightBySymbol).map((symbol) => {
    const ins = bySymbol[symbol] ?? null;
    const ratingKey = ins?.recommendationKey ?? "none";
    const target = ins?.targetMeanPrice;
    const price = priceBySymbol[symbol];
    const upsidePct =
      target !== undefined && price !== undefined && price > 0
        ? ((target - price) / price) * 100
        : undefined;
    return { symbol, ratingKey, ratingLabel: ratingLabel(ratingKey), target, upsidePct };
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
