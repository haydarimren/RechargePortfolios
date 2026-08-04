import { afterEach, describe, expect, it, vi } from "vitest";
import { repairYahooSymbol, resolveYahooSymbol } from "./symbol-resolve";

/**
 * Fake Yahoo. `chart` maps a symbol to the currency it quotes in; anything
 * absent 404s. `search` maps a bare ticker to the symbols Yahoo suggests.
 *
 * Every test uses a distinct ticker because the resolver caches positives
 * for 24h in module scope — that's the point of it, not a test smell.
 */
function fakeYahoo(opts: {
  chart?: Record<string, string>;
  search?: Record<string, string[]>;
}) {
  const chart = opts.chart ?? {};
  const search = opts.search ?? {};
  const probed: string[] = [];

  const impl = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const chartMatch = url.match(/\/v8\/finance\/chart\/([^?]+)/);
    if (chartMatch) {
      const symbol = decodeURIComponent(chartMatch[1]);
      probed.push(symbol);
      const currency = chart[symbol];
      if (!currency) {
        return { ok: false, status: 404, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          chart: {
            result: [
              { meta: { symbol, currency, regularMarketPrice: 42.5 } },
            ],
          },
        }),
      } as Response;
    }
    const searchMatch = url.match(/\/v1\/finance\/search\?q=([^&]+)/);
    if (searchMatch) {
      const q = decodeURIComponent(searchMatch[1]);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          quotes: (search[q] ?? []).map((symbol) => ({
            symbol,
            quoteType: "ETF",
          })),
        }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  vi.stubGlobal("fetch", impl);
  return { probed };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveYahooSymbol", () => {
  it("accepts the caller's guess without probing anything else", async () => {
    const { probed } = fakeYahoo({ chart: { "AAA.L": "GBP" } });
    const out = await resolveYahooSymbol("AAA", "GBX", "AAA.L");
    expect(out).toEqual({ symbol: "AAA.L", currency: "GBP" });
    expect(probed).toEqual(["AAA.L"]);
  });

  it("finds the Milan listing when the Xetra guess is dead", async () => {
    // The VNGA80 regression, with the real venue layout: the broker's
    // ticker heuristic said Xetra, and only Borsa Italiana keeps the
    // ticker on Yahoo.
    const { probed } = fakeYahoo({ chart: { "BBB80.MI": "EUR" } });
    const out = await resolveYahooSymbol("BBB80", "EUR", "BBB80.DE");
    expect(out).toEqual({ symbol: "BBB80.MI", currency: "EUR" });
    expect(probed.slice(0, 3)).toEqual(["BBB80.DE", "BBB80.AS", "BBB80.MI"]);
  });

  it("falls back to Yahoo search when every venue guess is dead", async () => {
    // Amsterdam relists the fund under a different Yahoo ticker, so no
    // amount of suffix permutation on the bare ticker finds it.
    const { probed } = fakeYahoo({
      chart: { "C80A.AS": "EUR" },
      search: { CCC80: ["C80A.AS"] },
    });
    const out = await resolveYahooSymbol("CCC80", "EUR", "CCC80.DE");
    expect(out).toEqual({ symbol: "C80A.AS", currency: "EUR" });
    expect(probed).toContain("C80A.AS");
  });

  it("prefers a currency match over an earlier hit in another currency", async () => {
    const { probed } = fakeYahoo({
      chart: { "DDD.DE": "EUR", "DDD.L": "GBP" },
    });
    const out = await resolveYahooSymbol("DDD", "GBX", "DDD.DE");
    expect(out).toEqual({ symbol: "DDD.L", currency: "GBP" });
    expect(probed).toEqual(["DDD.DE", "DDD.L"]);
  });

  it("keeps a wrong-currency hit rather than returning nothing", async () => {
    const { probed } = fakeYahoo({ chart: { "EEE.DE": "EUR" } });
    const out = await resolveYahooSymbol("EEE", "GBX", "EEE.DE");
    expect(out).toEqual({ symbol: "EEE.DE", currency: "EUR" });
    expect(probed.length).toBeGreaterThan(1);
  });

  it("returns null when nothing resolves", async () => {
    fakeYahoo({});
    expect(await resolveYahooSymbol("FFF", "EUR", "FFF.DE")).toBeNull();
  });

  it("caches, so a repeat resolution costs no network", async () => {
    const { probed } = fakeYahoo({ chart: { "GGG.L": "GBP" } });
    await resolveYahooSymbol("GGG", "GBP", "GGG.L");
    const before = probed.length;
    await resolveYahooSymbol("GGG", "GBP", "GGG.L");
    expect(probed.length).toBe(before);
  });

  it("coalesces concurrent resolutions of the same symbol", async () => {
    const { probed } = fakeYahoo({ chart: { "HHH.L": "GBP" } });
    const [a, b] = await Promise.all([
      resolveYahooSymbol("HHH", "GBP", "HHH.L"),
      resolveYahooSymbol("HHH", "GBP", "HHH.L"),
    ]);
    expect(a).toEqual(b);
    expect(probed).toEqual(["HHH.L"]);
  });

  it("ignores an empty ticker", async () => {
    fakeYahoo({});
    expect(await resolveYahooSymbol("  ")).toBeNull();
  });
});

describe("repairYahooSymbol", () => {
  it("recovers the currency hint from a dead symbol's own suffix", async () => {
    // Caller has no broker metadata — only "III80.DE doesn't work". The
    // .DE suffix is still enough to say "try the other EUR venues".
    fakeYahoo({ chart: { "III80.MI": "EUR" } });
    const out = await repairYahooSymbol("III80.DE");
    expect(out).toEqual({ symbol: "III80.MI", currency: "EUR" });
  });

  it("returns null when the symbol was already correct", async () => {
    fakeYahoo({ chart: { "JJJ.L": "GBP" } });
    expect(await repairYahooSymbol("JJJ.L")).toBeNull();
  });

  it("returns null when there is nothing to repair it to", async () => {
    fakeYahoo({});
    expect(await repairYahooSymbol("KKK.DE")).toBeNull();
  });
});
