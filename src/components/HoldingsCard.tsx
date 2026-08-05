"use client";

import { useState } from "react";
import type { TickerPosition } from "@/lib/portfolio";
import { fmtShares } from "@/lib/portfolio";
import type { StockQuote } from "@/lib/finnhub";
import type { AnalystRating } from "@/lib/insights";
import { RatingPill } from "@/components/insights-ui";
import { TwoLinePLCell } from "@/components/TwoLinePLCell";
import { AllocationTreemap } from "@/components/AllocationTreemap";
import { fmtMoney, fmtPct } from "@/lib/format";

const HEAD = "text-[10.5px] tracking-[0.1em] uppercase font-medium text-fg-fade";

/**
 * Row area scrolls inside the card from `lg` up, so a long portfolio doesn't
 * push the page down — the column header stays put and only the rows move.
 * It flexes into whatever height the page's grid row gives the card, which is
 * what keeps this column and the logbook column ending on the same line.
 * Kept off touch widths on purpose: a scroll region inside a scrolling page
 * fights the finger.
 */
const SCROLL_BODY = "lg:min-h-0 lg:flex-1 lg:overflow-y-auto";

function DayPct({ dp }: { dp: number | undefined }) {
  if (dp === undefined || !isFinite(dp)) return null;
  const flat = Math.abs(dp) < 0.05;
  const cls = flat ? "text-fg-fade" : dp > 0 ? "text-pos" : "text-neg";
  return (
    <span className={`num text-[10.5px] ${cls}`}>
      {dp >= 0 || flat ? "+" : ""}
      {flat ? "0.0" : dp.toFixed(1)}%
    </span>
  );
}

function Pill({ rating }: { rating: AnalystRating | undefined }) {
  if (!rating || rating.ratingKey === "none") return null;
  const label =
    rating.analystCount !== undefined && rating.analystCount > 0
      ? `${rating.ratingLabel} · ${rating.analystCount}`
      : rating.ratingLabel;
  return <RatingPill ratingKey={rating.ratingKey} label={label} />;
}

export function HoldingsCard({
  positions,
  marketValue,
  totalMarket,
  quotes,
  ratings,
  isOwner,
  portfolioId,
  unpricedSymbols,
  datesDegraded,
  ratingsDegraded,
  onPickSymbol,
  className = "",
}: {
  positions: TickerPosition[];
  marketValue: (symbol: string, shares: number) => number | null;
  totalMarket: number;
  quotes: Record<string, StockQuote | null>;
  /** buildAnalystRatings output keyed by symbol; null while loading. */
  ratings: Record<string, AnalystRating> | null;
  isOwner: boolean;
  portfolioId: string;
  unpricedSymbols: string[];
  datesDegraded: boolean;
  ratingsDegraded: boolean;
  onPickSymbol: (symbol: string) => void;
  className?: string;
}) {
  const [view, setView] = useState<"list" | "map">("list");

  return (
    <div className={`card overflow-hidden lg:flex lg:flex-col ${className}`}>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <span className="text-[13.5px] font-semibold">Holdings</span>
        <span className="num text-xs text-fg-fade">{positions.length}</span>
        <span className="flex-1" />
        <div className="flex overflow-hidden rounded-md border border-line text-xs" role="group" aria-label="Holdings view">
          {(["list", "map"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`px-3 py-1 font-medium transition-colors ${
                view === v ? "bg-bg-3 text-fg" : "text-fg-fade hover:text-fg-dim"
              }`}
            >
              {v === "list" ? "List" : "Map"}
            </button>
          ))}
        </div>
      </div>

      {(unpricedSymbols.length > 0 || datesDegraded) && (
        <div className="flex flex-col gap-1.5 border-b border-line px-4 py-2.5 text-[11.5px] leading-relaxed text-fg-fade">
          {unpricedSymbols.length > 0 && (
            <p>
              No live price for{" "}
              <span className="font-medium text-fg-dim">
                {unpricedSymbols.join(", ")}
              </span>
              {" — "}
              {unpricedSymbols.length === 1 ? "it is" : "they are"} left out of
              the totals and allocation, so the percentages cover only the
              priced positions.
            </p>
          )}
          {datesDegraded && (
            <p>
              {ratingsDegraded
                ? "Analyst ratings and upcoming dates are unavailable right now — they return automatically when the data source recovers."
                : "Upcoming event dates are unavailable right now — analyst ratings are unaffected."}
            </p>
          )}
        </div>
      )}

      {positions.length === 0 ? (
        <div className="p-10 text-center text-sm text-fg-dim">
          No holdings yet.
        </div>
      ) : view === "map" ? (
        <div className="p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <AllocationTreemap
            positions={positions}
            marketValue={marketValue}
            totalMarket={totalMarket}
            isOwner={isOwner}
            portfolioId={portfolioId}
          />
        </div>
      ) : isOwner ? (
        <>
          <div className="hidden md:grid grid-cols-[1.5fr_1fr_1.1fr_1.2fr] gap-3 border-b border-line px-4 py-2">
            <span className={HEAD}>Symbol</span>
            <span className={`${HEAD} text-right`}>Current · Day</span>
            <span className={`${HEAD} text-right`}>Market · Alloc</span>
            <span className={`${HEAD} text-right`}>Gain</span>
          </div>
          <div className={SCROLL_BODY}>
          {positions.map((p) => {
            const market = marketValue(p.symbol, p.shares);
            const currentPrice =
              market !== null && p.shares > 0 ? market / p.shares : null;
            const gain = market !== null ? market - p.cost : null;
            const gainPct =
              gain !== null && p.cost > 0 ? (gain / p.cost) * 100 : null;
            const allocationPct =
              market !== null && totalMarket > 0
                ? (market / totalMarket) * 100
                : null;
            const dp = quotes[p.symbol]?.dp;
            return (
              <button
                key={p.symbol}
                type="button"
                onClick={() => onPickSymbol(p.symbol)}
                className="grid w-full grid-cols-[1.4fr_1fr] items-center gap-3 border-b border-line px-4 py-3 text-left transition last:border-b-0 hover:bg-accent-soft/40 md:grid-cols-[1.5fr_1fr_1.1fr_1.2fr]"
              >
                <div className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-semibold tracking-tight text-fg">
                      {p.symbol}
                    </span>
                    <Pill rating={ratings?.[p.symbol]} />
                  </span>
                  <span className="num mt-0.5 block truncate text-[10.5px] text-fg-fade">
                    {fmtShares(p.shares)} sh · avg {fmtMoney(p.avgPrice)}
                    <span className="md:hidden">
                      {" · "}
                      <DayPct dp={dp} />
                    </span>
                  </span>
                </div>
                <div className="hidden text-right md:block">
                  <span className="num block text-sm text-fg-dim">
                    {currentPrice !== null ? fmtMoney(currentPrice) : "…"}
                  </span>
                  <DayPct dp={dp} />
                </div>
                <div className="hidden text-right md:block">
                  <span className="num block text-sm text-fg-dim">
                    {market !== null ? fmtMoney(market) : "…"}
                  </span>
                  {allocationPct !== null && (
                    <span className="num text-[10.5px] text-fg-fade">
                      <span className="mr-1.5 inline-block h-[3px] w-[46px] overflow-hidden rounded bg-line align-[2px]">
                        <span
                          style={{ width: `${Math.min(100, allocationPct)}%` }}
                          className="block h-full bg-accent"
                        />
                      </span>
                      {allocationPct.toFixed(1)}%
                    </span>
                  )}
                </div>
                <div className="flex flex-col items-end justify-center md:flex-row md:items-center md:justify-end">
                  {/* Mobile keeps the market value above the gain, matching
                      the current app's mobile row. md+ shows market in its
                      own column, so this line is mobile-only. */}
                  <span className="num font-semibold text-fg md:hidden">
                    {market !== null ? fmtMoney(market) : "…"}
                  </span>
                  {gain !== null && gainPct !== null ? (
                    <TwoLinePLCell amount={gain} pct={gainPct} currency="USD" />
                  ) : (
                    <span className="num text-sm text-fg-dim">…</span>
                  )}
                </div>
              </button>
            );
          })}
          </div>
        </>
      ) : (
        <>
          <div className="hidden md:grid grid-cols-[1.5fr_1fr_1fr] gap-3 border-b border-line px-4 py-2">
            <span className={HEAD}>Symbol</span>
            <span className={`${HEAD} text-right`}>Allocation</span>
            <span className={`${HEAD} text-right`}>Gain</span>
          </div>
          <div className={SCROLL_BODY}>
          {positions.map((p) => {
            const market = marketValue(p.symbol, p.shares);
            const gainPct =
              market !== null && p.cost > 0
                ? ((market - p.cost) / p.cost) * 100
                : null;
            const allocationPct =
              market !== null && totalMarket > 0
                ? (market / totalMarket) * 100
                : null;
            const tone =
              gainPct === null ? "" : gainPct >= 0 ? "text-pos" : "text-neg";
            return (
              <button
                key={p.symbol}
                type="button"
                onClick={() => onPickSymbol(p.symbol)}
                className="grid w-full grid-cols-[1.5fr_1fr_1fr] items-center gap-3 border-b border-line px-4 py-3.5 text-left transition last:border-b-0 hover:bg-accent-soft/40"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-semibold tracking-tight text-fg">
                    {p.symbol}
                  </span>
                  <Pill rating={ratings?.[p.symbol]} />
                </span>
                <span className="num text-right text-sm text-fg-dim">
                  {allocationPct !== null ? `${allocationPct.toFixed(1)}%` : "…"}
                </span>
                <span className={`num text-right text-sm ${tone}`}>
                  {gainPct === null ? "…" : fmtPct(gainPct)}
                </span>
              </button>
            );
          })}
          </div>
        </>
      )}
    </div>
  );
}
