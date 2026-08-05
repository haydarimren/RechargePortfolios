"use client";

import { useEffect, useMemo, useState } from "react";
import type { TickerPosition } from "@/lib/portfolio";
import { getStockInsights } from "@/lib/yahoo-insights";
import { getAnalystSpreads } from "@/lib/finnhub-recs";
import type { AnalystSpread, StockInsight } from "@/lib/insights";

/**
 * One insights fetch per symbol SET (not per consumer). Yahoo quoteSummary +
 * Finnhub recommendation spreads, both behind daily server-side TTL caches.
 *
 * Dep discipline: the effect keys on the sorted symbol string, never on the
 * positions array identity — the documented effect-loop trap. Results are
 * tagged with the key they were fetched for so a symbol-set change can't
 * briefly show the previous set's data.
 */
export function useInsightsData(positions: TickerPosition[]): {
  loading: boolean;
  insights: Record<string, StockInsight | null> | null;
  spreads: Record<string, AnalystSpread | null>;
  datesDegraded: boolean;
  ratingsDegraded: boolean;
} {
  const symbolKey = useMemo(
    () => positions.map((p) => p.symbol).sort().join(","),
    [positions],
  );

  const [data, setData] = useState<{
    key: string;
    insights: Record<string, StockInsight | null>;
    spreads: Record<string, AnalystSpread | null>;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const syms = symbolKey ? symbolKey.split(",") : [];
    if (syms.length === 0) return;
    const yahooFor = (sym: string) => {
      const pos = positions.find((p) => p.symbol === sym);
      return pos?.lots.find((l) => l.yahooSymbol)?.yahooSymbol ?? sym;
    };
    const apiSymbols = syms.map(yahooFor);
    Promise.all([
      getStockInsights(apiSymbols).catch(
        () => ({}) as Record<string, StockInsight | null>,
      ),
      getAnalystSpreads(apiSymbols).catch(
        () => ({}) as Record<string, AnalystSpread | null>,
      ),
    ]).then(([insMap, sprMap]) => {
      if (cancelled) return;
      const rekeyedIns: Record<string, StockInsight | null> = {};
      const rekeyedSpr: Record<string, AnalystSpread | null> = {};
      syms.forEach((s, i) => {
        rekeyedIns[s] = insMap[apiSymbols[i]] ?? null;
        rekeyedSpr[s] = sprMap[apiSymbols[i]] ?? null;
      });
      setData({ key: symbolKey, insights: rekeyedIns, spreads: rekeyedSpr });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scalar dep on purpose
  }, [symbolKey]);

  const loaded = useMemo(
    () =>
      symbolKey === ""
        ? { key: "", insights: {}, spreads: {} }
        : data?.key === symbolKey
          ? data
          : null,
    [symbolKey, data],
  );

  const { datesDegraded, ratingsDegraded } = useMemo(() => {
    const syms = symbolKey ? symbolKey.split(",") : [];
    if (!loaded || syms.length === 0) {
      return { datesDegraded: false, ratingsDegraded: false };
    }
    const noYahoo = syms.every((s) => loaded.insights[s] == null);
    return {
      datesDegraded: noYahoo,
      ratingsDegraded: noYahoo && syms.every((s) => loaded.spreads[s] == null),
    };
  }, [loaded, symbolKey]);

  const spreads = useMemo(() => loaded?.spreads ?? {}, [loaded]);

  return {
    loading: loaded === null,
    insights: loaded?.insights ?? null,
    spreads,
    datesDegraded,
    ratingsDegraded,
  };
}
