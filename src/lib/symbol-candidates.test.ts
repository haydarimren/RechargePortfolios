import { describe, expect, it } from "vitest";
import {
  normalizeQuoteCurrency,
  yahooSymbolCandidates,
} from "./symbol-candidates";

describe("yahooSymbolCandidates", () => {
  it("tries the caller's existing guess first", () => {
    const out = yahooSymbolCandidates("VUAG", {
      candidate: "VUAG.L",
      currency: "GBX",
    });
    expect(out[0]).toBe("VUAG.L");
  });

  it("covers the Milan listing for a EUR ticker whose guess was Xetra", () => {
    // The real regression: T212 reports VNGA80 in EUR, the exchange-letter
    // heuristic produced VNGA80.DE, and Yahoo only has VNGA80.MI.
    const out = yahooSymbolCandidates("VNGA80", {
      candidate: "VNGA80.DE",
      currency: "EUR",
    });
    expect(out[0]).toBe("VNGA80.DE");
    expect(out).toContain("VNGA80.MI");
    expect(out).toContain("VNGA80.AS");
  });

  it("puts the bare symbol first for USD but still offers the LSE USD line", () => {
    const out = yahooSymbolCandidates("VUAA", { currency: "USD" });
    expect(out[0]).toBe("VUAA");
    expect(out).toContain("VUAA.L");
  });

  it("does not let a bare ticker win by default for a non-US currency", () => {
    const out = yahooSymbolCandidates("VNGA80", { currency: "EUR" });
    expect(out[0]).toBe("VNGA80.DE");
    // Still tried, but last — a US symbol collision must not pre-empt the venue.
    expect(out[out.length - 1]).toBe("VNGA80");
  });

  it("deduplicates when the guess repeats a currency candidate", () => {
    const out = yahooSymbolCandidates("VUAG", {
      candidate: "VUAG.L",
      currency: "GBP",
    });
    expect(out.filter((s) => s === "VUAG.L")).toHaveLength(1);
  });

  it("uppercases and trims", () => {
    expect(yahooSymbolCandidates("  vuag ", { currency: "GBP" })).toEqual([
      "VUAG.L",
      "VUAG",
    ]);
  });

  it("returns nothing for an empty ticker", () => {
    expect(yahooSymbolCandidates("   ")).toEqual([]);
  });

  it("falls back to bare-only for an unknown currency", () => {
    expect(yahooSymbolCandidates("ABC", { currency: "XYZ" })).toEqual(["ABC"]);
  });
});

describe("normalizeQuoteCurrency", () => {
  it("converts LSE pence to pounds", () => {
    expect(normalizeQuoteCurrency("GBp")).toEqual({
      currency: "GBP",
      divisor: 100,
    });
    expect(normalizeQuoteCurrency("GBX")).toEqual({
      currency: "GBP",
      divisor: 100,
    });
  });

  it("leaves major-unit currencies alone", () => {
    expect(normalizeQuoteCurrency("GBP")).toEqual({
      currency: "GBP",
      divisor: 1,
    });
    expect(normalizeQuoteCurrency("EUR")).toEqual({
      currency: "EUR",
      divisor: 1,
    });
  });

  it("handles the other minor units Yahoo reports", () => {
    expect(normalizeQuoteCurrency("ZAc").divisor).toBe(100);
    expect(normalizeQuoteCurrency("ILA")).toEqual({
      currency: "ILS",
      divisor: 100,
    });
  });

  it("treats missing currency as unknown, not as an error", () => {
    expect(normalizeQuoteCurrency(undefined)).toEqual({
      currency: "",
      divisor: 1,
    });
  });
});
