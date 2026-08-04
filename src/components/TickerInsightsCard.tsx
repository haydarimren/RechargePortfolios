"use client";

import { useEffect, useMemo, useState } from "react";
import { getStockInsights } from "@/lib/yahoo-insights";
import { getAnalystSpreads } from "@/lib/finnhub-recs";
import {
  buildAnalystRatings, buildUpcomingDates,
  type StockInsight, type AnalystSpread,
} from "@/lib/insights";
import {
  RatingPill, AnalystSpreadBar, SkeletonRows, fmtMoney, signed, signedClass,
} from "./insights-ui";

const EVENT_LABEL: Record<string, string> = {
  earnings: "Earnings", "ex-dividend": "Ex-dividend", dividend: "Dividend pay",
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format an ISO date without going through `Date` — `new Date("2026-10-29")`
 *  is UTC midnight and renders as the 28th west of Greenwich. */
function fmtDate(iso: string, currentYear: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const base = `${MONTHS[m - 1]} ${d}`;
  return y === currentYear ? base : `${base}, ${y}`;
}

/**
 * Per-ticker market insights: analyst consensus (Yahoo) merged with the
 * analyst spread (Finnhub), plus upcoming calendar dates.
 *
 * Public market data only — no owner gate, and nothing about the viewer's
 * position crosses the wire. The symbol already goes server-side from this
 * page for quotes and history.
 *
 * Renders nothing at all when both sources come back empty, which is the
 * normal case for ETFs (no analyst coverage anywhere) and for a dead Yahoo
 * crumb handshake with no Finnhub key configured.
 */
export function TickerInsightsCard({
  symbol, yahooSymbol, price,
}: {
  symbol: string;
  yahooSymbol: string;
  price?: number;
}) {
  // Results carry the symbol they were fetched for, so `loading` is derived
  // rather than a separate flag — no setState in the effect body, and no
  // flash of the previous ticker's numbers when the route changes.
  const [data, setData] = useState<{
    key: string; insight: StockInsight | null; spread: AnalystSpread | null;
  } | null>(null);

  // Scalar dep on purpose — see the effect-loop trap in p/[id]/page.tsx.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getStockInsights([yahooSymbol]).catch(() => ({} as Record<string, StockInsight | null>)),
      getAnalystSpreads([yahooSymbol]).catch(() => ({} as Record<string, AnalystSpread | null>)),
    ]).then(([ins, spr]) => {
      if (cancelled) return;
      setData({
        key: yahooSymbol,
        insight: ins[yahooSymbol] ?? null,
        spread: spr[yahooSymbol] ?? null,
      });
    });
    return () => { cancelled = true; };
  }, [yahooSymbol]);

  const loaded = data?.key === yahooSymbol ? data : null;
  const insight = loaded?.insight ?? null;
  const spread = loaded?.spread ?? null;
  const loading = loaded === null;

  const todayISO = new Date().toISOString().split("T")[0];
  const currentYear = Number(todayISO.slice(0, 4));

  // Reuse the tab's row builder for one symbol so the pill-derivation and
  // analyst-count rules stay in exactly one place.
  const rating = useMemo(
    () => buildAnalystRatings(
      { [symbol]: insight }, { [symbol]: price }, { [symbol]: 1 }, { [symbol]: spread },
    )[0],
    [symbol, insight, price, spread],
  );
  const dates = useMemo(
    () => buildUpcomingDates({ [symbol]: insight }, todayISO),
    [symbol, insight, todayISO],
  );

  if (loading) {
    return (
      <section className="card p-4 md:p-5">
        <SkeletonRows />
      </section>
    );
  }

  const hasRating = rating.ratingKey !== "none" || rating.target !== undefined || !!spread;
  if (!hasRating && dates.length === 0) return null;

  return (
    <section className="card p-4 md:p-5">
      <div className="grid gap-5 md:grid-cols-2 md:gap-8">
        {/* Analyst consensus + spread */}
        <div>
          <h3 className="label mb-3">Analyst view</h3>
          {hasRating ? (
            <>
              <div className="flex items-center gap-2.5 mb-3">
                <RatingPill ratingKey={rating.ratingKey} label={rating.ratingLabel} />
                {rating.analystCount !== undefined && rating.analystCount > 0 && (
                  <span className="num text-xs text-fg-fade">
                    {rating.analystCount} {rating.analystCount === 1 ? "analyst" : "analysts"}
                  </span>
                )}
              </div>
              {spread && <AnalystSpreadBar spread={spread} />}
              {(rating.target !== undefined || rating.upsidePct !== undefined) && (
                <div className="flex items-baseline gap-2.5 mt-3">
                  {rating.target !== undefined && (
                    <span className="num text-sm text-fg-dim">Target ${fmtMoney(rating.target)}</span>
                  )}
                  {rating.upsidePct !== undefined && (
                    <span className={`num text-sm font-semibold ${signedClass(rating.upsidePct)}`}>
                      {signed(rating.upsidePct)}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-fg-dim text-sm py-1">No analyst coverage.</p>
          )}
        </div>

        {/* Upcoming calendar dates */}
        <div>
          <h3 className="label mb-3">Upcoming dates</h3>
          {dates.length === 0 ? (
            <p className="text-fg-dim text-sm py-1">No upcoming events.</p>
          ) : (
            <div className="divide-y divide-line">
              {dates.map((e) => (
                <div key={`${e.kind}-${e.date}`} className="flex items-center justify-between py-2 first:pt-0">
                  <span className="text-sm text-fg-dim">{EVENT_LABEL[e.kind]}</span>
                  <span className="num text-sm text-fg">{fmtDate(e.date, currentYear)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
