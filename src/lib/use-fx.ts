"use client";

import { useEffect, useMemo, useState } from "react";

import { currenciesInHoldings, fxSymbol } from "./currency";
import { getCachedHistoricalCloses } from "./historical-cache";
import { Holding } from "./types";
import { HistoricalPoint } from "./yahoo";

/**
 * Daily {currency}→USD series for every non-USD currency the given
 * holdings touch, covering back to the earliest purchase date.
 *
 * Shared by the portfolio page, the home grid and the friends grid so a
 * portfolio's value is the same number wherever it's rendered. Pass the
 * concatenation of every portfolio's holdings when a page shows several
 * — one series per currency covers all of them.
 *
 * Returns `{}` for an all-USD portfolio and fetches nothing, so
 * single-currency users are on exactly the code path they had before.
 */
export function useFxSeries(
  holdings: Holding[],
): Record<string, HistoricalPoint[]> {
  const [fxSeries, setFxSeries] = useState<Record<string, HistoricalPoint[]>>(
    {},
  );

  // Scalar deps on purpose: `holdings` gets a fresh object identity on
  // every Firestore snapshot, and depending on it directly would refetch
  // rates on each round-trip.
  const currencySig = useMemo(
    () => currenciesInHoldings(holdings).join(","),
    [holdings],
  );
  const earliestDate = useMemo(() => {
    let first: string | null = null;
    for (const h of holdings) {
      if (!first || h.purchaseDate < first) first = h.purchaseDate;
    }
    return first;
  }, [holdings]);

  useEffect(() => {
    let cancelled = false;
    // Wrapped in an async thunk so setState lands in a microtask rather
    // than synchronously in the effect body.
    const load = async () => {
      const currencies = currencySig ? currencySig.split(",") : [];
      if (currencies.length === 0 || !earliestDate) {
        if (!cancelled) {
          setFxSeries((prev) => (Object.keys(prev).length === 0 ? prev : {}));
        }
        return;
      }
      // Pad back like the price fetches do, so a lot bought on a weekend
      // or a bank holiday still finds a rate at-or-before its date.
      const fromMs = new Date(earliestDate).getTime() - 14 * 24 * 60 * 60 * 1000;
      const toMs = Date.now();
      const entries = await Promise.all(
        currencies.map((ccy) =>
          getCachedHistoricalCloses(fxSymbol(ccy), fromMs, toMs).then(
            (pts) => [ccy, pts] as const,
          ),
        ),
      );
      if (cancelled) return;
      setFxSeries(Object.fromEntries(entries.filter(([, p]) => p.length > 0)));
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [currencySig, earliestDate]);

  return fxSeries;
}
