import { describe, it, expect } from "vitest";
import {
  parseQuoteSummary, buildUpcomingDates, buildAnalystRatings, topMovers,
  ratingLabel, ratingTone, type StockInsight,
} from "./insights";

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
