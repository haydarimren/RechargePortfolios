import { describe, it, expect } from "vitest";
import {
  parseQuoteSummary, buildUpcomingDates, buildAnalystRatings, topMovers,
  ratingLabel, ratingTone, parseFinnhubRecommendation, spreadTotal,
  spreadSegments, deriveRatingKey,
  type StockInsight, type AnalystSpread,
} from "./insights";

/** Build a spread without spelling out every bucket. */
function spread(p: Partial<AnalystSpread>): AnalystSpread {
  return {
    strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
    period: "2026-08-01", ...p,
  };
}

describe("parseQuoteSummary", () => {
  const sample = {
    quoteSummary: { result: [{
      calendarEvents: {
        earnings: { earningsDate: [{ raw: 1755000000, fmt: "2025-08-12" }] },
        exDividendDate: { raw: 1752000000, fmt: "2025-07-08" },
        dividendDate: { raw: 1753000000, fmt: "2025-07-20" },
      },
      financialData: {
        targetMeanPrice: { raw: 298.93, fmt: "298.93" },
        recommendationKey: "strong_buy",
        numberOfAnalystOpinions: { raw: 42 },
      },
    }] },
  };
  it("parses dates, target, rating, analyst count", () => {
    const r = parseQuoteSummary(sample)!;
    expect(r.earningsDate).toBe("2025-08-12");
    expect(r.exDividendDate).toBe("2025-07-08");
    expect(r.dividendDate).toBe("2025-07-20");
    expect(r.targetMeanPrice).toBe(298.93);
    expect(r.recommendationKey).toBe("strong_buy");
    expect(r.analystCount).toBe(42);
  });
  it("returns null when there is no result", () => {
    expect(parseQuoteSummary({ quoteSummary: { result: [] } })).toBeNull();
    expect(parseQuoteSummary({})).toBeNull();
  });
  it("tolerates missing modules (all fields undefined)", () => {
    const r = parseQuoteSummary({ quoteSummary: { result: [{}] } })!;
    expect(r).toEqual({});
  });
});

describe("buildUpcomingDates", () => {
  const by: Record<string, StockInsight | null> = {
    AAA: { earningsDate: "2025-08-12", exDividendDate: "2025-06-01" }, // ex-div is past
    BBB: { dividendDate: "2025-06-26" },
    CCC: null,
  };
  it("keeps only future events, flattened and sorted ascending", () => {
    const out = buildUpcomingDates(by, "2025-06-14");
    expect(out).toEqual([
      { symbol: "BBB", kind: "dividend", date: "2025-06-26" },
      { symbol: "AAA", kind: "earnings", date: "2025-08-12" },
    ]);
  });
});

describe("buildAnalystRatings", () => {
  const by: Record<string, StockInsight | null> = {
    NVDA: { recommendationKey: "strong_buy", targetMeanPrice: 300 },
    LUNR: { recommendationKey: "none" },
    MSFT: null,
  };
  const price = { NVDA: 200, LUNR: 25, MSFT: 400 };
  const weight = { NVDA: 0.5, LUNR: 0.1, MSFT: 0.4 };
  it("computes upside, labels, and sorts by weight desc", () => {
    const out = buildAnalystRatings(by, price, weight);
    expect(out.map((r) => r.symbol)).toEqual(["NVDA", "MSFT", "LUNR"]);
    expect(out[0]).toEqual({ symbol: "NVDA", ratingKey: "strong_buy", ratingLabel: "Strong Buy", target: 300, upsidePct: 50 });
    expect(out[1]).toMatchObject({ symbol: "MSFT", ratingKey: "none", ratingLabel: "None", target: undefined, upsidePct: undefined });
    expect(out[2]).toMatchObject({ symbol: "LUNR", ratingLabel: "None", upsidePct: undefined });
  });
});

describe("parseFinnhubRecommendation", () => {
  // Finnhub returns newest-first in practice, but the contract is "latest by
  // period" — so the fixture is deliberately out of order.
  const sample = [
    { symbol: "IBM", period: "2026-06-01", strongBuy: 1, buy: 2, hold: 3, sell: 4, strongSell: 5 },
    { symbol: "IBM", period: "2026-08-01", strongBuy: 5, buy: 10, hold: 4, sell: 2, strongSell: 0 },
    { symbol: "IBM", period: "2026-07-01", strongBuy: 9, buy: 9, hold: 9, sell: 9, strongSell: 9 },
  ];
  it("picks the latest period", () => {
    expect(parseFinnhubRecommendation(sample)).toEqual({
      strongBuy: 5, buy: 10, hold: 4, sell: 2, strongSell: 0, period: "2026-08-01",
    });
  });
  it("returns null for an empty array", () => {
    expect(parseFinnhubRecommendation([])).toBeNull();
  });
  it("returns null for malformed payloads", () => {
    expect(parseFinnhubRecommendation(null)).toBeNull();
    expect(parseFinnhubRecommendation({ error: "no data" })).toBeNull();
    expect(parseFinnhubRecommendation([{ period: "2026-08-01" }])).toBeNull();
  });
  it("treats missing buckets as zero", () => {
    const r = parseFinnhubRecommendation([{ period: "2026-08-01", buy: 3, hold: 1 }])!;
    expect(r).toEqual({ strongBuy: 0, buy: 3, hold: 1, sell: 0, strongSell: 0, period: "2026-08-01" });
  });
});

describe("spreadTotal", () => {
  it("sums every bucket", () => {
    expect(spreadTotal(spread({ strongBuy: 5, buy: 10, hold: 4, sell: 2 }))).toBe(21);
    expect(spreadTotal(spread({}))).toBe(0);
  });
});

describe("deriveRatingKey", () => {
  it("maps a lopsided bullish spread to strong_buy", () => {
    expect(deriveRatingKey(spread({ strongBuy: 20, buy: 1 }))).toBe("strong_buy");
  });
  it("maps a lopsided bearish spread to strong_sell", () => {
    expect(deriveRatingKey(spread({ strongSell: 20, sell: 1 }))).toBe("strong_sell");
  });
  // Score = (2·sb + b − s − 2·ss) / total. Cuts at ±0.5 and ±1.5, with the
  // boundary value falling to the more extreme side; hold is the open
  // interval between −0.5 and 0.5.
  it("puts the +1.5 boundary in strong_buy and just below it in buy", () => {
    expect(deriveRatingKey(spread({ strongBuy: 1, buy: 1 }))).toBe("strong_buy"); // 1.5
    expect(deriveRatingKey(spread({ strongBuy: 1, buy: 2 }))).toBe("buy");        // 1.33
  });
  it("puts the +0.5 boundary in buy and just below it in hold", () => {
    expect(deriveRatingKey(spread({ buy: 1, hold: 1 }))).toBe("buy");   // 0.5
    expect(deriveRatingKey(spread({ buy: 1, hold: 2 }))).toBe("hold");  // 0.33
  });
  it("puts the −0.5 boundary in sell and just above it in hold", () => {
    expect(deriveRatingKey(spread({ sell: 1, hold: 1 }))).toBe("sell");  // −0.5
    expect(deriveRatingKey(spread({ sell: 1, hold: 2 }))).toBe("hold");  // −0.33
  });
  it("puts the −1.5 boundary in strong_sell and just above it in sell", () => {
    expect(deriveRatingKey(spread({ sell: 1, strongSell: 1 }))).toBe("strong_sell"); // −1.5
    expect(deriveRatingKey(spread({ sell: 2, strongSell: 1 }))).toBe("sell");        // −1.33
  });
  it("returns none when nobody covers the symbol", () => {
    expect(deriveRatingKey(spread({}))).toBe("none");
  });
});

describe("spreadSegments", () => {
  // 5 / 10 / 4 / 2 / 0 out of 21 — the reference case from the design.
  const s = spread({ strongBuy: 5, buy: 10, hold: 4, sell: 2, strongSell: 0 });
  it("orders segments most bullish first", () => {
    expect(spreadSegments(s).map((x) => x.key)).toEqual(["strongBuy", "buy", "hold", "sell"]);
  });
  it("drops zero buckets", () => {
    expect(spreadSegments(s).some((x) => x.key === "strongSell")).toBe(false);
    expect(spreadSegments(s).every((x) => x.count > 0)).toBe(true);
  });
  it("returns percentages of the fixed track that sum to 100", () => {
    const segs = spreadSegments(s);
    expect(segs.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100);
    expect(segs[1].pct).toBeCloseTo((10 / 21) * 100);
  });
  it("normalizes to the track regardless of how many analysts cover it", () => {
    // Two symbols with wildly different coverage but the same shape must
    // produce identical geometry — the bar encodes distribution, not size.
    const small = spreadSegments(spread({ buy: 1, hold: 1 }));
    const large = spreadSegments(spread({ buy: 50, hold: 50 }));
    expect(small.map((x) => x.pct)).toEqual(large.map((x) => x.pct));
  });
  it("labels only segments at or above 12% of the track", () => {
    const segs = spreadSegments(s);
    expect(segs.find((x) => x.key === "hold")!.showLabel).toBe(true);   // 19.0%
    expect(segs.find((x) => x.key === "sell")!.showLabel).toBe(false);  // 9.5%
  });
  it("returns an empty list for a zero total", () => {
    expect(spreadSegments(spread({}))).toEqual([]);
  });
});

describe("buildAnalystRatings with Finnhub spreads", () => {
  const by: Record<string, StockInsight | null> = {
    NVDA: { recommendationKey: "strong_buy", targetMeanPrice: 300, analystCount: 42 },
    MSFT: null,
  };
  const price = { NVDA: 200, MSFT: 400 };
  const weight = { NVDA: 0.6, MSFT: 0.4 };
  const spreads = {
    NVDA: spread({ strongBuy: 30, buy: 10 }),
    MSFT: spread({ buy: 8, hold: 4 }),
  };
  it("derives a pill for a symbol Yahoo does not cover", () => {
    const out = buildAnalystRatings(by, price, weight, spreads);
    const msft = out.find((r) => r.symbol === "MSFT")!;
    expect(msft.ratingKey).toBe("buy");
    expect(msft.ratingLabel).toBe("Buy");
  });
  it("keeps Yahoo's own rating when it has one", () => {
    const out = buildAnalystRatings(by, price, weight, spreads);
    expect(out.find((r) => r.symbol === "NVDA")!.ratingKey).toBe("strong_buy");
  });
  // Yahoo answers for plenty of symbols it has no consensus on, and says so
  // with the literal string "none" rather than by omitting the field. That
  // is a *defined* value, so `??` kept it and Finnhub never got a look —
  // real-world symptom: SNEX and CRDO showed no pill despite Finnhub
  // covering both.
  it("derives from the spread when Yahoo answers the literal \"none\"", () => {
    const out = buildAnalystRatings(
      { SNEX: { recommendationKey: "none", analystCount: 0 } },
      { SNEX: 76 },
      { SNEX: 1 },
      { SNEX: spread({ strongBuy: 3, buy: 3, hold: 2 }) },
    );
    expect(out[0].ratingKey).toBe("buy");
    expect(out[0].analystCount).toBe(8);
  });
  it("still reports \"none\" when neither source has a rating", () => {
    const out = buildAnalystRatings(
      { XYZ: { recommendationKey: "none" } },
      { XYZ: 10 },
      { XYZ: 1 },
      { XYZ: null },
    );
    expect(out[0].ratingKey).toBe("none");
  });
  it("counts analysts from the spread it draws, not from Yahoo", () => {
    const out = buildAnalystRatings(by, price, weight, spreads);
    // Yahoo says 42, but the bar shows 40 — the number must match the bar.
    expect(out.find((r) => r.symbol === "NVDA")!.analystCount).toBe(40);
  });
  it("falls back to Yahoo's count when there is no spread", () => {
    const out = buildAnalystRatings(by, price, weight, {});
    expect(out.find((r) => r.symbol === "NVDA")!.analystCount).toBe(42);
    expect(out.find((r) => r.symbol === "NVDA")!.spread).toBeUndefined();
  });
  it("leaves the weight sort order untouched", () => {
    expect(buildAnalystRatings(by, price, weight, spreads).map((r) => r.symbol))
      .toEqual(["NVDA", "MSFT"]);
  });
});

describe("topMovers", () => {
  const rows = [
    { symbol: "A", dailyPct: 5, returnPct: -2 },
    { symbol: "B", dailyPct: -3, returnPct: 40 },
    { symbol: "C", dailyPct: 1, returnPct: -10 },
    { symbol: "D", dailyPct: -8, returnPct: 12 },
  ];
  it("splits gainers (pct>0 desc) and losers (pct<0 asc), top 3, per metric", () => {
    const m = topMovers(rows);
    expect(m.today.gainers.map((r) => r.symbol)).toEqual(["A", "C"]);
    expect(m.today.losers.map((r) => r.symbol)).toEqual(["D", "B"]);
    expect(m.sincePurchase.gainers.map((r) => r.symbol)).toEqual(["B", "D"]);
    expect(m.sincePurchase.losers.map((r) => r.symbol)).toEqual(["C", "A"]);
  });
});

describe("ratingLabel / ratingTone", () => {
  it("maps keys to labels", () => {
    expect(ratingLabel("strong_buy")).toBe("Strong Buy");
    expect(ratingLabel("buy")).toBe("Buy");
    expect(ratingLabel("hold")).toBe("Hold");
    expect(ratingLabel("sell")).toBe("Sell");
    expect(ratingLabel("strong_sell")).toBe("Strong Sell");
    expect(ratingLabel("none")).toBe("None");
    expect(ratingLabel(undefined)).toBe("None");
  });
  it("maps keys to tones", () => {
    expect(ratingTone("strong_buy")).toBe("pos");
    expect(ratingTone("buy")).toBe("pos");
    expect(ratingTone("hold")).toBe("neutral");
    expect(ratingTone("sell")).toBe("neg");
    expect(ratingTone("strong_sell")).toBe("neg");
    expect(ratingTone("none")).toBe("fade");
    expect(ratingTone(undefined)).toBe("fade");
  });
});
